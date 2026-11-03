import { z } from "zod"
import { documentTimestamp, MISSION_MIN_INTERVAL_MS, missionEventPrincipal, missionLaunchModel, requiresMissionCalendar } from "./launch-policy"
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
  const model = missionLaunchModel(doc.configuration.launch), zone = "UTC"
  // Schedules keep slots 0..n-1; the internal event check, when present, follows them.
  const principal = model.schedules.map((timing): { when: MissionCalendarWhen; anchorAt: number } => {
    switch (timing.kind) {
      case "at": return { when: { type: "at", at: new Date(doc.oneShotAt ?? timing.at).toISOString(), tz: timing.zone }, anchorAt: doc.firstPlayedAt! }
      case "in": return { when: { type: "in", in: `${timing.delayMs} millis`, tz: zone }, anchorAt: (doc.oneShotAt ?? now + timing.delayMs) - timing.delayMs }
      case "every":
        if (timing.intervalMs < MISSION_MIN_INTERVAL_MS) throw new Error("Mission interval must be at least 15 minutes")
        return { when: { type: "every", every: `${timing.intervalMs} millis`, tz: zone }, anchorAt: principalAnchorAt }
      case "cron": return { when: { type: "cron", cron: timing.expression, tz: timing.zone }, anchorAt: principalAnchorAt }
    }
  })
  if (missionEventPrincipal(doc.configuration.launch))
    principal.push({ when: { type: "every", every: `${MISSION_RECONCILIATION_INTERVAL_MS} millis`, tz: zone }, anchorAt: principalAnchorAt })
  const plans = principal.map(({ when, anchorAt }, slot): MissionCalendarPlan => ({ role: "principal", slot, when, endsAt: doc.slotEndsAt, anchorAt }))
  for (const plan of plans) if (!previewMissionCalendar(plan, now, 1).length) throw new Error("Mission calendar has no next eligible occurrence")
  return [{ role: "reconciliation", slot: 0, when: { type: "every", every: `${MISSION_RECONCILIATION_INTERVAL_MS} millis`, tz: zone }, endsAt: null, anchorAt: now }, ...plans]
}
