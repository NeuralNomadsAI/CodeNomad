import { For, Show, createMemo } from "solid-js"
import type { MissionCalendarView } from "../../../server/src/opencode/mission-calendars"
import { useI18n } from "../lib/i18n"
import { missionProgramming } from "./mission-programming-model"

/** The programming of the selected programmed Mission: when it launches, its state and its past launches. Its toolbar commands it. */
export function MissionProgramming(props: { calendar: MissionCalendarView; failed?: boolean }) {
  const { t, locale } = useI18n()
  const model = createMemo(() => missionProgramming(props.calendar, t, locale()))
  return <section class="mission-unified-schedule" aria-label={t("missions.scheduling.title")}>
    <dl class="mission-schedule-facts">
      <dt>{t("missions.scheduling.when")}</dt><dd><bdi>{model().criteria}</bdi></dd>
      <dt>{t("missions.scheduleList.desired")}</dt><dd>{model().state}</dd>
      <dt>{model().nextLabel}</dt><dd><bdi>{model().next}</bdi></dd>
      <dt>{t("missions.scheduleList.launched")}</dt><dd>{model().launches}</dd>
    </dl>
    <Show when={props.failed}><p class="mission-control-stale" role="alert">{t("missions.control.mutation.error")}</p></Show>
    <section class="mission-past-runs" aria-label={t("missionsPanel.pastRuns")}><h3>{t("missionsPanel.pastRuns")}</h3>
      <Show when={model().runs.length} fallback={<p>{t("missionsPanel.schedule.noRuns")}</p>}><ol><For each={model().runs}>{run => <li>{run}</li>}</For></ol></Show>
    </section>
  </section>
}
