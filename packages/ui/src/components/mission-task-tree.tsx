import { For, Show, createMemo } from "solid-js"
import { Dynamic } from "solid-js/web"
import { AlertTriangle, ArrowUpRight, Check, Circle, CircleDot, CircleSlash, Clock, MessageCircleQuestion, XCircle } from "lucide-solid"
import type { MissionActorActivity, MissionMap, MissionTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { MissionGraph, orderMissionTasks } from "./mission-graph"
import { createMissionRecoveryAction } from "./mission-recovery-button"

export type MissionTaskState = "done" | "active" | "input" | "assigned" | "ready" | "waiting" | "blocked" | "failed" | "retired"

/** One status per node. A reported blockage is "blocked"; unmet dependencies are
 * "waiting"; an open native Form/permission is "input". Admission is only
 * "assigned": observed native activity alone makes a task "active". */
export function missionTaskState(task: MissionTask, activity?: MissionActorActivity["state"]): MissionTaskState {
  if (task.status === "completed") return "done"
  if (task.status === "withdrawn" || task.replacedByTaskKey) return "retired"
  if (task.status === "failed") return "failed"
  if (task.actorSessionId && (activity === "form" || activity === "permission")) return "input"
  if (task.status === "needs-input") return "blocked"
  if (task.status === "blocked") return "waiting"
  if (task.actorSessionId && (activity === "running" || activity === "background")) return "active"
  if (task.status === "dispatching" || task.status === "queued") return "assigned"
  return "ready"
}

const ICONS = { done: Check, active: CircleDot, input: MessageCircleQuestion, assigned: Circle, ready: Circle,
  waiting: Clock, blocked: AlertTriangle, failed: XCircle, retired: CircleSlash }

/** The Mission's single task view: declared dependencies drawn beside one row
 * per task, each row a status icon and title toggling the exact task reader. */
export function MissionTaskTree(props: {
  mission: MissionMap; instanceId: string; activity?: MissionActorActivity[]
  reading: (task: MissionTask) => boolean; onRead: (task: MissionTask) => void
  /** The task's exact owned conversation, once one is known. */
  conversation: (task: MissionTask) => string | undefined; onOpenConversation: (sessionId: string) => void
  disabled?: boolean; onRecoveryAdmitted?: () => void | Promise<void>
}) {
  const { t } = useI18n()
  let list!: HTMLUListElement
  const ordered = createMemo(() => orderMissionTasks(props.mission.tasks))
  const linked = () => props.mission.tasks.some(task => task.blockedBy.length)
  return <section class="mission-tree" aria-label={t("missionsPanel.tasks")}>
    <Show when={ordered().length} fallback={<p class="mission-control-empty-line">{t(props.mission.runState === "prepared"
      ? "missions.progress.prepared" : "missions.progress.noPlan")}</p>}>
      <div class="mission-flow" classList={{ "mission-flow-linked": linked() }}>
        <ul ref={list} class="mission-tree-list"><For each={ordered().map(task => task.id)}>{id => {
          const task = () => props.mission.tasks.find(task => task.id === id)!
          const activity = () => props.activity?.find(value => value.sessionId === task().actorSessionId)?.state
          const state = () => missionTaskState(task(), activity())
          const word = () => t(`missionsPanel.task.${state()}`)
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
          return <li class="mission-tree-node" data-task-key={task().key} data-status={task().status} data-state={state()}>
            <button type="button" class="mission-tree-task icon-toggle" aria-pressed={props.reading(task())}
              title={`${task().title} · ${word()}`} onClick={() => props.onRead(task())}>
              <span class="mission-tree-mark" data-graph-anchor aria-hidden="true"><Dynamic component={ICONS[state()]} class="h-3.5 w-3.5" /></span>
              <span class="mission-tree-title">{task().title}</span>
              <span class="sr-only">{word()}</span>
            </button>
            <Show when={props.conversation(task())}>{id => <button type="button" class="mission-tree-open"
              aria-label={t("missionsPanel.task.openConversation")} title={t("missionsPanel.task.openConversation")}
              onClick={() => props.onOpenConversation(id())}><ArrowUpRight class="h-3.5 w-3.5" aria-hidden="true" /></button>}</Show>
            <Show when={recover()}>{action => <div class="mission-tree-recovery">
              <button type="button" class="window-text-button" disabled={action().disabled} aria-description={action().description}
                onClick={() => void action().onSelect()}>{action().label}</button>{recovery.feedback}</div>}</Show>
          </li>
        }}</For></ul>
        <Show when={linked()}><MissionGraph tasks={ordered()} list={list} /></Show>
      </div>
    </Show>
  </section>
}
