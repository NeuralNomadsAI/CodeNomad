import { For, Match, Show, Switch, batch, createComputed, createEffect, createMemo, createSignal, onCleanup, untrack, type Component, type JSX } from "solid-js"
import { AlertTriangle, ArrowUpRight, Check, Eye, Flag, Loader2, Minus, Pencil, Plus, RefreshCw } from "lucide-solid"

import type { MissionMap, MissionReport } from "../../../../../../../server/src/api-types"
import { activateMissionDemand, deactivateMissionDemand, missionStore } from "../../../../../stores/missions"
import { activeParentSessionId, getAuthoritativelyDeletedSessionIdsForInstance, hydrateRestoredSessionChain, sessions, setActiveSessionFromList } from "../../../../../stores/sessions"
import { getOpenCodeInstanceGeneration } from "../../../../../stores/opencode-data"
import { instances, getPermissionQueue } from "../../../../../stores/instances"
import { getFormQueue } from "../../../../../stores/forms"
import { focusInterruption } from "../../../../../stores/interruption-navigation"
import { sessionPreviews, showSessionChat } from "../../../../../stores/session-previews"
import { forgetMissionView, missionProjectView, updateMissionProjectView, type MissionReaderTarget } from "../../../../../stores/mission-view-state"
import { MissionDisclosure } from "../../../../mission-disclosure"
import { MissionEditor, type MissionEditorAction } from "../../../../mission-editor"
import { MissionWork } from "../../../../mission-work"
import { MissionHistory } from "../../../../mission-history"
import { MissionAttention } from "../../../../mission-attention"
import { MissionProgress } from "../../../../mission-progress"
import { MissionActivity } from "../../../../mission-activity"
import { MissionGuidance } from "../../../../mission-guidance"
import { missionIncludesSession } from "../../../../mission-attention-model"
import { MissionListItem } from "../../../../mission-list-item"
import { MissionLifecycleControls } from "../../../../mission-lifecycle-controls"
import { MissionActors } from "../../../../mission-actors"
import { createMissionRecoveryAction } from "../../../../mission-recovery-button"
import { MissionCleanupPanel } from "../../../../mission-cleanup"
import { createMissionViewFence } from "../../../../../lib/mission-view-fence"

interface MissionControlProps {
  instanceId: string
  activeSessionId: () => string | null
  isActive?: () => boolean
  onRevealConversation?: () => void
  t: (key: string, vars?: Record<string, any>) => string
}

