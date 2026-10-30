import path from "node:path"

// OpenCode reads most `experimental` options from the whole `experimental` object of the
// highest-priority configuration document that has one, without merging documents.

export type Entry = { type: string; path?: string; info?: { experimental?: Record<string, unknown> } }

const pathsFor = (value: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) ? path.win32 : path.posix
export function samePath(left: string, right: string) {
  const paths = pathsFor(left)
  const normalize = (value: string) => paths.normalize(value).replace(/[\\/]$/, "")
  return paths === path.win32 ? normalize(left).toLowerCase() === normalize(right).toLowerCase() : normalize(left) === normalize(right)
}

/** A lower-priority document whose whole `experimental` object a new one in `target` would hide
 * (`entries` lowest priority first; a missing target sits just before its directory, as natively).
 * Higher, Location-specific objects are ignored: the Global document also serves Locations without
 * them, and the target's own native entry may be staler than its fresh `targetHasExperimental`. */
export function maskedBy(entries: readonly unknown[], target: string, targetHasExperimental: boolean): Entry | undefined {
  if (targetHasExperimental) return undefined
  const list = entries as Array<Entry | undefined>
  const own = list.findIndex(entry => entry?.type === "document" && entry.path !== undefined && samePath(entry.path, target))
  const directory = list.findIndex(entry => entry?.type === "directory" && entry.path !== undefined
    && samePath(entry.path, pathsFor(target).dirname(target)))
  const order = own >= 0 ? own : directory >= 0 ? directory - 0.5 : list.length
  let masked: Entry | undefined
  list.forEach((entry, index) => {
    if (index < order && entry?.type === "document" && entry.info?.experimental !== undefined) masked = entry
  })
  return masked
}
