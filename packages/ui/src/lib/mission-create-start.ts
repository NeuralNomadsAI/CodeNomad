import type { MissionMap } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { isRejectedLifecycleIntent } from "./mission-lifecycle-request"
import { completedRecurrenceControl, createRecurrenceControlIntent } from "./mission-recurrence-control"
import { instances } from "../stores/instances"
import { missionStore } from "../stores/missions"
import { missionLifecycleIntents, missionLifecycleSource } from "../stores/mission-lifecycle-intents"

export type CreatedStartOutcome = "started" | "not-started" | "uncertain"

/** One explicit start of a just-created one-time Mission, through the same
 * window-scoped intent record as its Start button. A lost reply stays held
 * there (Check status / Retry); this helper never resends. */
export async function startCreatedMission(instanceId: string, mission: MissionMap): Promise<CreatedStartOutcome> {
  const instance = instances().get(instanceId)
  const source = missionLifecycleSource(instanceId, mission, { directory: instance?.folder, proxyPath: instance?.proxyPath,
    projectID: instance?.metadata?.project?.id, snapshotProjectID: missionStore.state(instanceId).projectID })
  const intent = missionLifecycleIntents.reserve(source, mission.id,
    { action: "start", expectedRevision: mission.revision, requestId: crypto.randomUUID() })
  if (!intent || !missionLifecycleIntents.start(intent)) return "not-started"
  let outcome: "acknowledged" | "rejected" | "unknown" = "unknown"
  try {
    const result = await serverApi.controlMission(instanceId, mission.id, intent.input)
    if (result?.mission?.id === mission.id) outcome = "acknowledged"
  } catch (error) {
    if (isRejectedLifecycleIntent(error)) outcome = "rejected"
  } finally { missionLifecycleIntents.finish(intent, outcome) }
  return outcome === "acknowledged" ? "started" : outcome === "rejected" ? "not-started" : "uncertain"
}

/** Play once for a just-created paused schedule (revision 0). A repeated Play
 * from the list carries a new request at the then-current revision, so CAS
 * refuses a duplicate if this one committed without a reply. */
export async function playCreatedSchedule(instanceId: string, scheduleID: string, revision: number, directory?: string): Promise<CreatedStartOutcome> {
  const intent = createRecurrenceControlIntent(scheduleID, revision, "play", directory)
  try {
    const result = await serverApi.controlMissionRecurrence(instanceId, scheduleID, intent)
    return completedRecurrenceControl(result, intent) ? "started" : "uncertain"
  } catch { return "uncertain" }
}
