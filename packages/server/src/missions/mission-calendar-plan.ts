import { z } from "zod"
import { documentTimestamp, MISSION_MIN_INTERVAL_MS, requiresMissionCalendar } from "./launch-policy"
import type { MissionDocument } from "./mission-document"
import { previewMissionCalendar } from "./mission-calendar-preview"
export { nextMissionCalendarCron, previewMissionCalendar, previewMissionCalendars } from "./mission-calendar-preview"

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
