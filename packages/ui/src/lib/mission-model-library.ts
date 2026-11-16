import type { MissionMap } from "../../../server/src/missions/model"
import { MAX_MISSION_MODELS, parseMissionModel, type UserMissionModel } from "../../../server/src/missions/model-library"
export { MAX_MISSION_MODELS, parseMissionModel, normalizeMissionModels, validMissionModels, missionConfigurationTitle, type UserMissionModel } from "../../../server/src/missions/model-library"

/** The reusable inputs recorded on an existing one-time Mission, in any status: its
 * current objective and verbatim notes (read from one snapshot, `useRecordedBriefInputs`),
 * template and frozen profiles/task mode. Identity, plan, results and lifecycle state
 * never become part of a brief. */
export function missionRecordedBrief(mission: Pick<MissionMap, "template" | "profiles" | "taskMode">,
  inputs: { objective: string; notes: string }): Omit<UserMissionModel, "version" | "id" | "name"> {
  return { objective: inputs.objective, notes: inputs.notes, template: mission.template,
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
