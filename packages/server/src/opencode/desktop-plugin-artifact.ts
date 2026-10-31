import { createHash, randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
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
  return lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

/** The identity of one regular file holding exactly `bundle`, read through one handle. */
async function verifiedBundle(plugin: string, bundle: Uint8Array, hash: string): Promise<{ dev: number; ino: number } | undefined> {
  // Links (including Windows junctions) and directories are never opened or followed.
  const before = await lstatOrUndefined(plugin)
  if (!before?.isFile()) return undefined
  const handle = await open(plugin, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ELOOP" || error.code === "EISDIR") return undefined
    throw error
  })
  if (!handle) return undefined
  try {
    const info = await handle.stat(), named = await lstatOrUndefined(plugin)
    if (!named || !info.isFile() || !named.isFile() || named.isSymbolicLink() || info.nlink !== 1
      || info.dev !== named.dev || info.ino !== named.ino || info.size !== bundle.byteLength) return undefined
    const actual = createHash("sha256"), chunk = Buffer.alloc(64 * 1024)
    for (let offset = 0; offset < bundle.byteLength;) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, bundle.byteLength - offset), offset)
      if (!bytesRead) return undefined
      actual.update(chunk.subarray(0, bytesRead))
      offset += bytesRead
    }
    if (actual.digest("hex") !== hash || (await handle.read(chunk, 0, 1, bundle.byteLength)).bytesRead) return undefined
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
  const refuseDirectory = (named: Stats | undefined) => {
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
  let identity: { dev: number; ino: number } | undefined
  let failure: unknown
  for (const wait of BUNDLE_REPAIR_DELAYS_MS) {
    if (wait) await delay(wait, undefined, { ref: false })
    assertCurrent()
    try {
      identity = await verifiedBundle(plugin, bundle, hash)
      if (identity) break
      assertCurrent()
      await publishBundle(plugin, bundle)
      identity = await verifiedBundle(plugin, bundle, hash)
      if (identity) break
    } catch (error) {
      if (!TRANSIENT_LOCK_CODES.has(errorCode(error) ?? "")) throw error
      failure = error
    }
  }
  if (!identity) {
    // The server compiles against a library without `Error.cause`.
    throw Object.assign(new Error(`Managed plugin bundle differs from its digest and could not be replaced: ${plugin}. `
      + "Stop other CodeNomad servers using this OpenCode configuration, or delete that file, then reconnect."), { cause: failure })
  }
  return async () => {
    const named = await lstat(plugin)
    if (named.isFile() && !named.isSymbolicLink() && named.nlink === 1 && named.size === bundle.byteLength
      && named.dev === identity!.dev && named.ino === identity!.ino) return
    // Another installer may have published the same bytes meanwhile.
    identity = await verifiedBundle(plugin, bundle, hash)
    if (!identity) throw new Error(`Managed plugin bundle changed while it was being installed: ${plugin}`)
  }
}
