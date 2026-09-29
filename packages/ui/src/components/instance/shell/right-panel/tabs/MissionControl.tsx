import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onMount, type Component, type JSX } from "solid-js"
import { AlertTriangle, ArrowUpRight, Check, Flag, Loader2, Minus, Pencil, Plus, RefreshCw, Users } from "lucide-solid"

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
import { MissionReadButton } from "../../../../mission-read-button"

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
        <h2>{props.t("missions.control.title")}</h2>
        <div class="mission-control-actions">
        <button type="button" class="mission-control-icon-button" disabled={state().status === "unavailable" || Boolean(editor())}
          aria-label={props.t("missions.control.create")} title={props.t("missions.control.create")}
          onClick={() => setEditor({ kind: "create" })}><Plus class="h-4 w-4" aria-hidden="true" /></button>
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
        </div>
      </header>
      <Show when={navigationError()}><p class="mission-control-stale" role="alert">{props.t("sessionList.reload.error")}</p></Show>
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
                <MissionDisclosure missionId={scope()} name="index" title={props.t("missions.control.mapLabel")}><MissionIndex
                  missions={missions()}
                  selectedId={selected().id}
                  onSelect={setSelectedMissionId}
                  disabled={Boolean(editor())}
                  onEdit={value => setEditor({ kind: "edit", mission: value })}
                  onDelete={value => setEditor({ kind: "delete", mission: value })}
                  t={props.t}
                /></MissionDisclosure>
              <MissionOverview mission={selected()} t={props.t} onRead={() => void read({ missionId: selected().id, kind: "overview" })}
                onOpenCoordinator={() => void openActor(selected().coordinatorSessionId)} />
              <Show when={selected().status === "active" && selected().reports.some(report => report.notificationStatus === "pending")}>
                <p class="mission-control-stale" role="status">{props.t("missions.control.report.notificationPending")}</p>
              </Show>
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
  disabled: boolean
  onEdit: (mission: MissionMap) => void
  onDelete: (mission: MissionMap) => void
  t: MissionControlProps["t"]
}> = (props) => (
  <nav class="mission-control-index" aria-label={props.t("missions.control.mapLabel")}>
    <For each={props.missions.map(mission => mission.id)}>
      {id => {
        const mission = () => props.missions.find(mission => mission.id === id)!
        return <div class="mission-index-row" classList={{ "mission-index-row-active": id === props.selectedId }}>
        <button
          type="button"
          class="mission-control-index-item"
          classList={{ "mission-control-index-item-active": id === props.selectedId }}
          aria-current={id === props.selectedId ? "true" : undefined}
          title={mission().objective}
          onClick={() => props.onSelect(id)}
        >
          <span>{mission().objective}</span>
          <small data-status={mission().status}>{props.t(statusKey(mission().status))}</small>
        </button>
        <button type="button" class="mission-control-icon-button" disabled={props.disabled || mission().status !== "active"}
          aria-label={props.t("missions.control.edit")} title={props.t("missions.control.edit")}
          onClick={() => props.onEdit(mission())}><Pencil class="h-3.5 w-3.5" aria-hidden="true" /></button>
        <button type="button" class="mission-control-icon-button" disabled={props.disabled}
          aria-label={props.t("missions.control.delete")} title={props.t("missions.control.delete")}
          onClick={() => props.onDelete(mission())}><Minus class="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>
      }}
    </For>
  </nav>
)

const MissionOverview: Component<{ mission: MissionMap; t: MissionControlProps["t"]; onRead: () => void; onOpenCoordinator: () => void }> = (props) => (
  <MissionDisclosure missionId={props.mission.id} name="overview" title={props.t("missions.control.overview")}
    actions={<><MissionReadButton onClick={props.onRead} />
      <button type="button" class="mission-control-icon-button" aria-label={props.t("missions.control.openCoordinator")}
        title={props.t("missions.control.openCoordinator")} onClick={props.onOpenCoordinator}><ArrowUpRight class="h-3.5 w-3.5" aria-hidden="true" /></button></>}>
  <div class="mission-control-overview">
    <h3 class="mission-text-excerpt">{props.mission.objective}</h3>
  </div>
  </MissionDisclosure>
)

const MissionMesh: Component<{
  mission: MissionMap
  instanceId: string
  activeSessionId: string | null
  onOpenActor: (sessionId: string) => Promise<void>
  t: MissionControlProps["t"]
}> = (props) => (
  <MissionDisclosure missionId={props.mission.id} name="actors" defaultOpen={false} title={<><Users class="h-4 w-4" /><span>{props.t("missions.control.mesh.title")}</span><small>{props.mission.actors.length}</small></>}>
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
              actions={<MissionReadButton onClick={() => props.onRead(report())} />}
              label={`${props.tasks.find(task => task.key === report().taskKey)?.title ?? report().taskKey} — ${props.t(reportOutcomeKey(report().outcome))}`}
              title={<><span class="mission-report-mark" data-outcome={report().outcome} aria-hidden="true" />
                <span class="mission-report-heading"><span>{props.tasks.find(task => task.key === report().taskKey)?.title ?? report().taskKey}</span></span>
                <small>{props.t(reportOutcomeKey(report().outcome))}</small></>}>
              <p class="mission-text-excerpt">{report().summary}</p>
              <Show when={report().late}><p class="mission-report-detail">{props.t("missions.control.report.late")}</p></Show>
            </MissionDisclosure>
          }}
        </For>
      </div>
    </Show>
  </MissionDisclosure>
)

function actorRuntimeStatus(instanceId: string, actor: MissionActor): "working" | "idle" | "waiting" | "unknown" {
  if (getFormQueue(instanceId).some(form => form.sessionID === actor.sessionId)
    || getPermissionQueue(instanceId).some(permission => permission.sessionID === actor.sessionId)) return "waiting"
  const session = sessions().get(instanceId)?.get(actor.sessionId)
  if (!session || session.runtimeStatusKnown === false) return "unknown"
  return session.status === "working" || session.status === "compacting" ? "working" : "idle"
}

function statusKey(status: MissionMap["status"]): string {
  return `missions.control.status.${status}`
}

function reportOutcomeKey(outcome: MissionReport["outcome"]): string {
  return `missions.control.report.outcome.${outcome}`
}

export default MissionControl
