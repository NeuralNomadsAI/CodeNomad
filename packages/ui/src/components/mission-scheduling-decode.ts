import { Cron } from "effect"
import type { MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { missionSchedulingPolicy, newMissionSchedulingDraft, type MissionSchedulingDraft, type MissionSchedulingFields } from "./mission-scheduling-data"

/** Recognize only calendars with exactly the semantics of a simple control.
 * The original expression remains stored, including aliases and field spelling. */
function simpleCron(expression: string, zone: string): Partial<MissionSchedulingFields> | undefined {
  const cron = Cron.parseUnsafe(expression, zone)
  if (cron.minutes.size !== 1 || cron.hours.size !== 1) return undefined
  const minute = [...cron.minutes][0], hour = [...cron.hours][0]
  const times = [`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`]
  const prefix = `${minute} ${hour}`
  const equals = (value: string) => Cron.equals(cron, Cron.parseUnsafe(value, zone))
  if (equals(`${prefix} * * *`)) return { frequency: "daily", times }
  const days = [...cron.weekdays].sort()
  if (days.length && equals(`${prefix} * * ${days.join(",")}`)) return { frequency: "weekly", times, days }
  const monthDay = [...cron.days][0]
  if (cron.days.size === 1 && equals(`${prefix} ${monthDay} * *`)) return { frequency: "monthly", times, monthDay: String(monthDay) }
  return undefined
}

function localMinute(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at)
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)!.value
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`
}

/** Decode a server-validated policy. Unsupported native shapes are retained
 * explicitly; a form must never approximate them into a different schedule. */
export function decodeMissionSchedulingPolicy(policy: MissionLaunchPolicy, directory?: string,
  defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone): MissionSchedulingDraft {
  const draft = newMissionSchedulingDraft(defaultZone), timing = policy.timing
  let reason: NonNullable<MissionSchedulingDraft["stored"]>["reason"]
  const duration = (ms: number) => {
    if (ms % 60_000) { reason = "precision"; return }
    draft.unit = ms % 3_600_000 === 0 ? "hours" : "minutes"
    draft.amount = String(ms / (draft.unit === "hours" ? 3_600_000 : 60_000))
  }
  switch (timing.kind) {
    case "immediate": break
    case "at": draft.frequency = "at"; draft.zone = timing.zone; draft.date = localMinute(timing.at, timing.zone); break
    case "in": draft.frequency = "in"; duration(timing.delayMs); break
    case "every": draft.frequency = "every"; duration(timing.intervalMs); break
    case "cron": {
      draft.zone = timing.zone; draft.expression = timing.expression
      Object.assign(draft, simpleCron(timing.expression, timing.zone) ?? { frequency: "cron" })
      break
    }
    case "multi": {
      draft.frequency = "multi"; draft.zone = timing.calendars[0].zone
      const calendars = timing.calendars.map(item => simpleCron(item.expression, item.zone))
      if (timing.calendars.some(item => item.zone !== draft.zone) || calendars.some(item => item?.frequency !== "daily")) reason = "timing"
      else draft.times = calendars.map(item => item!.times![0]).sort()
      break
    }
  }
  const condition = policy.condition
  draft.condition = condition?.kind ?? "none"
  if (condition) switch (condition.kind) {
    case "schedule-success": case "mission-completed": draft.source = condition.missionID; break
    case "conversation-message": draft.source = condition.conversationID; break
    case "branch-commits": draft.source = condition.ref; if (condition.directory !== directory) reason = "source"; break
    case "files-changed": draft.files = condition.paths.join("\n"); break
  }
  draft.endAt = policy.ends.at === null ? "" : localMinute(policy.ends.at, draft.zone)
  draft.endAfter = policy.ends.afterMs === null ? "" : String(policy.ends.afterMs / 3_600_000)
  draft.maxLaunches = policy.ends.maxLaunches === null ? "" : String(policy.ends.maxLaunches)
  // Civil minute controls cannot encode sub-minute precision, a repeated hour's
  // second instant, or a fractional-hour end duration. Keep their exact policy.
  if (!reason) try {
    const encoded = missionSchedulingPolicy(draft, directory)
    if (timing.kind === "at" && encoded.timing.kind === "at" && encoded.timing.at !== timing.at
      || encoded.ends.at !== policy.ends.at || encoded.ends.afterMs !== policy.ends.afterMs) reason = "precision"
  } catch { reason = "precision" }
  return { ...draft, stored: { policy: structuredClone(policy), initial: structuredClone(draft), ...(reason ? { reason } : {}) } }
}
