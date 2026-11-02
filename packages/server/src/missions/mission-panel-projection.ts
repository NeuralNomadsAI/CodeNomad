import type { MissionMap } from "./model"
import type { MissionPanelPageRequest, MissionPanelPage } from "./mission-panel-wire"
import { missionPanelHeader } from "./mission-panel-header"
import { compactMissionMap, missionPanelReports, missionTaskPage } from "./mission-compact-map"
import { missionPanelPage, missionPanelWindow, missionPanelTextWindow } from "./mission-panel-page"
import { missionActivityContext, activityActorWindow } from "./mission-activity-context"
import { MISSION_ACTIVITY_ACTORS } from "./mission-panel-map"

/** Project one already validated range observation; callers own its identity/lifetime. */
export function projectMissionPanel(mission: MissionMap, request: Exclude<MissionPanelPageRequest, { source: "summaries" | "cleanups" | "marks" }>,
  damage: Required<Pick<MissionPanelPage, "discardedEvents" | "controlUnavailable" | "notificationUnavailable" | "cleanupUnavailable">>,
  extra: Pick<MissionPanelPage, "passage"> = {}) {
  const header = { projectID: mission.projectID, source: request.source, missionID: mission.id, revision: mission.revision, ...damage, ...extra }
  if (request.source === "activity") {
    const context = missionActivityContext(mission, damage)
    if (request.actorOrder !== undefined && request.actorOrder !== context.actorPage.order) return { available: false as const, reason: "changed" as const }
    return missionPanelPage({ ...header, phase: "context" }, [activityActorWindow(context, request.actorOffset ?? 0, MISSION_ACTIVITY_ACTORS)], request.cursor)
  }
  if (request.source === "tasks") {
    const page = missionTaskPage(mission, request.task)
    if (request.task.order !== undefined && request.task.order !== page.taskPage.order) return { available: false as const, reason: "changed" as const }
    return missionPanelPage(header, [page], request.cursor)
  }
  if (request.header) return missionPanelPage({ ...header, header: true }, [missionPanelHeader(mission)], request.cursor)
  const map = request.window ? { ...compactMissionMap(mission), reports: missionPanelReports(mission), claims: mission.claims, frontier: mission.frontier } : compactMissionMap(mission)
  if (request.field === undefined) return missionPanelPage(header, [map], request.cursor)
  if (!Object.prototype.hasOwnProperty.call(map, request.field)) return { available: false as const, reason: "field-not-found" as const }
  const value = request.part ? mission.control?.[request.part] ?? [] : (map as unknown as Record<string, unknown>)[request.field]
  const fieldHeader = { ...header, field: request.field, ...(request.part ? { part: request.part } : {}) }
  if (request.text) return missionPanelTextWindow(fieldHeader, value, request.window!, request.cursor)
  const values = Array.isArray(value) ? value : [value]
  return request.window ? missionPanelWindow(fieldHeader, values, request.window, request.cursor) : missionPanelPage(fieldHeader, values, request.cursor)
}
