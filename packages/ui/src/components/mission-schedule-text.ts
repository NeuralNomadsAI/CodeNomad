import type { RecurrenceSchedule } from "../stores/mission-recurrence"
import { missionClockTime, missionScheduleWhen, missionZoneDiffers, missionZoneName } from "../lib/mission-display"

type Translate = (key: string, vars?: Record<string, string | number>) => string
type Receipt = RecurrenceSchedule["history"][number]

/** Plain schedule wording shared by the panel and the central reader. Every
 * time is shown in the schedule's own zone, labelled only when it differs. */
export function missionScheduleText(t: Translate, locale: () => string) {
  const zoned = (schedule: RecurrenceSchedule, text: string, at?: number) => missionZoneDiffers(schedule.clock.zone, undefined, at)
    ? t("missionsPanel.schedule.zoned", { time: text, zone: missionZoneName(schedule.clock.zone, locale(), at) }) : text
  const date = (schedule: RecurrenceSchedule, at: number) => {
    let text: string
    try { text = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: schedule.clock.zone }).format(at) }
    catch { text = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(at) }
    return zoned(schedule, text, at)
  }
  return {
    clock: (schedule: RecurrenceSchedule) => missionClockTime(schedule.clock.time, locale()),
    every: (schedule: RecurrenceSchedule) => t("missionsPanel.schedule.every", { time: zoned(schedule, missionClockTime(schedule.clock.time, locale())) }),
    next: (schedule: RecurrenceSchedule) => schedule.state === "running" && schedule.nextDueAt !== null
      ? t("missionsPanel.schedule.nextRow", { when: zoned(schedule, t("missionsPanel.schedule.when",
        missionScheduleWhen(schedule.nextDueAt, schedule.clock.zone, locale())), schedule.nextDueAt) }) : undefined,
    date,
    outcome: (receipt: Receipt) => t(`missionsPanel.run.${receipt.reason ?? receipt.outcome}`),
    run: (schedule: RecurrenceSchedule, receipt: Receipt) => [date(schedule, receipt.dueAt), t(`missionsPanel.run.${receipt.reason ?? receipt.outcome}`),
      ...(receipt.trigger === "manual" ? [t("missions.recurrence.trigger.manual")] : [])].join(" · "),
  }
}
