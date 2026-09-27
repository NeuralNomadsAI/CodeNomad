import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onMount, type Component, type JSX } from "solid-js"
import { AlertTriangle, ArrowUpRight, Check, Flag, Loader2, Radio, RefreshCw, Users } from "lucide-solid"

import type { MissionActor, MissionMap, MissionReport } from "../../../../../../../server/src/api-types"
import { missionStore } from "../../../../../stores/missions"
import { refreshSessionCatalog, sessions, setActiveSessionFromList } from "../../../../../stores/sessions"
import { instances, getPermissionQueue } from "../../../../../stores/instances"
import { getFormQueue } from "../../../../../stores/forms"
import { showSessionChat } from "../../../../../stores/session-previews"
import { forgetMissionView, missionProjectView, updateMissionProjectView, type MissionReaderTarget } from "../../../../../stores/mission-view-state"
import { MissionDisclosure } from "../../../../mission-disclosure"
import { MissionEditor, type MissionEditorAction } from "../../../../mission-editor"
import { MissionWork } from "../../../../mission-work"
import { MissionHistory } from "../../../../mission-history"
import { MissionAttention } from "../../../../mission-attention"

interface MissionControlProps {
  instanceId: string
  activeSessionId: () => string | null
  onRevealConversation?: () => void
  t: (key: string, vars?: Record<string, any>) => string
}

