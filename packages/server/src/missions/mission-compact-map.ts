import { missionDecisionMaker } from "./decision-artifact"
import { describeMissionBodies } from "./mission-body-descriptors"
import { MISSION_BODY_FIELDS } from "./mission-content-wire"
import { MISSION_BRIEFING_CONTENT, isFullMissionMap, missionExcerpt, type MissionPanelExecutionMode, type MissionPanelMap,
  type MissionPanelReport } from "./mission-panel-map"
import { missionObjectiveLabel } from "./mission-summary"
import type { MissionMap, MissionReport, MissionTaskExecutionMode } from "./model"

/** A copy of `owner` without `fields`; every other field, unknown ones included, stays. */
function without<T extends object, K extends keyof T>(owner: T, fields: readonly K[]): Omit<T, K> {
  const copy: Partial<T> = { ...owner }
  for (const field of fields) delete copy[field]
  return copy as Omit<T, K>
}

/** `map` as the list and mission reads return it: each body field (`MISSION_BODY_FIELDS`)
 * dropped beside its descriptor (`describeMissionBodies`, unless the map carries them),
 * with in their place what the panel shows without bodies: the objective's label, report
 * rows with a summary excerpt and who settled a decision, the briefing's identity, an
 * independent mode's reason with an explanation excerpt, and plan changes with a reason
 * excerpt. A copy: the map passed is unchanged, and a compact map is returned as it is. */
export function compactMissionMap(map: MissionMap | MissionPanelMap): MissionPanelMap {
  if (!isFullMissionMap(map)) return map
  const described = map.bodies ? map : describeMissionBodies(map)
  const tasks = new Map(described.tasks.map(task => [task.key, task]))
  const report = (value: MissionReport): MissionPanelReport => {
    const decidedBy = missionDecisionMaker(described.template, tasks.get(value.taskKey), value)
    return { ...without(value, MISSION_BODY_FIELDS.report), excerpt: missionExcerpt(value.summary), ...(decidedBy ? { decidedBy } : {}) }
  }
  const mode = (value: MissionTaskExecutionMode): MissionPanelExecutionMode => value.kind === "independent"
    ? { ...without(value, ["explanation"]), excerpt: missionExcerpt(value.explanation) } : value
  return {
    ...without(described, MISSION_BODY_FIELDS.mission),
    excerpt: missionObjectiveLabel(described.objective),
    ...(described.briefing ? { briefing: without(described.briefing, MISSION_BRIEFING_CONTENT) } : {}),
    tasks: described.tasks.map(task => ({ ...without(task, MISSION_BODY_FIELDS.task),
      ...(task.executionMode ? { executionMode: mode(task.executionMode) } : {}),
      ...(task.report ? { report: report(task.report) } : {}),
      ...(task.lateReports ? { lateReports: task.lateReports.map(report) } : {}) })),
    reports: described.reports.map(report),
    history: described.history.map(change => ({ ...without(change, MISSION_BODY_FIELDS.change),
      ...(change.reason === undefined ? {} : { excerpt: missionExcerpt(change.reason) }) })),
  }
}

/** `read` with its maps compact (`compactMissionMap`): what the list and mission reads return. */
export function compactMissionReads<T extends { missions: readonly (MissionMap | MissionPanelMap)[] }>(read: T): Omit<T, "missions"> & { missions: MissionPanelMap[] } {
  return { ...read, missions: read.missions.map(compactMissionMap) }
}
