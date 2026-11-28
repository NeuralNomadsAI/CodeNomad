import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"

/** More children than this in one plugin(s)/ folder, or entries in one child folder, makes the listing uncertain. */
export const DISCOVERY_MAX_CHILDREN = 256

// The extensions the Node resolver infers, in its order (`util/src/runtime/import.node.ts`). Only a selection that
// every runtime makes alike is mirrored: Bun's resolver has its own order and directory rules.
const ENTRYPOINT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]

/**
 * Whether `file`'s shape could be the entrypoint native discovery loads for the plugin(s)/ folder child `child`: the
 * `.ts`/`.js` file child itself, or a `server`/`index` module directly in a directory child. A cheap filter for
 * display; write decisions compare with `discoveryEntrypointOf`'s single selection.
 */
export function discoveryEntrypointShape(paths: path.PlatformPath, child: string, file: string): boolean {
  const relative = paths.relative(child, file)
  if (relative === "") return child.endsWith(".ts") || child.endsWith(".js")
  if (escapes(paths, relative) || /[\\/]/.test(relative)) return false
  const extension = paths.extname(relative)
  return ENTRYPOINT_EXTENSIONS.includes(extension) && ["server", "index"].includes(relative.slice(0, -extension.length))
}

/** Whether a `path.relative` result leaves its base: `..` as a whole segment, or another root. */
export function escapes(paths: path.PlatformPath, relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${paths.sep}`) || relative.startsWith("../") || paths.isAbsolute(relative)
}

/**
 * The single entrypoint native discovery loads for the host plugin(s)/ folder child `child` (`plugin/source-directory.ts`,
 * `config/plugin/source.ts`): a `.ts`/`.js` file child loads as itself; a directory child through `selectedEntrypoint`.
 * `null` only when discovery provably skips the child: a dangling link, a file child without a `.ts`/`.js` name, an
 * entry that is neither file nor directory, or a folder `selectedEntrypoint` proves empty. Every doubt is `undefined`.
 */
export async function discoveryEntrypointOf(child: string): Promise<string | null | undefined> {
  const name = path.basename(child)
  let info
  try {
    info = await stat(child)
  } catch (error) {
    // A dangling link is skipped natively; any other failure is uncertain.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined
  }
  if (info.isFile()) return name.endsWith(".ts") || name.endsWith(".js") ? child : null
  if (!info.isDirectory()) return null
  return selectedEntrypoint(child)
}

/**
 * The single entrypoint an explicit local declaration loads (`config/plugin/source.ts`): only a directory loads,
 * through `selectedEntrypoint`; a file target is dropped ("configured plugin path must be a directory"), and a missing
 * path or an entry that is neither defines nothing. `null`: it defines no plugin; `undefined`: uncertain.
 */
export async function declaredEntrypointOf(target: string): Promise<string | null | undefined> {
  let info
  try {
    info = await stat(target)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined
  }
  return info.isDirectory() ? selectedEntrypoint(target) : null
}

/**
 * The single entrypoint `Host.resolve({ directory })` selects (`plugin/host.ts`, no package `main`): `server` before
 * `index`. The one resolver for discovered folder children and explicit local declarations. `null` only for a folder
 * with no entry whose name could resolve as `server`/`index` in any letter case. Every doubt is `undefined`: a read
 * error, a candidate group other than exactly one `server.<ext>` (else `index.<ext>`) with a Node-inferred extension
 * and the exact name, a candidate that is not a regular file, or one resolving outside the folder.
 */
export async function selectedEntrypoint(directory: string): Promise<string | null | undefined> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return undefined
  }
  if (entries.length > DISCOVERY_MAX_CHILDREN) return undefined
  for (const base of ["server", "index"]) {
    // Case-insensitive file systems resolve `Server.js` for `server`: any letter case counts as a candidate.
    const found = entries.filter(entry => entry.name.toLowerCase() === base || entry.name.toLowerCase().startsWith(`${base}.`))
    if (found.length === 0) continue
    const [only] = found
    const extension = path.extname(only!.name)
    if (found.length > 1 || only!.name !== `${base}${extension}` || !ENTRYPOINT_EXTENSIONS.includes(extension)) return undefined
    const file = path.join(directory, only!.name)
    try {
      if (!(await stat(file)).isFile()) return undefined
      // Native loading drops a folder whose entrypoint resolves outside it; not mirrored exactly, so it is uncertain.
      const [root, server] = await Promise.all([realpath(directory), realpath(file)])
      return escapes(path, path.relative(root, server)) ? undefined : file
    } catch {
      return undefined
    }
  }
  return null
}

/**
 * What native discovery could load from the reported plugin(s)/ folders: one entry per immediate child it would
 * load, holding the plugin IDs that child provably maps to: inventory entries reporting exactly its selected
 * entrypoint (as named or after resolving links and junctions), and verified descriptors. An empty list is an
 * unclassified child that may load any ID. `undefined` when a folder cannot be listed with certainty (unmapped path,
 * read error, too many children). Host file system only, read-only and bounded.
 */
export async function discoveryLoaders(input: {
  folders: readonly string[]
  hostPath: (servicePath: string) => Promise<string | undefined>
  inventory: ReadonlyArray<{ id: string; path: string }>
  managedIds: (serviceChild: string) => readonly string[]
  serviceJoin: (folder: string, name: string) => string
}): Promise<string[][] | undefined> {
  const resolved = async (file: string): Promise<string> => realpath(file).catch(() => file)
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
      const entrypoint = await discoveryEntrypointOf(path.join(hostFolder, child.name))
      if (entrypoint === null) continue
      if (entrypoint === undefined) { loaders.push([]); continue }
      const ids = new Set(input.managedIds(input.serviceJoin(folder, child.name)))
      for (const entry of await reportingEntries(entrypoint, inventory)) ids.add(entry.id)
      loaders.push([...ids])
    }
  }
  return loaders
}

/** The inventory entries reporting exactly `entrypoint`, as named or after resolving links and junctions. */
export async function reportingEntries<T extends { path: string; real: string }>(entrypoint: string, inventory: ReadonlyArray<T | undefined>): Promise<T[]> {
  const real = await realpath(entrypoint).catch(() => entrypoint)
  return inventory.filter((entry): entry is T => Boolean(entry && (entry.path === entrypoint || entry.real === real)))
}
