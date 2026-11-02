import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import { Dynamic } from "solid-js/web"
import { AlertTriangle, ArrowUpRight, Check, ChevronRight, Circle, CircleDot, CircleSlash, Clock, MessageCircleQuestion, XCircle } from "lucide-solid"
import type { MissionActorActivity, MissionPanelMap, MissionPanelTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { instances } from "../stores/instances"
import { missionDerivedSessionActive } from "../stores/mission-task-sessions"
import { sessions } from "../stores/session-state"
import { missionProjectView, updateMissionProjectView } from "../stores/mission-view-state"
import { MissionGraph, orderMissionTasks } from "./mission-graph"
import { createMissionRecoveryAction } from "./mission-recovery-button"
import { missionPanelScroll } from "./mission-panel-scroll"
import { missionStore } from "../stores/missions"
import type { MissionTaskRequest } from "../../../server/src/missions/mission-panel-map"
import { SettingsInfoTip } from "./settings/settings-info-tip"

export type MissionTaskState = "done" | "active" | "input" | "assigned" | "ready" | "waiting" | "blocked" | "failed" | "retired"

/** One status per node. A reported blockage is "blocked"; unmet dependencies are
 * "waiting"; an open native Form/permission is "input". Admission is only
 * "assigned": observed native activity of the task's own conversation alone
 * makes a task "active". */
export function missionTaskState(task: MissionPanelTask, activity?: MissionActorActivity["state"]): MissionTaskState {
  if (task.status === "completed") return "done"
  if (task.status === "withdrawn" || task.replacedByTaskKey) return "retired"
  if (task.status === "failed") return "failed"
  if (activity === "form" || activity === "permission") return "input"
  if (task.status === "needs-input") return "blocked"
  if (task.status === "blocked") return "waiting"
  if (activity === "running" || activity === "background") return "active"
  if (task.status === "dispatching" || task.status === "queued") return "assigned"
  return "ready"
}

/** A natively delegated task has no declared actor: the live status of its exact
 * linked conversation stands in. Loaded sessions supply open requests; the native
 * active set covers children the session list has not loaded. */
function conversationActivity(instanceId: string, mission: MissionPanelMap, sessionId: string): MissionActorActivity["state"] | undefined {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (session?.pendingPermission) return "permission"
  if (session?.pendingForm) return "form"
  return session?.status === "working" || session?.status === "compacting"
    || missionDerivedSessionActive(instanceId, mission, sessionId) ? "running" : undefined
}

const ICONS = { done: Check, active: CircleDot, input: MessageCircleQuestion, assigned: Circle, ready: Circle,
  waiting: Clock, blocked: AlertTriangle, failed: XCircle, retired: CircleSlash }

/** The Mission's single task view: declared dependencies drawn beside one row
 * per task, each row a status icon and title toggling the exact task reader. */
export function MissionTaskTree(props: {
  mission: MissionPanelMap; instanceId: string; activity?: MissionActorActivity[]
  reading: (task: MissionPanelTask) => boolean; onRead: (task: MissionPanelTask) => void
  /** The task's exact owned conversation, once one is known. */
  conversation: (task: MissionPanelTask) => string | undefined; onOpenConversation: (sessionId: string) => void
  active?: boolean; disabled?: boolean; onRecoveryAdmitted?: () => void | Promise<void>
}) {
  const { t } = useI18n()
  let list!: HTMLUListElement
  // A compact map holds a page of its tasks, each with its place in the whole display order;
  // a passage's full map holds them all.
  const page = () => props.mission.taskPage
  const ordered = createMemo(() => page() ? props.mission.tasks : orderMissionTasks(props.mission.tasks))
  const total = () => page()?.total ?? ordered().length
  // Pins stay in the same tree. Continue at the first unread position, without
  // turning each gap between pins into a separate row or control.
  const nextOffset = createMemo(() => {
    let cursor = 0
    for (const task of ordered()) {
      if (task.order !== undefined && task.order > cursor) return cursor
      if (task.order !== undefined) cursor = task.order + 1
    }
    return page() && total() > cursor ? cursor : undefined
  })
  const entries = createMemo(() => ordered().map(task => task.id))
  // Rows read their task and actor activity by identity: hundreds of rows stay linear.
  const byID = createMemo(() => new Map(props.mission.tasks.map(task => [task.id, task])))
  const activities = createMemo(() => new Map(props.activity?.map(value => [value.sessionId, value.state])))
  // Dependencies and dependents of a shown row that are not shown, from its whole map.
  const omitted = createMemo(() => {
    const keys = new Set(ordered().map(task => task.key)), shown = new Map<string, number>()
    for (const task of ordered()) for (const key of new Set(task.blockedBy)) if (keys.has(key)) shown.set(key, (shown.get(key) ?? 0) + 1)
    return new Map(page() ? ordered().map(task => [task.key, {
      dependencies: new Set(task.blockedBy.filter(key => !keys.has(key))).size, dependents: Math.max(0, (task.dependents ?? 0) - (shown.get(task.key) ?? 0)),
    }]) : [])
  })
  const linked = () => props.mission.tasks.some(task => task.blockedBy.length || task.dependents)
  const read = () => missionStore.state(props.instanceId).taskReads?.[props.mission.id]
  const readFurther = (request: MissionTaskRequest) => void missionStore.loadTasks(props.instanceId, props.mission.id, request)
  // The header supplies whole-mission counts. Ordinary windows do not identify
  // their place in the attention sequence, so never label these counts as unread.
  const attention = () => page()?.attention?.omitted && ordered().length < total() ? page()!.attention!.counts : undefined
  const omittedText = (task: MissionPanelTask) => {
    const value = omitted().get(task.key)
    return [value?.dependencies ? t(`missionsPanel.task.omittedDependencies.${value.dependencies === 1 ? "one" : "other"}`, { count: value.dependencies }) : "",
      value?.dependents ? t(`missionsPanel.task.omittedDependents.${value.dependents === 1 ? "one" : "other"}`, { count: value.dependents }) : ""].filter(Boolean).join(" · ")
  }
  const id = `mission-tree-${createUniqueId()}`
  // Per project, like the picker list: the folder scope survives instance restarts.
  const scope = () => instances().get(props.instanceId)?.folder ?? props.instanceId
  const open = () => missionProjectView(scope()).tasksCollapsed !== true
  let root!: HTMLElement
  const panelScrolls = missionPanelScroll(() => root, () => props.active ?? true)
  const [sentinel, setSentinel] = createSignal<HTMLLIElement>()
  const loadNext = () => {
    const offset = nextOffset()
    if (props.active !== false && open() && offset !== undefined && !read()?.loading) readFurther({ offset })
  }
  createEffect(() => {
    const target = sentinel(), offset = nextOffset()
    if (!target || props.active === false || !open() || offset === undefined || read()?.loading || read()?.failure) return
    const observer = new IntersectionObserver(entries => {
      // Reaching the manual fallback with the keyboard is not an activation.
      if (entries.some(entry => entry.isIntersecting) && !target.contains(document.activeElement) && !read()?.failure) loadNext()
    }, { root: panelScrolls() ? root.closest(".mission-control") : target.closest(".mission-flow"), rootMargin: "0px 0px 120px 0px" })
    observer.observe(target)
    onCleanup(() => observer.disconnect())
  })
  return <section ref={root} class="mission-tree mission-disclosure" data-scroller={panelScrolls() ? "panel" : undefined}>
    <h3><button type="button" class="mission-disclosure-trigger" aria-expanded={open()} aria-controls={id}
      onClick={() => updateMissionProjectView(scope(), { tasksCollapsed: open() || undefined })}>
      <ChevronRight class="disclosure-chevron h-4 w-4" aria-hidden="true" /><span>{t("missionsPanel.tasks")}</span>
      <small>{total()}</small>
    </button><Show when={attention()}>{counts => <SettingsInfoTip text={t("missionsPanel.tasks.attention.counts", counts())} />}</Show></h3>
    <div id={id} hidden={!open()}>
    <Show when={total()} fallback={<p class="mission-control-empty-line">{t(props.mission.runState === "prepared"
      ? "missions.progress.prepared" : "missions.progress.noPlan")}</p>}>
      <div class="mission-flow" classList={{ "mission-flow-linked": linked() }}>
        <ul ref={list} class="mission-tree-list"><For each={entries()}>{id => {
          const task = () => byID().get(id)!
          const activity = () => {
            const actor = task().actorSessionId
            if (actor) return activities().get(actor)
            const linked = props.conversation(task())
            return linked ? conversationActivity(props.instanceId, props.mission, linked) : undefined
          }
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
            <button type="button" class="mission-tree-task" aria-pressed={props.reading(task())}
              title={[task().title, word(), omittedText(task())].filter(Boolean).join(" · ")} onClick={() => props.onRead(task())}>
              <span class="mission-tree-mark" data-graph-anchor aria-hidden="true"><Dynamic component={ICONS[state()]} class="h-3.5 w-3.5" /></span>
              <span class="mission-tree-title">{task().title}</span>
              <span class="sr-only">{[word(), omittedText(task())].filter(Boolean).join(" · ")}</span>
            </button>
            <Show when={props.conversation(task())}>{id => <button type="button" class="mission-tree-open"
              aria-label={t("missionsPanel.task.openConversation")} title={t("missionsPanel.task.openConversation")}
              onClick={() => props.onOpenConversation(id())}><ArrowUpRight class="h-3.5 w-3.5" aria-hidden="true" /></button>}</Show>
            <Show when={recover()}>{action => <div class="mission-tree-recovery">
              <button type="button" class="window-text-button" disabled={action().disabled} aria-description={action().description}
                onClick={() => void action().onSelect()}>{action().label}</button>{recovery.feedback}</div>}</Show>
          </li>
        }}</For><Show when={nextOffset() !== undefined && !read()?.failure}><li ref={setSentinel} class="mission-tree-more">
          <button type="button" class="window-text-button" aria-disabled={read()?.loading || undefined}
            onClick={loadNext}>{t("missionsPanel.tasks.showMore")}</button>
        </li></Show></ul>
        <Show when={linked()}><MissionGraph tasks={ordered()} list={list} omitted={omitted()} /></Show>
      </div>
      <Show when={read()?.failure}>{failed =>
        <p class="mission-tree-read" role="status">{t(failed().reason === "changed" ? "missionsPanel.tasks.readChanged" : "missionsPanel.tasks.readFailed")}{" "}
          <button type="button" class="window-text-button" onClick={() => readFurther(failed().request)}>{t("missions.control.retry")}</button></p>}</Show>
    </Show>
    </div>
  </section>
}