const MissionControl: Component<MissionControlProps> = (props) => {
  const scope = () => instances().get(props.instanceId)?.folder ?? props.instanceId
  const selectedMissionId = () => missionProjectView(scope()).selected
  const setSelectedMissionId = (selected: string) => updateMissionProjectView(scope(), { selected })
  const [editor, setEditor] = createSignal<MissionEditorAction>()
  const [navigationError, setNavigationError] = createSignal(false)
  const state = () => missionStore.state(props.instanceId)
  const missions = () => state().missions

  onMount(() => void missionStore.ensure(props.instanceId))

  createEffect(() => {
    const available = missions()
    if (state().status !== "ready" || available.length === 0) return
    const current = selectedMissionId()
    if (current && available.some((mission) => mission.id === current)) return
    const activeSession = props.activeSessionId()
    const related = activeSession
      ? available.find((mission) => mission.actors.some((actor) => actor.sessionId === activeSession))
      : undefined
    setSelectedMissionId((related ?? available.find((mission) => mission.status === "active") ?? available[0]).id)
  })

  const mission = createMemo(() => missions().find((candidate) => candidate.id === selectedMissionId()) ?? missions()[0])

  const openActor = async (sessionId: string) => {
    setNavigationError(false)
    if (!sessions().get(props.instanceId)?.has(sessionId)) {
      try {
        await refreshSessionCatalog(props.instanceId)
      } catch {
        setNavigationError(true)
        return
      }
    }
    if (!sessions().get(props.instanceId)?.has(sessionId)) {
      setNavigationError(true)
      return
    }
    setActiveSessionFromList(props.instanceId, sessionId)
    showSessionChat(scope())
    updateMissionProjectView(scope(), { reader: undefined })
    props.onRevealConversation?.()
  }

  const read = async (target: MissionReaderTarget) => {
    const active = props.activeSessionId()
    if (!active || active === "info") {
      const coordinator = missions().find(m => m.id === target.missionId)?.coordinatorSessionId
      if (coordinator) await openActor(coordinator)
      if (!coordinator || !sessions().get(props.instanceId)?.has(coordinator)) return
    }
    showSessionChat(scope())
    updateMissionProjectView(scope(), { reader: target })
    props.onRevealConversation?.()
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
      <Show when={navigationError()}><p class="mission-control-stale" role="alert">{props.t("sessionList.reload.error")}</p></Show>
      <div class="mission-control-actions">
        <button type="button" class="button-secondary" disabled={state().status === "unavailable" || Boolean(editor())}
          onClick={() => setEditor({ kind: "create" })}>{props.t("missions.control.create")}</button>
        <Show when={mission()}>{selected => <>
          <button type="button" class="button-secondary" disabled={Boolean(editor()) || selected().status !== "active"} onClick={() => setEditor({ kind: "edit", mission: selected() })}>{props.t("missions.control.edit")}</button>
          <button type="button" class="button-secondary" disabled={Boolean(editor())} onClick={() => setEditor({ kind: "delete", mission: selected() })}>{props.t("missions.control.delete")}</button>
        </>}</Show>
      </div>
      <Show when={editor()} keyed>{action => <MissionEditor instanceId={props.instanceId} action={action}
        onCancel={() => setEditor(undefined)}
        onSaved={saved => {
          setEditor(undefined)
          if (!saved && action.mission) forgetMissionView(scope(), action.mission.id)
          void missionStore.refresh(props.instanceId).then(() => { if (saved) setSelectedMissionId(saved.id) })
        }} />}</Show>

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
                <MissionDisclosure missionId={scope()} name="index" title={props.t("missions.control.mapLabel")}><MissionIndex
                  missions={missions()}
                  selectedId={selected().id}
                  onSelect={setSelectedMissionId}
                  t={props.t}
                /></MissionDisclosure>
              </Show>
              <MissionOverview mission={selected()} t={props.t} onRead={() => void read({ missionId: selected().id, kind: "overview" })} />
              <button type="button" class="button-secondary" onClick={() => void openActor(selected().coordinatorSessionId)}>{props.t("missions.control.openCoordinator")}</button>
              <MissionAttention mission={selected()} instanceId={props.instanceId} onOpenActor={openActor} />
              <MissionWork
                mission={selected()}
                instanceId={props.instanceId}
                activeSessionId={props.activeSessionId()}
                onOpenActor={openActor}
                onRead={task => void read({ missionId: selected().id, kind: "task", itemId: task.id })}
                onReport={report => void read({ missionId: selected().id, kind: "report", itemId: report.id })}
              />
              <MissionMesh
                mission={selected()}
                instanceId={props.instanceId}
                activeSessionId={props.activeSessionId()}
                onOpenActor={openActor}
                t={props.t}
              />
              <MissionReports missionId={selected().id} tasks={selected().tasks} reports={selected().reports} t={props.t}
                onRead={report => void read({ missionId: selected().id, kind: "report", itemId: report.id })} />
              <MissionHistory mission={selected()} onRead={revision => void read({ missionId: selected().id, kind: "change", itemId: String(revision) })} />
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

const MissionOverview: Component<{ mission: MissionMap; t: MissionControlProps["t"]; onRead: () => void }> = (props) => (
  <MissionDisclosure missionId={props.mission.id} name="overview" title={props.t("missions.control.overview")}>
  <div class="mission-control-overview">
    <div class="mission-control-kicker">
      <span>{props.t(templateKey(props.mission.template))}</span>
      <span class="mission-status" data-status={props.mission.status}>{props.t(statusKey(props.mission.status))}</span>
    </div>
    <h3 class="mission-text-excerpt">{props.mission.objective}</h3>
    <Show when={props.mission.notes}><p class="mission-text-excerpt">{props.mission.notes}</p></Show>
    <Show when={props.mission.summary}><p class="mission-text-excerpt">{props.mission.summary}</p></Show>
    <button type="button" class="button-secondary mission-read-button" onClick={props.onRead}>{props.t("missions.control.read")}</button>
    <div class="mission-control-metrics" aria-label={props.t("missions.control.metrics.label")}>
      <Metric value={props.mission.actors.length} label={props.t("missions.control.metrics.actors")} />
      <Metric value={props.mission.tasks.length} label={props.t("missions.control.metrics.tasks")} />
      <Metric value={props.mission.frontier.length} label={props.t("missions.control.metrics.frontier")} />
      <Metric value={props.mission.claims.length} label={props.t("missions.control.metrics.claims")} />
    </div>
  </div>
  </MissionDisclosure>
)

const Metric: Component<{ value: number; label: string }> = (props) => (
  <div class="mission-control-metric"><strong>{props.value}</strong><span>{props.label}</span></div>
)

const MissionMesh: Component<{
  mission: MissionMap
  instanceId: string
  activeSessionId: string | null
  onOpenActor: (sessionId: string) => Promise<void>
  t: MissionControlProps["t"]
}> = (props) => (
  <MissionDisclosure missionId={props.mission.id} name="actors" title={<><Users class="h-4 w-4" /><span>{props.t("missions.control.mesh.title")}</span></>}>
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
  </MissionDisclosure>
)

const MissionReports: Component<{ missionId: string; tasks: MissionMap["tasks"]; reports: MissionReport[]; t: MissionControlProps["t"]; onRead: (report: MissionReport) => void }> = (props) => (
  <MissionDisclosure missionId={props.missionId} name="reports" title={<><Check class="h-4 w-4" /><span>{props.t("missions.control.reports.title")}</span></>}>
    <Show when={props.reports.length > 0} fallback={<p class="mission-control-empty-line">{props.t("missions.control.reports.empty")}</p>}>
      <div class="mission-report-list">
        <For each={props.reports.map(report => report.id).reverse()}>
          {id => {
            const report = () => props.reports.find(report => report.id === id)!
            return <MissionDisclosure class="mission-report" missionId={props.missionId} name={`report:${id}`} defaultOpen={false}
              label={`${props.tasks.find(task => task.key === report().taskKey)?.title ?? report().taskKey} — ${props.t(reportOutcomeKey(report().outcome))}`}
              title={<><span class="mission-report-mark" data-outcome={report().outcome} aria-hidden="true" />
                <span class="mission-report-heading"><span>{props.tasks.find(task => task.key === report().taskKey)?.title ?? report().taskKey}</span><strong>{report().summary}</strong></span>
                <small>{props.t(reportOutcomeKey(report().outcome))}</small></>}>
              <button type="button" class="button-secondary mission-read-button" onClick={() => props.onRead(report())}>{props.t("missions.control.read")}</button>
              <Show when={report().late}><p class="mission-report-detail">{props.t("missions.control.report.late")}</p></Show>
              <ReportList label={props.t("missions.control.report.evidence")} values={report().evidence} />
              <ReportList label={props.t("missions.control.report.next")} values={report().next} />
            </MissionDisclosure>
          }}
        </For>
      </div>
    </Show>
  </MissionDisclosure>
)

const ReportList: Component<{ label: string; values: string[] }> = (props) => (
  <Show when={props.values.length > 0}>
    <div class="mission-report-detail"><strong>{props.label}</strong><ul><For each={props.values}>{(value) => <li class="mission-text-excerpt">{value}</li>}</For></ul></div>
  </Show>
)

function actorRuntimeStatus(instanceId: string, actor: MissionActor): "working" | "idle" | "waiting" | "unknown" {
  if (getFormQueue(instanceId).some(form => form.sessionID === actor.sessionId)
    || getPermissionQueue(instanceId).some(permission => permission.sessionID === actor.sessionId)) return "waiting"
  const session = sessions().get(instanceId)?.get(actor.sessionId)
  if (!session || session.runtimeStatusKnown === false) return "unknown"
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

function reportOutcomeKey(outcome: MissionReport["outcome"]): string {
  return `missions.control.report.outcome.${outcome}`
}

export default MissionControl