const MissionControl: Component<MissionControlProps> = (props) => {
  const scope = () => instances().get(props.instanceId)?.folder ?? props.instanceId
  const selectedMissionId = () => missionProjectView(scope()).selected
  const setSelectedMissionId = (selected: string) => updateMissionProjectView(scope(), { selected })
  const [editor, setEditor] = createSignal<MissionEditorAction & { current: () => boolean }>()
  const [navigationError, setNavigationError] = createSignal(false)
  const state = () => missionStore.state(props.instanceId)
  const missions = () => state().missions
  const family = (id: string) => state().activity?.missions.find(item => item.missionId === id)?.family
  const includesSession = (value: MissionMap, id: string) => value.coordinatorSessionId === id
    || missionIncludesSession(value.actors, id, family(value.id))
  const directory = () => instances().get(props.instanceId)?.folder
  const projectID = () => instances().get(props.instanceId)?.metadata?.project?.id ?? state().projectID ?? missions()[0]?.projectID
  const captureView = createMissionViewFence(() => JSON.stringify([props.instanceId, directory(), projectID(), state().projectID]), () => props.isActive?.() ?? true)
  let intent = 0
  const selectMission = (id: string) => { intent++; setSelectedMissionId(id) }
  const openEditor = (action: MissionEditorAction) => {
    intent++
    setEditor({ ...action, current: captureView() })
  }
  const closeEditor = () => { intent++; setEditor(undefined) }

  const conversation = () => ({ session: props.activeSessionId(), parent: activeParentSessionId().get(props.instanceId),
    preview: sessionPreviews().get(scope()), reader: missionProjectView(scope()).reader })
  let conversationEpoch = 0, previousConversation = conversation()
  createComputed(() => {
    const next = conversation()
    if (next.session !== previousConversation.session || next.parent !== previousConversation.parent
      || next.preview !== previousConversation.preview || next.reader !== previousConversation.reader) conversationEpoch++
    previousConversation = next
  })

  createEffect(() => {
    const instanceId = props.instanceId
    if (!(props.isActive?.() ?? true)) return
    // Visibility owns demand; fetching state must not retrigger this effect.
    untrack(() => activateMissionDemand(instanceId))
    onCleanup(() => deactivateMissionDemand(instanceId))
  })

  let previousRelated = ""
  createEffect(() => {
    const available = missions()
    if (state().status !== "ready" || available.length === 0) return
    const current = untrack(selectedMissionId)
    const activeSession = props.activeSessionId()
    const matches = activeSession ? available.filter(value => includesSession(value, activeSession)) : []
    const related = matches.find(value => value.id === current) ?? (matches.length === 1 ? matches[0] : undefined)
    const relation = JSON.stringify([activeSession, related?.id])
    const changed = relation !== previousRelated
    previousRelated = relation
    if (current && available.some(value => value.id === current) && (!related || !changed)) return
    setSelectedMissionId((related ?? available.find((mission) => mission.status === "active") ?? available[0]).id)
  })

  const mission = createMemo(() => missions().find((candidate) => candidate.id === selectedMissionId()) ?? missions()[0])

  const navigationOrigin = () => {
    const instanceId = props.instanceId, viewScope = scope(), viewCurrent = captureView(), operation = ++intent
    let epoch = conversationEpoch
    return { instanceId, scope: viewScope,
      current: () => viewCurrent() && operation === intent && scope() === viewScope && epoch === conversationEpoch,
      // Adopt only our guarded synchronous batch, never an awaited external change.
      adoptConversation: () => { epoch = conversationEpoch },
    }
  }

  const openActor = async (sessionId: string, origin = navigationOrigin(), afterSelection?: () => void): Promise<boolean> => {
    const missionId = selectedMissionId()
    const client = instances().get(origin.instanceId)?.client, generation = getOpenCodeInstanceGeneration(origin.instanceId)
    const authorized = () => missions().some(value => value.id === missionId && includesSession(value, sessionId))
    const admitted = () => origin.current() && authorized()
      && instances().get(origin.instanceId)?.client === client && getOpenCodeInstanceGeneration(origin.instanceId) === generation
      && !getAuthoritativelyDeletedSessionIdsForInstance(origin.instanceId).has(sessionId)
    if (!admitted()) return false
    setNavigationError(false)
    // Targeted native hydration preserves authoritative locations and parent
    // metadata, including a cold descendant absent from the display catalog.
    try {
      await hydrateRestoredSessionChain(origin.instanceId, [sessionId], undefined, admitted)
    } catch {
      if (admitted()) setNavigationError(true)
      return false
    }
    if (!admitted()) return false
    if (!sessions().get(origin.instanceId)?.has(sessionId)) {
      setNavigationError(true)
      return false
    }
    batch(() => {
      setActiveSessionFromList(origin.instanceId, sessionId)
      showSessionChat(origin.scope)
      updateMissionProjectView(origin.scope, { reader: undefined })
    })
     origin.adoptConversation()
     if (!origin.current()) return false
     // Exact request selection belongs to our guarded navigation, before the
     // owned phone-drawer close retires this panel's view lifetime.
     afterSelection?.()
     if (!origin.current()) return false
     props.onRevealConversation?.()
    return origin.current()
  }

  const read = async (target: MissionReaderTarget) => {
    const origin = navigationOrigin()
    if (!origin.current()) return
    setNavigationError(false)
    const active = props.activeSessionId()
    if (!active || active === "info") {
      const coordinator = missions().find(m => m.id === target.missionId)?.coordinatorSessionId
      if (!coordinator || !await openActor(coordinator, origin)) return
    }
    if (!origin.current()) return
    batch(() => {
      showSessionChat(origin.scope)
      updateMissionProjectView(origin.scope, { reader: target })
    })
    origin.adoptConversation()
    if (!origin.current()) return
    props.onRevealConversation?.()
  }
  const readReport = (report: MissionReport) => {
    const value = mission()
    if (!value) return
    // The report reader resolves the durable report list. A reducer-owned result
    // outside that bounded list remains readable through its exact task instead.
    const task = value.tasks.find(task => task.report?.id === report.id)
    void read(value.reports.some(item => item.id === report.id)
      ? { missionId: value.id, kind: "report", itemId: report.id }
      : task ? { missionId: value.id, kind: "task", itemId: task.id }
        : { missionId: value.id, kind: "report", itemId: report.id })
  }

  return (
    <section class="mission-control" aria-label={props.t("missions.control.title")}>
      <header class="mission-control-header">
        <div class="mission-control-actions">
        <button type="button" class="mission-control-icon-button" disabled={state().status === "unavailable" || Boolean(editor())}
          aria-label={props.t("missions.control.create")} title={props.t("missions.control.create")}
          onClick={() => openEditor({ kind: "create" })}><Plus class="h-4 w-4" aria-hidden="true" /></button>
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
      <Show when={editor()} keyed>{action => {
        let completionCurrent: () => boolean = () => false
        return <MissionEditor instanceId={props.instanceId} viewDirectory={directory()} projectID={projectID()} action={action}
        active={() => action.current() && editor() === action}
        captureOperation={() => {
          const origin = captureView(), operation = intent
          completionCurrent = () => origin() && operation === intent
          return completionCurrent
        }}
        onCancel={closeEditor}
        onSaved={saved => {
          if (!completionCurrent() || editor() !== action) return
          const instanceId = props.instanceId, current = completionCurrent
          setEditor(undefined)
          if (!saved && action.mission) forgetMissionView(scope(), action.mission.id)
          void missionStore.refresh(instanceId).then(() => {
            if (saved && current() && !editor() && missions().some(mission => mission.id === saved.id)) setSelectedMissionId(saved.id)
          })
        }} />
      }}</Show>

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
                <MissionIndex
                  missions={missions()}
                  selectedId={selected().id}
                  onSelect={selectMission}
                  disabled={Boolean(editor())}
                  onEdit={value => openEditor({ kind: "edit", mission: value })}
                  onDelete={value => openEditor({ kind: "delete", mission: value })}
                  onRead={value => {
                    selectMission(value.id)
                    void read({ missionId: value.id, kind: "overview" })
                  }}
                  onOpenCoordinator={value => {
                    selectMission(value.id)
                    void openActor(value.coordinatorSessionId)
                  }}
                  recovery={value => createMissionRecoveryAction({
                    get instanceId() { return props.instanceId }, get mission() { return value() }, target: "coordinator",
                    get activity() { return state().activity?.missions.find(item => item.missionId === value().id)?.actors.find(actor => actor.sessionId === value().coordinatorSessionId)?.state },
                    get disabled() { return Boolean(editor()) || !(props.isActive?.() ?? true) },
                    onAdmitted: () => missionStore.refresh(props.instanceId),
                  })}
                  t={props.t}
                />
              <Show when={selected().id} keyed>{id => <MissionLifecycleControls instanceId={props.instanceId} mission={missions().find(mission => mission.id === id)!} disabled={Boolean(editor())} />}</Show>
              <MissionProgress mission={selected()} activity={state().activity?.missions.find(value => value.missionId === selected().id)?.actors}
                onOpenActor={async id => { await openActor(id) }}
                onReadOverview={() => void read({ missionId: selected().id, kind: "overview" })} />
               <MissionAttention mission={selected()} family={family(selected().id)} instanceId={props.instanceId} onOpenActor={async (id, request) => {
                 const origin = navigationOrigin()
                 await openActor(id, origin, () => {
                   if (!origin.current() || !request) return
                   const queue = request.kind === "form" ? getFormQueue(origin.instanceId) : getPermissionQueue(origin.instanceId)
                   if (queue.some(item => item.id === request.id && item.sessionID === id))
                     focusInterruption(origin.instanceId, id, request.id, request.kind)
                 })
               }} />
               <MissionActivity mission={selected()} onRead={readReport} />
              <MissionWork
                mission={selected()}
                instanceId={props.instanceId}
                activeSessionId={props.activeSessionId()}
                family={family(selected().id)}
                activity={state().activity?.missions.find(value => value.missionId === selected().id)?.actors}
                disabled={Boolean(editor()) || !(props.isActive?.() ?? true)}
                onRecoveryAdmitted={() => missionStore.refresh(props.instanceId)}
                onOpenActor={async id => { await openActor(id) }}
                onRead={task => void read({ missionId: selected().id, kind: "task", itemId: task.id })}
                onReport={report => void read({ missionId: selected().id, kind: "report", itemId: report.id })}
              />
                <MissionGuidance instanceId={props.instanceId} mission={selected()} active={props.isActive?.() ?? true}
                  disabled={Boolean(editor()) || state().status !== "ready"} />
                <MissionDisclosure missionId={selected().id} name="details" defaultOpen={false} title={props.t("missions.control.task.details")}>
                <Show when={selected().status === "active" && selected().reports.some(report => report.notificationStatus === "pending" && report.delivery !== "native-return")}>
                  <p class="mission-control-stale" role="status">{props.t("missions.control.report.notificationPending")}</p>
                </Show>
               <MissionReports missionId={selected().id} tasks={selected().tasks} reports={selected().reports} t={props.t}
                onRead={report => void read({ missionId: selected().id, kind: "report", itemId: report.id })} />
              <MissionActors
                mission={selected()}
                instanceId={props.instanceId}
                activity={state().activity?.missions.find(value => value.missionId === selected().id)?.actors}
                family={family(selected().id)}
                sessionTitle={id => sessions().get(props.instanceId)?.get(id)?.title ?? id}
                activeSessionId={props.activeSessionId()}
                onOpenActor={async id => { await openActor(id) }}
                t={props.t}
              />
                <MissionHistory mission={selected()} onRead={revision => void read({ missionId: selected().id, kind: "change", itemId: String(revision) })} />
               </MissionDisclosure>
            </>
          )}
        </Match>
      </Switch>
      <Show when={state().cleanupUnavailable}><p class="mission-control-stale" role="alert">{props.t("missions.cleanup.error.unconfirmed")}</p></Show>
      <MissionCleanupPanel instanceId={props.instanceId} cleanups={(state().cleanups ?? []).filter(item => item.pending > 0)}
        disabled={Boolean(editor()) || state().status !== "ready" || Boolean(state().cleanupUnavailable)} active={props.isActive?.() ?? true}
        refresh={() => missionStore.refresh(props.instanceId)} />
      <Show when={state().cleanups?.some(item => item.pending === 0)}>
        <MissionDisclosure missionId={`cleanup-history:${props.instanceId}`} name="cleanup-history" defaultOpen={false}
          title={props.t("missions.progress.cleanupHistory")}>
          <MissionCleanupPanel instanceId={props.instanceId} cleanups={(state().cleanups ?? []).filter(item => item.pending === 0)}
            disabled active={props.isActive?.() ?? true} refresh={() => missionStore.refresh(props.instanceId)} />
        </MissionDisclosure>
      </Show>
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
  onRead: (mission: MissionMap) => void
  onOpenCoordinator: (mission: MissionMap) => void
  recovery: (mission: () => MissionMap) => ReturnType<typeof createMissionRecoveryAction>
  t: MissionControlProps["t"]
}> = (props) => (
  <nav class="mission-control-index" aria-label={props.t("missions.control.mapLabel")}>
    <For each={props.missions.map(mission => mission.id)}>
      {id => {
        const mission = () => props.missions.find(mission => mission.id === id)!
        const recovery = props.recovery(mission)
        const recoveryAction = createMemo(() => id === props.selectedId ? recovery.action() : undefined)
        return <MissionListItem text={mission().objective} title={mission().objective}
          selected={id === props.selectedId} onSelect={() => props.onSelect(id)}
          statusKind={mission().status === "active" ? mission().runState ?? "active" : mission().status}
          status={props.t(mission().status === "active" && (mission().runState === "prepared" || mission().runState === "paused")
            ? `missions.control.run.${mission().runState}` : statusKey(mission().status))}
          actions={[
            { key: "read", label: props.t("missions.control.read"), icon: <Eye class="h-3.5 w-3.5" />, onSelect: () => props.onRead(mission()) },
            { key: "coordinator", label: props.t("missions.control.openCoordinator"), icon: <ArrowUpRight class="h-3.5 w-3.5" />, onSelect: () => props.onOpenCoordinator(mission()) },
            ...(recoveryAction() ? [recoveryAction()!] : []),
            { key: "edit", label: props.t("missions.control.edit"), icon: <Pencil class="h-3.5 w-3.5" />, disabled: props.disabled || mission().status !== "active", onSelect: () => props.onEdit(mission()) },
            { key: "delete", label: props.t("missions.control.delete"), icon: <Minus class="h-3.5 w-3.5" />, disabled: props.disabled, onSelect: () => props.onDelete(mission()) },
          ]}>
          <Show when={id === props.selectedId}>{recovery.feedback}</Show>
        </MissionListItem>
      }}
    </For>
  </nav>
)

