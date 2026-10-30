import { MissionControlError } from "./control-error"
import type { MissionDeleteInput } from "./control-types"
import type { MissionDocument, MissionDocumentTombstone } from "./mission-document"
import type { MissionDocumentAccess } from "./mission-document-one-time"
import { missionDeletionSynchronizationID, missionDocumentChanges } from "./mission-document-state"

function exact(input: MissionDeleteInput, saved: { requestID: string; expectedRevision: number; deleteManagedSessions: boolean }) {
  if (saved.requestID !== input.requestID || saved.expectedRevision !== input.expectedRevision
    || saved.deleteManagedSessions !== (input.deleteManagedSessions ?? false))
    throw new MissionControlError("Delete request ID was already used with a different request", "request-conflict")
}
function unresolved(doc: MissionDocument): boolean {
  const synchronization = doc.synchronization
  return !!doc.pending || !!doc.calendars.length || doc.blocked === "unknown"
    || !!doc.oneTime?.firstPlay && doc.oneTime.firstPlay.admittedAt === null
    || !!doc.scheduleActivation?.targets.some(target => target.attempted && !target.acknowledged)
    || !!synchronization && (synchronization.kind !== "delete" || synchronization.retiredCalendars.length > 0
      || synchronization.requestID !== missionDeletionSynchronizationID(doc.deletion!.requestID))
}
const pending = () => new MissionControlError("Mission deletion reconciliation is pending; retry the original deletion request", "cleanup-pending")

/** Called only after the journal validated the deletion CAS/identity. Capacity is
 * reserved BEFORE removing the map; a full registry leaves a visible stopped map. */
export async function prepareMissionDocumentDeletion(read: MissionDocumentAccess, access: MissionDocumentAccess,
  input: MissionDeleteInput, now: number, current: () => true, required = false): Promise<void> {
  const observed = await read(store => store.read(input.missionID))
  if (!observed) { if (required) throw pending(); return }
  if ("deletedAt" in observed) { exact(input, observed); return }
  try {
    await access(async store => {
      let doc = await store.read(input.missionID)
      if (!doc) throw pending()
      if ("deletedAt" in doc) { exact(input, doc); return }
      if (doc.preparation?.pending) throw pending()
      if (doc.deletion) exact(input, doc.deletion)
      await store.change(doc.id, doc.revision, current, next => {
        missionDocumentChanges.requestDeletion(next, input.requestID, now, {
          expectedRevision: input.expectedRevision, deleteManagedSessions: input.deleteManagedSessions ?? false,
        })
        // Empty owned references are a complete local reconciliation. Preserve
        // every in-flight mapping, pending passage and uncertain write otherwise.
        if (!unresolved(next)) next.synchronization = null
      })
      const saved = await store.read(input.missionID)
      if (!saved || "deletedAt" in saved) throw pending()
      doc = saved
      if (unresolved(doc) || doc.synchronization) throw pending()
      await store.reserveDeletion(doc.id, doc.revision, current)
    })
  } catch (error) {
    if (error instanceof MissionControlError) throw error
    throw pending()
  }
}

/** Journal/native cleanup succeeded. A failed compaction stays an exact retry;
 * its complete document or already-written tombstone remains authoritative. */
export async function finishMissionDocumentDeletion(read: MissionDocumentAccess, access: MissionDocumentAccess,
  input: MissionDeleteInput, now: number, current: () => true, required = false): Promise<void> {
  await prepareMissionDocumentDeletion(read, access, input, now, current, required)
  const observed = await read(store => store.read(input.missionID))
  if (!observed) { if (required) throw pending(); return }
  if ("deletedAt" in observed) { exact(input, observed); return }
  try {
    await access(async store => {
      const doc = await store.read(input.missionID)
      if (!doc) throw pending()
      if ("deletedAt" in doc) { exact(input, doc); return }
      exact(input, doc.deletion!)
      if (unresolved(doc) || doc.synchronization) throw pending()
      const tombstone: MissionDocumentTombstone = await store.compact(doc.id, doc.revision, now, current)
      exact(input, tombstone)
    })
  } catch (error) {
    if (error instanceof MissionControlError) throw error
    throw pending()
  }
}
