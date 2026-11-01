import { missionTaskExecutionEvidence } from "./execution-evidence"
import { missionIsRunning } from "./lifecycle-model"
import type { MissionActorEvidence, MissionPanelMap, MissionPanelTask } from "./mission-panel-map"
import { isCoordinatorNotificationReport } from "./native-report-provenance"

/** Server-side aggregate over all tasks, shared by compact-map and activity-context producers. */
export function missionActorEvidence(map: Pick<MissionPanelMap, "status" | "runState" | "reports" | "coordinatorSessionId">,
  tasks: readonly MissionPanelTask[]): MissionActorEvidence {
  const reportOwed = new Set<string>(), callOpen = new Set<string>()
  // A running mission's coordinator owes its final report, unless a report's coordinator notification is pending.
  if (missionIsRunning(map) && !map.reports.some(value => value.notificationStatus === "pending" && isCoordinatorNotificationReport(value))) reportOwed.add(map.coordinatorSessionId)
  for (const task of tasks) {
    if (!task.actorSessionId) continue
    const observed = missionTaskExecutionEvidence(task)
    if (observed.missingReport) reportOwed.add(task.actorSessionId)
    if (observed.nativeCall === "active" || observed.nativeCall === "unknown") callOpen.add(task.actorSessionId)
  }
  return { reportOwed: [...reportOwed], callOpen: [...callOpen] }
}
