import { For, Show, createMemo } from "solid-js"
import { ArrowUpRight } from "lucide-solid"
import type { MissionActorActivity, MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { missionExcerpt, missionProgress } from "./mission-progress-model"

export function MissionProgress(props: {
  mission: MissionMap; activity?: MissionActorActivity[]
  onReadOverview: () => void
  onOpenActor: (sessionId: string) => Promise<void>
}) {
  const { t } = useI18n()
  const progress = createMemo(() => missionProgress(props.mission, props.activity))
  const status = () => props.mission.status !== "active" ? `missions.control.status.${props.mission.status}`
    : props.mission.runState === "prepared" || props.mission.runState === "paused"
      ? `missions.control.run.${props.mission.runState}`
      : progress().activeWorkers.length || progress().coordinatorWorking ? "missions.progress.working" : "missions.progress.unconfirmed"
  return <section class="mission-progress" aria-label={t("missions.progress.title")}>
    <h3>{t("missions.progress.title")}</h3>
    <p class="mission-progress-state">{t(status())}</p>
    <Show when={props.mission.summary}>{summary => <button type="button" class="mission-progress-result" onClick={props.onReadOverview} title={summary()}>
      <span class="mission-progress-label">{t("missions.progress.outcome")}</span>
      <span class="mission-progress-summary">{missionExcerpt(summary())}</span>
    </button>}</Show>
    <Show when={progress().tasks.length} fallback={<p>{t(props.mission.runState === "prepared"
      ? "missions.progress.prepared" : "missions.progress.noPlan")}</p>}>
      <p>{t("missions.progress.counts", { completed: progress().completed, remaining: progress().open.length })}</p>
    </Show>
    <Show when={progress().activeWorkers.length}><div class="mission-progress-tasks"><span>{t("missions.progress.now")}</span>
      <For each={progress().activeWorkers}>{worker => {
        const title = () => props.mission.actors.find(actor => actor.sessionId === worker.sessionId)?.title ?? worker.sessionId
        return <button type="button" class="mission-inline-session"
          aria-label={t("missions.control.actor.open", { actor: title() })}
          onClick={() => void props.onOpenActor(worker.sessionId)}>
          <span>{title()}</span><ArrowUpRight class="h-3 w-3" aria-hidden="true" />
        </button>
      }}</For>
    </div></Show>
  </section>
}
