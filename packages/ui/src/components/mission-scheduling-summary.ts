import type { MissionCondition, MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { missionCriteriaStructure, missionLaunchModel, type MissionLaunchSchedule } from "../../../server/src/missions/mission-launch-kind"
import { decodeMissionSchedulingPolicy } from "./mission-scheduling-decode"
import { isMissionEventKind } from "./mission-scheduling-data"

type Translate = (key: string, params?: Record<string, string>) => string

/** One readable line per launch criterion, in stored order; after the first, each
 * line is prefixed with the connector before it: "or", "if" or "else". */
export function describeMissionCriteria(policy: MissionLaunchPolicy, t: Translate, locale: string, oneShotAt?: number | null): string[] {
  const model = missionLaunchModel(policy), draft = decodeMissionSchedulingPolicy(policy, undefined, "UTC")
  const date = (at: number, zone: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(at)
  // Some runtimes lack unit data for a locale; its own label keeps the text translated.
  const minutes = (ms: number) => Intl.NumberFormat.supportedLocalesOf(locale).length
    ? new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long" }).format(ms / 60_000)
    : `${ms / 60_000} ${t("missions.scheduling.minutes")}`
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
  const cronRows = draft.criteria.filter(item => !isMissionEventKind(item.kind))
  let cronIndex = 0
  const schedule = (item: MissionLaunchSchedule) => {
    if (item.kind === "at") return `${t("missions.scheduling.frequency.at")} · ${date(oneShotAt ?? item.at, item.zone)} · ${item.zone}`
    if (item.kind === "in") return `${t("missions.scheduling.frequency.in")} · ${minutes(item.delayMs)}`
    if (item.kind === "every") return `${t("missions.scheduling.frequency.every")} · ${minutes(item.intervalMs)}`
    const row = cronRows[cronIndex++]
    const title = t(`missions.scheduling.shortcut.${row?.kind ?? "cron"}`)
    switch (row?.kind) {
      case "hours": return `${title} · ${row.hours}`
      case "daily": return `${title} · ${row.time} · ${item.zone}`
      case "weekly": return `${title} · ${row.days.map(day => weekday.format(Date.UTC(2026, 10, 1 + day))).join(", ")} · ${row.time} · ${item.zone}`
      case "monthly": return `${title} · ${row.monthDay} · ${row.time} · ${item.zone}`
      default: return `${title} · ${item.expression} · ${item.zone}`
    }
  }
  const event = (item: MissionCondition) => {
    const reference = item.kind === "files-changed" ? item.paths.join(", ") : item.kind === "branch-commits" ? item.ref.slice("refs/heads/".length)
      : item.kind === "conversation-message" ? item.conversationID : item.missionID
    return `${t(`missions.scheduling.condition.${item.kind}`)} · ${reference}`
  }
  const items: (MissionLaunchSchedule | MissionCondition)[] = "when" in policy ? policy.when : [...model.schedules, ...model.events]
  const { connectors } = missionCriteriaStructure(items, kind => ["cron", "every", "at", "in"].includes(kind))
  return items.map((item, index) => {
    const line = item.kind === "cron" || item.kind === "every" || item.kind === "at" || item.kind === "in" ? schedule(item) : event(item)
    return index === 0 ? line : `${t(`missions.scheduling.connector.${connectors[index - 1]}`)} · ${line}`
  })
}

/** The zone that dates of this policy are shown in, when it has one. */
export function missionCriteriaZone(policy: MissionLaunchPolicy): string | undefined {
  const schedule = missionLaunchModel(policy).schedules.find(item => item.kind === "cron" || item.kind === "at")
  return schedule && (schedule.kind === "cron" || schedule.kind === "at") ? schedule.zone : undefined
}
