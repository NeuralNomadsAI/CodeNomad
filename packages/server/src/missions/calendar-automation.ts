import type { MissionCondition, MissionConfiguration } from "./launch-policy"
import { missionLaunchModel } from "./mission-launch-kind"
import { MISSION_CALENDAR_CODE, missionCalendarEventsSchema } from "./calendar-run"

/** Events have no clock of their own: their calendar asks this often. */
export const MISSION_CALENDAR_EVENT_INTERVAL = "15 minutes"

export type MissionCalendarAutomation = {
  name: string
  trigger: { type: "cron"; cron: string; tz: string } | { type: "every"; every: string }
  action: { type: "code"; code: string; args: Record<string, unknown> }
}
export type MissionCalendarUnsupported = "one-time" | "several-schedules" | "fallback-schedule" | "event" | "followed-conversations" | "ending"

/** The one native Automation that carries a Mission's launch criteria: a single date
 * rule with optional events as its condition, or events alone. Everything else names
 * what a single Automation cannot express. */
export function missionCalendarAutomation(configuration: MissionConfiguration): MissionCalendarAutomation | { unsupported: MissionCalendarUnsupported } {
  const model = missionLaunchModel(configuration.launch), schedule = model.schedules[0], plan = model.plans[0]
  if (!model.schedules.length && !model.events.length) return { unsupported: "one-time" }
  if (model.plans.some(item => item.fallback)) return { unsupported: "fallback-schedule" }
  if (model.schedules.length > 1) return { unsupported: "several-schedules" }
  if (schedule && schedule.kind !== "cron" && schedule.kind !== "every") return { unsupported: "one-time" }
  if (model.until !== null || model.endAfterMs !== null || model.maxLaunches !== null) return { unsupported: "ending" }
  if (configuration.watchedConversationIDs.length) return { unsupported: "followed-conversations" }
  const events: MissionCondition[] = schedule ? plan!.conditions : model.triggers
  if (!missionCalendarEventsSchema.safeParse(events).success) return { unsupported: "event" }
  const { title, objective, notes, template, taskMode, profiles, coordinatorGoal, coordinatorSessionID } = configuration
  // JSON drops what the configuration leaves out.
  const args = JSON.parse(JSON.stringify({ title, objective, notes, template, taskMode, profiles, coordinatorGoal, coordinatorSessionID,
    ...(events.length ? { when: events } : {}) })) as Record<string, unknown>
  return { name: title, action: { type: "code", code: MISSION_CALENDAR_CODE, args },
    trigger: schedule?.kind === "cron" ? { type: "cron", cron: schedule.expression, tz: schedule.zone }
      : { type: "every", every: schedule?.kind === "every" ? `${schedule.intervalMs} millis` : MISSION_CALENDAR_EVENT_INTERVAL } }
}
