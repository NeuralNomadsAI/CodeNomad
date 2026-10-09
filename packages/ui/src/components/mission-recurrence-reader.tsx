import { For, Show } from "solid-js"
import type { RecurrenceSchedule } from "../stores/mission-recurrence"
import { useI18n } from "../lib/i18n"
import { MissionRecurrencePassageReader } from "./mission-recurrence-passage-reader"
import { missionScheduleText } from "./mission-schedule-text"

/** Central schedule reader in the one-time overview's plain grammar: the rule,
 * the selected run's result, every run, and identifiers folded at the bottom. */
export function MissionRecurrenceReader(props: {
  instanceId: string; scope: string; projectID: string; schedule: RecurrenceSchedule
  passageID?: string; onSelect: (passageID: string) => void
}) {
  const { t, locale } = useI18n()
  const text = missionScheduleText(t, locale)
  const selectedID = () => props.passageID ?? props.schedule.latestResult?.passageID
  const selected = () => props.schedule.history.find(receipt => receipt.passageID === selectedID())
  const notice = () => props.schedule.interruptionReason === "service-restart" ? "missions.recurrence.interruptedRestart"
    : props.schedule.interruptionReason === "error" ? "missions.recurrence.interruptedError" : undefined
  return <div class="mission-recurrence-reader">
    <p class="mission-recurrence-rule"><bdi>{text.every(props.schedule)}</bdi>{" · "}
      <Show when={text.next(props.schedule)} fallback={t(`missions.recurrence.state.${props.schedule.state}`)}>{next => <bdi>{next()}</bdi>}</Show></p>
    <Show when={notice()}>{key => <p role="status">{t(key())}</p>}</Show>
    <Show when={selected()} fallback={<p>{t("missionsPanel.schedule.noRuns")}</p>}>{receipt => <section class="mission-recurrence-run"
      aria-label={t("missionsPanel.reader.runOf", { when: text.date(props.schedule, receipt().dueAt) })}>
      <h3>{t("missionsPanel.reader.runOf", { when: text.date(props.schedule, receipt().dueAt) })} · {text.outcome(receipt())}</h3>
      <Show when={receipt().missionID}><MissionRecurrencePassageReader instanceId={props.instanceId} scope={props.scope}
        projectID={props.projectID} scheduleID={props.schedule.id} receipt={receipt()} /></Show>
    </section>}</Show>
    <Show when={props.schedule.history.length}>
      <h3>{t("missionsPanel.pastRuns")}</h3>
      <ol class="mission-recurrence-runs"><For each={[...props.schedule.history].reverse()}>{receipt => <li>
        <button type="button" class="mission-past-run icon-toggle" data-passage-id={receipt.passageID} aria-pressed={selectedID() === receipt.passageID}
          onClick={() => props.onSelect(receipt.passageID)}><bdi>{text.run(props.schedule, receipt)}</bdi></button>
      </li>}</For></ol>
    </Show>
    <details class="mission-report-technical"><summary>{t("missionsPanel.technical")}</summary>
      <dl class="mission-technical">
        <dt>{t("missionsPanel.technical.schedule")}</dt><dd><bdi>{props.schedule.id}</bdi></dd>
        <Show when={selected()}>{receipt => <>
          <dt>{t("missionsPanel.technical.passage")}</dt><dd><bdi>{receipt().passageID}</bdi></dd>
          <dt>{t("missionsPanel.technical.due")}</dt><dd><time dateTime={new Date(receipt().dueAt).toISOString()}>{text.date(props.schedule, receipt().dueAt)}</time></dd>
          <dt>{t("missionsPanel.technical.settled")}</dt><dd><time dateTime={new Date(receipt().settledAt).toISOString()}>{text.date(props.schedule, receipt().settledAt)}</time></dd>
          <Show when={receipt().missionID}><dt>{t("missionsPanel.technical.mission")}</dt><dd><bdi>{receipt().missionID}</bdi></dd></Show>
          <Show when={receipt().conversationID}><dt>{t("missionsPanel.technical.conversation")}</dt><dd><bdi>{receipt().conversationID}</bdi></dd></Show>
        </>}</Show>
      </dl>
    </details>
  </div>
}
