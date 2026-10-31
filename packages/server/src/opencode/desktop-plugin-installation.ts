import { createHash, randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, readFile, rename, rm, rmdir, stat, writeFile, utimes } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PRESENCE_INTERVAL_MS, PRESENCE_READY_SUFFIX } from "./desktop-plugin-presence"

// Two presence checks plus a scan. Paid in full only when no marker can come:
// no Location loaded yet, or pre-marker plugin copies still loaded after an upgrade.
export const PRESENCE_READY_WAIT_MS = 5_000
const PRESENCE_READY_POLL_MS = 100
import { isLegacyAutomationPlugin } from "./automation-plugin"
import { assertNativePluginPath, type DesktopPluginNativePath } from "./desktop-plugin-wsl-paths"

export interface DesktopPluginPaths {
  config: string
  data: string
  // WSL entries use Linux paths; filesystem I/O uses translated drive/UNC paths.
  nativeData?: string
  resolveNativePath?: (directory: string, assertCurrent: () => void) => Promise<DesktopPluginNativePath>
}
export type DesktopPluginFeature = "session-pruning" | "automation" | "missions"

// Only parse our exact generated entry shape. Older backend leases remain
// readable during migration, but new heartbeats must leave the watched root.
async function managedStorage(feature: DesktopPluginFeature, existing: string | undefined, marker: string, paths: DesktopPluginPaths, assertCurrent: () => void) {
  if (!existing?.startsWith(marker)) return undefined
  const match = /^import \{ desktopPlugin \} from ("(?:[^"\\]|\\.)*")\nexport default desktopPlugin\((.+)\)\n$/.exec(existing.slice(marker.length))
  if (!match) throw new Error("Invalid managed CodeNomad plugin entry")
  const url = new URL(JSON.parse(match[1]) as string)
  const argument: unknown = JSON.parse(match[2])
  const presenceDirectories = typeof argument === "string" ? [argument] : argument
  const nativePaths = paths.nativeData ? path.posix : path
  if (!Array.isArray(presenceDirectories) || !presenceDirectories.length || presenceDirectories.length > 8
    || !presenceDirectories.every(directory => typeof directory === "string" && nativePaths.isAbsolute(directory)
      && !directory.includes("\0") && nativePaths.basename(directory) === "presence"
      && nativePaths.basename(nativePaths.dirname(directory)) === feature)) {
    throw new Error("Invalid managed CodeNomad plugin presence")
  }
  const nativeLeases = presenceDirectories[0] as string
  const nativeDirectory = nativePaths.dirname(nativeLeases)
  const plugin = paths.nativeData ? decodeURIComponent(url.pathname) : fileURLToPath(url)
  if (url.protocol !== "file:" || url.search || url.hash || (paths.nativeData && url.hostname)
    || !nativePaths.isAbsolute(nativeDirectory) || nativePaths.basename(nativeDirectory) !== feature
    || nativePaths.basename(nativeLeases) !== "presence" || nativePaths.dirname(plugin) !== nativeDirectory
    || !/^[a-f\d]{64}\.mjs$/.test(nativePaths.basename(plugin))) {
    throw new Error("Invalid managed CodeNomad plugin storage")
  }
  if (!paths.nativeData) return { directory: nativeDirectory, nativeDirectory, presenceDirectories: presenceDirectories as string[] }
  for (const directory of presenceDirectories) assertNativePluginPath(directory)
  if (!paths.resolveNativePath) throw new Error("Missing managed WSL plugin path resolver")
  const resolved = await paths.resolveNativePath(nativeDirectory, assertCurrent)
  return { directory: resolved.host, nativeDirectory, presenceDirectories: presenceDirectories as string[] }
}

