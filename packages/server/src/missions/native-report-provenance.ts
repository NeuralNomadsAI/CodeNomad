import type { MissionEvent, MissionNativeBinding, MissionReport } from "./model"
import { hasInvalidNotificationHistory } from "./receipt-identity"

/** One exact native invocation; the report's sessionId supplies child identity. */
export function parseNativeBinding(input: unknown): MissionNativeBinding | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  const nativeID = (input: unknown): input is string => typeof input === "string"
    && input.length > 0 && input.length <= 240 && !/[\s\x00-\x1f\x7f]/.test(input)
  if (Object.keys(value).some(key => !["generation", "parentSessionID", "toolCallID", "parentMessageID"].includes(key))
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
    || !nativeID(value.parentSessionID) || !nativeID(value.toolCallID) || !nativeID(value.parentMessageID)) return undefined
  return { generation: Number(value.generation), parentSessionID: value.parentSessionID,
    toolCallID: value.toolCallID, parentMessageID: value.parentMessageID }
}

/** Optional on historical reports; malformed provenance is never stripped. */
export function parseNativeCall(input: unknown): MissionNativeBinding | undefined {
  if (input === undefined) return undefined
  const binding = parseNativeBinding(input)
  if (!binding) throw new Error("Invalid native report invocation")
  return binding
}

export function sameNativeCall(left?: MissionNativeBinding, right?: MissionNativeBinding): boolean {
  if (!left || !right) return left === right
  return left.generation === right.generation && left.parentSessionID === right.parentSessionID
    && left.toolCallID === right.toolCallID && left.parentMessageID === right.parentMessageID
}

/** Routing is independent of report outcome and executor termination. */
export function isCoordinatorNotificationReport(report: Pick<MissionReport, "delivery">): boolean {
  return report.delivery === undefined || report.delivery === "coordinator-notification"
}

/** Event-only decoding cannot correlate a receipt with its report's route. */
export function hasInvalidReportNotificationHistory(events: readonly MissionEvent[]): boolean {
  if (hasInvalidNotificationHistory(events)) return true
  const nativeReturns = new Set(events.flatMap(event => event.type === "task.reported"
    && !isCoordinatorNotificationReport(event.report)
    ? [JSON.stringify([event.projectID, event.missionID, event.report.id])] : []))
  return events.some(event => event.type === "report.notified"
    && nativeReturns.has(JSON.stringify([event.projectID, event.missionID, event.reportID])))
}
