import { z } from "zod"
export { nextMissionCalendarCron, previewMissionCalendar, previewMissionCalendars } from "./mission-calendar-preview"

const text = z.string().min(1).max(512)
export const missionCalendarWhenSchema = z.union([
  z.object({ type: z.literal("at"), at: text, tz: text }).strict(),
  z.object({ type: z.literal("in"), in: text, tz: text }).strict(),
  z.object({ type: z.literal("every"), every: text, tz: text }).strict(),
  z.object({ type: z.literal("cron"), cron: text, tz: text }).strict(),
])
export type MissionCalendarWhen = z.infer<typeof missionCalendarWhenSchema>
export type MissionCalendarPlan = { role: "principal" | "reconciliation"; slot: number; when: MissionCalendarWhen; endsAt: number | null; anchorAt: number }
