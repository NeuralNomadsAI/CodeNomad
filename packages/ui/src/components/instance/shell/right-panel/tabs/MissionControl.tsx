import { For, Match, Show, Switch, batch, createComputed, createEffect, createMemo, createSignal, onCleanup, untrack, type Component, type JSX } from "solid-js"
import { AlertTriangle, ArrowUpRight, Eye, Flag, Loader2, Minus, Pencil, Plus, RefreshCw } from "lucide-solid"

import type { MissionMap } from "../../../../../../../server/src/api-types"
import { activateMissionDemand, deactivateMissionDemand, missionStore } from "../../../../../stores/missions"
import { activeParentSessionId, getAuthoritativelyDeletedSessionIdsForInstance, hydrateRestoredSessionChain, sessions, setActiveSessionFromList } from "../../../../../stores/sessions"
import { getOpenCodeInstanceGeneration } from "../../../../../stores/opencode-data"
import { instances, getPermissionQueue } from "../../../../../stores/instances"
import { getFormQueue } from "../../../../../stores/forms"
import { focusInterruption } from "../../../../../stores/interruption-navigation"
import { getSessionPreview, showSessionChatFor } from "../../../../../stores/session-previews"
import { forgetMissionView, missionDisclosureOpen, setMissionDisclosureOpen, missionProjectView, updateMissionProjectView, type MissionReaderTarget } from "../../../../../stores/mission-view-state"
import { MissionDisclosure } from "../../../../mission-disclosure"
import { MissionEditor, type MissionEditorAction } from "../../../../mission-editor"
import { MissionTracking } from "../../../../mission-tracking"
import { missionIncludesSession } from "../../../../mission-attention-model"
import { MissionListItem } from "../../../../mission-list-item"
import { createMissionRecoveryAction } from "../../../../mission-recovery-button"
import { MissionCleanupPanel } from "../../../../mission-cleanup"
import { MissionPreferences } from "../../../../mission-preferences"
import { MissionRecurrenceList } from "../../../../mission-recurrence-list"
import { missionTaskConversation } from "../../../../mission-task-navigation"
import { useMissionCurrentPassage } from "../../../../../stores/mission-recurrence"
import { createMissionViewFence } from "../../../../../lib/mission-view-fence"

interface MissionControlProps {
  instanceId: string
  activeSessionId: () => string | null
  isActive?: () => boolean
  onRevealConversation?: (restoreChat?: boolean) => void
  t: (key: string, vars?: Record<string, any>) => string
}

