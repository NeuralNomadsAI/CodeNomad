import { createHash } from "node:crypto"
import { PluginControlDocumentError, type PluginControlDocument } from "./plugin-control-document"
import { readNativeSetting } from "./native-setting-document"

export interface MissionExperimentalSettings { [key: string]: unknown; automations?: boolean; schedules?: boolean; subagent_depth?: number }
export const configuredMissionAutomation = (block: MissionExperimentalSettings) => block.automations ?? block.schedules

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
  if (block.automations !== undefined && typeof block.automations !== "boolean"
    || block.schedules !== undefined && typeof block.schedules !== "boolean"
    || block.subagent_depth !== undefined && (!Number.isSafeInteger(block.subagent_depth) || Number(block.subagent_depth) < 0))
    throw new PluginControlDocumentError("Invalid Missions experimental setting", "invalid")
  return { ...block } as MissionExperimentalSettings
}

export function readMissionExperimental(document: PluginControlDocument): MissionExperimentalSettings {
  return settings({ automations: readNativeSetting(document, ["experimental", "automations"]),
    schedules: readNativeSetting(document, ["experimental", "schedules"]),
    subagent_depth: readNativeSetting(document, ["experimental", "subagent_depth"]) })
}
