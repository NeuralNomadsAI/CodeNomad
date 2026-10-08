import type { RecurrenceControlRequest, RecurrenceControlStatus } from "../../../server/src/missions/recurrence-control-contract"
import type { RecurrenceManualResult } from "../../../server/src/missions/recurrence-manual-rpc"

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
export function completedRecurrenceManual(result: RecurrenceManualResult, intent: RecurrenceControlIntent): boolean {
  return result.version === 1 && result.scheduleID === intent.scheduleID && result.requestID === intent.requestID
    && result.expectedRevision === intent.expectedRevision && (result.outcome === "accepted" || result.outcome === "settled")
}
