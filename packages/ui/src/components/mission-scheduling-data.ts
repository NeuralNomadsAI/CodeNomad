import { Cron, DateTime } from "effect"
import type { MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import type { MissionCalendarPlan, MissionCalendarWhen } from "../../../server/src/missions/mission-calendar-plan"
import { previewMissionCalendars } from "../../../server/src/missions/mission-calendar-preview"
import { documentTimestamp, MISSION_MIN_INTERVAL_MS } from "../../../server/src/missions/mission-time"

export const missionFrequencies = ["immediate", "at", "in", "every", "daily", "weekly", "multi", "monthly", "cron"] as const
export type MissionFrequency = typeof missionFrequencies[number]
export type MissionConditionKind = NonNullable<MissionLaunchPolicy["condition"]>["kind"]
export interface MissionSchedulingFields {
  frequency: MissionFrequency; zone: string; date: string; amount: string; unit: "minutes" | "hours"
  times: string[]; days: number[]; monthDay: string; expression: string
  condition: MissionConditionKind | "none"; source: string; files: string
  endAt: string; endAfter: string; maxLaunches: string
}
export interface MissionSchedulingDraft extends MissionSchedulingFields {
  /** The loaded policy stays exact when an unrelated field is edited. Shapes
   * outside the simple controls require an explicit full-policy replacement. */
  stored?: { policy: MissionLaunchPolicy; initial: MissionSchedulingFields; reason?: "timing" | "precision" | "source" }
}
export function newMissionSchedulingDraft(zone = Intl.DateTimeFormat().resolvedOptions().timeZone): MissionSchedulingDraft {
  return { frequency: "immediate", zone, date: "", amount: "15", unit: "minutes", times: ["09:00"], days: [1], monthDay: "1",
    expression: "0 9 * * *", condition: "none", source: "", files: "", endAt: "", endAfter: "", maxLaunches: "" }
}
export class MissionSchedulingError extends Error {
  constructor(readonly field: "zone" | "date" | "interval" | "times" | "days" | "monthDay" | "cron" | "source" | "end" | "retained") { super(field) }
}
const fail = (field: MissionSchedulingError["field"]): never => { throw new MissionSchedulingError(field) }
const integer = (value: string, field: MissionSchedulingError["field"]) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fail(field)
function localInstant(value: string, zone: string, field: "date" | "end"): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return fail(field)
  try {
    // Reject impossible civil dates rather than normalizing February 31 into March.
    if (new Date(`${value}Z`).toISOString().slice(0, 16) !== value) return fail(field)
    return documentTimestamp.parse(DateTime.toEpochMillis(DateTime.makeZonedUnsafe(`${value}Z`, { timeZone: zone, adjustForTimeZone: true })))
  }
  catch { return fail(field) }
}
function calendar(expression: string, zone: string) {
  try { if (Cron.parseUnsafe(expression, zone).seconds.size !== 1) return fail("cron") }
  catch { return fail("cron") }
  return { expression: expression.trim().replace(/\s+/g, " "), zone }
}

