import type { RecurrenceControlRequest } from "./recurrence-control-contract"

/** Desired state committed by a control; Run now has none. */
export function recurrenceControlTargetState(action: RecurrenceControlRequest["action"]) {
  return action === "play" || action === "resume" ? "running" : action === "pause" || action === "check" ? "paused"
    : action === "stop" ? "stopped" : undefined
}

/** Check keeps whichever inactive state it observed: paused, or terminal stopped. */
export function recurrenceControlStateMatches(action: RecurrenceControlRequest["action"], state: string | undefined) {
  return action === "check" ? state === "paused" || state === "stopped" : state === recurrenceControlTargetState(action)
}
