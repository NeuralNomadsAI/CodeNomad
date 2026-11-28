import type { MissionMap } from "../../../server/src/missions/model"
import { parseMissionModel, type UserMissionModel } from "../../../server/src/missions/model-library"
export { MAX_MISSION_MODELS, parseMissionModel, normalizeMissionModels, validMissionModels, missionConfigurationTitle, saveMissionModelRecord, removeMissionModelRecord, sameMissionModel, type UserMissionModel } from "../../../server/src/missions/model-library"

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

// Window-memory provenance for the existing uncertain-creation hold. Never sent as
// authority, never persisted, and never looked up again from mutable preferences.
const submittedModels = new Map<string, Readonly<UserMissionModel>>()
export function retainSubmittedMissionModel(requestId: string, model?: UserMissionModel): void {
  if (model && !submittedModels.has(requestId)) submittedModels.set(requestId, Object.freeze(parseMissionModel(model)))
}
export function submittedMissionModel(requestId: string): Readonly<UserMissionModel> | undefined {
  return submittedModels.get(requestId)
}
