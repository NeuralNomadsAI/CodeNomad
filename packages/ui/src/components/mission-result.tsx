import { Show, createMemo, type JSX } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { missionExcerpt, missionProgress } from "./mission-progress-model"
import { missionBriefingFreshness } from "./mission-briefing-model"
import { missionRelativeTime } from "../lib/mission-display"

/** Result or current state in a few plain lines. The full overview stays in the
 * central reader, opened and hidden by the highlighted "Read all" toggle. */
export function MissionResult(props: {
  mission: MissionMap; reading: boolean; onReadAll: () => void; feedback?: JSX.Element
}) {
  const { t, locale } = useI18n()
  const progress = createMemo(() => missionProgress(props.mission))
  const briefing = () => props.mission.summary ? undefined : props.mission.briefing
  const text = () => missionExcerpt(props.mission.summary ?? briefing()?.summary ?? props.mission.objective)
  const freshness = createMemo(() => missionBriefingFreshness(props.mission))
  return <section class="mission-result" aria-label={t(props.mission.summary ? "missionsPanel.result" : "missionsPanel.currentState")}>
    <p class="mission-result-text" title={text()}>{text()}</p>
    <p class="mission-result-meta">
      <Show when={!props.mission.summary && progress().tasks.length}>
        <span>{t("missionsPanel.tasksDone", { done: progress().completed.toLocaleString(locale()), total: progress().tasks.length.toLocaleString(locale()) })}</span>
      </Show>
      <Show when={briefing()}>{value => <span title={new Date(value().createdAt).toLocaleString(locale())}>
        {t("missionsPanel.briefingAt", { time: missionRelativeTime(value().createdAt, locale()) })}</span>}</Show>
      <button type="button" class="window-text-button icon-toggle mission-result-read" aria-pressed={props.reading}
        onClick={() => props.onReadAll()}>{t("missionsPanel.readAll")}</button>
    </p>
    <Show when={briefing() && freshness().changed}><p class="mission-briefing-stale" role="status">{t(freshness().results
      ? freshness().results === 1 ? "missions.briefing.newResults.one" : "missions.briefing.newResults.other"
      : "missions.briefing.changed", { count: freshness().results })}</p></Show>
    <Show when={props.mission.status === "active" && progress().tasks.length && !progress().open.length}>
      <p class="mission-result-note">{t("missions.tracking.awaitingFinal")}</p>
    </Show>
    {props.feedback}
  </section>
}