const MissionReports: Component<{ missionId: string; tasks: MissionMap["tasks"]; reports: MissionReport[]; t: MissionControlProps["t"]; onRead: (report: MissionReport) => void }> = (props) => (
  <MissionDisclosure missionId={props.missionId} name="reports" defaultOpen={false} title={<><Check class="h-4 w-4" /><span>{props.t("missions.control.reports.title")}</span></>}>
    <Show when={props.reports.length > 0} fallback={<p class="mission-control-empty-line">{props.t("missions.control.reports.empty")}</p>}>
      <div class="mission-report-list">
        <For each={props.reports.map(report => report.id).reverse()}>
          {id => {
            const report = () => props.reports.find(report => report.id === id)!
            return <MissionListItem text={<>{props.tasks.find(task => task.key === report().taskKey)?.title ?? report().taskKey}{" — "}{report().summary}</>}
              title={report().summary} status={props.t(reportOutcomeKey(report().outcome))} statusKind={report().outcome}
              actions={[{ key: "read", label: props.t("missions.control.read"), icon: <Eye class="h-3.5 w-3.5" />, onSelect: () => props.onRead(report()) }]}>
              <Show when={report().late}><p class="mission-report-detail">{props.t("missions.control.report.late")}</p></Show>
            </MissionListItem>
          }}
        </For>
      </div>
    </Show>
  </MissionDisclosure>
)

function statusKey(status: MissionMap["status"]): string {
  return `missions.control.status.${status}`
}

function reportOutcomeKey(outcome: MissionReport["outcome"]): string {
  return `missions.control.report.outcome.${outcome}`
}

export default MissionControl
