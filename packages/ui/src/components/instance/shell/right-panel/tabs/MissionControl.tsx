import { Match, Show, Switch, batch, createComputed, createEffect, createMemo, createSignal, createUniqueId, onCleanup, untrack, type Component, type JSX } from "solid-js"
import { AlertTriangle, Flag, Loader2, RefreshCw, Settings } from "lucide-solid"

import type { MissionMap } from "../../../../../../../server/src/api-types"
import { activateMissionDemand, deactivateMissionDemand, missionStore } from "../../../../../stores/missions"
import { activeParentSessionId, getAuthoritativelyDeletedSessionIdsForInstance, hydrateRestoredSessionChain, sessions, setActiveSessionFromList } from "../../../../../stores/sessions"
import { getOpenCodeInstanceGeneration } from "../../../../../stores/opencode-data"
import { instances, getPermissionQueue } from "../../../../../stores/instances"
import { getFormQueue } from "../../../../../stores/forms"
import { focusInterruption } from "../../../../../stores/interruption-navigation"
import { getSessionPreview, showSessionChatFor } from "../../../../../stores/session-previews"
import { forgetMissionView, missionProjectView, updateMissionProjectView, type MissionReaderTarget } from "../../../../../stores/mission-view-state"
import { MissionEditor, type MissionEditorAction } from "../../../../mission-editor"
import { MissionTracking } from "../../../../mission-tracking"
import { missionIncludesSession, selectMissionAttention } from "../../../../mission-attention-model"
import { MissionPicker } from "../../../../mission-picker"
import { missionEntryAttention, type MissionPickerEntry } from "../../../../mission-picker-model"
import { MissionSelectedActions } from "../../../../mission-selected-actions"
import type { MissionControlRetry } from "../../../../mission-lifecycle-controls"
import { MISSION_ROW_TITLE_MAX, missionDisplayTitle, missionRelativeTime } from "../../../../../lib/mission-display"
import { useI18n } from "../../../../../lib/i18n"
import { MissionCleanupPanel } from "../../../../mission-cleanup"
import { openSettings } from "../../../../../stores/settings-screen"
import { createMissionRecurrenceList } from "../../../../mission-recurrence-list"
import { missionTaskConversation } from "../../../../mission-task-navigation"
import { missionDerivedSessionIncludes, missionDerivedTaskSession } from "../../../../../stores/mission-task-sessions"
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
  const { locale } = useI18n()
  const scope = () => instances().get(props.instanceId)?.folder ?? props.instanceId
  const selectedMissionId = () => missionProjectView(scope()).selected
  const selectedSchedule = () => missionProjectView(scope()).selectedRecurrence
  const [editor, setEditor] = createSignal<MissionEditorAction & { current: () => boolean }>()
  const [navigationError, setNavigationError] = createSignal(false)
  const [recurrenceRefresh, setRecurrenceRefresh] = createSignal(0)
  // The selected item's unconfirmed control, resent only by an explicit refresh click.
  const [controlRetry, setControlRetry] = createSignal<MissionControlRetry>()
  const [refreshing, setRefreshing] = createSignal(false)
  const registerRetry = (retry: MissionControlRetry) => {
    setControlRetry(() => retry)
    return () => setControlRetry(current => current === retry ? undefined : current)
  }
  const state = () => missionStore.state(props.instanceId)
  // Cached display revalidation is not a view/ownership transition. Message
  // admission still performs its own fresh authoritative mission read.
  const messagingDisabled = () => Boolean(editor()) || !["ready", "loading"].includes(state().status)
  const missions = () => state().missions
  const family = (id: string) => state().activity?.missions.find(item => item.missionId === id)?.family
  const includesSession = (value: MissionMap, id: string) => value.coordinatorSessionId === id
    || missionIncludesSession(value.actors, id, family(value.id)) || missionDerivedSessionIncludes(props.instanceId, value, id)
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
  const openPreferences = () => void openSettings("missions")

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

  const currentPassage = useMissionCurrentPassage({ instanceId: () => props.instanceId, projectID,
    directory: scope, scheduleID: selectedSchedule, active: () => props.isActive?.() ?? true, refresh: recurrenceRefresh })
  const mission = createMemo(() => selectedSchedule() ? currentPassage.snapshot()?.mission
    : missions().find((candidate) => candidate.id === selectedMissionId()))
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
        || missionIncludesSession(mission()!.actors, sessionId, selectedFamily())
        || missionDerivedSessionIncludes(props.instanceId, mission()!, sessionId)))
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
      const actor = value && target.kind === "task" ? task && missionTaskConversation(value, task, selectedFamily(),
        missionDerivedTaskSession(props.instanceId, value, task.key)) : value?.coordinatorSessionId
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
  const onOpenActor = async (id: string, request?: { id: string; kind: "form" | "permission" }) => {
    const origin = navigationOrigin()
    await openActor(id, origin, () => {
      if (!origin.current() || !request) return
      const queue = request.kind === "form" ? getFormQueue(origin.instanceId) : getPermissionQueue(origin.instanceId)
      if (queue.some(item => item.id === request.id && item.sessionID === id)) focusInterruption(origin.instanceId, id, request.id, request.kind)
    })
  }
  // Pending cleanups need an explicit retry and stay in the panel; settled
  // history belongs to the overview reader.
  const cleanupPending = () => (state().cleanups ?? []).some(item => item.pending > 0)
  const detailId = createUniqueId()
  const tracking = () => <>
    <Show when={selectedSchedule()}>
      <Show when={currentPassage.loading() && !currentPassage.snapshot()}><p role="status">{props.t("missions.control.loading")}</p></Show>
      <Show when={currentPassage.error()}><p role="status">{props.t(currentPassage.snapshot() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
    </Show>
    <Show when={mission()}>{selected => <MissionTracking
      instanceId={props.instanceId} mission={selected()} activity={observedActivity()}
      active={props.isActive?.() ?? true} disabled={Boolean(editor())}
      readOnly={Boolean(selectedSchedule())} reading={isReading} read={target => void read(target)}
      refresh={() => missionStore.refresh(props.instanceId)} onOpenActor={onOpenActor} />}</Show>
  </>
  const recurrence = createMissionRecurrenceList({ get instanceId() { return props.instanceId }, get scope() { return scope() },
    get projectID() { return projectID() }, active: () => props.isActive?.() ?? true, get refresh() { return recurrenceRefresh() },
    get onRead() { return props.onRevealConversation }, get selectedSchedule() { return selectedSchedule() },
    get tracking() { return tracking() }, detailId, registerRetry,
    get passage() {
      const passage = mission()
      if (!passage) return undefined
      const overview: MissionReaderTarget = { missionId: passage.id, kind: "overview" }
      return { reading: isReading(overview), onToggle: () => void read(overview),
        onOpenConversation: () => void openActor(passage.coordinatorSessionId) }
    } })
  const missionEntries = createMemo((): MissionPickerEntry[] => missions().map(value => {
    const observed = state().activity?.missions.find(item => item.missionId === value.id)
    const requests = selectMissionAttention({ actors: value.actors, forms: getFormQueue(props.instanceId),
      permissions: getPermissionQueue(props.instanceId), tasks: value.tasks, family: observed?.family })
      .filter(item => item.open && item.sessionId && item.kind !== "blocked").length
    const attention = missionEntryAttention(value, requests, observed?.actors.map(actor => actor.state))
    const resting = value.status !== "active" ? value.status : value.runState === "prepared" || value.runState === "paused" ? "paused" : "running"
    const stateText = props.t(value.status === "active" && (value.runState === "prepared" || value.runState === "paused")
      ? `missions.control.run.${value.runState}` : value.status === "active" ? "missionsPanel.state.inProgress" : statusKey(value.status))
    return { key: `mission:${value.id}`, title: missionDisplayTitle(value, MISSION_ROW_TITLE_MAX), attention, mark: attention ?? resting,
      status: [stateText, attention === "permission" ? props.t("missionsPanel.task.input") : "",
        missionRelativeTime(value.updatedAt, locale())].filter(Boolean).join(" · ") }
  }))
  const pickerEntries = () => [...missionEntries(), ...recurrence.entries()]
  const selectedKey = () => selectedSchedule() ? `schedule:${selectedSchedule()}` : mission() ? `mission:${mission()!.id}` : undefined
  const selectedOneTime = () => selectedSchedule() ? undefined : mission()
  const selectedOneTimeId = () => selectedOneTime()?.id
  const listExpanded = () => missionProjectView(scope()).listExpanded === true
  const refreshLabel = () => props.t(controlRetry()?.pending() ? "missions.control.refreshResend" : "missions.control.refresh")
  /** Read-only reconciliation first; only a control still unconfirmed by that
   * read is resent, with its original identity, from this explicit click. */
  const refresh = async () => {
    if (refreshing()) return
    const retry = controlRetry(), instanceId = props.instanceId
    setRefreshing(true)
    try {
      await Promise.allSettled([missionStore.refresh(instanceId), retry?.reconcile()])
      setRecurrenceRefresh(value => value + 1)
      if (retry && controlRetry() === retry && props.instanceId === instanceId && retry.pending()) await retry.resend()
    } finally { setRefreshing(false) }
  }
  return (
    <section class="mission-control" aria-label={props.t("missions.control.title")}>
      <header class="mission-control-header">
        <MissionPicker entries={pickerEntries()} selectedKey={selectedKey()}
          expanded={listExpanded()} onExpandedChange={value => updateMissionProjectView(scope(), { listExpanded: value || undefined })}
          onSelect={entry => {
            const [kind, id] = [entry.key.slice(0, entry.key.indexOf(":")), entry.key.slice(entry.key.indexOf(":") + 1)]
            if (kind === "schedule") { intent++; updateMissionProjectView(scope(), { selectedRecurrence: id }) }
            else selectMission(id)
          }}
          createDisabled={state().status === "unavailable" || Boolean(editor())}
          onCreate={() => openEditor({ kind: "create" })}
          trailing={<>
          <button type="button" class="mission-control-icon-button" aria-label={props.t("missions.preferences.title")}
            title={props.t("missions.preferences.title")} onClick={openPreferences}>
            <Settings class="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" class="mission-control-icon-button" aria-label={refreshLabel()}
            title={refreshLabel()} disabled={state().status === "loading" || refreshing()} onClick={() => void refresh()}>
            <Show when={state().status === "loading" || refreshing()} fallback={<RefreshCw class="h-4 w-4" />}>
              <Loader2 class="h-4 w-4 animate-spin" />
            </Show>
          </button>
        </>} />
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
      <Show when={state().status === "error" && missions().length > 0}>
        <div class="mission-control-stale" role="status">
          <AlertTriangle class="h-3.5 w-3.5" aria-hidden="true" />
          {props.t("missions.control.error.stale")}
        </div>
      </Show>

      {recurrence.view()}

      {/* Nothing below the picker until a Mission is selected; its detail is a separate section. */}
      <Show when={selectedOneTimeId()} keyed>{id => {
        // Keep the last known snapshot while the keyed detail is being disposed.
        const selected = createMemo<MissionMap>(previous => missions().find(value => value.id === id) ?? previous!)
        return <section id={detailId} class="mission-detail" aria-label={missionDisplayTitle(selected())}>
          <MissionSelectedActions instanceId={props.instanceId} mission={selected()} active={props.isActive?.() ?? true}
            disabled={Boolean(editor())} messagingDisabled={messagingDisabled()}
            reading={isReading({ missionId: id, kind: "overview" })} onToggleReader={() => void read({ missionId: id, kind: "overview" })}
            coordinatorActivity={state().activity?.missions.find(item => item.missionId === id)?.actors
              .find(actor => actor.sessionId === selected().coordinatorSessionId)?.state}
            onOpenCoordinator={() => void openActor(selected().coordinatorSessionId)}
            onAdmitted={() => missionStore.refresh(props.instanceId)} registerRetry={registerRetry}
            editDisabled={Boolean(editor()) || selected().status !== "active"} deleteDisabled={Boolean(editor())}
            onEdit={() => openEditor({ kind: "edit", mission: selected() })}
            onDelete={() => openEditor({ kind: "delete", mission: selected() })} />
          {tracking()}
        </section>
      }}</Show>

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
      </Switch></Show>
      <Show when={state().cleanupUnavailable}><p class="mission-control-stale" role="alert">{props.t("missions.cleanup.error.unconfirmed")}</p></Show>
      <Show when={cleanupPending()}><MissionCleanupPanel instanceId={props.instanceId} cleanups={state().cleanups ?? []}
        disabled={Boolean(editor()) || state().status !== "ready" || Boolean(state().cleanupUnavailable)} active={props.isActive?.() ?? true}
        refresh={() => missionStore.refresh(props.instanceId)} /></Show>
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

function statusKey(status: MissionMap["status"]): string {
  return `missions.control.status.${status}`
}

export default MissionControl
