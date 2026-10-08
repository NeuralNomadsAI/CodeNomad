export const MISSION_RECURRENCE_CHANGED_EVENT = "rpc.codenomad.missions.scheduleChanged" as const
export interface RecurrenceScheduleChanged { scheduleID: string; revision: number }
export const recurrenceScheduleChangedSchema = {
  type: "object", properties: {
    scheduleID: { type: "string", minLength: 3, maxLength: 100, pattern: "^[A-Za-z0-9_-]{3,100}$" },
    revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  }, required: ["scheduleID", "revision"], additionalProperties: false,
} as const

/** Invalidation only: no profile, consigne, result prose or execution authority. */
export function readRecurrenceScheduleChanged(event: { type: string; data?: unknown }): RecurrenceScheduleChanged | undefined {
  const data = event.data
  if (event.type !== MISSION_RECURRENCE_CHANGED_EVENT || !data || typeof data !== "object" || Array.isArray(data)) return undefined
  const value = data as Record<string, unknown>
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.every(key => key === "scheduleID" || key === "revision")
    || typeof value.scheduleID !== "string" || !/^[A-Za-z0-9_-]{3,100}$/.test(value.scheduleID)
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) return undefined
  return { scheduleID: value.scheduleID, revision: value.revision }
}
