import type { RecurrenceControlRequest, RecurrenceControlStatus } from "../../../server/src/missions/recurrence-control-contract"

export type RecurrenceControlIntent = RecurrenceControlRequest & { directory: string; retry?: boolean }

/** Browser equivalent of the native sorted-key recurrenceHumanRequestID digest. */
export async function createRecurrenceControlIntent(scheduleID: string, expectedEpoch: number,
  action: RecurrenceControlRequest["action"], expectedRevision: number, directory: string): Promise<RecurrenceControlIntent> {
  const nativeAction = action === "play" ? "authorize" : action === "pause" ? "pause" : "revoke"
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ action: nativeAction, epoch: expectedEpoch + 1, scheduleID })))
  const requestID = `rhuman_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`
  return { scheduleID, requestID, action, expectedRevision, expectedEpoch, directory }
}

export function recurrenceControlStatusInput(intent: RecurrenceControlIntent) {
  const { scheduleID: _scheduleID, retry: _retry, ...body } = intent
  return body
}

/** A signed epoch/list observation is not proof that native targets completed. */
export function completedRecurrenceControl(result: Partial<RecurrenceControlStatus>, intent: RecurrenceControlIntent): boolean {
  return result.version === 1 && result.scheduleID === intent.scheduleID && result.requestID === intent.requestID
    && result.epoch === intent.expectedEpoch + 1 && result.revision === intent.expectedRevision + 1
    && result.state === (intent.action === "play" ? "running" : intent.action === "pause" ? "paused" : "stopped")
    && result.controlsComplete === true && result.schedulerCancellation !== "unknown"
    && (!result.nativeControl || result.nativeControl.requestID === intent.requestID
      && Array.isArray(result.nativeControl.pending) && result.nativeControl.pending.length === 0)
    && (result.outcome === undefined || result.outcome === "committed" && result.expectedRevision === intent.expectedRevision)
}