const MissionControl: Component<MissionControlProps> = (props) => {
  const scope = () => instances().get(props.instanceId)?.folder ?? props.instanceId
  const selectedMissionId = () => missionProjectView(scope()).selected
  const selectedSchedule = () => missionProjectView(scope()).selectedRecurrence
  const setSelectedMissionId = (selected: string) => updateMissionProjectView(scope(), { selected })
  const [editor, setEditor] = createSignal<MissionEditorAction & { current: () => boolean }>()
  const [navigationError, setNavigationError] = createSignal(false)
  const [recurrenceRefresh, setRecurrenceRefresh] = createSignal(0)
  const state = () => missionStore.state(props.instanceId)
  // Cached display revalidation is not a view/ownership transition. Message
  // admission still performs its own fresh authoritative mission read.
  const messagingDisabled = () => Boolean(editor()) || !["ready", "loading"].includes(state().status)
  const missions = () => state().missions
  const family = (id: string) => state().activity?.missions.find(item => item.missionId === id)?.family
  const includesSession = (value: MissionMap, id: string) => value.coordinatorSessionId === id
    || missionIncludesSession(value.actors, id, family(value.id))
  const directory = () => instances().get(props.instanceId)?.folder
  const projectID = () => instances().get(props.instanceId)?.metadata?.project?.id ?? state().projectID ?? missions()[0]?.projectID
  const captureView = createMissionViewFence(() => JSON.stringify([props.instanceId, directory(), projectID(), state().projectID]), () => props.isActive?.() ?? true)
  let intent = 0
  const selectMission = (id: string) => { intent++; updateMissionProjectView(scope(), { selected: id, selectedRecurrence: undefined }) }
  const openEditor = (action: MissionEditorAction) => {
    intent++
    setEditor({ ...action, current: captureView() })
  }
  const closeEditor = () => { intent++; setEditor(undefined) }
  const preferencesScope = () => `preferences:${scope()}`
  const preferencesActive = () => (props.isActive?.() ?? true) && missionDisclosureOpen(preferencesScope(), "preferences", false)
  let preferencesSection: HTMLDivElement | undefined
  const openPreferences = () => {
    setMissionDisclosureOpen(preferencesScope(), "preferences", true)
    queueMicrotask(() => {
      preferencesSection?.scrollIntoView({ block: "nearest" })
      preferencesSection?.querySelector<HTMLButtonElement>(".mission-disclosure-trigger")?.focus({ preventScroll: true })
    })
  }

  const conversation = () => ({ session: props.activeSessionId(), parent: activeParentSessionId().get(props.instanceId),
    preview: getSessionPreview(props.activeSessionId() ?? "", scope()), reader: missionProjectView(scope()).reader })
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
    if (selectedSchedule() || state().status !== "ready" || available.length === 0) return
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

  const currentPassage = useMissionCurrentPassage({ instanceId: () => props.instanceId, projectID,
    directory: scope, scheduleID: selectedSchedule, active: () => props.isActive?.() ?? true, refresh: recurrenceRefresh })
  const mission = createMemo(() => selectedSchedule() ? currentPassage.snapshot()?.mission
    : missions().find((candidate) => candidate.id === selectedMissionId()) ?? missions()[0])
  const observedActivity = () => selectedSchedule() ? currentPassage.snapshot()?.activity : state().activity
  const readerTarget = (target: MissionReaderTarget): MissionReaderTarget => {
    const current = currentPassage.snapshot()
    return selectedSchedule() && current?.mission && current.passageID ? { ...target, recurrence: {
      instanceId: props.instanceId, projectID: current.projectID, scheduleID: current.scheduleID, passageID: current.passageID,
    } } : target
  }
  const selectedFamily = () => observedActivity()?.missions.find(item => item.missionId === mission()?.id)?.family

  const navigationOrigin = () => {
    const instanceId = props.instanceId, viewScope = scope(), viewCurrent = captureView(), operation = ++intent
    const schedule = selectedSchedule(), passage = currentPassage.snapshot()?.passageID
    let epoch = conversationEpoch
    return { instanceId, scope: viewScope,
      current: () => viewCurrent() && operation === intent && scope() === viewScope && epoch === conversationEpoch
        && selectedSchedule() === schedule && (!schedule || currentPassage.snapshot()?.passageID === passage),
      // Adopt only our guarded synchronous batch, never an awaited external change.
      adoptConversation: () => { epoch = conversationEpoch },
    }
  }

  const openActor = async (sessionId: string, origin = navigationOrigin(), afterSelection?: () => void): Promise<boolean> => {
    const missionId = mission()?.id
    const scheduleID = selectedSchedule(), passageID = currentPassage.snapshot()?.passageID
    const client = instances().get(origin.instanceId)?.client, generation = getOpenCodeInstanceGeneration(origin.instanceId)
    const authorized = () => selectedSchedule() === scheduleID && (!scheduleID || currentPassage.snapshot()?.passageID === passageID)
      && (scheduleID ? Boolean(mission()?.id === missionId && (mission()!.coordinatorSessionId === sessionId
        || missionIncludesSession(mission()!.actors, sessionId, selectedFamily())))
        : missions().some(value => value.id === missionId && includesSession(value, sessionId)))
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
      showSessionChatFor(sessionId, origin.scope)
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

  const isReading = (target: MissionReaderTarget) => {
    const current = missionProjectView(scope()).reader
    return current?.missionId === target.missionId && current.kind === target.kind && current.itemId === target.itemId
      && JSON.stringify(current.recurrence) === JSON.stringify(readerTarget(target).recurrence)
  }
  const read = async (target: MissionReaderTarget) => {
    if (isReading(target)) {
      intent++
      batch(() => { showSessionChatFor(props.activeSessionId() ?? "", scope()); updateMissionProjectView(scope(), { reader: undefined }) })
      return
    }
    const origin = navigationOrigin()
    if (!origin.current()) return
    setNavigationError(false)
    const active = props.activeSessionId()
    if (!active || active === "info") {
      const value = mission()?.id === target.missionId ? mission() : undefined
      const task = value?.tasks.find(task => task.id === target.itemId)
      const actor = value && target.kind === "task" ? task && missionTaskConversation(value, task, selectedFamily()) : value?.coordinatorSessionId
      if (!actor || !await openActor(actor, origin)) return
    }
    if (!origin.current()) return
    batch(() => {
      showSessionChatFor(props.activeSessionId() ?? "", origin.scope)
      updateMissionProjectView(origin.scope, { reader: readerTarget(target) })
    })
    origin.adoptConversation()
    if (!origin.current()) return
    props.onRevealConversation?.()
  }
   const tracking = () => <>
     <Show when={selectedSchedule()}>
       <Show when={currentPassage.loading() && !currentPassage.snapshot()}><p role="status">{props.t("missions.control.loading")}</p></Show>
       <Show when={currentPassage.error()}><p role="status">{props.t(currentPassage.snapshot() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
       <Show when={currentPassage.snapshot() && !mission() && !currentPassage.snapshot()?.passageID}><p>{props.t("missions.recurrence.currentEmpty")}</p></Show>
     </Show>
     <Show when={mission()}>{selected => <MissionTracking
    instanceId={props.instanceId} mission={selected()} activity={observedActivity()} activeSessionId={props.activeSessionId()}
    active={props.isActive?.() ?? true} disabled={Boolean(editor())} messagingDisabled={messagingDisabled() || Boolean(selectedSchedule())}
    readOnly={Boolean(selectedSchedule())} reading={isReading} read={target => void read(target)}
    details={selectedSchedule() ? <bdi>{selectedSchedule()}</bdi> : undefined}
    refresh={() => missionStore.refresh(props.instanceId)} onOpenActor={async (id, request) => {
      const origin = navigationOrigin()
      await openActor(id, origin, () => {
        if (!origin.current() || !request) return
        const queue = request.kind === "form" ? getFormQueue(origin.instanceId) : getPermissionQueue(origin.instanceId)
        if (queue.some(item => item.id === request.id && item.sessionID === id)) focusInterruption(origin.instanceId, id, request.id, request.kind)
      })
     }} />}</Show>
   </>
  return (
    <section class="mission-control" aria-label={props.t("missions.control.title")}>
      <header class="mission-control-header">
        <div class="mission-control-actions">
        <button type="button" class="mission-control-create" disabled={state().status === "unavailable" || Boolean(editor())}
          aria-label={props.t("missions.control.create")} title={props.t("missions.control.create")}
          onClick={() => openEditor({ kind: "create" })}><Plus class="h-4 w-4" aria-hidden="true" />{props.t("missions.control.create")}</button>
        <button
          type="button"
          class="mission-control-icon-button"
          aria-label={props.t("missions.control.refresh")}
          title={props.t("missions.control.refresh")}
          disabled={state().status === "loading"}
          onClick={() => { void missionStore.refresh(props.instanceId); setRecurrenceRefresh(value => value + 1) }}
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
        onCancel={closeEditor} onOpenPreferences={openPreferences}
        onRecurrenceRefresh={() => setRecurrenceRefresh(value => value + 1)}
        onRecurrenceSaved={() => { if (!completionCurrent() || editor() !== action) return; setEditor(undefined); setRecurrenceRefresh(value => value + 1) }}
        onSaved={saved => {
          if (!completionCurrent() || editor() !== action) return
          const instanceId = props.instanceId, current = completionCurrent
          setEditor(undefined)
          if (!saved && action.mission) forgetMissionView(scope(), action.mission.id)
          void missionStore.refresh(instanceId).then(() => {
            if (saved && current() && !editor() && missions().some(mission => mission.id === saved.id)) selectMission(saved.id)
          })
        }} />
      }}</Show>

      <MissionRecurrenceList instanceId={props.instanceId} scope={scope()} projectID={projectID()} active={() => props.isActive?.() ?? true}
        refresh={recurrenceRefresh()} onRead={props.onRevealConversation} selectedSchedule={selectedSchedule()} onSelect={id => {
          intent++; updateMissionProjectView(scope(), { selectedRecurrence: id === selectedSchedule() ? undefined : id })
        }} tracking={tracking()} technicalDetails={!mission()}>
                <MissionIndex
                  missions={missions()}
                  selectedId={selectedSchedule() ? "" : selectedMissionId() ?? ""}
                  reading={id => isReading({ missionId: id, kind: "overview" })}
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
      </MissionRecurrenceList>

      <Show when={!selectedSchedule()}><Switch>
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
        <Match when={state().status === "ready" && missions().length === 0 && !editor()}>
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
              {/* Title the one-time controls with their selected Mission so they never read as
                  belonging to the list row above; siblings keep the shared panel disclosure layout. */}
              <header class="window-header mission-one-time-header">
                <strong class="window-title" title={selected().objective}>{selected().objective}</strong>
                <span class="neutral-badge badge-shape">{props.t("missions.simple.oneTime")}</span></header>
              {tracking()}
            </>
          )}
        </Match>
      </Switch></Show>
      <Show when={state().cleanupUnavailable}><p class="mission-control-stale" role="alert">{props.t("missions.cleanup.error.unconfirmed")}</p></Show>
      <MissionCleanupPanel instanceId={props.instanceId} cleanups={state().cleanups ?? []}
        disabled={Boolean(editor()) || state().status !== "ready" || Boolean(state().cleanupUnavailable)} active={props.isActive?.() ?? true}
        refresh={() => missionStore.refresh(props.instanceId)} />
      <div ref={preferencesSection} class="mission-control-preferences">
        <MissionDisclosure missionId={preferencesScope()} name="preferences" defaultOpen={false}
          title={props.t("missions.preferences.title")} description={props.t("missions.defaults.hint")}>
          <MissionPreferences instanceId={props.instanceId} directory={directory()} active={preferencesActive} />
        </MissionDisclosure>
      </div>
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
  reading: (id: string) => boolean
  onSelect: (id: string) => void
  disabled: boolean
  onEdit: (mission: MissionMap) => void
  onDelete: (mission: MissionMap) => void
  onRead: (mission: MissionMap) => void
  onOpenCoordinator: (mission: MissionMap) => void
  recovery: (mission: () => MissionMap) => ReturnType<typeof createMissionRecoveryAction>
  t: MissionControlProps["t"]
}> = (props) => (
  <>
    <For each={props.missions.map(mission => mission.id)}>
      {id => {
        const mission = () => props.missions.find(mission => mission.id === id)!
        const recovery = props.recovery(mission)
        const recoveryAction = createMemo(() => id === props.selectedId ? recovery.action() : undefined)
         return <MissionListItem text={mission().objective} secondary={<span class="neutral-badge badge-shape">{props.t("missions.simple.oneTime")}</span>} title={mission().objective}
          selected={id === props.selectedId} onSelect={() => props.onSelect(id)}
          statusKind={mission().status === "active" ? mission().runState ?? "active" : mission().status}
          status={props.t(mission().status === "active" && (mission().runState === "prepared" || mission().runState === "paused")
            ? `missions.control.run.${mission().runState}` : mission().status === "active" ? "missions.tracking.open" : statusKey(mission().status))}
          actions={[
            { key: "read", label: props.t("missions.control.read"), checked: props.reading(id), icon: <Eye class="h-3.5 w-3.5" />, onSelect: () => props.onRead(mission()) },
            { key: "coordinator", label: props.t("missions.control.openCoordinator"), icon: <ArrowUpRight class="h-3.5 w-3.5" />, onSelect: () => props.onOpenCoordinator(mission()) },
            ...(recoveryAction() ? [recoveryAction()!] : []),
            { key: "edit", label: props.t("missions.control.edit"), icon: <Pencil class="h-3.5 w-3.5" />, disabled: props.disabled || mission().status !== "active", onSelect: () => props.onEdit(mission()) },
            { key: "delete", label: props.t("missions.control.delete"), icon: <Minus class="h-3.5 w-3.5" />, disabled: props.disabled, onSelect: () => props.onDelete(mission()) },
          ]}>
          <Show when={id === props.selectedId}>{recovery.feedback}</Show>
        </MissionListItem>
      }}
    </For>
  </>
)

function statusKey(status: MissionMap["status"]): string {
  return `missions.control.status.${status}`
}

export default MissionControl
