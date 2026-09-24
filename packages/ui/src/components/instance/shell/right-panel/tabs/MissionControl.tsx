import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onMount, type Component, type JSX } from "solid-js"
import { AlertTriangle, ArrowUpRight, Check, Flag, GitBranch, Loader2, Radio, RefreshCw, Users } from "lucide-solid"

import type { MissionActor, MissionMap, MissionReport, MissionTask } from "../../../../../../../server/src/api-types"
import { missionStore } from "../../../../../stores/missions"
import { refreshSessionCatalog, sessions, setActiveSessionFromList } from "../../../../../stores/sessions"

interface MissionControlProps {
  instanceId: string
  activeSessionId: () => string | null
  t: (key: string, vars?: Record<string, any>) => string
}

const MissionControl: Component<MissionControlProps> = (props) => {
  const [selectedMissionId, setSelectedMissionId] = createSignal<string>()
  const state = () => missionStore.state(props.instanceId)
  const missions = () => state().missions

  onMount(() => void missionStore.ensure(props.instanceId))

  createEffect(() => {
    const available = missions()
    const current = selectedMissionId()
    if (current && available.some((mission) => mission.id === current)) return
    const activeSession = props.activeSessionId()
    const related = activeSession
      ? available.find((mission) => mission.actors.some((actor) => actor.sessionId === activeSession))
      : undefined
    setSelectedMissionId((related ?? available.find((mission) => mission.status === "active") ?? available[0])?.id)
  })

  const mission = createMemo(() => missions().find((candidate) => candidate.id === selectedMissionId()) ?? missions()[0])

  const openActor = async (sessionId: string) => {
    if (!sessions().get(props.instanceId)?.has(sessionId)) {
      try {
        await refreshSessionCatalog(props.instanceId)
      } catch {
        return
      }
    }
    setActiveSessionFromList(props.instanceId, sessionId)
  }

  return (
    <section class="mission-control" aria-label={props.t("missions.control.title")}>
      <header class="mission-control-header">
        <div>
          <div class="mission-control-eyebrow">
            <Radio class="h-3 w-3" aria-hidden="true" />
            {props.t("missions.control.eyebrow")}
          </div>
          <h2>{props.t("missions.control.title")}</h2>
        </div>
        <button
          type="button"
          class="mission-control-icon-button"
          aria-label={props.t("missions.control.refresh")}
          title={props.t("missions.control.refresh")}
          disabled={state().status === "loading"}
          onClick={() => void missionStore.refresh(props.instanceId)}
        >
          <Show when={state().status === "loading"} fallback={<RefreshCw class="h-4 w-4" />}>
            <Loader2 class="h-4 w-4 animate-spin" />
          </Show>
        </button>
      </header>

      <Switch>
        <Match when={state().status === "loading" && missions().length === 0}>
          <StateMessage icon={<Loader2 class="h-5 w-5 animate-spin" />} title={props.t("missions.control.loading")} />
        </Match>
        <Match when={state().status === "unavailable"}>
          <StateMessage
            icon={<AlertTriangle class="h-5 w-5" />}
            title={props.t("missions.control.unavailable.title")}
            detail={props.t(state().reason === "workspace-unavailable"
              ? "missions.control.unavailable.workspace"
              : "missions.control.unavailable.plugin")}
          />
        </Match>
        <Match when={state().status === "error" && missions().length === 0}>
          <StateMessage
            icon={<AlertTriangle class="h-5 w-5" />}
            title={props.t("missions.control.error.title")}
            detail={state().error ?? props.t("missions.control.error.detail")}
            action={props.t("missions.control.retry")}
            onAction={() => void missionStore.refresh(props.instanceId)}
          />
        </Match>
        <Match when={state().status === "ready" && missions().length === 0}>
          <StateMessage
            icon={<Flag class="h-5 w-5" />}
            title={props.t("missions.control.empty.title")}
            detail={props.t("missions.control.empty.detail")}
          />
        </Match>
        <Match when={mission()}>
          {(selected) => (
            <>
              <Show when={state().status === "error"}>
                <div class="mission-control-stale" role="status">
                  <AlertTriangle class="h-3.5 w-3.5" aria-hidden="true" />
                  {props.t("missions.control.error.stale")}
                </div>
              </Show>
              <Show when={missions().length > 1}>
                <MissionIndex
                  missions={missions()}
                  selectedId={selected().id}
                  onSelect={setSelectedMissionId}
                  t={props.t}
                />
              </Show>
              <MissionOverview mission={selected()} t={props.t} />
              <MissionRoute
                mission={selected()}
                activeSessionId={props.activeSessionId()}
                onOpenActor={openActor}
                t={props.t}
              />
              <MissionMesh
                mission={selected()}
                instanceId={props.instanceId}
                activeSessionId={props.activeSessionId()}
                onOpenActor={openActor}
                t={props.t}
              />
              <MissionReports reports={selected().reports} t={props.t} />
            </>
          )}
        </Match>
      </Switch>
    </section>
  )
}

