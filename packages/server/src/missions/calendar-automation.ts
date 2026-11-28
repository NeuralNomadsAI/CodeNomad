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
export type MissionCalendarUnsupported = "one-time" | "fallback-schedule" | "ending" | "event" | "followed-conversations"

/** The native Automations that carry a Mission's launch criteria under one calendar
 * identity: one per date rule, each with the events after the rules as its condition,
 * or one that asks for events alone. Everything else names what they cannot express.
 * The arguments also keep the criteria as entered (`launch`), for the form that edits
 * them, and `prepared`, the Mission the first launch starts. */
export function missionCalendarAutomations(configuration: MissionConfiguration, calendar: string, prepared?: string): MissionCalendarAutomation[] | { unsupported: MissionCalendarUnsupported } {
  const model = missionLaunchModel(configuration.launch)
  if (!model.schedules.length && !model.events.length || model.schedules.some(item => item.kind !== "cron" && item.kind !== "every")) return { unsupported: "one-time" }
  if (model.plans.some(item => item.fallback)) return { unsupported: "fallback-schedule" }
  if (model.until !== null || model.endAfterMs !== null || model.maxLaunches !== null) return { unsupported: "ending" }
  if (configuration.watchedConversationIDs.length) return { unsupported: "followed-conversations" }
  if (!missionCalendarEventsSchema.safeParse(model.events).success) return { unsupported: "event" }
  const { title, objective, notes, template, taskMode, profiles, coordinatorGoal, coordinatorSessionID } = configuration
  const automation = (trigger: MissionCalendarAutomation["trigger"], events: MissionCondition[]): MissionCalendarAutomation => ({ name: title, trigger,
    // JSON drops what the configuration leaves out.
    action: { type: "code", code: MISSION_CALENDAR_CODE, args: JSON.parse(JSON.stringify({ calendar, title, objective, notes, template, taskMode, profiles,
      coordinatorGoal, coordinatorSessionID, ...(events.length ? { when: events } : {}), launch: configuration.launch, prepared })) } })
  if (!model.schedules.length) return [automation({ type: "every", every: MISSION_CALENDAR_EVENT_INTERVAL }, model.triggers)]
  return model.schedules.map((schedule, index) => automation(schedule.kind === "cron" ? { type: "cron", cron: schedule.expression, tz: schedule.zone }
    : { type: "every", every: `${(schedule as { intervalMs: number }).intervalMs} millis` }, model.plans[index]!.conditions))
}