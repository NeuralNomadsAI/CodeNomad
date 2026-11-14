import type { MissionIndexHints } from "../../missions/journal-index"
import type { MissionSnapshot } from "../../missions/model"
import { hasUnsettledNativeExecution } from "../../missions/native-call-observation"
import { isCoordinatorNotificationReport } from "../../missions/native-report-provenance"

/** Presence is not mission completion, nor permission to replay any effect. */
export function missionWorkRemains(snapshot: MissionSnapshot): boolean {
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable
    || snapshot.cleanupUnavailable) return true
  if (snapshot.cleanups?.some(cleanup => cleanup.pending > 0 || cleanup.documentPending === true)) return true
  return snapshot.missions.some(mission => mission.status === "active"
    || mission.controlUnavailable || mission.notificationUnavailable
    || Boolean(mission.control?.pending.length)
    || mission.tasks.some(task => task.outstandingExecution || hasUnsettledNativeExecution(task))
    || mission.reports.some(report => isCoordinatorNotificationReport(report) && report.notificationStatus === "pending"))
}

/** Unknown storage must not tear down executors captured by native work. `hinted`
 * (the journal index) may only retain: an empty or failed answer is confirmed by
 * the authoritative `read` before presence is released. */
export async function retainMissionWork(read: () => Promise<MissionSnapshot>, hinted?: () => Promise<boolean>): Promise<boolean> {
  if (await hinted?.().catch(() => false)) return true
  try { return missionWorkRemains(await read()) }
  catch { return true }
}

/** The index's answer for `retainMissionWork`: an open mission, or project damage outside every open one. */
export function hintsShowWork(hints: MissionIndexHints): boolean {
  const { discardedEvents, controlUnavailable, notificationUnavailable, cleanupUnavailable } = hints.aggregate()
  return hints.openIDs().length > 0 || discardedEvents > 0 || controlUnavailable || notificationUnavailable || cleanupUnavailable
}
