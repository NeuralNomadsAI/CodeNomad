import { createHash, randomUUID } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, open, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

// Waits before each verify-and-publish pass (about 3 s in all). Concurrent installers of
// the same bytes converge within the first passes; the later ones outlast short Windows
// sharing violations from a reader or an antivirus scan.
const BUNDLE_REPAIR_DELAYS_MS = [0, 25, 50, 100, 200, 400, 800, 1600]
const TRANSIENT_LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES"])

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" ? code : undefined
}

async function lstatOrUndefined(file: string) {
  return lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

type BundleIdentity = { dev: bigint; ino: bigint }

function singleFile(info: BigIntStats | undefined): info is BigIntStats {
  return Boolean(info?.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
}

async function openBundle(plugin: string) {
  return open(plugin, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ELOOP" || error.code === "EISDIR") return undefined
    throw error
  })
}

async function matchesIdentity(plugin: string, named: BigIntStats, identity: BundleIdentity): Promise<boolean> {
  if (!singleFile(named) || identity.ino === 0n || named.ino !== identity.ino) return false
  if (process.platform === "win32" && identity.dev === 0n) return false
  if (named.dev === identity.dev) return true
  // Some Windows/libuv path stats omit the volume while fstat supplies it. Keep
  // device verification: independently open the name and compare both handle IDs.
  if (process.platform !== "win32" || named.dev !== 0n) return false
  const probe = await openBundle(plugin)
  if (!probe) return false
  try {
    const held = await probe.stat({ bigint: true }), after = await lstatOrUndefined(plugin)
    return singleFile(held) && held.dev === identity.dev && held.ino === identity.ino && held.size === named.size
      && singleFile(after) && after.ino === identity.ino && after.size === named.size
      && (after.dev === 0n || after.dev === identity.dev)
  } finally { await probe.close() }
}

/** The identity of one regular file holding exactly `bundle`, read through one handle. */
async function verifiedBundle(plugin: string, bundle: Uint8Array, hash: string, reject: (reason: string) => undefined): Promise<BundleIdentity | undefined> {
  // Links (including Windows junctions) and directories are never opened or followed.
  const before = await lstatOrUndefined(plugin)
  if (!singleFile(before)) return reject("payload missing or not a single regular file")
  const handle = await openBundle(plugin)
  if (!handle) return reject("payload disappeared or became a link")
  try {
    const info = await handle.stat({ bigint: true }), named = await lstatOrUndefined(plugin)
    if (!singleFile(info) || !singleFile(named)) return reject("payload is not a single regular file")
    if (info.size !== BigInt(bundle.byteLength) || named.size !== info.size) return reject("payload size differs from bundle")
    if (!await matchesIdentity(plugin, named, info)) return reject("payload device or inode differs from open handle")
    const actual = createHash("sha256"), chunk = Buffer.alloc(64 * 1024)
    for (let offset = 0; offset < bundle.byteLength;) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, bundle.byteLength - offset), offset)
      if (!bytesRead) return reject("payload ended before bundle length")
      actual.update(chunk.subarray(0, bytesRead))
      offset += bytesRead
    }
    if (actual.digest("hex") !== hash) return reject("payload SHA-256 differs from bundle")
    if ((await handle.read(chunk, 0, 1, bundle.byteLength)).bytesRead) return reject("payload has trailing bytes")
    return { dev: info.dev, ino: info.ino }
  } finally { await handle.close() }
}

/** Test-only scheduling seam: runs after a directory link was observed, before it is removed. */
export const bundleRepairSchedule: { beforeLinkRemoval?: (plugin: string) => Promise<void> } = {}

/**
 * Renames a complete private copy over `plugin`, replacing the name itself, never a
 * link's target: a rename replaces a file link atomically. Windows cannot rename a file
 * over a directory link (a junction or a directory symlink); such a link is removed with
 * `rmdir`, which never removes a regular file another installer published meanwhile,
 * nor a link's target. When the name changed instead, nothing is replaced: the caller
 * verifies what is there now. An ordinary directory is never removed.
 */
async function publishBundle(plugin: string, bundle: Uint8Array) {
  const refuseDirectory = (named: BigIntStats | undefined) => {
    if (named?.isDirectory()) {
      throw new Error(`Managed plugin bundle path is a directory, which CodeNomad never removes: ${plugin}. Delete it, then reconnect.`)
    }
  }
  refuseDirectory(await lstatOrUndefined(plugin))
  const temporary = `${plugin}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bundle, { flag: "wx" })
    try {
      await rename(temporary, plugin)
      return
    } catch (error) {
      const code = errorCode(error)
      if (code !== "EPERM" && code !== "EISDIR" && code !== "EACCES") throw error
      const named = await lstatOrUndefined(plugin)
      refuseDirectory(named)
      // Not a link (a locked file, for example): the caller backs off and retries.
      if (!named?.isSymbolicLink()) throw error
    }
    await bundleRepairSchedule.beforeLinkRemoval?.(plugin)
    const removed = await rmdir(plugin).then(() => true, (error: NodeJS.ErrnoException) => {
      // The link is gone or became something else: another installer repaired the name.
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ENOTEMPTY" || error.code === "EEXIST") return false
      throw error
    })
    if (removed) await rename(temporary, plugin)
  } finally { await rm(temporary, { force: true }) }
}

/** Atomically publish or repair a payload, then verify it again before shim publication. */
export async function installDesktopPluginArtifact(plugin: string, bundle: Uint8Array, hash: string, assertCurrent: () => void = () => {}) {
  // A payload is only ever published whole, by renaming a complete temporary copy.
  // Transient Windows locks back off within the bounded passes; other failures are final.
  let identity: BundleIdentity | undefined
  let failure: unknown
  let reason = "payload unavailable"
  const verify = () => verifiedBundle(plugin, bundle, hash, detail => { reason = detail; return undefined })
  for (const wait of BUNDLE_REPAIR_DELAYS_MS) {
    if (wait) await delay(wait, undefined, { ref: false })
    assertCurrent()
    try {
      identity = await verify()
      if (identity) break
      assertCurrent()
      await publishBundle(plugin, bundle)
      identity = await verify()
      if (identity) break
    } catch (error) {
      if (!TRANSIENT_LOCK_CODES.has(errorCode(error) ?? "")) throw error
      failure = error
    }
  }
  if (!identity) {
    // The server compiles against a library without `Error.cause`.
    throw Object.assign(new Error(`Managed plugin bundle could not be verified or replaced (${reason}): ${plugin}. `
      + "Check filesystem access and other CodeNomad servers using this OpenCode configuration, then reconnect."), { cause: failure })
  }
  return async () => {
    const named = await lstat(plugin, { bigint: true })
    if (singleFile(named) && named.size === BigInt(bundle.byteLength)
      && named.dev === identity!.dev && named.ino === identity!.ino) return
    // Another installer may have published the same bytes meanwhile.
    identity = await verify()
    if (!identity) throw new Error(`Managed plugin bundle changed while it was being installed (${reason}): ${plugin}`)
  }
}
