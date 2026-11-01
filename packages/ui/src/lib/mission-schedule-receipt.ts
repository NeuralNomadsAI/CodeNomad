import { HttpResponseError } from "./retryable-file-search"

export type MissionScheduleControlReceipt = { pending: boolean; document: { id: string; control: { requestID: string; expectedRevision: number;
  action: string; pending: boolean } | null } | null; deleted?: boolean;
  deletionReceipt?: { id: string; requestID: string; expectedRevision: number; deleteManagedSessions: boolean } }

// A partial response proves only this receipt, never the freshness of its display
// document or permission to mutate it.
export function partialMissionScheduleReceipt(error: unknown): MissionScheduleControlReceipt | undefined {
  if (!(error instanceof HttpResponseError) || error.status !== 503 || error.code !== "schedule-pending") return
  const body = error.body as Partial<MissionScheduleControlReceipt> | undefined, doc = body?.document, control = doc?.control
  if (body?.pending !== true || typeof doc?.id !== "string" || !/^[A-Za-z0-9_-]{3,100}$/.test(doc.id)
    || !control || typeof control.requestID !== "string" || !/^[A-Za-z0-9_-]{3,128}$/.test(control.requestID)
    || !Number.isSafeInteger(control.expectedRevision) || control.expectedRevision < 0
    || !["create", "configure", "play", "pause", "resume", "stop", "check", "run-now", "delete"].includes(control.action)
    || typeof control.pending !== "boolean") return
  return { pending: true, document: { id: doc.id, control: { requestID: control.requestID,
    expectedRevision: control.expectedRevision, action: control.action, pending: control.pending } } }
}
