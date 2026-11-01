import { HttpResponseError } from "./retryable-file-search"

export type MissionScheduleControlReceipt = { pending: boolean; document: { id: string; control: { requestID: string; expectedRevision: number;
  action: string; pending: boolean } | null } | null; deleted?: boolean;
  deletionReceipt?: { id: string; requestID: string; expectedRevision: number; deleteManagedSessions: boolean } }

export function refusedMissionScheduleReceipt(error: unknown, request: { requestID: string; expectedRevision: number; action: string }, missionID?: string) {
  if (!(error instanceof HttpResponseError) || error.status !== 409 || error.code !== "schedule-refused") return false
  const body = error.body as { pending?: unknown; refusal?: { missionID?: unknown; requestID?: unknown; expectedRevision?: unknown; action?: unknown } } | undefined
  const refusal = body?.refusal
  return body?.pending === false && typeof refusal?.missionID === "string" && (!missionID || refusal.missionID === missionID)
    && refusal.requestID === request.requestID && refusal.expectedRevision === request.expectedRevision && refusal.action === request.action
}

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