function within(directory: string, root: string): boolean {
  const relative = path.relative(root, directory)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

// Atomic replacement: readers see the previous or the next content, never a partial one.
// The temporary name never matches the lease pattern that presence scans.
async function writeLease(lease: string, content: string) {
  const temporary = `${lease}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: "wx" })
    await rename(temporary, lease)
  } finally { await rm(temporary, { force: true }) }
}

// Waits before each verify-and-publish pass (about 3 s in all). Concurrent installers of
// the same bytes converge within the first passes; the later ones outlast short Windows
// sharing violations from a reader or an antivirus scan.
const BUNDLE_REPAIR_DELAYS_MS = [0, 25, 50, 100, 200, 400, 800, 1600]
// Sharing violations and locks Windows reports while another process holds the file.
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

/**
 * The identity of `plugin` when it is one regular file holding exactly `bundle`,
 * read through a single handle; undefined when it is absent or holds anything else.
 */
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

/**
 * `leaseContent` is the backend's current lease state (empty when it requests
 * nothing). The lease is created with it and rewritten only when it changes:
 * at `sync()`, else at the next heartbeat, which also retries a failed write.
 */
export async function installDesktopPluginPresence(
  feature: DesktopPluginFeature,
  bundle: Uint8Array,
  paths: DesktopPluginPaths,
  assertCurrent: () => void = () => {},
  leaseContent: () => string = () => "",
) {
  assertCurrent()
  const marker = `// Managed by CodeNomad: ${feature.replaceAll("-", " ")} lifecycle v1\n`
  const hash = createHash("sha256").update(bundle).digest("hex")
  const entry = path.join(paths.config, "plugins", `codenomad-${feature}.ts`)
  const existing = await readFile(entry, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  assertCurrent()
  if (existing !== undefined && !existing.startsWith(marker)
    && !(feature === "automation" && isLegacyAutomationPlugin(existing))) {
    throw new Error(`Existing plugin entry is not managed by CodeNomad: ${entry}`)
  }
  const storage = await managedStorage(feature, existing, marker, paths, assertCurrent)
  assertCurrent()
  const retainStorage = storage && !within(storage.directory, paths.config)
  const directory = retainStorage ? storage.directory : path.join(paths.data, feature)
  const nativeDirectory = retainStorage ? storage.nativeDirectory : (paths.nativeData ? path.posix.join(paths.nativeData, feature) : directory)
  const leases = path.join(directory, "presence")
  const nativeLeases = paths.nativeData ? path.posix.join(nativeDirectory, "presence") : leases
  const plugin = path.join(directory, `${hash}.mjs`)
  const pluginUrl = paths.nativeData
    ? pathToFileURL(`${nativeDirectory}/${hash}.mjs`, { windows: false }).href
    : pathToFileURL(plugin).href
  const presenceDirectories = [...new Set([nativeLeases, ...(storage?.presenceDirectories ?? [])])]
  const source = `${marker}import { desktopPlugin } from ${JSON.stringify(pluginUrl)}\nexport default desktopPlugin(${JSON.stringify(presenceDirectories.length === 1 ? nativeLeases : presenceDirectories)})\n`
  await mkdir(leases, { recursive: true })
  assertCurrent()
  await mkdir(path.dirname(entry), { recursive: true })
  assertCurrent()
  // Immutable, content-addressed payloads keep running instances independent of upgrades.
  // A payload is only ever published whole, by renaming a complete temporary copy, and a
  // name holding other bytes (cut short by a killed process, or not a single regular file)
  // is replaced the same way: the entry only ever points at verified bytes.
  // Transient Windows locks (a reader, an antivirus scan) back off within the bounded
  // passes; any other failure is final at once.
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
  const assertBundlePath = async () => {
    const named = await lstat(plugin)
    if (named.isFile() && !named.isSymbolicLink() && named.nlink === 1 && named.size === bundle.byteLength
      && named.dev === identity!.dev && named.ino === identity!.ino) return
    // Another installer may have published the same bytes meanwhile.
    identity = await verifiedBundle(plugin, bundle, hash)
    if (!identity) throw new Error(`Managed plugin bundle changed while it was being installed: ${plugin}`)
  }
  await assertBundlePath()
  assertCurrent()
  const lease = path.join(leases, `${randomUUID()}.lease`)
  let written = leaseContent()
  try {
    await writeLease(lease, written)
    assertCurrent()
    if (existing !== source) {
      const temporary = `${entry}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, source)
        assertCurrent()
        await assertBundlePath()
        await rename(temporary, entry)
      } finally { await rm(temporary, { force: true }) }
    }
    assertCurrent()
  } catch (error) {
    await rm(lease, { force: true })
    throw error
  }
  let pending = Promise.resolve()
  let disposed = false
  // Serialized with the heartbeat and disposal, so a rewrite never resurrects a removed lease.
  const sync = (renew: boolean) => pending = pending.then(async () => {
    if (disposed) return
    const content = leaseContent()
    if (content !== written) {
      await writeLease(lease, content)
      written = content
    } else if (renew) {
      const now = new Date()
      await utimes(lease, now, now)
    }
  }).catch(() => {})
  const timer = setInterval(() => { void sync(true) }, PRESENCE_INTERVAL_MS)
  timer.unref()
  // Plugins register at their next presence check; the marker confirms every
  // follower in the daemon process has observed this lease while registered.
  // Bounded: an older plugin without markers only delays the first RPC.
  const readyMarker = `${lease}${PRESENCE_READY_SUFFIX}`
  const ready = (async () => {
    for (const deadline = Date.now() + PRESENCE_READY_WAIT_MS; !disposed && Date.now() < deadline;) {
      if (await stat(readyMarker).then(() => true, () => false)) return true
      await delay(PRESENCE_READY_POLL_MS, undefined, { ref: false })
    }
    return false
  })()
  return Object.assign(async () => {
    disposed = true
    clearInterval(timer)
    await pending
    await rm(lease, { force: true })
    await rm(readyMarker, { force: true })
  }, { ready, sync: () => sync(false) })
}
