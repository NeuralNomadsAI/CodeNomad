import { For, Show, createMemo } from "solid-js"
import { AlertTriangle, Check, Circle, CircleDot } from "lucide-solid"
import type { MissionActorActivity, MissionMap, MissionTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { orderMissionTasks } from "./mission-graph"
import { createMissionRecoveryAction } from "./mission-recovery-button"
import { missionProgress } from "./mission-progress-model"

type TaskWord = "active" | "assigned" | "ready" | "waiting" | "blocked" | "failed"

/** Plain status words; completed tasks show only their check mark. A reported
 * blockage is "blocked"; unmet dependencies are "waiting". Admission is only
 * "assigned": observed native activity alone makes a task "active". */
function taskWord(task: MissionTask, activity?: MissionActorActivity["state"]): TaskWord | undefined {
  if (task.status === "completed") return undefined
  if (task.status === "failed") return "failed"
  if (task.status === "needs-input") return "blocked"
  if (task.status === "blocked") return "waiting"
  if (task.actorSessionId && (activity === "running" || activity === "background")) return "active"
  if (task.status === "dispatching" || task.status === "queued") return "assigned"
  return "ready"
}

/** Current plan as a checklist. Each row toggles the exact task reader. */
export function MissionTaskChecklist(props: {
  mission: MissionMap; instanceId: string; activity?: MissionActorActivity[]
  reading: (task: MissionTask) => boolean; onRead: (task: MissionTask) => void
  disabled?: boolean; onRecoveryAdmitted?: () => void | Promise<void>
}) {
  const { t, locale } = useI18n()
  const progress = createMemo(() => missionProgress(props.mission, props.activity))
  const current = createMemo(() => new Set(progress().tasks.map(task => task.id)))
  const ordered = createMemo(() => orderMissionTasks(props.mission.tasks).filter(task => current().has(task.id)))
  return <section class="mission-checklist" aria-label={t("missionsPanel.tasks")}>
    <h3>{t("missionsPanel.tasks")}<Show when={progress().tasks.length}>
      <small>{progress().completed.toLocaleString(locale())}/{progress().tasks.length.toLocaleString(locale())}</small></Show></h3>
    <Show when={ordered().length} fallback={<p class="mission-control-empty-line">{t(props.mission.runState === "prepared"
      ? "missions.progress.prepared" : "missions.progress.noPlan")}</p>}>
      <ul><For each={ordered().map(task => task.id)}>{id => {
        const task = () => props.mission.tasks.find(task => task.id === id)!
        const activity = () => props.activity?.find(value => value.sessionId === task().actorSessionId)?.state
        const word = () => taskWord(task(), activity())
        const recovery = createMissionRecoveryAction({
          get instanceId() { return props.instanceId },
          get mission() { return props.mission },
          target: "report",
          get taskKey() { return task().key },
          get disabled() { return props.disabled },
          get activity() { return activity() },
          onAdmitted: () => props.onRecoveryAdmitted?.(),
        })
        const recover = () => props.onRecoveryAdmitted ? recovery.action() : undefined
        return <li data-task-key={task().key} data-status={task().status}>
          <button type="button" class="mission-checklist-task icon-toggle" aria-pressed={props.reading(task())}
            data-word={word() ?? "done"} onClick={() => props.onRead(task())}>
            <span class="mission-checklist-mark" aria-hidden="true">{word() === undefined ? <Check class="h-3.5 w-3.5" />
              : word() === "active" ? <CircleDot class="h-3.5 w-3.5" />
              : word() === "failed" || word() === "blocked" ? <AlertTriangle class="h-3.5 w-3.5" /> : <Circle class="h-3.5 w-3.5" />}</span>
            <span class="mission-checklist-title">{task().title}</span>
            <Show when={word()} fallback={<span class="sr-only">{t("missionsPanel.task.done")}</span>}>
              {value => <span class="mission-checklist-word">{t(`missionsPanel.task.${value()}`)}</span>}</Show>
          </button>
          <Show when={recover()}>{action => <div class="mission-checklist-recovery">
            <button type="button" class="window-text-button" disabled={action().disabled} aria-description={action().description}
              onClick={() => void action().onSelect()}>{action().label}</button>{recovery.feedback}</div>}</Show>
        </li>
      }}</For></ul>
    </Show>
  </section>
}
