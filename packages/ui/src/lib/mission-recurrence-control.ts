import type { RecurrenceAction } from "../stores/mission-recurrence"

export interface RecurrenceControlIntent {
  scheduleID: string; requestID: string; expectedRevision: number
}
export interface RecurrenceControlStatus {
  scheduleID: string; requestID: string; status: "pending" | "completed" | "partial" | "unknown"
}
export function createRecurrenceControlIntent(scheduleID: string, expectedRevision: number): RecurrenceControlIntent {
  return { scheduleID, requestID: crypto.randomUUID(), expectedRevision }
}
export function recurrenceControlStatusInput(intent: RecurrenceControlIntent) {
  return { scheduleID: intent.scheduleID, requestID: intent.requestID }
}
export function completedRecurrenceControl(result: Partial<RecurrenceControlStatus>, intent: RecurrenceControlIntent): boolean {
  return result.scheduleID === intent.scheduleID && result.requestID === intent.requestID && result.status === "completed"
}
export type { RecurrenceAction }
