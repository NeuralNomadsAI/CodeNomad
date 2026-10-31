import { Cron, Option } from "effect"
import { Schedule } from "@opencode/schema/schedule"
import { z } from "zod"
import { documentCounter, documentTimestamp, MISSION_MIN_INTERVAL_MS, requiresMissionCalendar } from "./launch-policy"
import type { MissionDocument } from "./mission-document"

const text = z.string().min(1).max(512)
export const missionCalendarWhenSchema = z.union([
  z.object({ type: z.literal("at"), at: text, tz: text }).strict(),
  z.object({ type: z.literal("in"), in: text, tz: text }).strict(),
  z.object({ type: z.literal("every"), every: text, tz: text }).strict(),
  z.object({ type: z.literal("cron"), cron: text, tz: text }).strict(),
])
export type MissionCalendarWhen = z.infer<typeof missionCalendarWhenSchema>
export const MISSION_RECONCILIATION_INTERVAL_MS = 15 * 60_000
export type MissionCalendarPlan = { role: "principal" | "reconciliation"; slot: number; when: MissionCalendarWhen; endsAt: number | null; anchorAt: number }

/** Native nextCron wrapper: skip the already-past first occurrence of a repeated
 * civil hour. All civil parsing stays in the installed native Effect Cron. */
export function nextMissionCalendarCron(expression: string, zone: string, now: number): number | undefined {
  const cron = Cron.parseUnsafe(expression, zone)
  let from = now
  for (let pass = 0; pass < 64; pass++) {
    let at: number
    try { at = Cron.next(cron, new Date(from)).getTime() } catch { return undefined }
    if (at > now) return at
    from = at + 60 * 60_000
  }
  throw new Error("Mission cron next occurrence coverage exceeded")
}

export function missionCalendarPlans(doc: MissionDocument, now: number, principalAnchorAt = now): MissionCalendarPlan[] {
  documentTimestamp.parse(now)
  if (!requiresMissionCalendar(doc.configuration.launch)) return []
  if (doc.firstPlayedAt === null) throw new Error("Mission calendar requires Play")
  const timing = doc.configuration.launch.timing, zone = "UTC"
  let principal: MissionCalendarWhen[]
  switch (timing.kind) {
    case "immediate": principal = [{ type: "every", every: `${MISSION_RECONCILIATION_INTERVAL_MS} millis`, tz: zone }]; break
    case "at": principal = [{ type: "at", at: new Date(doc.oneShotAt ?? timing.at).toISOString(), tz: timing.zone }]; break
    case "in": principal = [{ type: "in", in: `${timing.delayMs} millis`, tz: zone }]; break
    case "every":
      if (timing.intervalMs < MISSION_MIN_INTERVAL_MS) throw new Error("Mission interval must be at least 15 minutes")
      principal = [{ type: "every", every: `${timing.intervalMs} millis`, tz: zone }]; break
    case "cron": principal = [{ type: "cron", cron: timing.expression, tz: timing.zone }]; break
    case "multi": principal = timing.calendars.map(item => ({ type: "cron", cron: item.expression, tz: item.zone })); break
  }
  const plans = principal.map((when, slot): MissionCalendarPlan => ({ role: "principal", slot, when, endsAt: doc.slotEndsAt,
    anchorAt: timing.kind === "in" ? (doc.oneShotAt ?? now + timing.delayMs) - timing.delayMs : timing.kind === "at" ? doc.firstPlayedAt! : principalAnchorAt }))
  for (const plan of plans) if (!previewMissionCalendar(plan, now, 1).length) throw new Error("Mission calendar has no next eligible occurrence")
  return [{ role: "reconciliation", slot: 0, when: { type: "every", every: `${MISSION_RECONCILIATION_INTERVAL_MS} millis`, tz: zone }, endsAt: null, anchorAt: now }, ...plans]
}

/** Display preview only; live scheduling/phase always comes from native rows. */
export function previewMissionCalendar(plan: MissionCalendarPlan, from: number, count = 5): number[] {
  documentTimestamp.parse(from); documentCounter.max(5).parse(count)
  const result: number[] = [], when = plan.when
  let at = plan.when.type === "cron" ? from : plan.anchorAt
  for (let index = 0; index < count; index++) {
    if (when.type === "cron") {
      const next = nextMissionCalendarCron(when.cron, when.tz, at)
      if (next === undefined) break
      at = next
    } else if (when.type === "at") at = Date.parse(when.at)
    else {
      const duration = Option.getOrUndefined(Schedule.durationMillis(when.type === "every" ? when.every : when.in))
      if (duration === undefined || duration <= 0) throw new Error("Mission native duration invalid")
      at += duration
      if (when.type === "every" && at <= from) at += (Math.floor((from - at) / duration) + 1) * duration
    }
    if (!Number.isSafeInteger(at) || (when.type === "cron" || when.type === "every") && at <= from || plan.endsAt !== null && at > plan.endsAt) break
    result.push(at)
    if (when.type === "at" || when.type === "in") break
  }
  return result
}
export function previewMissionCalendars(plans: readonly MissionCalendarPlan[], from: number, count = 5): number[] {
  documentCounter.max(5).parse(count)
  return [...new Set(plans.filter(plan => plan.role === "principal").flatMap(plan => previewMissionCalendar(plan, from, count)))].sort((a, b) => a - b).slice(0, count)
}
