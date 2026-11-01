import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile, utimes } from "node:fs/promises"
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
import { installDesktopPluginArtifact } from "./desktop-plugin-artifact"
import type { NativeScheduleCarrierInstallation } from "./missions/native-schedule-carrier-binding"

export type DesktopMissionArtifacts = Readonly<Pick<NativeScheduleCarrierInstallation, "provider" | "runtime">>

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
  const arguments_: unknown[] = JSON.parse(`[${match[2]}]`)
  if (!arguments_.length || arguments_.length > 2) throw new Error("Invalid managed CodeNomad plugin arguments")
  const [argument, artifacts] = arguments_
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
  if (arguments_.length === 2) {
    if (feature !== "missions" || !artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)
      || Object.keys(artifacts).sort().join(",") !== "provider,runtime") throw new Error("Invalid managed Missions artifacts")
    for (const role of ["provider", "runtime"] as const) {
      const artifact = (artifacts as DesktopMissionArtifacts)[role]
      if (!artifact || Object.keys(artifact).sort().join(",") !== "file,sha256"
        || typeof artifact.file !== "string" || typeof artifact.sha256 !== "string" || !/^[a-f\d]{64}$/.test(artifact.sha256)
        || nativePaths.dirname(artifact.file) !== nativeDirectory
        || nativePaths.basename(artifact.file) !== `${artifact.sha256}${role === "provider" ? ".provider" : ""}.mjs`
        || role === "runtime" && artifact.file !== plugin) throw new Error("Invalid managed Missions artifacts")
      if (paths.nativeData) assertNativePluginPath(artifact.file)
    }
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
  providerBundle?: Uint8Array,
) {
  assertCurrent()
  if (providerBundle && feature !== "missions") throw new Error("Local carrier provider requires Missions")
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
  const providerHash = providerBundle && createHash("sha256").update(providerBundle).digest("hex")
  const nativePlugin = paths.nativeData ? path.posix.join(nativeDirectory, `${hash}.mjs`) : plugin
  const artifacts: DesktopMissionArtifacts | undefined = providerHash ? Object.freeze({
    provider: Object.freeze({ file: (paths.nativeData ? path.posix : path).join(nativeDirectory, `${providerHash}.provider.mjs`), sha256: providerHash }),
    runtime: Object.freeze({ file: nativePlugin, sha256: hash }),
  }) : undefined
  const source = `${marker}import { desktopPlugin } from ${JSON.stringify(pluginUrl)}\nexport default desktopPlugin(${JSON.stringify(presenceDirectories.length === 1 ? nativeLeases : presenceDirectories)}${artifacts ? `, ${JSON.stringify(artifacts)}` : ""})\n`
  await mkdir(leases, { recursive: true })
  assertCurrent()
  await mkdir(path.dirname(entry), { recursive: true })
  assertCurrent()
  // Immutable, content-addressed payloads keep running instances independent of upgrades.
  const assertRuntimePath = await installDesktopPluginArtifact(plugin, bundle, hash, assertCurrent)
  assertCurrent()
  const assertProviderPath = providerBundle && providerHash
    ? await installDesktopPluginArtifact(path.join(directory, `${providerHash}.provider.mjs`), providerBundle, providerHash, assertCurrent)
    : undefined
  const assertBundlePath = async () => { await assertRuntimePath(); await assertProviderPath?.() }
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
        assertCurrent()
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
