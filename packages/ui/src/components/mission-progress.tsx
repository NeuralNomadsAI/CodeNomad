import { For, Show, createMemo } from "solid-js"
import { ArrowUpRight } from "lucide-solid"
import type { MissionActorActivity, MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { missionProgress } from "./mission-progress-model"

export function MissionProgress(props: {
  mission: MissionMap; activity?: MissionActorActivity[]
  observedAt?: number
  onOpenActor: (sessionId: string) => Promise<void>
}) {
  const { t, locale } = useI18n()
  const progress = createMemo(() => missionProgress(props.mission, props.activity))
  const idle = () => {
    const ids = [...new Set([props.mission.coordinatorSessionId, ...props.mission.actors.map(actor => actor.sessionId)])]
    return ids.every(id => props.activity?.some(actor => actor.sessionId === id && actor.state === "idle-without-report"))
  }
  const status = () => props.mission.status !== "active" ? `missions.control.status.${props.mission.status}`
    : props.mission.runState === "prepared" || props.mission.runState === "paused"
      ? `missions.control.run.${props.mission.runState}`
      : progress().activeWorkers.length || progress().coordinatorWorking ? "missions.progress.working"
        : idle() ? "missions.tracking.idle" : "missions.progress.unconfirmed"
  return <section class="mission-progress" aria-label={t("missions.progress.title")}>
    <p class="mission-progress-state" title={props.observedAt ? t("missions.tracking.observed", { date: new Date(props.observedAt).toLocaleString(locale()) }) : undefined}>{t(status())}</p>
    <Show when={props.observedAt}><time class="sr-only" dateTime={new Date(props.observedAt!).toISOString()}>
      {t("missions.tracking.observed", { date: new Date(props.observedAt!).toLocaleString(locale()) })}
    </time></Show>
    <Show when={progress().tasks.length} fallback={<p>{t(props.mission.runState === "prepared"
      ? "missions.progress.prepared" : "missions.progress.noPlan")}</p>}>
      <p title={t("missions.tracking.countHint")} aria-description={t("missions.tracking.countHint")}>{t("missions.progress.counts", { completed: progress().completed, remaining: progress().open.length })}</p>
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
    <Show when={props.mission.status === "active" && progress().tasks.length && !progress().open.length}>
      <p class="mission-tracking-finish">{t("missions.tracking.awaitingFinal")}</p>
    </Show>
  </section>
}
