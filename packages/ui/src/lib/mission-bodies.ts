import type { MissionPanelMap } from "../../../server/src/api-types"
import { missionBodyDescriptor, type MissionContentSelector } from "../../../server/src/missions/mission-content-wire"
import { isFullMissionMap } from "../../../server/src/missions/mission-panel-map"

/** A body field of the owner at `selector`, from a full map (a passage's own) only: the
 * compact maps of one-time missions carry none, and their readers read it. */
export function missionOwnBody<T>(mission: MissionPanelMap | undefined, selector: MissionContentSelector): T | undefined {
  if (!mission || !isFullMissionMap(mission)) return undefined
  const owner: object | undefined = selector.kind === "mission" ? mission
    : selector.kind === "task" ? mission.tasks.find(task => task.key === selector.taskKey)
    : selector.kind === "report" ? mission.reports.find(report => report.id === selector.reportId)
    : mission.history.find(change => change.revision === selector.change)
  return owner && (owner as Record<string, unknown>)[selector.field] as T | undefined
}

/** Whether `mission` records a body at `selector` that a section shows: a text with
 * characters, a list with items, or any other value. A compact map answers from the
 * body's descriptor (`characters` of its text, a list's JSON brackets included); a
 * passage's full map from its own value. */
export function missionBodyPresent(mission: MissionPanelMap | undefined, selector: MissionContentSelector, shape: "text" | "list" | "value"): boolean {
  if (!mission) return false
  if (isFullMissionMap(mission)) {
    const value = missionOwnBody<unknown>(mission, selector)
    return shape === "text" ? Boolean(value) : shape === "list" ? Array.isArray(value) && value.length > 0 : value !== undefined
  }
  const descriptor = missionBodyDescriptor(mission, selector)
  return descriptor !== undefined && (shape === "text" ? descriptor.characters > 0 : shape === "list" ? descriptor.characters > 2 : true)
}
