import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile, utimes } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PRESENCE_INTERVAL_MS } from "./desktop-plugin-presence"
import { isLegacyAutomationPlugin } from "./automation-plugin"

export interface DesktopPluginPaths {
  config: string
  data: string
  // WSL uses Linux paths in the entry, UNC paths only for host filesystem I/O.
  nativeData?: string
}
export type DesktopPluginFeature = "session-pruning" | "automation"

// Retain the explicitly recorded managed storage on upgrade: another backend
// may still be heartbeating there. Only parse our exact generated entry shape.
function managedStorage(feature: DesktopPluginFeature, existing: string | undefined, marker: string, paths: DesktopPluginPaths) {
  if (!existing?.startsWith(marker)) return undefined
  const match = /^import \{ desktopPlugin \} from ("(?:[^"\\]|\\.)*")\nexport default desktopPlugin\(("(?:[^"\\]|\\.)*")\)\n$/.exec(existing.slice(marker.length))
  if (!match) throw new Error("Invalid managed CodeNomad plugin entry")
  const url = new URL(JSON.parse(match[1]) as string)
  const nativeLeases: string = JSON.parse(match[2])
  const nativePaths = paths.nativeData ? path.posix : path
  const nativeDirectory = nativePaths.dirname(nativeLeases)
  const plugin = paths.nativeData ? decodeURIComponent(url.pathname) : fileURLToPath(url)
  if (url.protocol !== "file:" || url.search || url.hash || (paths.nativeData && url.hostname)
    || !nativePaths.isAbsolute(nativeDirectory) || nativePaths.basename(nativeDirectory) !== feature
    || nativePaths.basename(nativeLeases) !== "presence" || nativePaths.dirname(plugin) !== nativeDirectory
    || !/^[a-f\d]{64}\.mjs$/.test(nativePaths.basename(plugin))) {
    throw new Error("Invalid managed CodeNomad plugin storage")
  }
  if (!paths.nativeData) return { directory: nativeDirectory, nativeDirectory }
  const uncRoot = /^(\\\\wsl(?:\.localhost|\$)\\[^\\]+)/i.exec(paths.config)?.[1]
  if (!uncRoot || nativeDirectory.includes("\\")) throw new Error("Invalid managed WSL plugin storage")
  return { directory: `${uncRoot}${nativeDirectory.replaceAll("/", "\\")}`, nativeDirectory }
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
  const storage = managedStorage(feature, existing, marker, paths)
  const directory = storage?.directory ?? path.join(paths.data, feature)
  const nativeDirectory = storage?.nativeDirectory ?? (paths.nativeData ? path.posix.join(paths.nativeData, feature) : directory)
  const leases = path.join(directory, "presence")
  const nativeLeases = paths.nativeData ? path.posix.join(nativeDirectory, "presence") : leases
  const plugin = path.join(directory, `${hash}.mjs`)
  const nativeUrl = new URL("file:///")
  nativeUrl.pathname = `${nativeDirectory}/${hash}.mjs`
  const pluginUrl = paths.nativeData ? nativeUrl.href : pathToFileURL(plugin).href
  const source = `${marker}import { desktopPlugin } from ${JSON.stringify(pluginUrl)}\nexport default desktopPlugin(${JSON.stringify(nativeLeases)})\n`
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
