import { canonicalAuthority } from "./authority-protocol"
import { runMissionExclusive } from "./exclusive"
import { MissionJournal, type MissionStorage } from "./journal"
import type { MissionDocument } from "./mission-document"
import type { NativeMissionDocumentStore } from "./mission-document-store"
import { MISSION_SCHEMA_VERSION, type MissionDeletedEvent } from "./model"
import { stableToken } from "./receipt-identity"

/** Calendar deletion owns document exclusion before the ordinary journal writer.
 * The empty creation journal is retired before document compaction, with its
 * original request/revision retained across either lost acknowledgement. */
export async function deleteDormantMissionJournal(store: NativeMissionDocumentStore, storage: MissionStorage,
  document: MissionDocument, current: () => true): Promise<void> {
  store.assertActive()
  if (!document.dormantJournal || document.dormantJournal.deleted) return
  const journal = new MissionJournal(storage, document.projectID, document.projectCanonical)
  await runMissionExclusive(`mutation:${journal.projectToken}`, async () => {
    const doc = await store.read(document.id)
    if (!doc || "deletedAt" in doc || !doc.deletion || !doc.dormantJournal || !doc.oneTime || doc.preparation?.pending
      || doc.pending || doc.synchronization || doc.calendars.length || doc.calendarOwner?.operation.pending
      || doc.calendarOwner?.slots.length || doc.calendarOwner?.retired.length) throw new Error("Dormant journal deletion pending")
    if (doc.dormantJournal.deleted) return
    const event: MissionDeletedEvent = { version: MISSION_SCHEMA_VERSION, type: "mission.deleted",
      id: `evt_${stableToken(`${doc.id}\0deleted-${doc.deletion.requestID}`, 28)}`, missionID: doc.id, projectID: doc.projectID,
      requestID: doc.deletion.requestID, expectedRevision: doc.dormantJournal.revision,
      createdAt: doc.deletion.requestedAt, deleteManagedSessions: false }
    const saved = await journal.event(doc.id, event.id)
    const record = await journal.deletionRecord(doc.id)
    const recorded = !!record && record.deletionID === event.id && record.requestID === event.requestID
      && record.expectedRevision === event.expectedRevision && record.createdAt === event.createdAt
      && record.deleteManagedSessions === false && !record.documentCleanup && record.removed === 0
    if (record && !recorded) throw new Error("Dormant deletion record differs")
    if (saved) {
      if (canonicalAuthority(saved) !== canonicalAuthority(event)) throw new Error("Dormant deletion receipt differs")
    } else if (!recorded) {
      const view = await journal.missionView(doc.id), mission = view.mission
      if (view.discardedEvents || view.controlUnavailable || view.cleanupUnavailable || view.notificationUnavailable
        || !mission || mission.revision !== event.expectedRevision || mission.coordinatorSessionId !== doc.oneTime.coordinatorSessionID
        || mission.runState !== "prepared" || mission.status !== "active" || mission.tasks.length || mission.control)
        throw new Error("Dormant journal ownership unavailable")
      await journal.assertCanAppend(event)
      await store.reserveDeletion(doc.id, doc.revision, current)
      await journal.append(event, current)
    }
    const view = await journal.missionView(doc.id)
    if (!recorded && canonicalAuthority(await journal.event(doc.id, event.id)) !== canonicalAuthority(event)
      || view.mission || view.discardedEvents || view.controlUnavailable || view.cleanupUnavailable || view.notificationUnavailable)
      throw new Error("Dormant journal deletion unconfirmed")
    await store.change(doc.id, doc.revision, current, value => { value.dormantJournal!.deleted = true })
  })
}
