import { parseMissionProfiles, validateMissionProfiles, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionMap, MissionTemplateId } from "../../../server/src/missions/model"
import { normalizeStoredTemplateId } from "../../../server/src/missions/template-id"
import type { MissionTaskMode } from "./mission-defaults"

/** A reusable user brief, not an AI model or a saved execution. */
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
    || !["custom", "debug", "wayfinder"].includes(normalizeStoredTemplateId(value.template) as string)
    || (value.taskMode !== undefined && !["native", "independent"].includes(value.taskMode as string))) throw new Error("Invalid mission model")
  const template = normalizeStoredTemplateId(value.template) as MissionTemplateId
  const profiles = parseMissionProfiles(value.profiles)
  validateMissionProfiles(template, profiles)
  return { version: 1, id: value.id, name: value.name.trim(), objective: value.objective.trim(), notes: value.notes, template,
    ...(profiles === undefined ? {} : { profiles }), ...(value.taskMode === undefined ? {} : { taskMode: value.taskMode as MissionTaskMode }) }
}

/** Invalid/oversized documents never become execution inputs. Arrays replace in JSON Merge Patch. */
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

/** The reusable inputs recorded on an existing one-time Mission, in any status:
 * its current objective, verbatim notes, template and frozen profiles/task mode.
 * Identity, plan, results and lifecycle state never become part of a brief. */
export function missionRecordedBrief(mission: Pick<MissionMap, "objective" | "notes" | "template" | "profiles" | "taskMode">): Omit<UserMissionModel, "version" | "id" | "name"> {
  return { objective: mission.objective, notes: mission.notes ?? "", template: mission.template,
    ...(mission.profiles === undefined ? {} : { profiles: structuredClone(mission.profiles) }),
    ...(mission.taskMode === undefined ? {} : { taskMode: mission.taskMode }) }
}

export function saveMissionModelRecord(current: readonly UserMissionModel[], input: UserMissionModel): UserMissionModel[] {
  const model = parseMissionModel(input)
  if (!current.some(item => item.id === model.id) && current.length >= MAX_MISSION_MODELS) throw new Error("Mission model limit reached")
  return [...current.filter(item => item.id !== model.id).map(parseMissionModel), model]
}

export function removeMissionModelRecord(current: readonly UserMissionModel[], id: string): UserMissionModel[] {
  return current.filter(item => item.id !== id).map(parseMissionModel)
}

// Window-memory provenance for the existing uncertain-creation hold. Never sent as
// authority, never persisted, and never looked up again from mutable preferences.
const submittedModels = new Map<string, Readonly<Pick<UserMissionModel, "id" | "name">>>()
export function retainSubmittedMissionModel(requestId: string, model?: Pick<UserMissionModel, "id" | "name">): void {
  if (model && !submittedModels.has(requestId)) submittedModels.set(requestId, Object.freeze({ id: model.id, name: model.name }))
}
export function submittedMissionModel(requestId: string): Readonly<Pick<UserMissionModel, "id" | "name">> | undefined {
  return submittedModels.get(requestId)
}
