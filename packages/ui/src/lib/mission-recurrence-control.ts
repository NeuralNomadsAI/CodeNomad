import type { RecurrenceControlRequest, RecurrenceControlStatus } from "../../../server/src/missions/recurrence-control-contract"
import type { recurrenceNotDispatchedCode as NotDispatchedCode } from "../../../server/src/missions/recurrence-control-contract"
import type { RecurrenceManualResult } from "../../../server/src/missions/recurrence-manual-rpc"
import { HttpResponseError } from "./retryable-file-search"

export type RecurrenceAction = RecurrenceControlRequest["action"]
export type RecurrenceControlIntent = RecurrenceControlRequest & { directory?: string; retry?: boolean }
export type { RecurrenceControlStatus }
export function createRecurrenceControlIntent(scheduleID: string, expectedRevision: number, action: RecurrenceAction, directory?: string): RecurrenceControlIntent {
  return { scheduleID, requestID: crypto.randomUUID(), expectedRevision, action, ...(directory ? { directory } : {}) }
}
export function recurrenceControlStatusInput(intent: RecurrenceControlIntent) {
  const { scheduleID: _scheduleID, retry: _retry, ...input } = intent
  return input
}
/** Control mutations return the native record; status reads add its outcome. */
export function readRecurrenceControlResult(raw: unknown): RecurrenceControlStatus {
  if (!raw || typeof raw !== "object") throw new Error("Invalid recurrence control result")
  const { targetsKnown: _targetsKnown, ...record } = raw as Record<string, unknown>
  // The owned HTTP adapter validates the native record. Keep Node-only schemas
  // out of the renderer; exact identity/completion checks below remain required.
  return { ...record, outcome: record.outcome ?? (record.controlsComplete === true ? "committed" : "unknown") } as RecurrenceControlStatus
}
export function completedRecurrenceControl(result: RecurrenceControlStatus, intent: RecurrenceControlIntent): boolean {
  return result.version === 1 && result.scheduleID === intent.scheduleID && result.requestID === intent.requestID
    && (result.action === undefined || result.action === intent.action)
    && result.expectedRevision === intent.expectedRevision && result.revision === intent.expectedRevision + 1
    && result.outcome === "committed" && result.controlsComplete === true
    && result.state === (intent.action === "play" || intent.action === "resume" ? "running"
      : intent.action === "pause" || intent.action === "check" ? "paused" : "stopped")
    && result.schedulerCancellation !== "unknown" && (result.targets === undefined
      || Array.isArray(result.targets) && result.targets.every(target => target && target.outcome === "acknowledged"))
}
export function partialRecurrenceControl(result: RecurrenceControlStatus, intent: RecurrenceControlIntent): boolean {
  return result.version === 1 && result.outcome === "unknown" && (intent.action === "pause" || intent.action === "stop")
    && (result.action === undefined || result.action === intent.action) && result.scheduleID === intent.scheduleID
    && result.requestID === intent.requestID && result.expectedRevision === intent.expectedRevision
    && result.revision === intent.expectedRevision + 1 && result.controlsComplete === false
}
// Type-bound to the route's code without importing its Node-side module.
const recurrenceNotDispatchedCode: typeof NotDispatchedCode = "recurrence-not-dispatched"
const refusalKeys = { "revision-conflict": "missions.recurrence.refused.stale", "control-conflict": "missions.recurrence.refused.conflict" } as const
type RefusalReason = keyof typeof refusalKeys

/** Message key when the route proves the original request had no effect, or
 * undefined when it must stay held. Only the native-proven conflict codes, the
 * route's coded refusal before dispatch and its pre-permit 400/401 qualify;
 * uncoded 503s, other statuses and transport loss may follow a committed control
 * and are never resent. Callers apply it only to a request's first attempt. */
export function recurrenceControlRefusalKey(error: unknown): string | undefined {
  if (!(error instanceof HttpResponseError)) return undefined
  if (error.status === 409 && error.code === "recurrence-revision-conflict") return refusalKeys["revision-conflict"]
  if (error.status === 409 && error.code === "recurrence-control-conflict") return refusalKeys["control-conflict"]
  if ((error.status === 409 || error.status === 503) && error.code === recurrenceNotDispatchedCode) return "missions.recurrence.refused.notSent"
  if (!error.code && (error.status === 400 || error.status === 401)) return "missions.recurrence.refused.notAdmitted"
  return undefined
}
/** Message key of an exact status read proving the request never applied and never can. */
export function rejectedRecurrenceControl(result: { version: number; scheduleID: string; requestID: string; expectedRevision: number;
  outcome: string; reason?: string }, intent: RecurrenceControlIntent): string | undefined {
  if (result.version !== 1 || result.scheduleID !== intent.scheduleID || result.requestID !== intent.requestID
    || result.expectedRevision !== intent.expectedRevision || result.outcome !== "rejected" || !result.reason
    || !Object.prototype.hasOwnProperty.call(refusalKeys, result.reason)) return undefined
  return refusalKeys[result.reason as RefusalReason]
}
export function completedRecurrenceManual(result: RecurrenceManualResult, intent: RecurrenceControlIntent): boolean {
  return result.version === 1 && result.scheduleID === intent.scheduleID && result.requestID === intent.requestID
    && result.expectedRevision === intent.expectedRevision && (result.outcome === "accepted" || result.outcome === "settled")
}
