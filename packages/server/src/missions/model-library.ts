import { parseMissionProfiles, sameMissionProfiles, validateMissionProfiles, type MissionProfiles } from "./playbook-profiles"
import type { MissionTemplateId } from "./model"
import type { MissionTaskMode } from "./task-execution-mode"
import { MISSION_TITLE_MAX } from "./mission-title"

/** A reusable user brief, independent of execution. */
export interface UserMissionModel {
  version: 1
  id: string
  name: string
  objective: string
  notes: string
  template: MissionTemplateId
  profiles?: MissionProfiles
  taskMode?: MissionTaskMode
}

export const MAX_MISSION_MODELS = 20
const fields = ["version", "id", "name", "objective", "notes", "template", "profiles", "taskMode"]
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseMissionModel(input: unknown): UserMissionModel {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid mission model")
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !fields.includes(key)) || value.version !== 1
    || typeof value.id !== "string" || !uuid.test(value.id)
    || typeof value.name !== "string" || !value.name.trim() || value.name.length > 80
    || typeof value.objective !== "string" || !value.objective.trim() || value.objective.length > 20_000
    || typeof value.notes !== "string" || value.notes.length > 20_000
    || !["custom", "debug", "wayfinder", "delivery", "compare"].includes(value.template as string)
    || (value.taskMode !== undefined && !["native", "independent"].includes(value.taskMode as string))) throw new Error("Invalid mission model")
  const template = value.template as MissionTemplateId
  const profiles = parseMissionProfiles(value.profiles)
  validateMissionProfiles(template, profiles)
  return { version: 1, id: value.id, name: value.name.trim(), objective: value.objective.trim(), notes: value.notes, template,
    ...(profiles === undefined ? {} : { profiles }), ...(value.taskMode === undefined ? {} : { taskMode: value.taskMode as MissionTaskMode }) }
}

export function normalizeMissionModels(input: unknown): UserMissionModel[] {
  if (!Array.isArray(input) || input.length > MAX_MISSION_MODELS) return []
  try {
    const models = input.map(parseMissionModel)
    return new Set(models.map(model => model.id)).size === models.length ? models : []
  } catch { return [] }
}

export function validMissionModels(input: unknown): boolean {
  return input === undefined || (Array.isArray(input) && (input.length === 0 || normalizeMissionModels(input).length === input.length))
}

export function saveMissionModelRecord(current: readonly UserMissionModel[], input: UserMissionModel): UserMissionModel[] {
  const model = parseMissionModel(input)
  if (!current.some(item => item.id === model.id) && current.length >= MAX_MISSION_MODELS) throw new Error("Mission model limit reached")
  return [...current.filter(item => item.id !== model.id).map(parseMissionModel), model]
}

export function removeMissionModelRecord(current: readonly UserMissionModel[], id: string): UserMissionModel[] {
  return current.filter(item => item.id !== id).map(parseMissionModel)
}

/** Match the editor's title prefill without changing the saved name. */
export function missionConfigurationTitle(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MISSION_TITLE_MAX).replace(/[\uD800-\uDBFF]$/, "").trimEnd()
}

export function sameMissionModel(left?: UserMissionModel, right?: UserMissionModel): boolean {
  if (!left || !right) return left === right
  return left.version === right.version && left.id === right.id && left.name === right.name
    && left.objective === right.objective && left.notes === right.notes && left.template === right.template
    && left.taskMode === right.taskMode && sameMissionProfiles(left.profiles, right.profiles)
}
