import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { Dynamic } from "solid-js/web"
import { AlertTriangle, Check, Circle, CircleDot, CircleSlash, Clock, MessageCircleQuestion, XCircle } from "lucide-solid"
import type { MissionActorActivity, MissionPanelMap, MissionPanelTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { missionDerivedSessionActive } from "../stores/mission-task-sessions"
import { sessions } from "../stores/session-state"
import { MissionGraph, orderMissionTasks } from "./mission-graph"
import { useMissionPanelStore, useMissionViewScope } from "./mission-panel-scope"
import { markMissionTasksSeen, missionTaskUnseen } from "../stores/mission-task-seen"
import { toggleSweepClear, toggleSweepGroup } from "../lib/toggle-sweep"
import { missionVirtualViewport } from "./mission-virtual-viewport"
import { observeListEnd } from "../lib/list-end-observer"
import { preserveListFocus } from "../lib/preserve-list-focus"
import { taskQuestion, type MissionQuestion } from "./mission-question-owners"
import { missionQuestionContext } from "./mission-questions"
import type { MissionTaskRequest } from "../../../server/src/missions/mission-panel-map"
import { SettingsInfoTip } from "./settings/settings-info-tip"

export type MissionTaskState = "done" | "active" | "input" | "assigned" | "ready" | "waiting" | "blocked" | "failed" | "retired"

/** One status per node. A reported blockage is "blocked"; unmet dependencies are
 * "waiting"; an open native Form/permission is "input". Admission is only
 * "assigned": observed native activity of the task's own conversation alone
 * makes a task "active". */
export function missionTaskState(task: Pick<MissionPanelTask, "status" | "replacedByTaskKey">, activity?: MissionActorActivity["state"]): MissionTaskState {
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
export function conversationActivity(instanceId: string, mission: Pick<MissionPanelMap, "id" | "projectID" | "coordinatorSessionId">, sessionId: string): MissionActorActivity["state"] | undefined {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (session?.pendingPermission) return "permission"
  if (session?.pendingForm) return "form"
  return session?.status === "working" || session?.status === "compacting"
    || missionDerivedSessionActive(instanceId, mission, sessionId) ? "running" : undefined
}

/** The state a task row shows: its question first, then its own conversation's
 * activity (its declared actor's, else its linked native conversation's). The
 * Mission row's chevron takes the most urgent of these, so both always agree. */
export function missionTaskRowState(instanceId: string, mission: Pick<MissionPanelMap, "id" | "projectID" | "coordinatorSessionId">,
  task: Pick<MissionPanelTask, "status" | "replacedByTaskKey" | "actorSessionId">,
  activities: ReadonlyMap<string, MissionActorActivity["state"]>, conversation: string | undefined, asked: boolean): MissionTaskState {
  if (asked) return "input"
  const actor = task.actorSessionId !== mission.coordinatorSessionId ? task.actorSessionId : undefined
  const observed = actor ? activities.get(actor) : undefined, target = actor ?? (conversation !== mission.coordinatorSessionId ? conversation : undefined)
  const activity = observed && observed !== "unknown" ? observed : target ? conversationActivity(instanceId, mission, target) : undefined
  return missionTaskState(task, activity)
}

const ICONS = { done: Check, active: CircleDot, input: MessageCircleQuestion, assigned: Circle, ready: Circle,
  waiting: Clock, blocked: AlertTriangle, failed: XCircle, retired: CircleSlash }

/** The Mission's tasks as its row's children: session-list rows (session-tree.css),
 * one level deep, with declared dependencies drawn beside them. A row selects its
 * task, the only selection in the panel; while the task waits for an answer it also
 * opens its question. A selected task's actions are the header toolbar's. */
export function MissionTaskTree(props: {
  mission: MissionPanelMap; instanceId: string; activity?: MissionActorActivity[]
  selected: (task: MissionPanelTask) => boolean; onSelect: (task: MissionPanelTask) => void
  /** The task's exact owned conversation, once one is known. */
  conversation: (task: MissionPanelTask) => string | undefined
  active?: boolean
  /** The Mission's open questions; a task carrying one is red and opens it. */
  questions?: readonly MissionQuestion[]
  onAnswer?: (sessionId: string, request?: MissionQuestion["request"]) => void
}) {
  const missionStore = useMissionPanelStore(), viewScope = useMissionViewScope()
  const { t } = useI18n()
  const [list, setList] = createSignal<HTMLUListElement>()
  const [virtualizer, setVirtualizer] = createSignal<VirtualizerHandle>()
  const [layoutVersion, setLayoutVersion] = createSignal(0)
  const [focusedTask, setFocusedTask] = createSignal<string>()
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
  const questionContext = createMemo(() => missionQuestionContext(props.instanceId, props.mission))
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
  let root!: HTMLElement
  // The browser owns task scrolling and anchoring. A previously focused row must
  // never pull a wheel-scrolled viewport back when later task pages or rails arrive.
  const [sentinel, setSentinel] = createSignal<HTMLDivElement>()
  // The dependency rail's lanes beyond the rows' indent (mission-graph.tsx).
  const [graphExtra, setGraphExtra] = createSignal(0)
  const [flow, setFlow] = createSignal<HTMLDivElement>()
  preserveListFocus(flow)
  const viewport = missionVirtualViewport(flow, () => props.active ?? true)
  const kept = createMemo(() => ordered().flatMap((task, index) =>
    props.selected(task) || task.key === focusedTask() ? [index] : []))
  const List = (attributes: JSX.HTMLAttributes<HTMLUListElement>) => <ul {...attributes} ref={setList} class="mission-tree-list" />
  const loadNext = () => {
    const offset = nextOffset()
    if (props.active !== false && offset !== undefined && !read()?.loading) readFurther({ offset })
  }
  createEffect(() => {
    const target = sentinel(), offset = nextOffset()
    if (!target || props.active === false || offset === undefined || read()?.loading || read()?.failure) return
    onCleanup(observeListEnd(target, root.closest<HTMLElement>(".mission-control"), () => {
      if (!read()?.failure) loadNext()
    }, 120))
  })
  return <section ref={root} class="mission-tree" aria-label={`${t("missionsPanel.tasks")} (${total()})`}
    onFocusIn={event => setFocusedTask((event.target as Element).closest<HTMLElement>("[data-task-key]")?.dataset.taskKey)}>
    <Show when={attention()}>{counts => <p class="mission-tree-summary">{t("missionsPanel.tasks")} · {total()}
      <SettingsInfoTip text={t("missionsPanel.tasks.attention.counts", counts())} /></p>}</Show>
    <Show when={total()}>
      <div ref={element => {
        let disposed = false
        // MissionRows attaches retained detail in an effect before viewport discovery.
        queueMicrotask(() => { if (!disposed) setFlow(element) })
        onCleanup(() => { disposed = true; setFlow(undefined) })
      }} class="mission-flow" classList={{ "mission-flow-linked": linked() }} style={{ "--mission-graph-extra": `${graphExtra()}px` }}>
        <Show when={viewport.scrollRef()}>{host => <Virtualizer as={List} item="li" data={entries()} scrollRef={host()}
          startMargin={viewport.startMargin()} ref={setVirtualizer} bufferSize={400} keepMounted={kept()}
          onResize={() => setLayoutVersion(value => value + 1)}>{id => {
          const task = () => byID().get(id)!
          const question = () => props.questions?.length
            ? taskQuestion(questionContext(), props.questions, task(), props.conversation(task())) : undefined
          const state = () => missionTaskRowState(props.instanceId, props.mission, task(), activities(), props.conversation(task()), Boolean(question()))
          const word = () => t(`missionsPanel.task.${state()}`)
          const selected = () => props.selected(task())
          // A task carrying a correlated question also opens it, like a session row waiting
          // for an answer; an aggregate "input" activity state alone (possibly an
          // uncorrelated global request) only selects.
          // A finished task stays green until seen, like a session's Idle badge.
          const unseen = () => state() === "done" && viewScope !== undefined && missionTaskUnseen(viewScope(), props.mission.id, task())
           const markSeen = () => { if (viewScope && state() === "done") markMissionTasksSeen(viewScope(), props.mission.id, [task()]) }
          const select = () => {
            props.onSelect(task())
            markSeen()
            const asked = question()
            if (asked) props.onAnswer?.(asked.sessionId, asked.request)
          }
          const icon = () => <Dynamic component={ICONS[state()]} class="h-4 w-4" aria-hidden="true" />
          return <div class="mission-tree-node session-list-item" data-task-key={task().key} data-status={task().status} data-state={state()}
            data-unseen={unseen() || undefined}>
            <div class={`session-item-base session-item-nested ${selected() ? "session-item-active" : "session-item-inactive"}`}>
              <span class="session-item-expander session-item-expander--spacer" aria-hidden="true" />
              {/* Clicking an unseen task's icon, or sweeping across icons, marks it as seen. */}
              <Show when={unseen()} fallback={<span class="mission-tree-mark" data-graph-anchor aria-hidden="true" onClick={select}>{icon()}</span>}>
                <button type="button" class="mission-tree-mark mission-tree-mark-clear" data-graph-anchor aria-label={t("sessionList.expand.markRead")}
                  title={t("sessionList.expand.markRead")} data-toggle-sweep={toggleSweepGroup("mission-task-seen")} ref={element => toggleSweepClear(element)}
                  onClick={markSeen}>{icon()}</button>
              </Show>
              <button type="button" class="session-item-select mission-tree-task" aria-current={selected() ? "true" : undefined}
                aria-description={question() ? t("missionsPanel.task.answer") : undefined}
                title={[task().title, word(), question() ? t("missionsPanel.task.answer") : "", omittedText(task())].filter(Boolean).join(" · ")}
                onClick={select}>
                <span class="session-item-title session-item-title--clamp" dir="auto">{task().title}</span>
                <span class="sr-only">{[word(), omittedText(task())].filter(Boolean).join(" · ")}</span>
              </button>
            </div>
          </div>
        }}</Virtualizer>}</Show><Show when={nextOffset() !== undefined && !read()?.failure}>
          <div ref={setSentinel} class="mission-tree-more" aria-hidden="true" />
        </Show>
        <Show when={linked() && list() && virtualizer()}><MissionGraph tasks={ordered()} list={list()!} virtualizer={virtualizer()}
          layoutVersion={layoutVersion()} omitted={omitted()} onExtra={setGraphExtra} /></Show>
      </div>
      <Show when={read()?.failure}>{failed =>
        <p class="mission-tree-read" role="status">{t(failed().reason === "changed" ? "missionsPanel.tasks.readChanged" : "missionsPanel.tasks.readFailed")}{" "}
          <button type="button" class="window-action" onClick={() => readFurther(failed().request)}>{t("missions.control.retry")}</button></p>}</Show>
    </Show>
  </section>
}
