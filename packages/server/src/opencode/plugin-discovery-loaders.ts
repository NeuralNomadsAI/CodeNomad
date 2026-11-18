import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"

/** More children than this in one plugin(s)/ folder makes the listing uncertain. */
export const DISCOVERY_MAX_CHILDREN = 256

// Native module resolution infers these extensions for a directory's `server`/`index` entrypoint.
const ENTRYPOINT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]

/**
 * Whether `file` is the entrypoint native discovery loads for the plugin(s)/ folder child `child`
 * (`plugin/source-directory.ts`, `plugin/host.ts`): a `.ts`/`.js` file child loads as itself, a directory child through
 * its `server` or `index` module. Other resolutions (package `main`, nested `server/index`, any deeper module) are not
 * counted. The single rule for positive writes and for mapping discovery children to inventory.
 */
export function discoveryEntrypointOf(paths: path.PlatformPath, child: string, file: string): boolean {
  const relative = paths.relative(child, file)
  if (relative === "") return child.endsWith(".ts") || child.endsWith(".js")
  if (relative.startsWith("..") || paths.isAbsolute(relative) || /[\\/]/.test(relative)) return false
  const extension = paths.extname(relative)
  return ENTRYPOINT_EXTENSIONS.includes(extension) && ["server", "index"].includes(relative.slice(0, -extension.length))
}

/**
 * What native discovery could load from the reported plugin(s)/ folders (`plugin/source-directory.ts`): one entry per
 * immediate child it would examine, holding the plugin IDs that child provably maps to (an inventory entry or a
 * verified descriptor inside it, after resolving links). An empty list is an unclassified child that may load any ID.
 * `undefined` when a folder cannot be listed with certainty (unmapped path, read error, too many children).
 * Host file system only: one bounded `readdir` per folder, one `stat` per symlinked child, read-only.
 */
export async function discoveryLoaders(input: {
  folders: readonly string[]
  hostPath: (servicePath: string) => Promise<string | undefined>
  inventory: ReadonlyArray<{ id: string; path: string }>
  managedIds: (serviceChild: string) => readonly string[]
  serviceJoin: (folder: string, name: string) => string
}): Promise<string[][] | undefined> {
  const resolved = async (file: string) => realpath(file).catch(() => file)
  const inventory = await Promise.all(input.inventory.map(async entry => {
    const host = await input.hostPath(entry.path)
    return host ? { id: entry.id, path: host, real: await resolved(host) } : undefined
  }))
  const loaders: string[][] = []
  for (const folder of input.folders) {
    const hostFolder = await input.hostPath(folder)
    if (!hostFolder) return undefined
    let children
    try {
      children = await readdir(hostFolder, { withFileTypes: true })
    } catch (error) {
      // An absent folder discovers nothing, as natively.
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue
      return undefined
    }
    if (children.length > DISCOVERY_MAX_CHILDREN) return undefined
    for (const child of children) {
      const hostChild = path.join(hostFolder, child.name)
      const source = child.name.endsWith(".ts") || child.name.endsWith(".js")
      let candidate = child.isDirectory() || (child.isFile() && source)
      if (child.isSymbolicLink()) {
        // Native discovery follows the link: a source file or a directory loads, anything else is skipped.
        candidate = await stat(hostChild).then(info => info.isDirectory() || (source && info.isFile()), () => false)
      }
      if (!candidate) continue
      // An inventory entry identifies the child only when it is the very entrypoint discovery loads for it (as named,
      // or after resolving links and junctions); a nested or sibling module leaves the child unclassified.
      const real = await resolved(hostChild)
      const ids = new Set(input.managedIds(input.serviceJoin(folder, child.name)))
      for (const entry of inventory) {
        if (entry && (discoveryEntrypointOf(path, hostChild, entry.path) || discoveryEntrypointOf(path, real, entry.real))) ids.add(entry.id)
      }
      loaders.push([...ids])
    }
  }
  return loaders
}
