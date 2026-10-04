import type { MissionSnapshot } from "../../missions/model"
import { hasUnsettledNativeExecution } from "../../missions/native-call-observation"
import { isCoordinatorNotificationReport } from "../../missions/native-report-provenance"

/** Presence is not mission completion, nor permission to replay any effect. */
export function missionWorkRemains(snapshot: MissionSnapshot): boolean {
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable
    || snapshot.cleanupUnavailable) return true
  if (snapshot.cleanups?.some(cleanup => cleanup.pending > 0)) return true
  return snapshot.missions.some(mission => mission.status === "active"
    || mission.controlUnavailable || mission.notificationUnavailable
    || Boolean(mission.control?.pending.length)
    || mission.tasks.some(task => task.outstandingExecution || hasUnsettledNativeExecution(task))
    || mission.reports.some(report => isCoordinatorNotificationReport(report) && report.notificationStatus === "pending"))
}

/** Unknown storage must not tear down executors captured by native work. */
export async function retainMissionWork(read: () => Promise<MissionSnapshot>): Promise<boolean> {
  try { return missionWorkRemains(await read()) }
  catch { return true }
}
