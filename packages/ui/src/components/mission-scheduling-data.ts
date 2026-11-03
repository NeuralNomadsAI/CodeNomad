import { Cron, DateTime } from "effect"
import type { MissionCondition, MissionCriteriaLaunchPolicy, MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import type { MissionCalendarPlan, MissionCalendarWhen } from "../../../server/src/missions/mission-calendar-plan"
import { previewMissionCalendars } from "../../../server/src/missions/mission-calendar-preview"
import { missionLaunchLimit, missionLaunchModel, type MissionLaunchModel } from "../../../server/src/missions/mission-launch-kind"
import { documentTimestamp } from "../../../server/src/missions/mission-time"

/** Schedule shortcuts write a cron; advanced cron is written directly. */
export const missionScheduleShortcuts = ["hours", "daily", "weekly", "monthly", "cron"] as const
export const missionEventKinds = ["branch-commits", "conversation-message", "files-changed", "schedule-success", "mission-completed"] as const
export type MissionConditionKind = MissionCondition["kind"]
export type MissionCriterionKind = typeof missionScheduleShortcuts[number] | MissionConditionKind
export const MISSION_CRITERIA_LIMIT = 16
/** Divisors of a day, so "every N hours" keeps the same gap across midnight. */
export const missionHourSteps = [1, 2, 3, 4, 6, 8, 12] as const
export interface MissionCriterionDraft {
  id: string; kind: MissionCriterionKind
  hours: string; time: string; days: number[]; monthDay: string; expression: string; source: string; files: string
}
export interface MissionSchedulingFields { criteria: MissionCriterionDraft[]; onlyWithNews: boolean; zone: string; until: string }
type Criterion = MissionCriteriaLaunchPolicy["when"][number]
export interface MissionSchedulingDraft extends MissionSchedulingFields {
  /** The loaded policy stays exact when nothing is edited, and each unedited
   * criterion keeps its stored spelling. Shapes this form cannot express are
   * retained until an explicit replacement. */
  stored?: { policy: MissionLaunchPolicy; initial: MissionSchedulingFields; exact: Record<string, Criterion>
    reason?: "timing" | "precision" | "source" | "retired" }
}
export const isMissionEventKind = (kind: MissionCriterionKind): kind is MissionConditionKind =>
  (missionEventKinds as readonly string[]).includes(kind)
export function newMissionCriterion(kind: MissionCriterionKind = "daily", existing: readonly MissionCriterionDraft[] = []): MissionCriterionDraft {
  // A new daily row takes the first free hour from 09:00, so adding twice is never a duplicate.
  const taken = new Set(existing.filter(row => row.kind === "daily").map(row => row.time))
  const hour = Array.from({ length: 24 }, (_, offset) => (9 + offset) % 24).find(value => !taken.has(`${String(value).padStart(2, "0")}:00`)) ?? 9
  return { id: crypto.randomUUID(), kind, hours: "6", time: `${String(hour).padStart(2, "0")}:00`, days: [1, 2, 3, 4, 5], monthDay: "1",
    expression: "0 9 * * *", source: "", files: "" }
}
export function newMissionSchedulingDraft(zone = Intl.DateTimeFormat().resolvedOptions().timeZone): MissionSchedulingDraft {
  return { criteria: [], onlyWithNews: false, zone, until: "" }
}
export class MissionSchedulingError extends Error {
  constructor(readonly field: "zone" | "hours" | "time" | "days" | "monthDay" | "cron" | "source" | "until" | "count" | "duplicate" | "retained",
    readonly index?: number) { super(field) }
}
const fail = (field: MissionSchedulingError["field"], index?: number): never => { throw new MissionSchedulingError(field, index) }
const integer = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined
export function localInstant(value: string, zone: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined
  try {
    // Reject impossible civil dates rather than normalizing February 31 into March.
    if (new Date(`${value}Z`).toISOString().slice(0, 16) !== value) return undefined
    return documentTimestamp.parse(DateTime.toEpochMillis(DateTime.makeZonedUnsafe(`${value}Z`, { timeZone: zone, adjustForTimeZone: true })))
  } catch { return undefined }
}
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const unique = (items: unknown[]) => new Set(items.map(item => JSON.stringify(item))).size === items.length

/** The cron a schedule shortcut writes; advanced rows are their own expression. */
export function missionCriterionCron(row: MissionCriterionDraft, index = 0): string {
  if (row.kind === "cron") return row.expression.trim().replace(/\s+/g, " ")
  if (row.kind === "hours") {
    const hours = integer(row.hours)
    if (!hours || !(missionHourSteps as readonly number[]).includes(hours)) return fail("hours", index)
    return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time)) return fail("time", index)
  const [hour, minute] = row.time.split(":").map(Number), prefix = `${minute} ${hour}`
  if (row.kind === "daily") return `${prefix} * * *`
  if (row.kind === "weekly") {
    if (!row.days.length || row.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return fail("days", index)
    return `${prefix} * * ${[...new Set(row.days)].sort().join(",")}`
  }
  const day = integer(row.monthDay)
  if (!day || day > 31) return fail("monthDay", index)
  return `${prefix} ${day} * *`
}
function eventCriterion(row: MissionCriterionDraft & { kind: MissionConditionKind }, index: number, directory?: string): MissionCondition {
  const source = row.source.trim()
  switch (row.kind) {
    case "schedule-success": case "mission-completed":
      if (!/^[A-Za-z0-9_-]{3,100}$/.test(source)) return fail("source", index)
      return { kind: row.kind, missionID: source }
    case "conversation-message":
      if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(source)) return fail("source", index)
      return { kind: row.kind, conversationID: source }
    case "branch-commits":
      if (!directory || !source.startsWith("refs/heads/") || source.length < 12 || source.length > 1024
        || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(source) || source.includes("..") || source.includes("@{")
        || source.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) return fail("source", index)
      return { kind: row.kind, directory, ref: source }
    case "files-changed": {
      const paths = [...new Set(row.files.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
      if (!paths.length || paths.length > 128 || paths.some(value => value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value)
        || value.split("/").some(part => !part || part === "." || part === ".."))) return fail("source", index)
      return { kind: row.kind, paths: paths.sort() }
    }
  }
}

/** UI validation only; the native configuration codec and source ownership remain authoritative. */
export function missionSchedulingPolicy(draft: MissionSchedulingDraft, directory?: string): MissionLaunchPolicy {
  const { stored, ...fields } = draft
  const unchanged = !!stored && sameJSON(fields, stored.initial)
  if (stored?.reason) {
    if (!unchanged) return fail("retained")
    if (stored.reason === "source") return fail("source")
    return structuredClone(stored.policy)
  }
  if (unchanged) return structuredClone(stored!.policy)
  const zone = draft.zone.trim()
  const scheduled = draft.criteria.some(row => !isMissionEventKind(row.kind))
  if (scheduled || draft.until) {
    try { new Intl.DateTimeFormat("en", { timeZone: zone }) } catch { return fail("zone") }
    if (!zone) return fail("zone")
  }
  const when = draft.criteria.map((row, index): Criterion => {
    const initial = stored?.initial.criteria.find(item => item.id === row.id)
    if (initial && sameJSON(initial, row) && stored!.exact[row.id] && (isMissionEventKind(row.kind) || zone === stored!.initial.zone))
      return structuredClone(stored!.exact[row.id])
    if (isMissionEventKind(row.kind)) return eventCriterion(row as MissionCriterionDraft & { kind: MissionConditionKind }, index, directory)
    const expression = missionCriterionCron(row, index)
    try { if (Cron.parseUnsafe(expression, zone).seconds.size !== 1) return fail("cron", index) }
    catch { return fail("cron", index) }
    return { kind: "cron", expression, zone }
  })
  const schedules = when.filter(item => item.kind === "cron"), events = when.filter(item => item.kind !== "cron")
  if (!unique(schedules) || !unique(events)) return fail("duplicate")
  const onlyWithNews = draft.onlyWithNews && schedules.length > 0 && events.length > 0
  if (events.length > 8 || schedules.length + (events.length && !onlyWithNews ? 1 : 0) > 8) return fail("count")
  const until = !when.length || !draft.until ? null : localInstant(draft.until, zone) ?? fail("until")
  return { when, onlyWithNews, until }
}

/** Prospective schedule slots from Play; events alone have no dated slots. */
export function previewMissionScheduling(policy: MissionLaunchPolicy, anchorAt: number, from = anchorAt): number[] {
  const model = missionLaunchModel(policy)
  const ends = [model.until, model.endAfterMs === null ? null : anchorAt + model.endAfterMs].filter((value): value is number => value !== null)
  return previewSchedules(model.schedules, anchorAt, from, ends.length ? Math.min(...ends) : null,
    model.events.length ? null : missionLaunchLimit(policy))
}
function previewSchedules(schedules: MissionLaunchModel["schedules"], anchorAt: number, from: number, endsAt: number | null, limit: number | null) {
  const plans = schedules.map((timing, slot): MissionCalendarPlan => {
    const when: MissionCalendarWhen = timing.kind === "at" ? { type: "at", at: new Date(timing.at).toISOString(), tz: timing.zone }
      : timing.kind === "in" ? { type: "in", in: `${timing.delayMs} millis`, tz: "UTC" }
        : timing.kind === "every" ? { type: "every", every: `${timing.intervalMs} millis`, tz: "UTC" }
          : { type: "cron", cron: timing.expression, tz: timing.zone }
    return { role: "principal", slot, when, anchorAt, endsAt }
  })
  const dates = previewMissionCalendars(plans, from).filter(at => at > from)
  return limit !== null ? dates.slice(0, limit) : dates
}

export interface MissionSchedulingPhase {
  firstPlayedAt: number; oneShotAt: number | null; slotEndsAt: number | null; nextDueAt: number | null; launchedCount: number
}
/** Saved relative origins/ends survive editor reopening. A known late native
 * slot is shown once, followed by future slots rather than a backlog. */
export function previewSavedMissionScheduling(policy: MissionLaunchPolicy, phase: MissionSchedulingPhase, now: number, unchanged: boolean) {
  const model = missionLaunchModel(policy), next = phase.nextDueAt
  const delay = model.schedules.find(item => item.kind === "in"), every = model.schedules.find(item => item.kind === "every")
  const limit = missionLaunchLimit(policy), remaining = limit === null ? null : Math.max(0, limit - phase.launchedCount)
  if (remaining === 0 || !model.schedules.length) return []
  const interval = every?.kind === "every" ? every.intervalMs : null
  if (unchanged && interval !== null && next === null) return []
  const ends = [model.until, model.endAfterMs === null ? null : phase.firstPlayedAt + model.endAfterMs].filter((value): value is number => value !== null)
  const until = ends.length ? Math.min(...ends) : null
  const schedules = model.schedules.map(item => unchanged && item === delay && phase.oneShotAt !== null ? { kind: "at" as const, at: phase.oneShotAt, zone: "UTC" } : item)
  const anchor = unchanged ? interval !== null && next !== null ? next - interval : phase.firstPlayedAt : now
  const dates = previewSchedules(schedules, anchor, Math.max(now, unchanged ? next ?? 0 : 0), until, model.events.length ? null : remaining)
  const result = unchanged && next !== null && (until === null || next <= until) ? [next, ...dates] : dates
  return result.slice(0, !model.events.length && remaining !== null ? Math.min(remaining, 5) : 5)
}
