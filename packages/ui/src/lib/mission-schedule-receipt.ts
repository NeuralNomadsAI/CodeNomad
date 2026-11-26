import { HttpResponseError } from "./retryable-file-search"

export type MissionScheduleControlReceipt = { pending: boolean; document: { id: string; revision?: number; kind?: "one-time" | "schedule"; dormant?: boolean; control: { requestID: string; expectedRevision: number;
  action: string; pending: boolean } | null } | null; deleted?: boolean;
  deletionReceipt?: { id: string; requestID: string; expectedRevision: number; deleteManagedSessions: boolean };
  checkReceipt?: { id: string; requestID: string; expectedRevision: number; action: "check" };
  notDispatched?: { missionID: string; requestID: string; expectedRevision: number; action: "check" } }

export function refusedMissionScheduleReceipt(error: unknown, request: { requestID: string; expectedRevision: number; action: string }, missionID?: string) {
  if (!(error instanceof HttpResponseError) || error.status !== 409 || error.code !== "schedule-refused") return false
  const body = error.body as { pending?: unknown; refusal?: { missionID?: unknown; requestID?: unknown; expectedRevision?: unknown; action?: unknown } } | undefined
  const refusal = body?.refusal
  return body?.pending === false && typeof refusal?.missionID === "string" && (!missionID || refusal.missionID === missionID)
    && refusal.requestID === request.requestID && refusal.expectedRevision === request.expectedRevision && refusal.action === request.action
}

// Per-attempt no-dispatch proof (HTTP 409 schedule-busy): proves only that THIS
// HTTP attempt did not cross the native boundary, never that an earlier attempt
// of the same ID was absent. Callers may clear only a known fresh first attempt.
export function notDispatchedMissionScheduleAttempt(error: unknown, request: { requestID: string; expectedRevision: number; action: string }, missionID?: string) {
  if (!(error instanceof HttpResponseError) || error.status !== 409 || error.code !== "schedule-busy") return false
  const body = error.body as { dispatched?: unknown; missionID?: unknown; requestID?: unknown; expectedRevision?: unknown; action?: unknown } | undefined
  return body?.dispatched === false && typeof body.missionID === "string" && (!missionID || body.missionID === missionID)
    && body.requestID === request.requestID && body.expectedRevision === request.expectedRevision && body.action === request.action
}

export function undispatchedMissionScheduleCheck(result: MissionScheduleControlReceipt, request: { requestID: string; expectedRevision: number; action: string }, missionID: string) {
  const skipped = result.notDispatched
  return request.action === "check" && result.pending === false && !!skipped
    && skipped.missionID === missionID && skipped.requestID === request.requestID
    && skipped.expectedRevision === request.expectedRevision && skipped.action === "check"
}

const validPendingControl = (control: unknown) => {
  if (control === null || control === undefined) return true
  const value = control as { requestID?: unknown; expectedRevision?: unknown; action?: unknown; pending?: unknown }
  return typeof value.requestID === "string" && /^[A-Za-z0-9_-]{3,128}$/.test(value.requestID)
    && typeof value.expectedRevision === "number" && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0
    && typeof value.action === "string"
    && ["create", "configure", "play", "pause", "resume", "stop", "check", "run-now", "delete", "reconcile"].includes(value.action)
    && typeof value.pending === "boolean"
}

// A pending status read (HTTP 503 schedule-pending) still carries the document's
// current id and revision so recovery/interruption controls can verify revision
// before dispatching.
export function pendingMissionScheduleRevision(error: unknown): { document: { id: string; revision: number; scheduleActivation?: undefined } } | undefined {
  if (!(error instanceof HttpResponseError) || error.status !== 503 || error.code !== "schedule-pending") return
  const body = error.body as { pending?: unknown; document?: { id?: unknown; revision?: unknown; control?: unknown } | null } | undefined
  const doc = body?.document
  if (body?.pending !== true || typeof doc?.id !== "string" || !/^[A-Za-z0-9_-]{3,100}$/.test(doc.id)
    || typeof doc.revision !== "number" || !Number.isSafeInteger(doc.revision) || doc.revision < 0
    || !validPendingControl(doc.control)) return
  return { document: { id: doc.id, revision: doc.revision } }
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
  return { pending: true, document: { id: doc.id,
    ...(doc.kind === "one-time" || doc.kind === "schedule" ? { kind: doc.kind } : {}),
    ...(typeof doc.dormant === "boolean" ? { dormant: doc.dormant } : {}),
    control: { requestID: control.requestID, expectedRevision: control.expectedRevision, action: control.action, pending: control.pending } } }
}
