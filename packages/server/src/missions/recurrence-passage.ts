import type { MissionStorage } from "./journal"
import { isMissionCoordinatorSession } from "./session-identity"
import { isolatedMissionPassageJournal } from "./mission-document-passage-storage"
import { parseRecurrenceDocument, RECURRENCE_STORAGE_PREFIX, type RecurrenceDocument } from "./recurrence-contract"

/** Storage isolation only, never an ownership grant. The caller supplies its
 * current protected-writer fence; ordinary MissionControl can use this storage
 * unchanged, with passage.id as its creation requestID and the real project.
 * Authority storage must NOT use this adapter or acquire a new namespace. */
export function recurrencePassage(storage: MissionStorage, input: RecurrenceDocument, current: () => true,
  now: () => number = Date.now) {
  const doc = parseRecurrenceDocument(input, input.projectID, input.projectCanonical, input.id)
  if (!doc.pending) throw new Error("Recurrence passage missing")
  const passage = doc.pending.passage
  const isolated = passageJournal(storage, doc, passage.id, current, now)
  if (doc.pending.admission && doc.pending.admission.missionID !== isolated.missionID) throw new Error("Recurrence mission conflict")
  return { passageID: passage.id, messageID: passage.messageID,
    coordinatorSessionID: passage.coordinatorSessionID, ...isolated }
}

/** Archived display authority comes only from the exact durable receipt. No
 * browser mission/session selectors and no reconstructed pending passage. */
export function archivedRecurrencePassage(storage: MissionStorage, input: RecurrenceDocument, passageID: string) {
  const doc = parseRecurrenceDocument(input, input.projectID, input.projectCanonical, input.id)
  const receipt = doc.history.find(item => item.passage.id === passageID)
  if (!receipt || !("missionID" in receipt.result)) throw new Error("Archived recurrence result unavailable")
  const isolated = passageJournal(storage, doc, receipt.passage.id, () => { throw new Error("Archived recurrence is read-only") })
  if (receipt.result.missionID !== isolated.missionID
    || !isMissionCoordinatorSession(receipt.result.conversationID, isolated.missionID))
    throw new Error("Archived recurrence mission conflict")
  return { receipt, ...isolated }
}

function passageJournal(storage: MissionStorage, doc: RecurrenceDocument, passageID: string, current: () => true, now: () => number = Date.now) {
  return isolatedMissionPassageJournal(storage, { projectID: doc.projectID, projectCanonical: doc.projectCanonical,
    ownerID: doc.id, passageID, storagePrefix: RECURRENCE_STORAGE_PREFIX }, current, now)
}
