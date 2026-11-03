import { Cron } from "effect"
import type { MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { missionLaunchModel } from "../../../server/src/missions/mission-launch-kind"
import { localInstant, missionHourSteps, newMissionCriterion, newMissionSchedulingDraft, type MissionCriterionDraft,
  type MissionSchedulingDraft } from "./mission-scheduling-data"

/** Recognize only calendars with exactly the semantics of a shortcut.
 * The original expression remains stored, including aliases and field spelling. */
function shortcut(expression: string, zone: string): Partial<MissionCriterionDraft> | undefined {
  let cron: Cron.Cron
  try { cron = Cron.parseUnsafe(expression, zone) } catch { return undefined }
  const equals = (value: string) => { try { return Cron.equals(cron, Cron.parseUnsafe(value, zone)) } catch { return false } }
  // An empty native field set is a wildcard.
  const hours = cron.hours.size ? [...cron.hours].sort((a, b) => a - b) : Array.from({ length: 24 }, (_, hour) => hour)
  const step = hours.length === 24 ? 1 : hours[1] - hours[0]
  if (hours.length > 1 && (missionHourSteps as readonly number[]).includes(step) && equals(step === 1 ? "0 * * * *" : `0 */${step} * * *`))
    return { kind: "hours", hours: String(step) }
  if (cron.minutes.size !== 1 || cron.hours.size !== 1) return undefined
  const minute = [...cron.minutes][0], hour = hours[0]
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, prefix = `${minute} ${hour}`
  if (equals(`${prefix} * * *`)) return { kind: "daily", time }
  const days = [...cron.weekdays].sort()
  if (days.length && equals(`${prefix} * * ${days.join(",")}`)) return { kind: "weekly", time, days }
  const monthDay = [...cron.days][0]
  if (cron.days.size === 1 && equals(`${prefix} ${monthDay} * *`)) return { kind: "monthly", time, monthDay: String(monthDay) }
  return undefined
}

export function localMinute(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at)
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)!.value
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`
}

/** Decode a server-validated policy, including stored legacy shapes. Shapes the
 * criteria form cannot express are retained explicitly, never approximated. */
export function decodeMissionSchedulingPolicy(policy: MissionLaunchPolicy, directory?: string,
  defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone): MissionSchedulingDraft {
  const draft = newMissionSchedulingDraft(defaultZone), model = missionLaunchModel(policy)
  const exact: NonNullable<MissionSchedulingDraft["stored"]>["exact"] = {}
  let reason: NonNullable<MissionSchedulingDraft["stored"]>["reason"]
  // Intervals, delays, single dates, passage limits, relative ends and a launch
  // once on an event alone have no criteria control.
  if (model.maxLaunches !== null || model.endAfterMs !== null || model.schedules.some(item => item.kind !== "cron")
    || !model.schedules.length && model.events.length && "timing" in policy) reason = "retired"
  const zones = [...new Set(model.schedules.flatMap(item => item.kind === "cron" || item.kind === "at" ? [item.zone] : []))]
  if (zones.length > 1) reason ??= "timing"
  draft.zone = zones[0] ?? defaultZone
  for (const schedule of model.schedules) {
    if (schedule.kind !== "cron") continue
    const row = { ...newMissionCriterion("cron"), expression: schedule.expression, ...shortcut(schedule.expression, schedule.zone) }
    exact[row.id] = { kind: "cron", expression: schedule.expression, zone: schedule.zone }
    draft.criteria.push(row)
  }
  for (const event of model.events) {
    const row = newMissionCriterion(event.kind)
    switch (event.kind) {
      case "schedule-success": case "mission-completed": row.source = event.missionID; break
      case "conversation-message": row.source = event.conversationID; break
      case "branch-commits": row.source = event.ref; if (event.directory !== directory) reason ??= "source"; break
      case "files-changed": row.files = event.paths.join("\n"); break
    }
    exact[row.id] = structuredClone(event)
    draft.criteria.push(row)
  }
  draft.onlyWithNews = model.onlyWithNews
  if (model.until !== null) {
    draft.until = localMinute(model.until, draft.zone)
    // Civil minute controls cannot encode sub-minute precision or a repeated hour's second instant.
    if (localInstant(draft.until, draft.zone) !== model.until) reason ??= "precision"
  }
  const { stored: _stored, ...initial } = draft
  return { ...draft, stored: { policy: structuredClone(policy), initial: structuredClone(initial), exact, ...(reason ? { reason } : {}) } }
}
