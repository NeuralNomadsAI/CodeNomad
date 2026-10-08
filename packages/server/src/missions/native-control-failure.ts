import { isDeepStrictEqual } from "node:util"
import { authorityDigest, rejectAuthority } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { stableToken, type MissionJournal } from "./journal"
import type { MissionFinishedEvent } from "./model"

/** Construction-only positive native observation, never a model report or RPC input.
 * This subset has no declared task: the original start operation itself failed.
 * RecurrenceAuthority.settle already owns the shared business lock and native transaction. */
export async function recordNativeControlFailure(journal: MissionJournal,
  missionID: string, failure: NonNullable<MissionFinishedEvent["nativeFailure"]>, summary: string, current: () => true) {
  const snapshot = await journal.snapshot(), history = await journal.events(), mission = snapshot.missions[0]
  const control = mission?.control, acknowledgement = control?.receipts?.[0]?.nativeAcknowledgement
  if (snapshot.missions.length !== 1 || snapshot.discardedEvents || history.discardedEvents
    || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.cleanupUnavailable
    || !mission || mission.id !== missionID || !["active", "failed"].includes(mission.status)
    || mission.tasks.length || mission.reports.length || mission.actors.length !== 1
    || mission.coordinatorSessionId !== failure.sessionID || control?.id !== failure.operationID
    || control.action !== "start" || control.pending.length || control.targets.length !== 1
    || control.targets[0].sessionID !== failure.sessionID || control.receipts?.length !== 1
    || control.receipts[0].acknowledgementState !== "known"
    || acknowledgement?.disposition !== "start-admitted" || acknowledgement.admission.id !== failure.messageID
    || authorityDigest(acknowledgement.admission.payload.text) !== failure.inputDigest
    || control.recurrence?.messageID !== failure.messageID) rejectAuthority("observation-unavailable")
  const id = `evt_${stableToken(`${missionID}\0finished`, 28)}`
  const previous = await journal.event(missionID, id)
  if (history.events.length !== (previous ? 4 : 3)
    || history.events.some(event => !["mission.created", "mission.control-requested", "mission.control-applied", "mission.finished"].includes(event.type)))
    rejectAuthority("observation-unavailable")
  const guard = () => assertSynchronousAuthorityGuard(current, "policy-unqualified")
  guard()
  if (previous) {
    if (previous.type !== "mission.finished" || previous.outcome !== "failed" || previous.summary !== summary
      || !isDeepStrictEqual(previous.nativeFailure, failure)) rejectAuthority("observation-unavailable")
    return
  }
  if (mission.status !== "active" || mission.runState !== "running") rejectAuthority("observation-unavailable")
  await journal.append({ version: 1, id, type: "mission.finished", projectID: mission.projectID, missionID,
    outcome: "failed", summary,
    nativeFailure: failure, createdAt: mission.updatedAt + 1 }, guard)
  guard()
}
