import type { MissionPanelMap } from "../../../server/src/api-types"
import { missionBodyPresent } from "../lib/mission-bodies"
import { missionReports, missionTaskReport } from "./mission-progress-model"

/** Whether a map's overview shows its briefing: one is recorded and the map has no summary. */
export function missionBriefed(mission: MissionPanelMap | undefined): boolean {
  return Boolean(mission?.briefing) && !missionBodyPresent(mission, { kind: "mission", field: "summary" }, "text")
}

export function missionBriefingFreshness(mission: MissionPanelMap) {
  const value = mission.briefing
  if (!value) return { results: 0, changed: false }
  return { results: missionReports(mission).filter(report => report.createdAt > value.basedOnUpdatedAt && !report.late
    && mission.tasks.some(task => missionTaskReport(mission, task)?.id === report.id)).length,
    changed: mission.revision > value.basedOnRevision + 1 }
}