const StateMessage: Component<{
  icon: JSX.Element
  title: string
  detail?: string
  action?: string
  onAction?: () => void
}> = (props) => (
  <div class="mission-control-state">
    <div class="mission-control-state-icon">{props.icon}</div>
    <strong>{props.title}</strong>
    <Show when={props.detail}><p>{props.detail}</p></Show>
    <Show when={props.action && props.onAction}>
      <button type="button" class="button-secondary px-3" onClick={props.onAction}>{props.action}</button>
    </Show>
  </div>
)

const MissionIndex: Component<{
  missions: MissionMap[]
  selectedId: string
  onSelect: (id: string) => void
  t: MissionControlProps["t"]
}> = (props) => (
  <nav class="mission-control-index" aria-label={props.t("missions.control.mapLabel")}>
    <For each={props.missions}>
      {(mission) => (
        <button
          type="button"
          class="mission-control-index-item"
          classList={{ "mission-control-index-item-active": mission.id === props.selectedId }}
          aria-current={mission.id === props.selectedId ? "true" : undefined}
          onClick={() => props.onSelect(mission.id)}
        >
          <span>{mission.objective}</span>
          <small>{props.t(statusKey(mission.status))}</small>
        </button>
      )}
    </For>
  </nav>
)

const MissionOverview: Component<{ mission: MissionMap; t: MissionControlProps["t"] }> = (props) => (
  <div class="mission-control-overview">
    <div class="mission-control-kicker">
      <span>{props.t(templateKey(props.mission.template))}</span>
      <span class="mission-status" data-status={props.mission.status}>{props.t(statusKey(props.mission.status))}</span>
    </div>
    <h3>{props.mission.objective}</h3>
    <Show when={props.mission.summary}><p>{props.mission.summary}</p></Show>
    <div class="mission-control-metrics" aria-label={props.t("missions.control.metrics.label")}>
      <Metric value={props.mission.actors.length} label={props.t("missions.control.metrics.actors")} />
      <Metric value={props.mission.tasks.length} label={props.t("missions.control.metrics.tasks")} />
      <Metric value={props.mission.frontier.length} label={props.t("missions.control.metrics.frontier")} />
      <Metric value={props.mission.claims.length} label={props.t("missions.control.metrics.claims")} />
    </div>
  </div>
)

const Metric: Component<{ value: number; label: string }> = (props) => (
  <div class="mission-control-metric"><strong>{props.value}</strong><span>{props.label}</span></div>
)

