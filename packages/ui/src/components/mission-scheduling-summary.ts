import type { MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { missionLaunchModel } from "../../../server/src/missions/mission-launch-kind"
import { decodeMissionSchedulingPolicy } from "./mission-scheduling-decode"
import { isMissionEventKind } from "./mission-scheduling-data"

type Translate = (key: string, params?: Record<string, string>) => string

/** One readable line per launch criterion, in stored order: schedules, then events. */
export function describeMissionCriteria(policy: MissionLaunchPolicy, t: Translate, locale: string, oneShotAt?: number | null): string[] {
  const model = missionLaunchModel(policy), draft = decodeMissionSchedulingPolicy(policy, undefined, "UTC")
  const date = (at: number, zone: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(at)
  // Some runtimes lack unit data for a locale; its own label keeps the text translated.
  const minutes = (ms: number) => Intl.NumberFormat.supportedLocalesOf(locale).length
    ? new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long" }).format(ms / 60_000)
    : `${ms / 60_000} ${t("missions.scheduling.minutes")}`
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
  const lines = model.schedules.map((schedule, index) => {
    if (schedule.kind === "at") return `${t("missions.scheduling.frequency.at")} · ${date(oneShotAt ?? schedule.at, schedule.zone)} · ${schedule.zone}`
    if (schedule.kind === "in") return `${t("missions.scheduling.frequency.in")} · ${minutes(schedule.delayMs)}`
    if (schedule.kind === "every") return `${t("missions.scheduling.frequency.every")} · ${minutes(schedule.intervalMs)}`
    const row = draft.criteria.filter(item => !isMissionEventKind(item.kind))[index]
    const title = t(`missions.scheduling.shortcut.${row?.kind ?? "cron"}`)
    switch (row?.kind) {
      case "hours": return `${title} · ${row.hours}`
      case "daily": return `${title} · ${row.time} · ${schedule.zone}`
      case "weekly": return `${title} · ${row.days.map(day => weekday.format(Date.UTC(2026, 10, 1 + day))).join(", ")} · ${row.time} · ${schedule.zone}`
      case "monthly": return `${title} · ${row.monthDay} · ${row.time} · ${schedule.zone}`
      default: return `${title} · ${schedule.expression} · ${schedule.zone}`
    }
  })
  for (const event of model.events) {
    const reference = event.kind === "files-changed" ? event.paths.join(", ") : event.kind === "branch-commits" ? event.ref.slice("refs/heads/".length)
      : event.kind === "conversation-message" ? event.conversationID : event.missionID
    lines.push(`${t(`missions.scheduling.condition.${event.kind}`)} · ${reference}`)
  }
  return lines
}

/** The zone that dates of this policy are shown in, when it has one. */
export function missionCriteriaZone(policy: MissionLaunchPolicy): string | undefined {
  const schedule = missionLaunchModel(policy).schedules.find(item => item.kind === "cron" || item.kind === "at")
  return schedule && (schedule.kind === "cron" || schedule.kind === "at") ? schedule.zone : undefined
}
