import { projectMissionDocument, type MissionDocument, type MissionDocumentTombstone } from "./mission-document"
import { missionDocumentSummary } from "./mission-document-one-time"
import { missionScheduleAvailableActions, unobservedMissionSchedule, type MissionScheduleObservation } from "./mission-schedule-display"
import { displayMissionText } from "./truncate-text"

/** Most recent real activity timestamp from the schedule owner's own events,
 * independent of selection, expansion or future scheduled wakes. */
export function missionDocumentActivityAt(doc: MissionDocument, passageUpdatedAt?: number): number {
  return Math.max(
    doc.createdAt,
    doc.firstPlayedAt ?? 0,
    doc.checks?.lastAt ?? 0,
    doc.deletion?.requestedAt ?? 0,
    doc.oneTime?.firstPlay?.requestedAt ?? 0,
    doc.oneTime?.firstPlay?.admittedAt ?? 0,
    doc.calendarOwner?.operation.startedAt ?? 0,
    doc.calendarOwner?.operation.textEdit?.createdAt ?? 0,
    ...(doc.calendarOwner?.receipts.map(item => item.startedAt) ?? []),
    doc.pending?.createdAt ?? 0,
    doc.pending?.admittedAt ?? 0,
    doc.history.at(-1)?.settledAt ?? 0,
    passageUpdatedAt ?? 0,
  )
}

/** Public schedule data contains no runtime path, proof cookie, environment or
 * stored provider descriptors. The document remains the mutation authority. */
export function missionScheduleView(doc: MissionDocument | MissionDocumentTombstone | undefined, pending?: boolean,
  observation?: MissionScheduleObservation, passageUpdatedAt?: number) {
  if (!doc || "deletedAt" in doc) return { document: null, pending: false, ...(doc ? { deleted: true,
    deletionReceipt: { id: doc.id, requestID: doc.requestID, expectedRevision: doc.expectedRevision, deleteManagedSessions: doc.deleteManagedSessions } } : {}) }
  const projection = projectMissionDocument(doc), operation = doc.calendarOwner?.operation
    ?? (doc.preparation ? { ...doc.preparation, action: "configure" as const } : undefined)
  const owner = doc.calendarOwner
  const carriers = (owner?.slots ?? doc.calendars).map(item => ({ role: item.role, slot: item.slot,
    timeGeneration: item.timeGeneration, sessionID: item.sessionID, scheduleID: item.scheduleID, retiring: false, cleanupPending: false }))
  for (const item of owner?.retired ?? []) carriers.push({ role: item.descriptor.role, slot: item.descriptor.slot,
    timeGeneration: item.descriptor.timeGeneration, sessionID: item.descriptor.sessionID, scheduleID: item.descriptor.scheduleID,
    retiring: true, cleanupPending: !item.scheduleRemoved || !item.sessionRemoved || !item.indexRemoved })
  return { document: { ...missionDocumentSummary(doc), id: doc.id, createdAt: doc.createdAt,
    activityAt: missionDocumentActivityAt(doc, passageUpdatedAt),
     configuration: { ...doc.configuration, title: displayMissionText(doc.configuration.title) },
    ...(doc.creation ? { creation: doc.creation } : {}),
    kind: doc.oneTime && !doc.dormantJournal ? "one-time" as const : "schedule" as const,
    oneShotAt: doc.oneShotAt, slotEndsAt: doc.slotEndsAt, successfulCount: doc.successfulCount, checks: doc.checks ?? null,
    observation: observation ?? unobservedMissionSchedule(doc), availableActions: missionScheduleAvailableActions(doc),
    technical: { carriers, cleanupPending: !!doc.deletion || carriers.some(item => item.cleanupPending) || owner?.error === "cleanup-pending" },
    blockReason: doc.deletion ? "deleting" as const : doc.calendarOwner?.error ?? (doc.synchronization ? "synchronizing" as const : doc.blocked),
    pendingPassage: projection.pending, latestResult: projection.latestResult, history: projection.history,
    remaining: projection.remaining, settledCount: doc.settledCount, blocked: doc.blocked, edit: projection.edit,
    control: operation ? { requestID: operation.requestID, expectedRevision: operation.expectedRevision, action: operation.action,
      pending: operation.pending } : null },
  pending: pending ?? !!(operation?.pending || doc.synchronization || doc.blocked === "unknown") }
}
export type MissionScheduleRead = ReturnType<typeof missionScheduleView>
