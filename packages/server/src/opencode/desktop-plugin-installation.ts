import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile, utimes } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PRESENCE_INTERVAL_MS } from "./desktop-plugin-presence"
import { isLegacyAutomationPlugin } from "./automation-plugin"
import { assertNativePluginPath, type DesktopPluginNativePath } from "./desktop-plugin-wsl-paths"

export interface DesktopPluginPaths {
  config: string
  data: string
  // WSL entries use Linux paths; filesystem I/O uses translated drive/UNC paths.
  nativeData?: string
  resolveNativePath?: (directory: string, assertCurrent: () => void) => Promise<DesktopPluginNativePath>
}
export type DesktopPluginFeature = "session-pruning" | "automation"

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

export async function installDesktopPluginPresence(
  feature: DesktopPluginFeature,
  bundle: Uint8Array,
  paths: DesktopPluginPaths,
  assertCurrent: () => void = () => {},
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
  await writeFile(plugin, bundle, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  assertCurrent()
  const lease = path.join(leases, `${randomUUID()}.lease`)
  try {
    await writeFile(lease, "")
    assertCurrent()
    if (existing !== source) {
      const temporary = `${entry}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, source)
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
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      const now = new Date()
      await utimes(lease, now, now)
    }).catch(() => {})
  }, PRESENCE_INTERVAL_MS)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await pending
    await rm(lease, { force: true })
  }
}
