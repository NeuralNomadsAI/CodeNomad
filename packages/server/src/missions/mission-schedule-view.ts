import { projectMissionDocument, type MissionDocument, type MissionDocumentTombstone } from "./mission-document"
import { missionDocumentSummary } from "./mission-document-one-time"
import { missionScheduleAvailableActions, unobservedMissionSchedule, type MissionScheduleObservation } from "./mission-schedule-display"

/** Public schedule data contains no runtime path, proof cookie, environment or
 * stored provider descriptors. The document remains the mutation authority. */
export function missionScheduleView(doc: MissionDocument | MissionDocumentTombstone | undefined, pending?: boolean, observation?: MissionScheduleObservation) {
  if (!doc || "deletedAt" in doc) return { document: null, pending: false, ...(doc ? { deleted: true,
    deletionReceipt: { id: doc.id, requestID: doc.requestID, expectedRevision: doc.expectedRevision, deleteManagedSessions: doc.deleteManagedSessions } } : {}) }
  const projection = projectMissionDocument(doc), operation = doc.calendarOwner?.operation
    ?? (doc.preparation ? { ...doc.preparation, action: "configure" as const } : undefined)
  return { document: { ...missionDocumentSummary(doc), id: doc.id, configuration: doc.configuration,
    kind: doc.oneTime && !doc.dormantJournal ? "one-time" as const : "schedule" as const,
    oneShotAt: doc.oneShotAt, slotEndsAt: doc.slotEndsAt, successfulCount: doc.successfulCount, checks: doc.checks ?? null,
    observation: observation ?? unobservedMissionSchedule(doc), availableActions: missionScheduleAvailableActions(doc),
    blockReason: doc.deletion ? "deleting" as const : doc.calendarOwner?.error ?? (doc.synchronization ? "synchronizing" as const : doc.blocked),
    pendingPassage: projection.pending, latestResult: projection.latestResult, history: projection.history,
    remaining: projection.remaining, settledCount: doc.settledCount, blocked: doc.blocked, edit: projection.edit,
    control: operation ? { requestID: operation.requestID, expectedRevision: operation.expectedRevision, action: operation.action,
      pending: operation.pending } : null },
  pending: pending ?? !!(operation?.pending || doc.synchronization || doc.blocked === "unknown") }
}
export type MissionScheduleRead = ReturnType<typeof missionScheduleView>
