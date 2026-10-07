import { canonicalAuthority } from "./authority-protocol"
import { runMissionExclusive } from "./exclusive"
import type { MissionStorage } from "./journal"
import { isCoordinatorNotificationReport } from "./native-report-provenance"
import { recurrenceResultSchema, type RecurrenceDocument, type RecurrenceResult } from "./recurrence-contract"
import { recurrencePassage } from "./recurrence-passage"
import type { NativeMissionRecurrenceStore } from "./recurrence-store"

/** Dedicated fresh native terminal/reference authority, NOT admission-ACK
 * settlement. Validate the exact outcome, native artifact message placement and
 * watched-conversation cursor provenance. Unknown evidence must throw, retaining
 * pending. Return the existing protected-writer synchronous fence, not a grant.
 * Called under the business mutation lock: reads only, no business mutators or
 * authority transactions that reacquire that lock. No native reader is implied. */
export type RecurrenceArchiveAuthorization = (document: Readonly<RecurrenceDocument>, result: Readonly<RecurrenceResult>) => Promise<() => void>

/** Archive references into the existing bounded ledger, never delete a Mission
 * or a native conversation. Journals remain exact-key addressable but are never
 * scanned by the ordinary project journal. Physical retention is not bounded:
 * storage has no safe removal/archival transaction, so reclamation is NOT enabled.
 * authorizeArchive must validate fresh native terminal evidence for the supplied result;
 * a journal outcome/model report alone is not that evidence. */
export async function archiveRecurrencePassage(store: NativeMissionRecurrenceStore, storage: MissionStorage,
  id: string, input: RecurrenceResult, now: number, authorizeArchive: RecurrenceArchiveAuthorization) {
  const result = recurrenceResultSchema.parse(JSON.parse(canonicalAuthority(input)))
  // Same key as MissionControl.mutate. Hold journal validation THROUGH finish,
  // excluding deletion/cleanup/control publication in the async read/write gap.
  // Order: business -> recurrence mutation. Reservation releases its recurrence
  // mutation lock before calling admission; no reverse acquisition is introduced.
  return runMissionExclusive(`mutation:${store.projectToken}`, async () => {
  const doc = await store.read(id)
  if (!doc?.pending?.admission) throw new Error("Recurrence admitted passage missing")
  const admission = doc.pending.admission
  if (result.passageID !== admission.passageID || result.messageID !== admission.messageID
    || result.missionID !== admission.missionID || result.conversationID !== admission.conversationID) throw new Error("Recurrence archive identity conflict")
  const current = await authorizeArchive(structuredClone(doc), structuredClone(result))
  current()
  const { journal, missionID } = recurrencePassage(storage, doc, current, () => now)
  const snapshot = await journal.snapshot(), mission = snapshot.missions[0]
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.cleanupUnavailable
    || snapshot.missions.length !== 1 || !mission || mission.id !== missionID
    || mission.coordinatorSessionId !== result.conversationID || mission.status !== result.outcome
    || mission.control?.pending.length || mission.reports.some(report => isCoordinatorNotificationReport(report) && report.notificationStatus !== "admitted")
    || snapshot.cleanups?.some(cleanup => cleanup.pending > 0)) throw new Error("Recurrence archive unsettled journal")
  const fresh = await store.read(id)
  if (!fresh || fresh.revision !== doc.revision) throw new Error("Recurrence archive changed")
  current()
  // finish rechecks all four exact identities, watches and cursor capacity;
  // unknown writes keep the original pending or durable receipt, never replay.
  return store.finish(id, result, now, current)
  })
}
