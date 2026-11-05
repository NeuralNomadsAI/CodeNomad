import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readDesktopPluginFile } from "./desktop-plugin-artifact"
import { assertNativePluginPath } from "./desktop-plugin-wsl-paths"

export interface ManagedDesktopPlugin {
  entry: string
  plugin: string
  ids: readonly string[]
}

/** Parse only the installer's generated shim, including retained outside-root storage. */
export function parseManagedDesktopPluginEntry(feature: string, source: string, paths: path.PlatformPath) {
  const marker = `// Managed by CodeNomad: ${feature.replaceAll("-", " ")} lifecycle v1\n`
  if (!source.startsWith(marker)) return undefined
  const match = /^import \{ desktopPlugin \} from ("(?:[^"\\]|\\.)*")\nexport default desktopPlugin\((.+)\)\n$/.exec(source.slice(marker.length))
  if (!match) throw new Error("Invalid managed CodeNomad plugin entry")
  const url = new URL(JSON.parse(match[1]) as string)
  const arguments_: unknown[] = JSON.parse(`[${match[2]}]`)
  if (!arguments_.length || arguments_.length > 2) throw new Error("Invalid managed CodeNomad plugin arguments")
  const [argument, artifacts] = arguments_
  const presenceDirectories = typeof argument === "string" ? [argument] : argument
  if (!Array.isArray(presenceDirectories) || !presenceDirectories.length || presenceDirectories.length > 8
    || !presenceDirectories.every(directory => typeof directory === "string" && paths.isAbsolute(directory)
      && !directory.includes("\0") && paths.basename(directory) === "presence"
      && paths.basename(paths.dirname(directory)) === feature)) throw new Error("Invalid managed CodeNomad plugin presence")
  const nativeDirectory = paths.dirname(presenceDirectories[0] as string)
  const plugin = fileURLToPath(url, { windows: paths === path.win32 })
  if (url.protocol !== "file:" || url.search || url.hash || (paths === path.posix && url.hostname)
    || paths.dirname(plugin) !== nativeDirectory || !/^[a-f\d]{64}\.mjs$/.test(paths.basename(plugin))) {
    throw new Error("Invalid managed CodeNomad plugin storage")
  }
  if (paths === path.posix) {
    assertNativePluginPath(plugin)
    for (const directory of presenceDirectories) assertNativePluginPath(directory)
  }
  if (arguments_.length === 2) {
    if (feature !== "missions" || !artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)
      || Object.keys(artifacts).sort().join(",") !== "provider,runtime") throw new Error("Invalid managed Missions artifacts")
    for (const role of ["provider", "runtime"] as const) {
      const artifact = (artifacts as Record<string, { file: string; sha256: string }>)[role]
      if (!artifact || Object.keys(artifact).sort().join(",") !== "file,sha256"
        || typeof artifact.file !== "string" || typeof artifact.sha256 !== "string" || !/^[a-f\d]{64}$/.test(artifact.sha256)
        || paths.dirname(artifact.file) !== nativeDirectory
        || paths.basename(artifact.file) !== `${artifact.sha256}${role === "provider" ? ".provider" : ""}.mjs`
        || role === "runtime" && artifact.file !== plugin) throw new Error("Invalid managed Missions artifacts")
      if (paths === path.posix) assertNativePluginPath(artifact.file)
    }
  }
  return { plugin, nativeDirectory, presenceDirectories: presenceDirectories as string[] }
}

// The publication build places IDs in the hashed payload. Discovery never imports executable code.
function desktopPluginIds(bundle: Uint8Array): readonly string[] {
  const header = Buffer.from(bundle.subarray(0, 4096)).toString("utf8").split("\n", 1)[0]
  const prefix = "// CodeNomad plugin IDs: "
  if (!header.startsWith(prefix)) return []
  try {
    const ids: unknown = JSON.parse(header.slice(prefix.length))
    return Array.isArray(ids) && ids.length <= 32 && ids.every(id => typeof id === "string" && id.length > 0
      && id.length <= 256 && id === id.trim() && !id.startsWith("-") && !/[*\x00-\x1f\x7f]/.test(id))
      ? [...new Set(ids)] : []
  } catch { return [] }
}

export function managedDesktopPluginForSource(installations: readonly ManagedDesktopPlugin[], source: string, paths: path.PlatformPath) {
  try {
    const local = /^file:/i.test(source) ? fileURLToPath(source, { windows: paths === path.win32 }) : source
    if (!paths.isAbsolute(local) || /[\x00-\x1f\x7f]/.test(local)) return undefined
    const normalize = (value: string) => paths === path.win32 ? paths.normalize(value).toLowerCase() : paths.normalize(value)
    const identity = normalize(local)
    return installations.find(entry => normalize(entry.entry) === identity || normalize(entry.plugin) === identity)
  } catch { return undefined }
}

/** Read only the authenticated daemon's discovery root; map paths only for filesystem IO. */
export async function readManagedDesktopPlugins(options: {
  globalDirectory: string
  paths: path.PlatformPath
  hostPath(nativePath: string): Promise<string | undefined>
  assertCurrent(): void
}): Promise<ManagedDesktopPlugin[]> {
  const directory = options.paths.join(options.globalDirectory, "plugins")
  const hostDirectory = await options.hostPath(directory)
  if (!hostDirectory) return []
  const names = await readdir(hostDirectory).catch(() => [])
  const result: ManagedDesktopPlugin[] = []
  for (const name of names) {
    const match = /^codenomad-([a-z][a-z0-9-]*)\.ts$/.exec(name)
    if (!match) continue
    try {
      options.assertCurrent()
      const source = await readDesktopPluginFile(path.join(hostDirectory, name), 64 * 1024)
      if (!source) continue
      const parsed = parseManagedDesktopPluginEntry(match[1], source.toString("utf8"), options.paths)
      if (!parsed) continue
      // Translate the directory only: wslpath/realpath can dereference a final file symlink.
      const hostStorage = await options.hostPath(options.paths.dirname(parsed.plugin))
      if (!hostStorage) continue
      const bundle = await readDesktopPluginFile(path.join(hostStorage, options.paths.basename(parsed.plugin)), 32 * 1024 * 1024)
      if (!bundle || createHash("sha256").update(bundle).digest("hex") !== options.paths.basename(parsed.plugin, ".mjs")) continue
      result.push({ entry: options.paths.join(directory, name), plugin: parsed.plugin, ids: desktopPluginIds(bundle) })
    } catch { /* Unproven files retain ordinary plugin visibility. */ }
  }
  options.assertCurrent()
  return result
}
