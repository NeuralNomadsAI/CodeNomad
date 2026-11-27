import type { MissionCalendarView } from "../../../server/src/opencode/mission-calendars"
import { describeMissionCriteria, missionCriteriaZone } from "./mission-scheduling-summary"

type Translate = (key: string, params?: Record<string, string>) => string
const RUN_OUTCOMES = ["completed", "failed", "stopped"]

/** What the panel shows of a programmed Mission's programming. */
export function missionProgramming(calendar: MissionCalendarView, t: Translate, locale: string) {
  const policy = calendar.launch
  const zone = policy && missionCriteriaZone(policy)
  const date = (at: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", ...(zone ? { timeZone: zone } : {}) }).format(at)
  const due = calendar.rules.flatMap(rule => rule.nextDueAt === undefined ? [] : [rule.nextDueAt])
  // Events alone are looked at on an interval; a date is a wake.
  const nextLabel = t(calendar.rules.every(rule => rule.trigger.type === "every") ? "missions.scheduleList.nextCheck" : "missions.scheduleList.nextWake")
  const next = calendar.paused || !due.length ? t("missions.scheduleList.none") : date(Math.min(...due))
  const criteria = policy ? describeMissionCriteria(policy, t, locale).join("; ") : ""
  return {
    criteria, nextLabel, next, launches: calendar.last?.launches ?? 0,
    state: t(`missions.scheduleList.state.${calendar.paused ? "paused" : "running"}`),
    /** The Mission row's additions. */
    row: [criteria, calendar.paused ? t("missions.scheduleList.state.paused") : `${nextLabel} · ${next}`].filter(Boolean),
    /** Past launches, newest first: a Mission removed before it ended reads as stopped. */
    runs: [...calendar.last?.history ?? []].reverse().map(run =>
      `${date(run.at)} · ${t(`missionsPanel.run.${RUN_OUTCOMES.includes(run.outcome) ? run.outcome : "stopped"}`)}`),
  }
}

/** Follows a programmed Mission to its next launch: the Mission that replaced `selected`, when one did. */
export function missionProgrammingSuccessor(before: readonly Pick<MissionCalendarView, "id" | "missionID">[],
  after: readonly Pick<MissionCalendarView, "id" | "missionID">[], selected: string | undefined): string | undefined {
  const calendar = selected && before.find(item => item.missionID === selected)?.id
  const next = calendar ? after.find(item => item.id === calendar)?.missionID : undefined
  return next && next !== selected ? next : undefined
}
