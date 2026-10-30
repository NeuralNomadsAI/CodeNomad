import path from "node:path"
import type { PluginControlDocument } from "./plugin-control-document"
import { readNativeSetting } from "./native-setting-document"

// OpenCode reads most `experimental` options from the whole `experimental` object of the
// highest-priority configuration document that has one, without merging documents.

export type Entry = { type: string; path?: string; info?: { experimental?: Record<string, unknown> } }

const pathsFor = (value: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) ? path.win32 : path.posix
export function samePath(left: string, right: string) {
  const paths = pathsFor(left)
  const normalize = (value: string) => paths.normalize(value).replace(/[\\/]$/, "")
  return paths === path.win32 ? normalize(left).toLowerCase() === normalize(right).toLowerCase() : normalize(left) === normalize(right)
}

function contains(ancestor: string, value: string) {
  const paths = pathsFor(value)
  const relative = paths.relative(ancestor, value)
  return relative === "" || !relative.startsWith("..") && !paths.isAbsolute(relative)
}

/** Where `target` sits in native `entries` (lowest priority first): its own entry, else just before its
 * listed directory, as natively. */
function targetOrder(list: Array<Entry | undefined>, target: string): number | undefined {
  const own = list.findIndex(entry => entry?.type === "document" && entry.path !== undefined && samePath(entry.path, target))
  if (own >= 0) return own
  const directory = list.findIndex(entry => entry?.type === "directory" && entry.path !== undefined
    && samePath(entry.path, pathsFor(target).dirname(target)))
  return directory >= 0 ? directory - 0.5 : undefined
}

function lastExperimental(list: Array<Entry | undefined>, order: number): Entry | undefined {
  let masked: Entry | undefined
  list.forEach((entry, index) => {
    if (index < order && entry?.type === "document" && entry.info?.experimental !== undefined) masked = entry
  })
  return masked
}

/** A lower-priority document whose whole `experimental` object a new one in `target` would hide
 * (`entries` lowest priority first). Higher, Location-specific objects are ignored: the Global document
 * also serves Locations without them, and the target's own native entry may be staler than its fresh
 * `targetHasExperimental`. */
export function maskedBy(entries: readonly unknown[], target: string, targetHasExperimental: boolean): Entry | undefined {
  if (targetHasExperimental) return undefined
  const list = entries as Array<Entry | undefined>
  return lastExperimental(list, targetOrder(list, target) ?? list.length)
}

/** Files of `location` and its ancestors and anything under their `.opencode` directories: the project
 * walk OpenCode loads above the Global layer and below content and managed configuration. */
function inProjectWalk(entry: Entry | undefined, location: string) {
  if (entry?.path === undefined) return false
  const paths = pathsFor(entry.path)
  let directory = entry.type === "directory" ? entry.path : paths.dirname(entry.path)
  if (entry.type !== "directory" && contains(directory, location)) return true
  for (; directory !== paths.dirname(directory); directory = paths.dirname(directory))
    if (paths.basename(directory).toLowerCase() === ".opencode") return contains(paths.dirname(directory), location)
  return false
}

/** `maskedBy` for the selected Location's project write `target`, with the Global entry replaced by the
 * fresh Global document (native entries lag behind writes until the watcher reloads). A target without
 * a native entry or listed directory sits at the end of the project walk that follows the Global
 * directory; any entry outside that walk ends it, so an unrecognized layer is never treated as lower. */
export function projectMaskedBy(entries: readonly unknown[], target: string,
  global: { path: string; document: PluginControlDocument } | undefined): Entry | undefined {
  const list = [...entries] as Array<Entry | undefined>
  if (global) {
    let experimental: unknown, readable = true
    try { experimental = global.document.exists ? readNativeSetting(global.document, ["experimental"]) : undefined }
    catch { readable = false }
    const fresh = (entry: Entry | undefined): Entry => ({ type: "document", path: global.path,
      info: { ...entry?.info, experimental: experimental as Record<string, unknown> | undefined } })
    const own = list.findIndex(entry => entry?.type === "document" && entry.path !== undefined && samePath(entry.path, global.path))
    // An unreadable fresh document keeps the native entry.
    if (readable && own >= 0) list[own] = fresh(list[own])
    else if (readable && experimental !== undefined) {
      const order = targetOrder(list, global.path)
      if (order !== undefined) list.splice(Math.ceil(order), 0, fresh(undefined))
    }
  }
  let order = targetOrder(list, target)
  if (order === undefined) {
    const paths = pathsFor(target)
    const parent = paths.dirname(target)
    const location = paths.basename(parent).toLowerCase() === ".opencode" ? paths.dirname(parent) : parent
    const start = !global ? -1 : list.findIndex(entry => entry?.type === "directory" && entry.path !== undefined
      && samePath(entry.path, paths.dirname(global.path)))
    order = start < 0 ? 0 : start + 1
    while (start >= 0 && order < list.length && inProjectWalk(list[order], location)) order++
  }
  return lastExperimental(list, order)
}
