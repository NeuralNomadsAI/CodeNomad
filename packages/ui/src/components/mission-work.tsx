import { For, Show, createUniqueId } from "solid-js"
import { ArrowUpRight, GitBranch } from "lucide-solid"
import type { MissionMap, MissionTask, MissionReport } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { setMissionDisclosureOpen } from "../stores/mission-view-state"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionExecution } from "./mission-execution"

export function MissionWork(props: {
  mission: MissionMap; instanceId: string; activeSessionId: string | null
  onOpenActor: (id: string) => Promise<void>
  onRead: (task: MissionTask) => void; onReport: (report: MissionReport) => void
}) {
  const { t } = useI18n()
  const prefix = createUniqueId()
  // Grouping conveys concurrency; creation order is not a dependency chain.
  const statuses = ["needs-input", "failed", "ready", "dispatching", "queued", "blocked", "completed", "withdrawn"] as const
  const taskByKey = (key: string) => props.mission.tasks.find(task => task.key === key)
  function reveal(key: string) {
    const task = taskByKey(key)
    if (!task) return
    setMissionDisclosureOpen(props.mission.id, `group:${task.status}`, true)
    setMissionDisclosureOpen(props.mission.id, `task:${task.id}`, true)
    requestAnimationFrame(() => document.getElementById(`${prefix}-${task.id}`)?.querySelector("button")?.focus())
  }
  const links = (keys: string[], translationKey: string) => <For each={keys}>{key =>
    <button type="button" class="mission-task-link" onClick={() => reveal(key)}>
      {t(translationKey, { tasks: taskByKey(key)?.title ?? key })}
    </button>
  }</For>
  return <MissionDisclosure missionId={props.mission.id} name="route"
    title={<><GitBranch class="h-4 w-4" aria-hidden="true" /><span>{t("missions.control.route.title")}</span></>}>
    <Show when={props.mission.tasks.length} fallback={<p class="mission-control-empty-line">{t("missions.control.route.empty")}</p>}>
      <For each={statuses}>{status => <Show when={props.mission.tasks.some(task => task.status === status)}>
        <MissionDisclosure missionId={props.mission.id} name={`group:${status}`} title={t(`missions.control.task.status.${status === "withdrawn" ? "superseded" : status}`)}>
          <ul class="mission-route-list"><For each={props.mission.tasks.filter(task => task.status === status).map(task => task.id)}>{id => {
            const task = () => props.mission.tasks.find(task => task.id === id)!
            const report = () => props.mission.reports.find(report => report.taskKey === task().key)
            const actor = () => props.mission.actors.find(actor => actor.sessionId === task().actorSessionId)
            return <li id={`${prefix}-${id}`} class="mission-route-task" data-status={task().status}>
              <MissionDisclosure missionId={props.mission.id} name={`task:${id}`} defaultOpen={false} title={<span>{task().title}</span>}>
                <p class="mission-text-excerpt">{task().brief}</p>
                <Show when={task().replacedByTaskKey}>{key => <button type="button" class="mission-task-link" onClick={() => reveal(key())}>
                  {t("missions.control.task.replacedBy", { task: taskByKey(key())?.title ?? key() })}
                </button>}</Show>
                <Show when={task().status === "withdrawn" && task().outstandingExecution}><p role="status">{t("missions.control.task.retiredRunning")}</p></Show>
                <div class="mission-control-actions">
                  <button type="button" class="button-secondary mission-read-button" onClick={() => props.onRead(task())}>{t("missions.control.read")}</button>
                  <Show when={report()}>{value => <button type="button" class="button-secondary mission-read-button" onClick={() => props.onReport(value())}>{t("missions.control.task.result")}</button>}</Show>
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
        </MissionDisclosure>
      </Show>}</For>
    </Show>
  </MissionDisclosure>
}
