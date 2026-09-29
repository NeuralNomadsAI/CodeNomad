import { For, Show, createMemo, createUniqueId } from "solid-js"
import { ArrowUpRight, GitBranch } from "lucide-solid"
import type { MissionMap, MissionTask, MissionReport } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { setMissionDisclosureOpen } from "../stores/mission-view-state"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionExecution } from "./mission-execution"
import { MissionReadButton } from "./mission-read-button"
import { MissionGraph, orderMissionTasks } from "./mission-graph"

export function MissionWork(props: {
  mission: MissionMap; instanceId: string; activeSessionId: string | null
  onOpenActor: (id: string) => Promise<void>
  onRead: (task: MissionTask) => void; onReport: (report: MissionReport) => void
}) {
  const { t } = useI18n()
  const prefix = createUniqueId()
  let list!: HTMLUListElement
  const ordered = createMemo(() => orderMissionTasks(props.mission.tasks))
  const taskByKey = (key: string) => props.mission.tasks.find(task => task.key === key)
  function reveal(key: string) {
    const task = taskByKey(key)
    if (!task) return
    setMissionDisclosureOpen(props.mission.id, `task:${task.id}`, true)
    requestAnimationFrame(() => {
      const row = document.getElementById(`${prefix}-${task.id}`)
      row?.scrollIntoView({ block: "nearest" })
      row?.querySelector("button")?.focus({ preventScroll: true })
    })
  }
  const links = (keys: string[], translationKey: string) => <For each={keys}>{key =>
    <button type="button" class="mission-task-link" onClick={() => reveal(key)}>
      {t(translationKey, { tasks: taskByKey(key)?.title ?? key })}
    </button>
  }</For>
  return <MissionDisclosure missionId={props.mission.id} name="route" label={t("missions.control.route.title")}
    title={<><GitBranch class="h-4 w-4" aria-hidden="true" /><span>{t("missions.control.route.title")}</span>
      <small title={t("missions.control.metrics.tasks")}>{props.mission.tasks.filter(task => task.status === "completed").length}/{props.mission.tasks.length}</small></>}>
    <Show when={props.mission.tasks.length} fallback={<p class="mission-control-empty-line">{t("missions.control.route.empty")}</p>}>
      <div class="mission-flow">
          <ul ref={list} class="mission-route-list"><For each={ordered().map(task => task.id)}>{id => {
            const task = () => props.mission.tasks.find(task => task.id === id)!
            const report = () => [...props.mission.reports].reverse().find(report => report.taskKey === task().key)
            const actor = () => props.mission.actors.find(actor => actor.sessionId === task().actorSessionId)
            return <li id={`${prefix}-${id}`} class="mission-route-task" data-task-key={task().key} data-status={task().status}>
              <MissionDisclosure missionId={props.mission.id} name={`task:${id}`} defaultOpen={false} label={task().title}
                description={t(`missions.control.task.status.${task().status === "withdrawn" ? "superseded" : task().status}`)}
                title={<><span class="mission-task-title" title={task().title}>{task().title}</span>
                  <span class="mission-task-status">{t(`missions.control.task.status.${task().status === "withdrawn" ? "superseded" : task().status}`)}</span></>}
                actions={<MissionReadButton onClick={() => props.onRead(task())} />}>
                <p class="mission-text-excerpt">{task().brief}</p>
                <Show when={task().replacedByTaskKey}>{key => <button type="button" class="mission-task-link" onClick={() => reveal(key())}>
                  {t("missions.control.task.replacedBy", { task: taskByKey(key())?.title ?? key() })}
                </button>}</Show>
                <Show when={task().status === "withdrawn" && task().outstandingExecution}><p role="status">{t("missions.control.task.retiredRunning")}</p></Show>
                <div class="mission-control-actions">
                  <Show when={report()}>{value => <div class="mission-task-result"><span class="mission-text-excerpt">{value().summary}</span>
                    <MissionReadButton label={t("missions.control.task.result")} onClick={() => props.onReport(value())} /></div>}</Show>
                </div>
                <div class="mission-task-dependencies">
                  {links(task().blockedBy, "missions.control.task.blockedBy")}
                  {links(props.mission.tasks.filter(other => other.blockedBy.includes(task().key)).map(other => other.key), "missions.control.task.blocks")}
                </div>
                <div class="mission-route-meta">
                  <span>{task().role}</span>
                </div>
                <MissionExecution instanceId={props.instanceId} task={task()} />
                <Show when={task().actorSessionId}>{sessionId => <button type="button" class="mission-inline-session"
                  classList={{ "mission-inline-session-active": props.activeSessionId === sessionId() }}
                  onClick={() => void props.onOpenActor(sessionId())}>
                  <span>{actor()?.title ?? t("missions.control.actor.specialist")}</span><ArrowUpRight class="h-3 w-3" aria-hidden="true" />
                </button>}</Show>
                <div class="mission-route-meta" aria-label={t("missions.control.task.details")}><code>{task().key}</code></div>
              </MissionDisclosure>
            </li>
          }}</For></ul>
        <MissionGraph tasks={ordered()} list={list} />
      </div>
    </Show>
  </MissionDisclosure>
}
