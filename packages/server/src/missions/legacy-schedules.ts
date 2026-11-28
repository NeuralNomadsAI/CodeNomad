import { stableToken } from "./receipt-identity"

/** Where the recurring engine kept its schedules, one document per schedule, beside the documents of one-time Missions. */
export const legacyScheduleKey = (project: { id: string; canonical: string }, id = "") =>
  `codenomad-missions/documents-v1/project/${stableToken(`${project.id}\0${project.canonical}`, 24)}/missions/${id}`

export type LegacySchedule = {
  id: string
  /** As stored: validated by whoever takes it over. */
  configuration: Record<string, unknown>
  /** It ran, and no failed passage held it. */
  running: boolean
  /** One of its passages is under way: it is taken over once that passage ended. */
  busy: boolean
  /** The native Automations and technical conversations that woke it. */
  automations: string[]; carriers: string[]
}

const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 240 ? value : undefined

/** What a stored document says of a schedule of the recurring engine, read without that engine:
 * `undefined` for a deleted schedule, a one-time Mission's document or anything else. */
export function legacySchedule(raw: unknown): LegacySchedule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const doc = raw as Record<string, any>, id = text(doc.id)
  if (!id || "deletedAt" in doc || doc.oneTime && !doc.dormantJournal || !doc.configuration || typeof doc.configuration !== "object") return undefined
  const wakes = [...Array.isArray(doc.calendars) ? doc.calendars : [], ...Array.isArray(doc.calendarOwner?.slots) ? doc.calendarOwner.slots : [],
    ...(Array.isArray(doc.calendarOwner?.retired) ? doc.calendarOwner.retired : []).map((item: any) => item?.descriptor)]
  const unique = (key: "scheduleID" | "sessionID") => [...new Set(wakes.flatMap(item => text(item?.[key]) ?? []))].slice(0, 64)
  return { id, configuration: doc.configuration, running: doc.state === "running" && !doc.blocked, busy: !!doc.pending, automations: unique("scheduleID"), carriers: unique("sessionID") }
}

/** The deleted form of a stored schedule, as the recurring engine writes it: what still reads that storage
 * keeps listing the others, and a conversation one of its passages created coordinates ordinary Missions again. */
export function legacyTombstone(raw: unknown, deletedAt: number): Record<string, unknown> | undefined {
  if (!legacySchedule(raw)) return undefined
  const doc = raw as Record<string, any>, revision = Number.isSafeInteger(doc.revision) && doc.revision >= 0 ? doc.revision as number : 0
  const asked = doc.deletion && typeof doc.deletion.requestID === "string" && Number.isSafeInteger(doc.deletion.expectedRevision) ? doc.deletion : undefined
  return { version: 1, id: doc.id, projectID: doc.projectID, projectCanonical: doc.projectCanonical, revision: revision + 1,
    requestID: asked?.requestID ?? `takeover_${doc.id}`.slice(0, 128), expectedRevision: asked?.expectedRevision ?? revision,
    deleteManagedSessions: false, deletedAt, timeGeneration: Number.isSafeInteger(doc.timeGeneration) && doc.timeGeneration > 0 ? doc.timeGeneration : 1 }
}