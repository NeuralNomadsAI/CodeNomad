import type { MissionMap } from "../../../server/src/api-types"
import { missionReports, missionTaskReport } from "./mission-progress-model"

export function missionBriefingFreshness(mission: MissionMap) {
  const value = mission.briefing
  if (!value) return { results: 0, changed: false }
  return { results: missionReports(mission).filter(report => report.createdAt > value.basedOnUpdatedAt && !report.late
    && mission.tasks.some(task => missionTaskReport(mission, task)?.id === report.id)).length,
    changed: mission.revision > value.basedOnRevision + 1 }
}
