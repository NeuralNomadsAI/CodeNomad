import { Cron } from "effect"
import type { MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { missionLaunchModel } from "../../../server/src/missions/mission-launch-kind"
import { missionHourSteps, newMissionCriterion, newMissionSchedulingDraft, type MissionCriterionDraft,
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

/** Decode a server-validated policy, including stored legacy shapes. Shapes the
 * criteria form cannot express are retained explicitly, never approximated. A legacy
 * end date or single launch on an event has no control: the unchanged policy keeps
 * it, and saving an edit writes criteria without it. */
export function decodeMissionSchedulingPolicy(policy: MissionLaunchPolicy, directory?: string,
  defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone): MissionSchedulingDraft {
  const draft = newMissionSchedulingDraft(defaultZone), model = missionLaunchModel(policy)
  draft.criteria = []
  const exact: NonNullable<MissionSchedulingDraft["stored"]>["exact"] = {}
  let reason: NonNullable<MissionSchedulingDraft["stored"]>["reason"]
  // Intervals, delays, single dates, passage limits and relative ends have no criteria control.
  const once = !model.schedules.length && model.triggers.length > 0 && "timing" in policy
  if (model.maxLaunches !== null && !once || model.endAfterMs !== null || model.schedules.some(item => item.kind !== "cron" && item.kind !== "now")) reason = "retired"
  const zones = [...new Set(model.schedules.flatMap(item => item.kind === "cron" || item.kind === "at" ? [item.zone] : []))]
  if (zones.length > 1) reason ??= "timing"
  draft.zone = zones[0] ?? defaultZone
  // Cards keep the stored order, so each one keeps its role. A legacy frequency comes
  // first and its condition below it, which makes that event a condition.
  const items = "when" in policy ? policy.when : [...model.schedules, ...model.events]
  for (const item of items) {
    if (item.kind === "now") {
      const row = newMissionCriterion("now")
      exact[row.id] = { kind: "now" }; draft.criteria.push(row)
      continue
    }
    if (item.kind === "cron") {
      const row = { ...newMissionCriterion("cron"), expression: item.expression, ...shortcut(item.expression, item.zone) }
      exact[row.id] = { kind: "cron", expression: item.expression, zone: item.zone }
      draft.criteria.push(row)
      continue
    }
    if (item.kind === "every" || item.kind === "at" || item.kind === "in") continue
    const event = item, row = newMissionCriterion(event.kind)
    switch (event.kind) {
      case "schedule-success": case "mission-completed": row.source = event.missionID; break
      case "conversation-message": row.source = event.conversationID; break
      case "branch-commits": row.source = event.ref; if (event.directory !== directory) reason ??= "source"; break
      case "files-changed": row.files = event.paths.join("\n"); break
    }
    exact[row.id] = structuredClone(event)
    draft.criteria.push(row)
  }
  if (!items.length) draft.criteria.push(newMissionCriterion("now"))
  const { stored: _stored, ...initial } = draft
  return { ...draft, stored: { policy: structuredClone(policy), initial: structuredClone(initial), exact, ...(reason ? { reason } : {}) } }
}
