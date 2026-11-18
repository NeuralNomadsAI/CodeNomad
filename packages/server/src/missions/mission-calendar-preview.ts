import { Cron, Option } from "effect"
import { Schedule } from "@opencode/schema/schedule"
import { documentCounter, documentTimestamp } from "./mission-time"
import type { MissionCalendarPlan } from "./mission-calendar-plan"

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

/** Shared browser/native display preview; live scheduling/phase comes from native rows. */
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
