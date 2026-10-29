import { createHash } from "node:crypto"
import path from "node:path"
import type { ConfigEntry } from "@opencode/client"
import { PluginControlDocumentError, type PluginControlDocument } from "./plugin-control-document"
import { editNativeSetting, readNativeSetting, removeEmptyNativeObject } from "./native-setting-document"

export interface MissionExperimentalSettings { schedules?: boolean; subagent_depth?: number }

export function nativeSettingExpectation(document: PluginControlDocument): string {
  return createHash("sha256").update(JSON.stringify([
    document.requestedPath, document.writePath, document.exists, document.mode, document.byteOrderMark, document.text,
  ])).digest("hex")
}

function settings(value: unknown): MissionExperimentalSettings {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PluginControlDocumentError("OpenCode experimental setting must be an object", "invalid")
  const block = value as Record<string, unknown>
  if (block.schedules !== undefined && typeof block.schedules !== "boolean"
    || block.subagent_depth !== undefined && (!Number.isSafeInteger(block.subagent_depth) || Number(block.subagent_depth) < 0))
    throw new PluginControlDocumentError("Invalid Missions experimental setting", "invalid")
  return { ...(block.schedules === undefined ? {} : { schedules: block.schedules as boolean }),
    ...(block.subagent_depth === undefined ? {} : { subagent_depth: block.subagent_depth as number }) }
}

/** Native precedence selects one whole block. Only the two owned keys leave this reader. */
export function effectiveMissionExperimental(entries: readonly ConfigEntry[]) {
  const entry = [...entries].reverse().find(entry => entry.type === "document" && entry.info.experimental !== undefined)
  return entry?.type === "document"
    ? { ...settings(entry.info.experimental), origin: entry.path ?? null }
    : { origin: null }
}

export function readMissionExperimental(document: PluginControlDocument): MissionExperimentalSettings {
  return settings({ schedules: readNativeSetting(document, ["experimental", "schedules"]),
    subagent_depth: readNativeSetting(document, ["experimental", "subagent_depth"]) })
}

/** Native boundaries around a target; both bounds equal its insertion index when absent. */
export function nativeExperimentalTargetPosition(entries: readonly ConfigEntry[], target: string, directory: string): { before: number; after: number } {
  const paths = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(target) ? path.win32 : path.posix
  const same = (a: string, b: string) => paths === path.win32
    ? paths.normalize(a).toLowerCase() === paths.normalize(b).toLowerCase() : paths.normalize(a) === paths.normalize(b)
  let position = entries.findIndex(entry => entry.type === "document" && entry.path && same(entry.path, target))
  const present = position >= 0
  if (position < 0) position = entries.findIndex(entry => entry.type === "directory" && same(entry.path, paths.dirname(target)))
  if (position < 0 && paths.basename(paths.dirname(target)) === ".opencode"
    && same(paths.dirname(paths.dirname(target)), directory)) {
    // A new active-location .opencode layer follows every ancestor/direct project layer,
    // and precedes inline/managed settings. Unknown placement fails closed.
    const ancestor = (root: string) => {
      const relative = paths.relative(root, directory)
      return relative === "" || relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
    }
    position = entries.reduce((last, entry, index) => {
      if (!entry.path) return last
      const parent = entry.type === "directory" ? entry.path : paths.dirname(entry.path)
      const root = paths.basename(parent) === ".opencode" ? paths.dirname(parent) : parent
      return ancestor(root) ? index + 1 : last
    }, -1)
    // Even an empty project inherits the discovered global configuration directory.
    if (position < 0) {
      const global = entries.findIndex(entry => entry.type === "directory")
      if (global >= 0) position = global + 1
    }
  }
  if (position < 0) throw new PluginControlDocumentError("OpenCode configuration precedence is unknown", "invalid")
  return { before: position, after: position + (present ? 1 : 0) }
}

export function inheritedMissionExperimental(entries: readonly ConfigEntry[], target: string, directory: string): MissionExperimentalSettings {
  const position = nativeExperimentalTargetPosition(entries, target, directory)
  const { origin: _origin, ...inherited } = effectiveMissionExperimental(entries.slice(0, position.before))
  return inherited
}

/** Both authors use one JSONC edit under the existing physical-file lock/byte expectation. */
export function editMissionExperimental(
  document: PluginControlDocument,
  key: keyof MissionExperimentalSettings,
  value: boolean | number | undefined,
  inherited: MissionExperimentalSettings,
  scope: "global" | "project" = "project",
): string {
  // Check both paths for duplicates even when only their companion is being edited.
  const local = readMissionExperimental(document)
  if (scope === "project" && key === "schedules" && value === true && local.schedules === false)
    throw new PluginControlDocumentError("OpenCode schedules are explicitly disabled in this document", "conflict")
  settings({ [key]: value })
  let current = document
  const apply = (field: keyof MissionExperimentalSettings, next: unknown) => {
    const updated = editNativeSetting(current, ["experimental", field], next)
    current = { ...current, text: current.byteOrderMark ? updated.slice(1) : updated }
  }
  if (key === "subagent_depth" && local.schedules === undefined && inherited.schedules === true) {
    const block = readNativeSetting(document, ["experimental"])
    // Removing the sole depth exposes inheritance directly; a remaining block
    // still shadows it and needs the same companion preservation as a save.
    if (value !== undefined || block && Object.keys(block).some(field => field !== "subagent_depth")) apply("schedules", true)
  }
  if (key === "schedules" && readNativeSetting(document, ["experimental"]) === undefined
    && local.subagent_depth === undefined && inherited.subagent_depth !== undefined)
    apply("subagent_depth", inherited.subagent_depth)
  apply(key, value)
  return removeEmptyNativeObject(current, ["experimental"])
    ?? `${current.byteOrderMark ? "\uFEFF" : ""}${current.text}`
}
