import { canonicalAuthority } from "./authority-protocol"
import { missionDocumentPassage, isolatedMissionPassageJournal } from "./mission-document-passage-storage"
import { MISSION_DOCUMENT_PREFIX, type MissionDocument } from "./mission-document"
import type { MissionPassageTextIntent } from "./mission-calendar-owner-state"
import type { MissionConfiguration } from "./launch-policy"
import type { MissionStorage } from "./journal"
import { stableToken } from "./receipt-identity"

/** Caller persists this original journal revision and payload before publication. */
export async function prepareMissionPassageText(storage: MissionStorage, doc: MissionDocument,
  configuration: MissionConfiguration, current: () => true, now = Date.now()): Promise<MissionPassageTextIntent> {
  if (!doc.pending || doc.pending.admittedAt === null) throw new Error("Mission passage lacks admission")
  const snapshot = await missionDocumentPassage(storage, doc, current).journal.snapshot(), mission = snapshot.missions[0]
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.missions.length !== 1
    || mission.id !== doc.pending.missionID || mission.coordinatorSessionId !== doc.pending.coordinatorSessionID
    || mission.status !== "active" || canonicalAuthority(mission.profiles ?? null) !== canonicalAuthority(doc.pending.configuration.profiles ?? null))
    throw new Error("Mission passage journal unavailable")
  current()
  return { passageID: doc.pending.id, missionID: mission.id, coordinatorSessionID: mission.coordinatorSessionId,
    expectedJournalRevision: mission.revision, createdAt: Math.max(now, mission.updatedAt + 1), configuration }
}

/** Exact receipt reads also work after archive. Only an explicit original control
 * may publish an absent event; reconciliation performs observation alone. */
export async function recordMissionPassageText(storage: MissionStorage, doc: MissionDocument,
  current: () => true, publish: boolean): Promise<boolean> {
  const operation = doc.calendarOwner?.operation, intent = operation?.textEdit
  if (!intent) throw new Error("Mission passage text intent unavailable")
  const { journal, missionID } = isolatedMissionPassageJournal(storage, { projectID: doc.projectID,
    projectCanonical: doc.projectCanonical, ownerID: doc.id, passageID: intent.passageID, storagePrefix: MISSION_DOCUMENT_PREFIX }, current)
  if (missionID !== intent.missionID) throw new Error("Mission passage text identity differs")
  const event = { version: 1 as const, type: "mission.updated" as const,
    id: `evt_${stableToken(`${missionID}\0updated-${operation.requestID}`, 28)}`, missionID, projectID: doc.projectID,
    requestID: operation.requestID, expectedRevision: intent.expectedJournalRevision,
    objective: intent.configuration.objective, ...(intent.configuration.notes === undefined ? {} : { notes: intent.configuration.notes }),
    notesSpecified: true, createdAt: intent.createdAt }
  const exact = (saved: unknown) => canonicalAuthority(JSON.parse(JSON.stringify(saved))) === canonicalAuthority(event)
  const saved = await journal.event(missionID, event.id)
  if (saved) {
    if (!exact(saved)) throw new Error("Mission passage edit request conflict")
    current(); return true
  }
  if (!publish) { current(); return false }
  const snapshot = await journal.snapshot(), mission = snapshot.missions[0]
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.missions.length !== 1
    || mission.id !== missionID || mission.coordinatorSessionId !== intent.coordinatorSessionID
    || mission.status !== "active" || mission.revision !== intent.expectedJournalRevision)
    throw new Error("Mission passage journal revision conflict")
  current()
  await journal.append(event, current)
  const receipt = await journal.event(missionID, event.id)
  current()
  return !!receipt && exact(receipt)
}
