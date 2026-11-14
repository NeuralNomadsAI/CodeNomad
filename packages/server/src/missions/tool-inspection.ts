import { NO_TASK_CONVERSATION, type MissionControl } from "./control"
import { MissionControlError } from "./control-error"
import type { MissionInspectInput } from "./control-types"
import type { MissionMap } from "./model"
import { boundedInspection, boundedMissionList, boundedTaskView, inspectionContent, inspectionContentValue, MISSION_TASK_VIEW_FIELDS, type MissionInspectContent } from "./inspect-view"
import { compactMission, compactMissionTask, nativeAssignment } from "./tool-result"

/** Fit inside the owning journal invocation, before a scheduled passage crosses RPC. */
export type MissionToolInspectInput = MissionInspectInput & { taskKey?: string; taskOffset?: number; content?: MissionInspectContent; list?: boolean; listOffset?: number }
export async function missionToolInspection(control: MissionControl, sessionID: string, input: MissionToolInspectInput, operationID: string, catalog?: unknown) {
  if (input.list) return boundedMissionList(await control.listMissions(sessionID), input.listOffset)
  const result = await control.inspect(sessionID, input, operationID)
  const response = input.taskKey === undefined ? result : await observedTaskView(control, sessionID, result.mission, input.taskKey)
  if (catalog !== undefined) Object.assign(response, { catalog })
  const read = input.content
  if (read) {
    if (!result.mission) throw new MissionControlError("No mission is associated with this session", "mission-not-found")
    let value: unknown
    if (read.kind === "task" && (MISSION_TASK_VIEW_FIELDS as readonly string[]).includes(read.field)) {
      const view = await observedTaskView(control, sessionID, result.mission, read.taskKey)
      if (view.revision !== read.revision) throw new Error("Mission changed since this page: read it again from its first page")
      if (!Object.prototype.hasOwnProperty.call(view, read.field)) throw new Error("Mission content unavailable")
      value = view[read.field]
    } else value = inspectionContentValue(result, read)
    return inspectionContent(result.mission.id, read, value)
  }
  return input.taskKey === undefined ? boundedInspection(result, input.taskOffset) : boundedTaskView(response as Record<string, unknown>, result.mission!, input.taskKey)
}

async function observedTaskView(control: MissionControl, sessionID: string, mission: MissionMap | null, taskKey: string): Promise<Record<string, unknown>> {
  const task = mission?.tasks.find(candidate => candidate.key === taskKey)
  if (!mission || !task) throw new MissionControlError(`Mission task not found: ${taskKey}`, "task-not-found")
  const [native, answers] = await Promise.allSettled([control.observeTask(sessionID, mission.id, taskKey), control.decisionCandidates(sessionID, mission.id, taskKey)])
  return { ...compactMission(mission), task: compactMissionTask(task), ...nativeAssignment(mission, task),
    reports: mission.reports.filter(report => report.taskKey === taskKey),
    ...(native.status === "rejected" ? { native: { unknown: true } } : native.value
      ? { native: native.value.sessions.length ? native.value : { ...native.value, note: NO_TASK_CONVERSATION } } : {}),
    ...(answers.status === "rejected" ? { humanAnswers: { unknown: true } } : answers.value ? { humanAnswers: answers.value } : {}) }
}