/** UI validation only; the native configuration codec and source ownership remain authoritative. */
export function missionSchedulingPolicy(draft: MissionSchedulingDraft, directory?: string): MissionLaunchPolicy {
  const same = (keys: (keyof MissionSchedulingFields)[]) => !!draft.stored && keys.every(key => JSON.stringify(draft[key]) === JSON.stringify(draft.stored!.initial[key]))
  if (draft.stored?.reason) {
    if (!same(Object.keys(draft.stored.initial) as (keyof MissionSchedulingFields)[])) return fail("retained")
    if (draft.stored.reason === "source") return fail("source")
    return structuredClone(draft.stored.policy)
  }
  const zone = draft.zone.trim()
  try { new Intl.DateTimeFormat("en", { timeZone: zone }) } catch { return fail("zone") }
  if (!zone) return fail("zone")
  const duration = () => {
    const ms = integer(draft.amount, "interval") * (draft.unit === "hours" ? 3_600_000 : 60_000)
    try { return documentTimestamp.parse(ms) } catch { return fail("interval") }
  }
  const times = () => {
    if (!draft.times.length || draft.times.length > 8 || draft.times.some(value => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) return fail("times")
    return [...new Set(draft.times)].sort().map(value => { const [hour, minute] = value.split(":"); return `${Number(minute)} ${Number(hour)}` })
  }
  let timing: MissionLaunchPolicy["timing"]
  switch (draft.frequency) {
    case "immediate": timing = { kind: "immediate" }; break
    case "at": timing = { kind: "at", at: localInstant(draft.date, zone, "date"), zone }; break
    case "in": timing = { kind: "in", delayMs: duration() }; break
    case "every": {
      const intervalMs = duration(); if (intervalMs < MISSION_MIN_INTERVAL_MS) return fail("interval")
      timing = { kind: "every", intervalMs }; break
    }
    case "cron": timing = { kind: "cron", ...calendar(draft.expression, zone) }; break
    case "multi": timing = { kind: "multi", calendars: times().map(time => calendar(`${time} * * *`, zone)) }; break
    case "daily": timing = { kind: "cron", ...calendar(`${times()[0]} * * *`, zone) }; break
    case "weekly": {
      if (!draft.days.length || draft.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return fail("days")
      timing = { kind: "cron", ...calendar(`${times()[0]} * * ${[...new Set(draft.days)].sort().join(",")}`, zone) }; break
    }
    case "monthly": {
      const day = integer(draft.monthDay, "monthDay"); if (day > 31) return fail("monthDay")
      timing = { kind: "cron", ...calendar(`${times()[0]} ${day} * *`, zone) }; break
    }
  }
  let condition: MissionLaunchPolicy["condition"] = null
  const source = draft.source.trim()
  switch (draft.condition) {
    case "none": break
    case "schedule-success": case "mission-completed":
      if (!/^[A-Za-z0-9_-]{3,100}$/.test(source)) return fail("source")
      condition = { kind: draft.condition, missionID: source }; break
    case "conversation-message":
      if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(source)) return fail("source")
      condition = { kind: draft.condition, conversationID: source }; break
    case "branch-commits":
      if (!directory || !source.startsWith("refs/heads/") || source.length < 12 || source.length > 1024
        || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(source) || source.includes("..") || source.includes("@{")
        || source.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) return fail("source")
      condition = { kind: draft.condition, directory, ref: source }; break
    case "files-changed": {
      const paths = [...new Set(draft.files.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
      if (!paths.length || paths.length > 128 || paths.some(value => value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value)
        || value.split("/").some(part => !part || part === "." || part === ".."))) return fail("source")
      condition = { kind: draft.condition, paths: paths.sort() }; break
    }
  }
  const afterMs = draft.endAfter ? integer(draft.endAfter, "end") * 3_600_000 : null
  if (afterMs !== null && !documentTimestamp.safeParse(afterMs).success) return fail("end")
  const ends = { maxLaunches: draft.maxLaunches ? integer(draft.maxLaunches, "end") : null,
    at: draft.endAt ? localInstant(draft.endAt, zone, "end") : null, afterMs }
  if (same(["frequency", "zone", "date", "amount", "unit", "times", "days", "monthDay", "expression"])) timing = structuredClone(draft.stored!.policy.timing)
  if (same(["condition", "source", "files"])) {
    const original = draft.stored!.policy.condition
    if (original?.kind === "branch-commits" && original.directory !== directory) return fail("source")
    condition = structuredClone(original)
  }
  return { timing, condition, ends: same(["endAt", "endAfter", "maxLaunches", "zone"]) ? structuredClone(draft.stored!.policy.ends) : ends }
}

/** Prospective Play preview. Callers supply a frozen anchor; persisted phases use native row reads. */
export function previewMissionScheduling(policy: MissionLaunchPolicy, anchorAt: number, from = anchorAt): number[] {
  const timing = policy.timing
  if (timing.kind === "immediate" && !policy.condition) return [anchorAt]
  let whens: MissionCalendarWhen[]
  switch (timing.kind) {
    case "immediate": whens = [{ type: "every", every: "15 minutes", tz: "UTC" }]; break
    case "at": whens = [{ type: "at", at: new Date(timing.at).toISOString(), tz: timing.zone }]; break
    case "in": whens = [{ type: "in", in: `${timing.delayMs} millis`, tz: "UTC" }]; break
    case "every": whens = [{ type: "every", every: `${timing.intervalMs} millis`, tz: "UTC" }]; break
    case "cron": whens = [{ type: "cron", cron: timing.expression, tz: timing.zone }]; break
    case "multi": whens = timing.calendars.map(item => ({ type: "cron", cron: item.expression, tz: item.zone })); break
  }
  const ends = [policy.ends.at, policy.ends.afterMs === null ? null : anchorAt + policy.ends.afterMs].filter((value): value is number => value !== null)
  const plans: MissionCalendarPlan[] = whens.map((when, slot) => ({ role: "principal", slot, when, anchorAt, endsAt: ends.length ? Math.min(...ends) : null }))
  const dates = previewMissionCalendars(plans, from).filter(at => at > from)
  return !policy.condition && policy.ends.maxLaunches !== null ? dates.slice(0, policy.ends.maxLaunches) : dates
}

export interface MissionSchedulingPhase {
  firstPlayedAt: number; oneShotAt: number | null; slotEndsAt: number | null; nextDueAt: number | null; launchedCount: number
}
/** Saved relative origins/fins survive editor reopening. A known late native
 * slot is shown once, followed by future slots rather than a backlog. */
export function previewSavedMissionScheduling(policy: MissionLaunchPolicy, phase: MissionSchedulingPhase, now: number, unchanged: boolean) {
  const next = phase.nextDueAt, timing = unchanged && policy.timing.kind === "in" && phase.oneShotAt !== null
    ? { kind: "at" as const, at: phase.oneShotAt, zone: "UTC" } : policy.timing
  const ends = [policy.ends.at, policy.ends.afterMs === null ? null : phase.firstPlayedAt + policy.ends.afterMs]
    .filter((value): value is number => value !== null)
  const maximum = ["every", "cron", "multi"].includes(policy.timing.kind) ? policy.ends.maxLaunches : 1
  const remaining = maximum === null ? null : Math.max(0, maximum - phase.launchedCount)
  if (remaining === 0) return []
  const interval = timing.kind === "every" ? timing.intervalMs : timing.kind === "immediate" && policy.condition ? MISSION_MIN_INTERVAL_MS : null
  if (unchanged && interval !== null && next === null) return []
  const anchor = unchanged ? interval !== null && next !== null ? next - interval : phase.firstPlayedAt : now
  const preview = { ...policy, timing, ends: { ...policy.ends, maxLaunches: remaining, afterMs: null, at: ends.length ? Math.min(...ends) : null } }
  const dates = previewMissionScheduling(preview, anchor, Math.max(now, unchanged ? next ?? 0 : 0))
  const result = unchanged && next !== null && (preview.ends.at === null || next <= preview.ends.at) ? [next, ...dates] : dates
  return result.slice(0, !policy.condition && remaining !== null ? Math.min(remaining, 5) : 5)
}