const MissionRoute: Component<{
  mission: MissionMap
  activeSessionId: string | null
  onOpenActor: (sessionId: string) => Promise<void>
  t: MissionControlProps["t"]
}> = (props) => (
  <MissionSection icon={<GitBranch class="h-4 w-4" />} title={props.t("missions.control.route.title")}>
    <Show when={props.mission.tasks.length > 0} fallback={<p class="mission-control-empty-line">{props.t("missions.control.route.empty")}</p>}>
      <ol class="mission-route-list">
        <For each={props.mission.tasks}>
          {(task) => (
            <li class="mission-route-task" data-status={task.status}>
              <span class="mission-route-node" aria-hidden="true" />
              <div class="mission-route-content">
                <div class="mission-route-heading">
                  <div><code>{task.key}</code><strong>{task.title}</strong></div>
                  <span class="mission-task-status">{props.t(taskStatusKey(task.status))}</span>
                </div>
                <div class="mission-route-meta">
                  <span>{task.role}</span>
                  <Show when={task.blockedBy.length > 0}>
                    <span>{props.t("missions.control.task.blockedBy", { tasks: task.blockedBy.join(", ") })}</span>
                  </Show>
                </div>
                <Show when={task.actorSessionId}>
                  {(sessionId) => (
                    <button
                      type="button"
                      class="mission-inline-session"
                      classList={{ "mission-inline-session-active": props.activeSessionId === sessionId() }}
                      onClick={() => void props.onOpenActor(sessionId())}
                    >
                      <span>{shortSession(sessionId())}</span>
                      <ArrowUpRight class="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                </Show>
              </div>
            </li>
          )}
        </For>
      </ol>
    </Show>
  </MissionSection>
)

const MissionMesh: Component<{
  mission: MissionMap
  instanceId: string
  activeSessionId: string | null
  onOpenActor: (sessionId: string) => Promise<void>
  t: MissionControlProps["t"]
}> = (props) => (
  <MissionSection icon={<Users class="h-4 w-4" />} title={props.t("missions.control.mesh.title")}>
    <div class="mission-mesh-list">
      <For each={props.mission.actors}>
        {(actor) => {
          const runtime = () => actorRuntimeStatus(props.instanceId, actor)
          return (
            <div class="mission-actor" classList={{ "mission-actor-active": props.activeSessionId === actor.sessionId }}>
              <span class="mission-actor-signal" data-status={runtime()} aria-hidden="true" />
              <div class="mission-actor-copy">
                <strong>{actor.title}</strong>
                <span>{props.t(actor.kind === "coordinator" ? "missions.control.actor.coordinator" : "missions.control.actor.specialist")} · {actor.roles.join(", ")}</span>
                <code>{shortSession(actor.sessionId)}</code>
              </div>
              <div class="mission-actor-actions">
                <small>{props.t(`missions.control.actor.status.${runtime()}`)}</small>
                <button
                  type="button"
                  class="mission-control-icon-button"
                  aria-label={props.t("missions.control.actor.open", { actor: actor.title })}
                  title={props.t("missions.control.actor.open", { actor: actor.title })}
                  onClick={() => void props.onOpenActor(actor.sessionId)}
                >
                  <ArrowUpRight class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )
        }}
      </For>
    </div>
  </MissionSection>
)

const MissionReports: Component<{ reports: MissionReport[]; t: MissionControlProps["t"] }> = (props) => (
  <MissionSection icon={<Check class="h-4 w-4" />} title={props.t("missions.control.reports.title")}>
    <Show when={props.reports.length > 0} fallback={<p class="mission-control-empty-line">{props.t("missions.control.reports.empty")}</p>}>
      <div class="mission-report-list">
        <For each={[...props.reports].reverse()}>
          {(report) => (
            <details class="mission-report">
              <summary>
                <span class="mission-report-mark" data-outcome={report.outcome} aria-hidden="true" />
                <span><code>{report.taskKey}</code><strong>{report.summary}</strong></span>
                <small>{props.t(reportOutcomeKey(report.outcome))}</small>
              </summary>
              <ReportList label={props.t("missions.control.report.evidence")} values={report.evidence} />
              <ReportList label={props.t("missions.control.report.next")} values={report.next} />
            </details>
          )}
        </For>
      </div>
    </Show>
  </MissionSection>
)

const ReportList: Component<{ label: string; values: string[] }> = (props) => (
  <Show when={props.values.length > 0}>
    <div class="mission-report-detail"><strong>{props.label}</strong><ul><For each={props.values}>{(value) => <li>{value}</li>}</For></ul></div>
  </Show>
)

const MissionSection: Component<{ icon: JSX.Element; title: string; children: JSX.Element }> = (props) => (
  <section class="mission-control-section">
    <h3>{props.icon}<span>{props.title}</span></h3>
    {props.children}
  </section>
)

function actorRuntimeStatus(instanceId: string, actor: MissionActor): "working" | "idle" | "unknown" {
  const session = sessions().get(instanceId)?.get(actor.sessionId)
  if (!session) return "unknown"
  return session.status === "working" || session.status === "compacting" ? "working" : "idle"
}

function shortSession(sessionId: string): string {
  return sessionId.length > 18 ? `${sessionId.slice(0, 9)}…${sessionId.slice(-6)}` : sessionId
}

function templateKey(template: MissionMap["template"]): string {
  return `missions.control.template.${template}`
}

function statusKey(status: MissionMap["status"]): string {
  return `missions.control.status.${status}`
}

function taskStatusKey(status: MissionTask["status"]): string {
  return `missions.control.task.status.${status}`
}

function reportOutcomeKey(outcome: MissionReport["outcome"]): string {
  return `missions.control.report.outcome.${outcome}`
}

export default MissionControl
