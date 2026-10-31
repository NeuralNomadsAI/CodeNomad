import { projectMissionDocument, type MissionDocument, type MissionDocumentTombstone } from "./mission-document"
import { missionDocumentSummary } from "./mission-document-one-time"

/** Public schedule data contains no runtime path, proof cookie, environment or
 * stored provider descriptors. The document remains the mutation authority. */
export function missionScheduleView(doc: MissionDocument | MissionDocumentTombstone | undefined, pending?: boolean) {
  if (!doc || "deletedAt" in doc) return { document: null, pending: false, ...(doc ? { deleted: true,
    deletionReceipt: { id: doc.id, requestID: doc.requestID, expectedRevision: doc.expectedRevision, deleteManagedSessions: doc.deleteManagedSessions } } : {}) }
  const projection = projectMissionDocument(doc), operation = doc.calendarOwner?.operation
  return { document: { ...missionDocumentSummary(doc), id: doc.id, configuration: doc.configuration,
    remaining: projection.remaining, settledCount: doc.settledCount, blocked: doc.blocked, edit: projection.edit,
    control: operation ? { requestID: operation.requestID, expectedRevision: operation.expectedRevision, action: operation.action,
      pending: operation.pending } : null },
  pending: pending ?? !!(operation?.pending || doc.synchronization || doc.blocked === "unknown") }
}
