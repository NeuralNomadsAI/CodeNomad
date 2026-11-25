import { For, Match, Show, Switch, batch, createComputed, createEffect, createMemo, createSignal, createUniqueId, onCleanup, untrack, type Component, type JSX } from "solid-js"
import { AlertTriangle, Flag, Loader2, RefreshCw, Settings } from "lucide-solid"

import type { MissionActivityProjection, MissionPanelMap, MissionSummary } from "../../../../../../../server/src/api-types"
import type { MissionUnavailableReason } from "../../../../../../../server/src/missions/model"
import { missionTaskExecutionEvidence } from "../../../../../../../server/src/missions/execution-evidence"
import type { MissionTaskMark } from "../../../../../../../server/src/missions/mission-task-marks"
import { MISSION_MARK_ACTORS } from "../../../../../lib/mission-panel-schema"
import { activateMissionDemand, deactivateMissionDemand, missionStore } from "../../../../../stores/missions"
import { getAuthoritativelyDeletedSessionIdsForInstance, hydrateRestoredSessionChain, sessions, setActiveSessionFromList } from "../../../../../stores/sessions"
import { getOpenCodeInstanceGeneration } from "../../../../../stores/opencode-data"
import { instances, getPermissionQueue } from "../../../../../stores/instances"
import { getFormQueue } from "../../../../../stores/forms"
import { focusInterruption } from "../../../../../stores/interruption-navigation"
import { applySurface, beginGesture, type SurfaceGesture } from "../../../../../stores/session-surface"
import { MAX_EXPANDED, forgetMissionView, markMissionsFinishedSeen, missionFinishedSeen, missionProjectView, retargetMissionReader, updateMissionProjectView, navigateMissionProjectView,
  type MissionReaderTarget } from "../../../../../stores/mission-view-state"
import { markMissionTasksSeen, missionTaskUnseen, seedMissionTasksSeen } from "../../../../../stores/mission-task-seen"
import { MissionEditor, type MissionEditorAction } from "../../../../mission-editor"
import { missionEditor, openMissionEditor, settleMissionEditor } from "../../../../../stores/mission-editor-state"
import { MissionTracking } from "../../../../mission-tracking"
import { missionIncludesSession, selectMissionAttention } from "../../../../mission-attention-model"
import { missionQuestionContext, missionQuestions, type MissionQuestionStore } from "../../../../mission-questions"
import { currentMissionObservations, missionQuestionOwners } from "../../../../mission-question-owners"
import { MissionPanelHeader, MissionRows } from "../../../../mission-picker"
import { MissionActionBar, MissionActionSlot, MissionTaskToolbarActive } from "../../../../mission-action-bar"
import { missionMark, sortMissionPickerEntries, type MissionPickerEntry } from "../../../../mission-picker-model"
import { createDocumentAttention } from "../../../../session/session-idle-attention"
import { MissionSelectedActions } from "../../../../mission-selected-actions"
import type { MissionControlRetry } from "../../../../mission-lifecycle-controls"
import { missionActivityWorking } from "../../../../mission-native-execution-model"
import { MISSION_ROW_TITLE_MAX, missionDisplayTitle, missionRelativeTime } from "../../../../../lib/mission-display"
import { useI18n } from "../../../../../lib/i18n"
import { MissionCleanupPanel } from "../../../../mission-cleanup"
import { missionCleanupPending } from "../../../../../lib/mission-cleanup"
import { openSettings, openSettingsRow } from "../../../../../stores/settings-screen"
import { createMissionRecurrenceList } from "../../../../mission-recurrence-list"
import { missionTaskConversation } from "../../../../mission-task-navigation"
import { conversationActivity, missionTaskRowState } from "../../../../mission-task-tree"
import { MissionTaskActions, type MissionTaskSelection } from "../../../../mission-task-actions"
import { MissionPassagePreview, MissionTaskPreview, type MissionPassageActorClick, type MissionPassageIdentity } from "../../../../mission-task-preview"
import { missionDerivedSessionIncludes, missionDerivedTaskSession, useMissionTaskSessionDemand } from "../../../../../stores/mission-task-sessions"
import { useMissionCurrentPassage } from "../../../../../stores/mission-recurrence"
import { createMissionViewFence, createReportedChanges } from "../../../../../lib/mission-view-fence"
import { sessionListRestored } from "../../../../../stores/session-list-restoration"
import { createMissionScheduleList } from "../../../../mission-schedule-list"
import { MissionPanelScope, MissionViewScope } from "../../../../mission-panel-scope"
import { MissionPanelPaging } from "../../../../mission-panel-paging"
import { projectScope } from "../../../../../lib/backend-identity"
import { captureBackendOperation } from "../../../../../lib/backend-operation"
import { MissionListPaging } from "../../../../mission-list-paging"

interface MissionControlProps {
  instanceId: string
  activeSessionId: () => string | null
  isActive?: () => boolean
  onRevealConversation?: (restoreChat?: boolean) => void
  t: (key: string, vars?: Record<string, any>) => string
}

// Each cause names what can fix it: reconnecting CodeNomad cannot load a plugin
// OpenCode has not loaded, nor provide a bridge this backend never published.
const UNAVAILABLE_DETAIL: Record<MissionUnavailableReason, string> = {
  "host-unavailable": "missions.control.unavailable.host",
  "plugin-unavailable": "missions.control.unavailable.plugin",
  "plugin-failed": "missions.control.unavailable.pluginFailed",
  "workspace-unavailable": "missions.control.unavailable.workspace",
}

const MissionControl: Component<MissionControlProps> = (props) => {
  const { locale } = useI18n()
  const scope = () => { const instance = instances().get(props.instanceId); return instance ? projectScope(instance) : props.instanceId }
  const view = () => missionProjectView(props.instanceId)
  const updateView = (patch: Parameters<typeof updateMissionProjectView>[1]) => updateMissionProjectView(props.instanceId, patch)
  const selectedMissionId = () => view().selected
  const selectedSchedule = () => view().selectedRecurrence
  const selectedScheduled = () => view().selectedScheduled
  const editorScope = () => JSON.stringify([props.instanceId, scope()])
  const editor = () => missionEditor(editorScope())
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
  // Full maps (open, selected, read) and one row per mission.
  const missions = () => state().missions
  const rows = () => state().summaries
  const family = (id: string) => state().activity?.missions.find(item => item.missionId === id)?.family
  // A full map, or a list row before its map is read (its declared actors and its
  // current marks window); a passage reads its own store and family. Only current
  // observation pages are evidence.
  const includesSession = (value: Pick<MissionPanelMap, "id" | "projectID" | "coordinatorSessionId"> & { actors: readonly { sessionId: string }[] }, id: string,
    store: MissionQuestionStore = missionStore, observedFamily = family(value.id), request?: { id: string; kind: "form" | "permission" }) => {
    const pages = currentMissionObservations(store, props.instanceId, value.id)
    return value.coordinatorSessionId === id
      || missionIncludesSession([...value.actors, ...store.observedActors(props.instanceId, value.id), ...pages.flatMap(page => page.context.actors)], id, observedFamily)
      || pages.some(page => page.requests.items.some(item => item.request.sessionID === id && (!request || item.kind === request.kind && item.request.id === request.id)))
      || missionDerivedSessionIncludes(props.instanceId, value as MissionPanelMap, id)
  }
  const directory = () => instances().get(props.instanceId)?.folder
  const projectID = () => instances().get(props.instanceId)?.metadata?.project?.id ?? state().projectID ?? missions()[0]?.projectID
  const completionScope = () => JSON.stringify([scope(), projectID()])
  createComputed(() => {
    if (state().projectID !== projectID() || state().status !== "ready") return
    const boundary = Math.max(0, ...rows().map(row => row.updatedAt), ...missions().flatMap(map => map.tasks.map(task => task.updatedAt)))
    untrack(() => seedMissionTasksSeen(completionScope(), boundary))
  })
  // A first list read that reports the instance's project is the view already shown: an operation
  // captured before it landed (a creation an agent submits right after opening the panel) still
  // completes here. One that reports another project is another view.
  const listProjectChanges = createReportedChanges(() => JSON.stringify([props.instanceId, directory()]), () => state().projectID,
    () => instances().get(props.instanceId)?.metadata?.project?.id)
  const captureView = createMissionViewFence(() => JSON.stringify([props.instanceId, directory(), projectID(), listProjectChanges()]), () => props.isActive?.() ?? true)
  let intent = 0
  const selectMission = (id: string) => {
    intent++
    // Hand off ownership before updateView unmounts an expanded preview, keeping its evidence alive.
    if (expandedKeys().has(`mission:${id}`)) missionStore.want(props.instanceId, wantOwner, id, false, undefined, true, true)
    updateView({ selected: id, selectedRecurrence: undefined, selectedScheduled: undefined, selectedTask: undefined })
  }
  // The panel has one selection: a row, or instead one task (of a one-time Mission, or of
  // the selected schedule's passage, whose row stays selected underneath).
  const selectedTaskKey = () => view().selectedTask
  const isSelectedTask = (missionId: string, taskId: string) => selectedTaskKey()?.missionId === missionId && selectedTaskKey()?.taskId === taskId
  // While the eye is pressed (a Mission or task reader is open), the reader follows the selection.
  const viewing = () => {
    const reader = view().reader
    return Boolean(reader) && reader!.kind !== "playbook"
  }
  const selectTask = (missionId: string, taskId: string, passage?: MissionPassageIdentity) => {
    intent++
    const resolved = passage ?? (passageSchedule() !== undefined && mission()?.id === missionId ? currentPassageIdentity() : undefined)
    // Hand off one-time mission ownership before selection change unmounts an expanded preview,
    // so activity evidence beyond directory marks survives into immediate question navigation.
    if (!resolved) {
      missionStore.want(props.instanceId, wantOwner, missionId, false, undefined, expandedKeys().has(`mission:${missionId}`), true)
    }
    navigateMissionProjectView(props.instanceId, {
      ...(resolved
        ? { selected: undefined,
            selectedRecurrence: resolved.owner === "scheduled" ? undefined : resolved.scheduleID,
            selectedScheduled: resolved.owner === "scheduled" ? resolved.scheduleID : undefined }
        : { selected: missionId, selectedRecurrence: undefined, selectedScheduled: undefined }),
      selectedTask: { missionId, taskId },
      ...(viewing() ? { reader: readerTarget({ missionId, kind: "task", itemId: taskId }, resolved ?? null) } : {}),
    })
  }
  // A chosen one-time Mission takes the open reader to its summary.
  const followReader = (id: string, intent: SurfaceGesture) => {
    const reader = view().reader
    if (!viewing() || !reader?.recurrence && reader?.missionId === id && reader.kind === "overview") return
    navigateMissionProjectView(props.instanceId, { reader: { missionId: id, kind: "overview" } }, intent)
  }
  const [actionSlot, setActionSlot] = createSignal<HTMLElement>()
  // The sticky header's height is the panel's scroll padding (mission-control.css).
  const measureHeader = (header: HTMLElement) => {
    const observer = new ResizeObserver(() => header.parentElement?.style.setProperty("--mission-header-height", `${header.offsetHeight}px`))
    observer.observe(header)
    onCleanup(() => observer.disconnect())
  }
  const [query, setQuery] = createSignal("")
  const openEditor = (action: MissionEditorAction) => {
    intent++
    openMissionEditor(editorScope(), action)
  }
  const closeEditor = () => {
    intent++
    const open = editor()
    if (open) settleMissionEditor(open)
  }
  const openPreferences = () => void openSettings("missions")
  // Playbook details keep the editor's independent operation current.
  const showPlaybook = (template: MissionPanelMap["template"], taskMode: "native" | "independent") => {
    batch(() => {
      navigateMissionProjectView(props.instanceId, { reader: { missionId: template, kind: "playbook", taskMode } })
    })
    props.onRevealConversation?.()
  }

  // Session-list restoration keeps priority; activation revalidates afterwards.
  const visible = () => (props.isActive?.() ?? true) && sessionListRestored(props.instanceId)
  createEffect(() => {
    const instanceId = props.instanceId
    if (!visible()) return
    // Visibility owns demand; fetching state must not retrigger this effect.
    untrack(() => activateMissionDemand(instanceId))
    onCleanup(() => deactivateMissionDemand(instanceId))
  })

  // A late recovery acknowledgement refreshes only a still-visible view: hidden
  // views keep their cached snapshot for activation revalidation.
  // Task trees are shown, and read, while the panel is active and the creation form is closed.
  const treeShown = () => (props.isActive?.() ?? true) && editor()?.kind !== "create"
  const directoryTaskMarks = createMemo(() => new Map(rows().map(row => [row.id, missionStore.taskMarks(props.instanceId, row.id)])))
  createEffect(() => {
    if (!visible() || !treeShown()) return
    for (const row of rows()) {
      if (row.taskCount === 0) continue
      const marks = directoryTaskMarks().get(row.id)!
      if (marks.loading) return
      if (marks.failure) continue
      const stale = marks.revision === undefined || marks.revision < row.revision
      if (stale || marks.more) {
        untrack(() => void missionStore.more(props.instanceId, `task-marks:${row.id}`, stale))
        return
      }
    }
  })
  // State marks belong to the rows already displayed, not a second user-managed
  // inventory. Continue one bounded window at a time, never beyond the shown directory.
  // Failures stay parked until an explicit Retry; inactive/covered trees stop demand.
  createEffect(() => {
    const marks = missionStore.progress(props.instanceId, "marks")
    if (!visible() || !treeShown() || marks.loading || marks.failure || !marks.more || marks.loaded >= rows().length) return
    untrack(() => void missionStore.more(props.instanceId, "marks"))
  })
  const refreshVisible = () => (props.isActive?.() ?? true) && missionStore.demandedInstanceIds().includes(props.instanceId)
    ? missionStore.refresh(props.instanceId) : Promise.resolve()

  const expandedKeys = createMemo(() => new Set(view().expanded ?? []))
  const isKeyExpanded = (key: string | undefined) => key !== undefined && expandedKeys().has(key)
  const passageSchedule = () => selectedSchedule() ?? selectedScheduled()
  const selectedScheduleExpanded = () => isKeyExpanded(selectedScheduled() ? `scheduled:${selectedScheduled()}` : selectedSchedule() ? `schedule:${selectedSchedule()}` : undefined)
  const [scheduledCurrent, setScheduledCurrent] = createSignal<string>()
  const [pendingSchedule, setPendingSchedule] = createSignal<{ key: string; origin: { instanceId: string; scope: string; signal: AbortSignal; surfaceIntent: SurfaceGesture; current: () => boolean; bindPassage: () => void };
    current: () => boolean; reader: boolean; answer: boolean; passageID?: string }>()
  const [openingPassage, setOpeningPassage] = createSignal<{ scheduleID: string; owner: "daily" | "scheduled" }>()
  const retireSchedule = () => {
    setPendingSchedule(undefined)
    setOpeningPassage(undefined)
  }
  onCleanup(retireSchedule)
  const readerTargetsSelectedSchedule = () => {
    const schedule = passageSchedule(), reader = view().reader
    if (!schedule || !reader || reader.kind === "playbook") return false
    const owner = selectedScheduled() ? "scheduled" : "daily"
    if (reader.recurrence) return reader.recurrence.scheduleID === schedule && (reader.recurrence.owner ?? "daily") === owner
    return reader.kind === "recurrence" && !reader.itemId && reader.missionId === schedule
      && Boolean(reader.scheduleOwner === "scheduled") === (owner === "scheduled")
  }
  const passageDemanded = () => {
    const schedule = passageSchedule()
    if (!schedule) return false
    const owner = selectedScheduled() ? "scheduled" : "daily"
    const key = `${owner === "scheduled" ? "scheduled" : "schedule"}:${schedule}`
    return selectedScheduleExpanded()
      || readerTargetsSelectedSchedule()
      || pendingSchedule()?.key === key
      || (openingPassage()?.scheduleID === schedule && openingPassage()?.owner === owner)
      || Boolean(selectedTaskKey())
  }
  const currentPassage = useMissionCurrentPassage({ instanceId: () => props.instanceId, projectID,
    directory: () => directory() ?? "", scheduleID: () => selectedSchedule() ?? scheduledCurrent(), owner: () => selectedScheduled() ? "scheduled" : "daily", active: () => (props.isActive?.() ?? true) && passageDemanded(), refresh: recurrenceRefresh })
  const passageStore = () => currentPassage.inventory() ?? missionStore
  // Collapsed completed rows use their summary (zero reads); collapsed active,
  // failed and stopped rows demand header-only, plus bounded activity observation
  // when directory marks do not cover toolbar evidence (never task pages);
  // expanding the chevron demands the full map.
  const wantOwner = `selection:${createUniqueId()}`
  const needsSelectedActivity = (id: string) => {
    const row = rows().find(item => item.id === id), map = missions().find(item => item.id === id)
    const status = map?.status ?? row?.status, runState = map?.runState ?? row?.runState ?? "running"
    if (status !== "active" || runState === "prepared") return false
    const actorCount = map?.panelCollections?.actors?.total
      ?? (row && "actorCount" in row && typeof row.actorCount === "number" ? row.actorCount : undefined)
    if (actorCount !== undefined && actorCount > MISSION_MARK_ACTORS) return true
    const expectedRevision = Math.max(row?.revision ?? 0, map?.revision ?? 0)
    const markPages = missionStore.markObservations(props.instanceId, id)
    const covered = markPages.length === 1 && markPages[0].coverage === "observed"
      && markPages[0].activity.family.state === "observed"
      && markPages[0].context.actorPage.end >= markPages[0].context.actorPage.total
      && markPages[0].context.revision >= expectedRevision
    if (covered) return false
    const marks = missionStore.progress(props.instanceId, "marks")
    return !row || Boolean(marks.failure) || !marks.loading && !marks.more
  }
  const selectionDemand = createMemo(() => {
    if (selectedSchedule() || selectedScheduled()) return undefined
    const id = selectedMissionId()
    if (!id) return undefined
    if (expandedKeys().has(`mission:${id}`)) return { id, detail: true, activity: true }
    if (selectedTaskKey()?.missionId === id) return { id, detail: false, activity: needsSelectedActivity(id) }
    const row = rows().find(item => item.id === id)
    if (row && row.status === "completed") return undefined
    return { id, detail: false, activity: needsSelectedActivity(id) }
  }, undefined, { equals: (a, b) => a?.id === b?.id && a?.detail === b?.detail && a?.activity === b?.activity })
  createEffect(() => {
    const instanceId = props.instanceId
    onCleanup(() => missionStore.want(instanceId, wantOwner, undefined))
  })
  createEffect(() => {
    const instanceId = props.instanceId, demand = selectionDemand()
    untrack(() => missionStore.want(instanceId, wantOwner, demand?.id, false, undefined, demand?.detail ?? false, demand?.activity ?? false))
  })
  const selectedOneTimeRow = () => selectedSchedule() || selectedScheduled() ? undefined : rows().find(row => row.id === selectedMissionId())
  const selectedOneTimeMap = () => selectedSchedule() || selectedScheduled() ? undefined : missions().find((candidate) => candidate.id === selectedMissionId())
  const mission = createMemo(() => passageSchedule() ? currentPassage.snapshot()?.scheduleID === passageSchedule() ? currentPassage.snapshot()?.mission : undefined
    : selectedOneTimeMap())
  const observedActivity = () => passageSchedule() ? currentPassage.snapshot()?.activity : state().activity
  // Open questions of a mission's declared actors and observed family.
  const openRequests = (id: string, actors: readonly { sessionId: string }[], activity?: MissionActivityProjection) => selectMissionAttention({ actors,
    forms: getFormQueue(props.instanceId), permissions: getPermissionQueue(props.instanceId), tasks: [],
    family: activity?.missions.find(item => item.missionId === id)?.family })
    .filter(item => item.open && item.sessionId && item.kind !== "blocked").length
  const currentRequests = () => {
    const value = mission(), passageID = currentPassage.snapshot()?.passageID
    if (!passageSchedule() || !passageDemanded() || !value || !passageID) return
    const store = passageStore(), actors = [...value.actors, ...store.observedActors(props.instanceId, value.id)]
    const known = new Set(currentMissionObservations(store, props.instanceId, value.id).flatMap(page => page.requests.items.map(item => `${item.kind}:${item.request.id}`)))
    return { passageID, count: Math.max(known.size, openRequests(value.id, actors, observedActivity())) }
  }
  const currentPassageIdentity = (): MissionPassageIdentity | undefined => {
    const current = currentPassage.snapshot()
    return passageSchedule() && current?.mission && current.passageID ? {
      projectID: current.projectID, scheduleID: current.scheduleID, passageID: current.passageID,
      ...(current.source?.owner === "scheduled" ? { owner: "scheduled" as const } : {}),
    } : undefined
  }
  const readerTarget = (target: MissionReaderTarget, passage: MissionPassageIdentity | null | undefined = currentPassageIdentity()): MissionReaderTarget =>
    target.kind !== "recurrence" && target.kind !== "playbook" && passage
      ? { ...target, recurrence: { instanceId: props.instanceId, ...passage } } : target
  const selectedFamily = () => observedActivity()?.missions.find(item => item.missionId === mission()?.id)?.family

  const navigationOrigin = (mode: "selected" | "discover" | "row" = "selected", surfaceIntent = beginGesture({ instanceId: props.instanceId, sessionId: props.activeSessionId() ?? null })) => {
    const instanceId = props.instanceId, viewScope = scope(), viewCurrent = captureView(), operation = ++intent
    const backend = captureBackendOperation(instanceId)
    const schedule = mode === "row" ? undefined : passageSchedule()
    let passage = mode === "selected" ? currentPassage.snapshot()?.passageID : undefined
    return { instanceId, scope: viewScope, signal: backend.signal, surfaceIntent,
      current: () => backend.current() && surfaceIntent.current() && viewCurrent() && operation === intent && scope() === viewScope
        && (mode === "row" || passageSchedule() === schedule && (!schedule || mode === "discover" && passage === undefined || currentPassage.snapshot()?.passageID === passage)),
      bindPassage: () => { passage = currentPassage.snapshot()?.passageID },
    }
  }

  const openActor = async (sessionId: string, authorized: () => boolean, origin: ReturnType<typeof navigationOrigin> = navigationOrigin(), afterSelection?: () => void): Promise<boolean> => {
    const client = instances().get(origin.instanceId)?.client, generation = getOpenCodeInstanceGeneration(origin.instanceId)
    const backend = captureBackendOperation(origin.instanceId, origin.signal)
    const admitted = () => backend.current() && origin.current() && authorized()
      && instances().get(origin.instanceId)?.client === client && getOpenCodeInstanceGeneration(origin.instanceId) === generation
      && !getAuthoritativelyDeletedSessionIdsForInstance(origin.instanceId).has(sessionId)
    if (!admitted()) return false
    setNavigationError(false)
    // Targeted native hydration preserves authoritative locations and parent
    // metadata, including a cold descendant absent from the display catalog.
    try {
      await hydrateRestoredSessionChain(origin.instanceId, [sessionId], backend.signal, admitted)
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
      setActiveSessionFromList(origin.instanceId, sessionId, origin.surfaceIntent)
      applySurface({ instanceId: origin.instanceId, sessionId }, { kind: "conversation" }, origin.surfaceIntent)
    })
    if (!origin.current()) return false
    // Exact request selection belongs to our guarded navigation, before the
    // owned phone-drawer close retires this panel's view lifetime.
    afterSelection?.()
    if (!origin.current()) return false
    props.onRevealConversation?.()
    return origin.current()
  }
  const focusRequest = (origin: ReturnType<typeof navigationOrigin>, sessionId: string, request?: { id: string; kind: "form" | "permission" }) => request ? () => {
    if (!origin.current()) return
    const queue = request.kind === "form" ? getFormQueue(origin.instanceId) : getPermissionQueue(origin.instanceId)
    if (queue.some(item => item.id === request.id && item.sessionID === sessionId)) focusInterruption(origin.instanceId, sessionId, request.id, request.kind)
  } : undefined
  const ownsOneTimeSession = (missionId: string | undefined, sessionId: string, request?: { id: string; kind: "form" | "permission" }) =>
    Boolean(missionId && (missions().some(value => value.id === missionId && includesSession(value, sessionId, missionStore, family(value.id), request))
      || rows().some(row => row.id === missionId && includesSession({ ...row, projectID: projectID() ?? "", actors: row.actorSessionIds.map(id => ({ sessionId: id })) }, sessionId, missionStore, family(row.id), request))))
  const openOneTimeActor = (missionId: string | undefined, sessionId: string, request?: { id: string; kind: "form" | "permission" }, origin = navigationOrigin()) =>
    openActor(sessionId, () => ownsOneTimeSession(missionId, sessionId, request), origin, focusRequest(origin, sessionId, request))
  const openSelectedPassageActor = (sessionId: string, request?: { id: string; kind: "form" | "permission" }, origin = navigationOrigin()) => {
    const scheduleID = passageSchedule(), passageID = currentPassage.snapshot()?.passageID, missionId = mission()?.id
    return openActor(sessionId, () => Boolean(scheduleID && passageID && missionId
      && passageSchedule() === scheduleID && currentPassage.snapshot()?.scheduleID === scheduleID
      && currentPassage.snapshot()?.passageID === passageID && mission()?.id === missionId
      && includesSession(mission()!, sessionId, passageStore(), selectedFamily(), request)), origin, focusRequest(origin, sessionId, request))
  }
  const openPreviewPassageActor = async (click: MissionPassageActorClick) => {
    const origin = navigationOrigin("row")
    await openActor(click.sessionId, () => {
      const live = click.live()
      if (live) return includesSession(live.mission, click.sessionId, live.store, live.family, click.request)
      const current = currentPassage.snapshot()
      return Boolean(passageSchedule() === click.scheduleID && current?.scheduleID === click.scheduleID
        && current.passageID === click.passageID && current.mission?.id === click.missionId
        && includesSession(current.mission, click.sessionId, passageStore(), selectedFamily(), click.request))
    }, origin, focusRequest(origin, click.sessionId, click.request))
  }

  const isReading = (target: MissionReaderTarget) => {
    const current = view().reader
    return current?.missionId === target.missionId && current.kind === target.kind && current.itemId === target.itemId
      && JSON.stringify(current.recurrence) === JSON.stringify(readerTarget(target).recurrence)
  }
  const read = async (target: MissionReaderTarget) => {
    if (isReading(target)) {
      intent++
      const ctx = { instanceId: props.instanceId, sessionId: props.activeSessionId() ?? null }
      applySurface(ctx, { kind: "conversation" })
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
          missionDerivedTaskSession(props.instanceId, value, task.key), [...value.actors, ...passageStore().observedActors(props.instanceId, value.id)])
        : value?.coordinatorSessionId ?? (passageSchedule() ? undefined : rows().find(row => row.id === target.missionId)?.coordinatorSessionId)
      const opened = actor ? await (passageSchedule() ? openSelectedPassageActor(actor, undefined, origin) : openOneTimeActor(target.missionId, actor, undefined, origin)) : false
      if (!opened) return
    }
    if (!origin.current()) return
    batch(() => {
      navigateMissionProjectView(origin.instanceId, { reader: readerTarget(target) }, origin.surfaceIntent)
    })
    if (!origin.current()) return
    props.onRevealConversation?.()
  }
  const onOpenActor = async (id: string, request?: { id: string; kind: "form" | "permission" }, missionId?: string, origin = navigationOrigin()) => {
    await (passageSchedule() ? openSelectedPassageActor(id, request, origin) : openOneTimeActor(missionId ?? mission()?.id, id, request, origin))
  }
  // Pending cleanups need an explicit retry and stay in the panel; settled
  // history belongs to the overview reader.
  const cleanupPending = () => (state().cleanups ?? []).some(missionCleanupPending)
  const detailId = createUniqueId()
  // Unfolds the selection's detail (MissionRows owns its folding).
  let revealDetail: (() => void) | undefined
  /** The selected task of `value`, with its conversation and activity. */
  const taskSelection = (value: MissionPanelMap | undefined, activity: MissionActivityProjection | undefined, store: ReturnType<typeof passageStore> = missionStore): MissionTaskSelection | undefined => {
    const selection = selectedTaskKey()
    if (!value || selection?.missionId !== value.id) return
    const task = value.tasks.find(item => item.id === selection.taskId)
    if (!task) return
    const observed = activity?.missions.find(item => item.missionId === value.id)
    const conversation = missionTaskConversation(value, task, observed?.family, missionDerivedTaskSession(props.instanceId, value, task.key),
      [...value.actors, ...store.observedActors(props.instanceId, value.id)])
    const state = task.actorSessionId ? observed?.actors.find(actor => actor.sessionId === task.actorSessionId)?.state
      : conversation ? conversationActivity(props.instanceId, value, conversation) : undefined
    return { task, conversation, activity: state }
  }
  // A red schedule row's question: the read passage's flag question, else its first one.
  const passageQuestion = () => {
    const value = passageSchedule() ? mission() : undefined
    if (!value) return undefined
    const store = passageStore(), family = observedActivity()?.missions.find(item => item.missionId === value.id)?.family
    const questions = missionQuestions({ instanceId: props.instanceId, mission: value, actors: value.actors, family, store })
    const actors = [...value.actors, ...store.observedActors(props.instanceId, value.id)]
    const owners = missionQuestionOwners(missionQuestionContext(props.instanceId, value), questions, value.tasks,
      task => missionTaskConversation(value, task, family, missionDerivedTaskSession(props.instanceId, value, task.key), actors))
    return owners.flag[0] ?? questions[0]
  }
  // Selecting a red schedule row answers as soon as its passage's questions are
  // discovered (the passage, its activity and request windows load separately). The
  // click's fences hold throughout: the same view, no newer selection or navigation
  // intent, no conversation change, the same connection and no editor; otherwise the
  // answer is dropped, never replayed later.
  const scheduleTarget = (id: string, scheduled: boolean): MissionReaderTarget => ({ kind: "recurrence", missionId: id,
    instanceId: props.instanceId, projectID: projectID(), ...(scheduled ? { scheduleOwner: "scheduled" as const } : {}) })
  createEffect(() => {
    const pending = pendingSchedule()
    if (!pending) return
    if (!(props.isActive?.() ?? true) || editor() || selectedKey() !== pending.key || !untrack(pending.current)) { retireSchedule(); return }
    // A failed read before any passage is shown, or a schedule with no current passage,
    // retires the intent: it never waits for a later read.
    const snapshot = currentPassage.snapshot()
    if ((currentPassage.error() && !mission()) || (!currentPassage.loading() && snapshot?.scheduleID === passageSchedule() && !snapshot?.passageID)) {
      retireSchedule(); return
    }
    // Only the passage first read after the click: a replacement retires the intent.
    const passageID = snapshot?.passageID ?? undefined
    if (passageID && pending.passageID === undefined) pending.passageID = passageID
    else if (pending.passageID !== undefined && passageID !== pending.passageID) { retireSchedule(); return }
    if (pending.reader && snapshot?.mission && passageID && !currentPassage.loading() && !currentPassage.error()) {
      untrack(() => {
        pending.origin.bindPassage()
        const reader = view().reader
        if (reader) retargetMissionReader(props.instanceId, reader, readerTarget({ missionId: snapshot.mission!.id, kind: "overview" }), pending.origin.surfaceIntent)
      })
      pending.reader = false
    }
    if (!pending.answer) {
      if (!currentPassage.loading() && snapshot?.scheduleID === passageSchedule()) retireSchedule()
      return
    }
    // Tracked: reruns as the passage, its activity and its request windows arrive.
    const question = passageQuestion()
    if (!question) {
      // Discovery settled without a question (it was answered meanwhile): retire the
      // intent, so a later unrelated question never triggers it.
      const value = mission()
      if (value && observedActivity()?.missions.some(item => item.missionId === value.id) && !currentPassage.loading()
        && !passageStore().reading(props.instanceId)) retireSchedule()
      return
    }
    const scheduleID = passageSchedule(), owner: "daily" | "scheduled" = selectedScheduled() ? "scheduled" : "daily"
    const token = scheduleID ? { scheduleID, owner } : undefined
    batch(() => {
      setOpeningPassage(token)
      setPendingSchedule(undefined)
    })
    untrack(() => {
      pending.origin.bindPassage()
      void onOpenActor(question.sessionId, question.request, undefined, pending.origin)
        .finally(() => setOpeningPassage(current => current === token ? undefined : current))
    })
  })
  // Whether the selection is a task of the selected row's Mission (or passage) rather than the row.
  // Restored/off-page task selection owns the toolbar while its bounded read resolves.
  const taskSelected = () => Boolean(selectedTaskKey())
  const selectedTaskDemand = createMemo(() => {
    const key = selectedTaskKey(), value = mission(), store = passageStore()
    if (!key || !value || value.id !== key.missionId || value.tasks.some(task => task.id === key.taskId)) return
    return { key: JSON.stringify([props.instanceId, scope(), value.projectID, passageSchedule(), currentPassage.snapshot()?.passageID,
      key, value.taskPage?.order, value.revision]), value, selection: key, store }
  }, undefined, { equals: (a, b) => a?.key === b?.key })
  let taskDemandKey: string | undefined
  createEffect(() => {
    const demand = selectedTaskDemand()
    if (!treeShown() || !demand || taskDemandKey === demand.key) return
    taskDemandKey = demand.key
    const current = captureView(), selection = demand.selection, schedule = passageSchedule(), passage = currentPassage.snapshot()?.passageID
    const stillCurrent = () => current() && selectedTaskKey() === selection && passageSchedule() === schedule
      && currentPassage.snapshot()?.passageID === passage && selectedTaskDemand()?.key === demand.key
    if (!demand.value.taskPage) {
      untrack(() => { if (stillCurrent()) updateView({ selectedTask: undefined }) })
      return
    }
    untrack(() => void demand.store.loadTasks(props.instanceId, demand.value.id, { ids: [selection.taskId] }).then(result => {
      if (result === "read" && stillCurrent() && !mission()?.tasks.some(task => task.id === selection.taskId))
        updateView({ selectedTask: undefined })
    }))
  })
  createEffect(() => {
    const selection = selectedTaskKey()
    if (selection && !passageSchedule() && missionStore.mapMissing(props.instanceId, selection.missionId))
      untrack(() => updateView({ selectedTask: undefined }))
  })
  createEffect(() => {
    const selection = selectedTaskKey(), snapshot = currentPassage.snapshot()
    // A positively read replacement/no-current passage retires its former task selection.
    if (selection && passageSchedule() && snapshot && snapshot.scheduleID === passageSchedule() && !currentPassage.loading()
      && !currentPassage.error() && snapshot.mission?.id !== selection.missionId)
      untrack(() => updateView({ selectedTask: undefined }))
  })
  createEffect(() => {
    const reader = view().reader
    if (!reader) return
    const resolve = () => {
      const snapshot = currentPassage.snapshot()
      if (!passageSchedule() || !snapshot || snapshot.scheduleID !== passageSchedule() || currentPassage.loading() || currentPassage.error()) return
      const scheduleReader = reader.kind === "recurrence" && !reader.itemId && reader.missionId === snapshot.scheduleID
        && reader.instanceId === props.instanceId && reader.projectID === projectID()
        && Boolean(reader.scheduleOwner === "scheduled") === Boolean(selectedScheduled())
      const passageReader = reader.recurrence?.scheduleID === snapshot.scheduleID && reader.recurrence.passageID !== snapshot.passageID
      if (!(scheduleReader && snapshot.mission && snapshot.passageID) && !passageReader) return
      return snapshot.mission && snapshot.passageID ? readerTarget({ missionId: snapshot.mission.id, kind: "overview" })
        : scheduleTarget(snapshot.scheduleID, Boolean(selectedScheduled()))
    }
    const target = resolve()
    if (target) untrack(() => retargetMissionReader(props.instanceId, reader, target))
  })
  // A schedule's current passage: its selected task takes the toolbar from the schedule's.
  const passageTask = createMemo(() => passageSchedule() ? taskSelection(mission(), observedActivity(), passageStore()) : undefined)
  const passageToolbarKey = createMemo(() => {
    const current = mission(), task = passageTask(), passageID = currentPassage.snapshot()?.passageID
    return current && task && passageID ? JSON.stringify([passageSchedule(), passageID, current.id, task.task.key]) : undefined
  })
  const tracking = () => <MissionPanelScope value={passageStore}><Show when={mission()}>{selected =>
    <MissionTracking instanceId={props.instanceId} mission={selected()} activity={observedActivity()}
      active={treeShown()} selected={task => isSelectedTask(selected().id, task.id)} onSelect={task => selectTask(selected().id, task.id)}
      onOpenActor={onOpenActor} />}</Show></MissionPanelScope>
  const previewRefreshes = new Set<() => Promise<void>>()
  const registerPreviewRefresh = (run: () => Promise<void>) => {
    previewRefreshes.add(run)
    return () => { previewRefreshes.delete(run) }
  }
  const previewSchedulePassage = (owner: "daily" | "scheduled", id: string) => <MissionPassagePreview
    instanceId={props.instanceId} projectID={projectID()} directory={directory() ?? ""}
    scheduleId={id} owner={owner} active={treeShown()} refresh={recurrenceRefresh()}
    onRegisterRefresh={registerPreviewRefresh}
    selected={(value, task) => isSelectedTask(value.id, task.id)}
    onSelect={(value, task, passage) => selectTask(value.id, task.id, passage)}
    onOpenActor={openPreviewPassageActor} />
  const recurrence = createMissionRecurrenceList({ get instanceId() { return props.instanceId }, get scope() { return scope() },
    get projectID() { return projectID() }, active: () => props.isActive?.() ?? true, get refresh() { return recurrenceRefresh() },
    get onRead() { return props.onRevealConversation }, get selectedSchedule() { return selectedSchedule() },
    get expanded() { return selectedScheduleExpanded() },
    previewTracking: id => previewSchedulePassage("daily", id),
    onOpenPendingConversation: (scheduleId, passageID, sessionId) => void openActor(sessionId,
      () => selectedSchedule() === scheduleId && recurrence.ownsPendingSession(scheduleId, passageID, sessionId)),
    get tracking() { return selectedSchedule() && selectedScheduleExpanded() ? tracking() : undefined }, detailId, registerRetry,
    get selectedRequests() { return selectedSchedule() ? currentRequests() : undefined },
    get passage() {
      const passage = mission()
      if (!passage) return undefined
      const overview: MissionReaderTarget = { missionId: passage.id, kind: "overview" }
      return { reading: isReading(overview), onToggle: () => void read(overview),
        onOpenConversation: () => void onOpenActor(passage.coordinatorSessionId) }
    } })
  const mapsById = createMemo(() => new Map(missions().map(map => [map.id, map])))
  const activityById = createMemo(() => new Map(state().activity?.missions.map(value => [value.missionId, value])))
  // Directory task facts own row attention. Selection only demands the detailed plan.
  const rowQuestions = createMemo(() => new Map(rows().map(value => {
    const observed = activityById().get(value.id), family = observed?.family
    const map = mapsById().get(value.id)
    const key = map ?? { ...value, projectID: projectID() ?? "" }
    const observations = currentMissionObservations(missionStore, props.instanceId, value.id)
    const marks = directoryTaskMarks().get(value.id)
    const currentMarks = marks?.revision !== undefined && marks.revision >= value.revision && marks.revision >= (map?.revision ?? 0)
    const facts: readonly MissionTaskMark[] = currentMarks ? marks.tasks : map?.tasks ?? []
    const actors = [...map?.actors ?? observations.flatMap(page => page.context.actors), ...missionStore.observedActors(props.instanceId, value.id)]
    const sessionContext = { id: value.id, projectID: key.projectID, coordinatorSessionId: value.coordinatorSessionId,
      revision: currentMarks ? marks.revision! : map?.revision ?? value.revision, tasks: facts }
    const questions = missionQuestions({ instanceId: props.instanceId, mission: { ...key, tasks: facts }, actors,
      family, store: missionStore })
    const conversation = (task: MissionTaskMark) => missionTaskConversation({ ...sessionContext, actors }, task, family,
      missionDerivedTaskSession(props.instanceId, key, task.key), actors)
    const activities = new Map(observed?.actors.map(actor => [actor.sessionId, actor.state]))
    const taskStates = facts.map(task => missionTaskRowState(props.instanceId, key, task, activities, conversation(task), false))
    const coveredActors = new Set(facts.flatMap(task => [task.actorSessionId, conversation(task)].filter((id): id is string => Boolean(id))))
    const loadedOwed = new Set(map?.tasks.filter(task => missionTaskExecutionEvidence(task).missingReport).map(task => task.actorSessionId))
    const wholeOwed = [...map?.actorEvidence?.reportOwed ?? [], ...observations
      .flatMap(page => page.context.actors.filter(actor => actor.reportOwed).map(actor => actor.sessionId))]
    const offPageOwed = new Set(wholeOwed.filter(id => !loadedOwed.has(id)))
    const partialTasks = currentMarks ? marks.more : !map || (map.taskPage?.total ?? map.tasks.length) > map.tasks.length
    // Finished tasks this window has not shown yet (green, like an idle subsession).
    const unseen = facts.filter((task, index) => taskStates[index] === "done" && missionTaskUnseen(completionScope(), value.id, task))
    const observeNative = facts.some(task => !task.actorSessionId && !task.replacedByTaskKey && !["completed", "failed", "withdrawn"].includes(task.status))
      && Boolean(family?.state !== "unknown" && family?.members.some(member => member.actorSessionId === value.coordinatorSessionId && member.sessionId !== value.coordinatorSessionId))
    return [value.id, { ...missionQuestionOwners(missionQuestionContext(props.instanceId, key), questions, currentMarks || map ? facts : undefined, conversation),
      sessionContext, observeNative, facts, taskStates, coveredActors, offPageOwed, partialTasks, unseen }]
  })))
  const missionEntries = createMemo((): MissionPickerEntry[] => rows().map(value => {
    const observed = activityById().get(value.id)
    const questions = rowQuestions().get(value.id)
    const others = questions?.partialTasks ? observed?.actors.filter(actor => actor.sessionId !== value.coordinatorSessionId
      && (!questions.coveredActors.has(actor.sessionId) || questions.offPageOwed.has(actor.sessionId))).map(actor => actor.state) ?? [] : []
    const mark = missionMark(value, { openRequests: questions?.flag.length ?? 0, actorStates: observed?.actors.map(actor => actor.state),
      coordinatorState: observed?.actors.find(actor => actor.sessionId === value.coordinatorSessionId)?.state,
      seen: missionFinishedSeen(completionScope(), value) })
    // Like session rows, input, work and unseen results propagate independently of selection.
    const tasks = questions?.taskStates ?? []
    const childActivity = questions?.tasks.length || tasks.includes("input")
      || others.some(state => state === "permission" || state === "form") ? "permission" as const
      : tasks.includes("active") || others.some(state => state === "running" || state === "queued" || state === "background")
        ? "working" as const : questions?.unseen.length ? "idle" as const : undefined
    const stateText = props.t(value.status === "active" && (value.runState === "prepared" || value.runState === "paused")
      ? `missions.control.run.${value.runState}` : value.status === "active" && mark === "interrupted" ? "missionsPanel.state.interrupted"
        : value.status === "active" ? "missionsPanel.state.inProgress" : statusKey(value.status))
    // The read map's count, else the row's (absent when unknown: the chevron stays).
    const map = missionStore.state(props.instanceId).missions.find(item => item.id === value.id)
    const taskCount = map ? map.taskPage?.total ?? map.tasks.length : value.taskCount
    return { key: `mission:${value.id}`, title: missionDisplayTitle(value, MISSION_ROW_TITLE_MAX), mark, childActivity, leaf: taskCount === 0,
      activityAt: value.updatedAt,
      status: [stateText, mark === "permission" ? props.t("missionsPanel.task.input") : "",
        childActivity === "permission" ? props.t("missionsPanel.row.taskInput") : "",
        missionRelativeTime(value.updatedAt, locale())].filter(Boolean).join(" · ") }
  }))
  // The saved Mission ID survives ownership conversion in another window, including
  // cold restoration. Point-read that selection; absence never triggers an inventory scan.
  const unifiedSelection = () => selectedScheduled() ?? (selectedSchedule() ? undefined : selectedMissionId())
  const scheduled = createMissionScheduleList({ get instanceId() { return props.instanceId }, get directory() { return directory() ?? "" },
    get selectedRequests() { return selectedScheduled() ? currentRequests() : undefined },
    get expanded() { return selectedScheduleExpanded() },
    previewTracking: id => previewSchedulePassage("scheduled", id),
    onPassage: setScheduledCurrent,
    onNoPassage: id => {
      if (selectedScheduled() !== id) return
      const reader = view().reader
      batch(() => {
        if (selectedTaskKey()) updateView({ selectedTask: undefined })
        if (reader?.recurrence?.scheduleID === id && reader.recurrence.owner === "scheduled")
          retargetMissionReader(props.instanceId, reader, scheduleTarget(id, true))
      })
    },
    get tracking() { return selectedScheduled() && selectedScheduleExpanded() ? tracking() : undefined },
    get passage() { const value = selectedScheduled() ? mission() : undefined; if (!value) return undefined
      const target: MissionReaderTarget = { missionId: value.id, kind: "overview" }
      return { reading: isReading(target), onToggle: () => void read(target) } },
    get overview() {
      const id = selectedScheduled()
      if (!id) return undefined
      const target = scheduleTarget(id, true)
      return { reading: isReading(target), onToggle: () => {
        intent++
        const close = isReading(target)
        navigateMissionProjectView(props.instanceId, { reader: close ? undefined : target })
        if (!close) props.onRevealConversation?.()
      } }
    },
    get projectID() { return projectID() }, active: visible, enabled: () => !editor(), get refresh() { return recurrenceRefresh() },
    get selected() { return unifiedSelection() }, detailId, onEdit: id => openEditor({ kind: "edit", scheduleID: id }),
    onDeleted: id => { if (selectedScheduled() === id) updateView({ selectedScheduled: undefined }) },
    onOpenConversation: target => void openActor(
      target.sessionID,
      () => (target.kind === "pending" ? selectedScheduled() === target.scheduleID : true) && scheduled.ownsSession(target),
      navigationOrigin(target.kind === "pending" ? "selected" : "row"),
    ) })
  createEffect(() => {
    const id = unifiedSelection()
    if (!visible() || editor() || !id) return
    const representation = scheduled.representation(id)
    if (representation === "one-time" && selectedScheduled() === id) updateView({ selected: id, selectedRecurrence: undefined, selectedScheduled: undefined, selectedTask: undefined })
    else if (representation === "schedule" && selectedScheduled() !== id) {
      updateView({ selected: undefined, selectedRecurrence: undefined, selectedScheduled: id })
    }
  })
  const pickerEntries = createMemo(() => {
    const unified = scheduled.entries(), ids = new Set(unified.map(row => row.key.slice("scheduled:".length)))
    return sortMissionPickerEntries([
      ...missionEntries().filter(row => !ids.has(row.key.slice("mission:".length))),
      ...recurrence.entries(),
      ...unified,
    ])
  })
  const selectedRow = selectedOneTimeRow
  const selectedKey = () => selectedScheduled() ? `scheduled:${selectedScheduled()}` : selectedSchedule() ? `schedule:${selectedSchedule()}` : selectedRow() ? `mission:${selectedRow()!.id}` : undefined
  const selectedOneTimeId = () => {
    const map = selectedOneTimeMap()
    if (map) return map.id
    const row = selectedOneTimeRow()
    return row && (!selectionDemand() || row.status === "completed") && !missionStore.mapMissing(props.instanceId, row.id) ? row.id : undefined
  }
  const selectedOneTimeExpanded = () => { const id = selectedOneTimeId(); return Boolean(id && expandedKeys().has(`mission:${id}`)) }
  const creating = () => editor()?.kind === "create"
  // Like an idle session, a completed Mission stays green until this window shows it;
  // the creation form hides the selected detail.
  const documentAttention = createDocumentAttention()
  createEffect(() => {
    if (!["ready", "loading", "error"].includes(state().status) || state().projectID !== projectID()) return
    const completed = rows().filter(value => value.status === "completed")
    const shownId = selectedOneTimeMap()?.status === "completed" ? selectedOneTimeMap()!.id
      : selectedRow()?.status === "completed" ? selectedRow()!.id : undefined
    const shown = (props.isActive?.() ?? true) && documentAttention() && !creating() && shownId ? [shownId] : []
    const viewScope = completionScope()
    untrack(() => markMissionsFinishedSeen(viewScope, shown, completed, true))
  })
  const [journalSettled, setJournalSettled] = createSignal<string>()
  const loadKey = () => JSON.stringify([props.instanceId, directory()])
  createComputed(() => {
    const key = loadKey(), status = state().status
    if (status === "ready" || status === "error" || status === "unavailable") setJournalSettled(key)
  })
  const initialLoading = () => journalSettled() !== loadKey() && state().status === "loading"
  const refreshLabel = () => props.t(controlRetry()?.pending() ? "missions.control.refreshResend" : "missions.control.refresh")
  const refreshSpinning = () => refreshing() || initialLoading()
  /** Read-only reconciliation first; only a control still unconfirmed by that
   * read is resent, with its original identity, from this explicit click. */
  const refresh = async () => {
    if (refreshing()) return
    const retry = controlRetry(), instanceId = props.instanceId
    const operation = captureBackendOperation(instanceId, undefined, captureView())
    if (!operation.current()) return
    setRefreshing(true)
    try {
      const mapRead = missionStore.refresh(instanceId)
      const extraReads = Promise.allSettled([
        scheduled.refreshNow(),
        recurrence.refreshNow(),
        currentPassage.refreshNow(),
        ...[...previewRefreshes].map(run => run()),
      ])
      const [, read] = await Promise.allSettled([mapRead, retry?.reconcile(mapRead)])
      if (operation.current()) {
        // A skipped, failed or superseded read never leads to a resend.
        const witnessed = read.status === "fulfilled" && read.value === true
        if (retry && witnessed && controlRetry() === retry && props.instanceId === instanceId && retry.pending()) await retry.resend()
      }
      await extraReads
    } finally { setRefreshing(false) }
  }
  return (
    // While creating, the form replaces the list and the selected detail, which stay mounted
    // (hidden by mission-control.css) so their pending controls and retries survive.
     <MissionViewScope value={completionScope}><MissionActionSlot.Provider value={actionSlot}><MissionTaskToolbarActive.Provider value={() => Boolean(passageSchedule() && taskSelected())}>
    <section class="mission-control" data-creating={creating() ? "" : undefined} aria-label={props.t("missions.control.title")}>
      <header class="mission-control-header" ref={measureHeader}>
        <MissionPanelHeader actionSlot={setActionSlot}
          idleActions={<MissionActionBar inline label={props.t("missionsPanel.picker.actions")} reading={false} />}
          query={query()} onQuery={setQuery} filterable={pickerEntries().length > 0}
          createDisabled={state().status === "unavailable" || Boolean(editor())}
          creating={creating()}
          onCreate={() => openEditor({ kind: "create" })}
          trailing={<>
          <button type="button" class="mission-control-icon-button" aria-label={props.t("missions.preferences.title")}
            title={props.t("missions.preferences.title")} onClick={openPreferences}>
            <Settings class="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" class="mission-control-icon-button" aria-label={refreshLabel()}
            title={refreshLabel()} disabled={refreshing() || initialLoading()} onClick={() => void refresh()}>
            <Show when={refreshSpinning()} fallback={<RefreshCw class="h-4 w-4" />}>
              <span class="inline-flex animate-spin"><Loader2 class="h-4 w-4" /></span>
            </Show>
          </button>
        </>} />
      </header>
      <For each={rows().map(row => row.id)}>{id => {
        useMissionTaskSessionDemand({ instanceId: () => props.instanceId, mission: () => rowQuestions().get(id)?.sessionContext,
          active: () => visible() && treeShown() && Boolean(rowQuestions().get(id)?.observeNative), pulse: () => state().activity?.generatedAt })
        return null
      }}</For>
      <Show when={passageSchedule() && taskSelected()}>
        <Show when={passageToolbarKey()} keyed
          fallback={<MissionActionBar task label={props.t("missionsPanel.picker.actions")} reading={false} />}>
          {_key => <MissionPanelScope value={passageStore}><MissionTaskActions readOnly instanceId={props.instanceId} mission={mission()!}
            selection={passageTask()!} disabled onAdmitted={refreshVisible}
            reading={isReading({ missionId: mission()!.id, kind: "task", itemId: passageTask()!.task.id })}
            onToggleReader={() => { const task = passageTask(), current = mission(); if (task && current) void read({ missionId: current.id, kind: "task", itemId: task.task.id }) }}
            onOpenConversation={id => void openSelectedPassageActor(id)} /></MissionPanelScope>}
        </Show>
      </Show>
      <Show when={navigationError()}><p class="mission-control-stale" role="alert">{props.t("sessionList.reload.error")}</p></Show>
      <Show when={editor()} keyed>{action => {
        let completionCurrent: () => boolean = () => false
        // Live view activity; each operation captures its own view fence.
        return <MissionEditor instanceId={props.instanceId} viewDirectory={directory()} projectID={projectID()} action={action}
        active={() => (props.isActive?.() ?? true) && editor() === action}
        onDispose={draft => settleMissionEditor(action, draft === null ? action : draft && { ...action, draft })}
        captureOperation={() => {
          const origin = captureView(), operation = intent, backend = captureBackendOperation(props.instanceId)
          completionCurrent = () => backend.current() && origin() && operation === intent
          return completionCurrent
        }}
        onCancel={closeEditor} onOpenPreferences={openPreferences} onShowPlaybook={showPlaybook}
        onReopen={() => {
          // The edit reopens on the newest map, read first: the one it opened on is outdated.
          // The form stays as it opened until this settles; a failed read rejects, so it says so.
          const view = captureBackendOperation(props.instanceId, undefined, captureView()).current
          return missionStore.refresh(props.instanceId).then(() => {
            if (!view() || editor() !== action) return
            if (missionStore.state(props.instanceId).status !== "ready") throw new Error("The mission map could not be read")
            const current = missions().find(mission => mission.id === action.mission?.id)
            if (current) openEditor({ kind: "edit", mission: current })
          })
        }}
        onRecurrenceRefresh={() => setRecurrenceRefresh(value => value + 1)}
        onRecurrenceSaved={() => { if (!completionCurrent() || editor() !== action) return; settleMissionEditor(action); setRecurrenceRefresh(value => value + 1) }}
        onSaved={(saved, scheduleID) => {
          if (!completionCurrent() || editor() !== action) return
          const instanceId = props.instanceId, current = completionCurrent
          settleMissionEditor(action)
          setRecurrenceRefresh(value => value + 1)
          if (scheduleID) updateView({ selectedScheduled: scheduleID, selectedRecurrence: undefined })
          const deletedId = action.deleteTarget?.id ?? action.mission?.id
          if (!saved && deletedId) forgetMissionView(props.instanceId, deletedId)
          void missionStore.refresh(instanceId).then(() => {
            const id = saved?.id ?? scheduleID
            if (id && current() && !editor()) selectMission(id)
          })
        }} />
      }}</Show>
      <MissionRows entries={pickerEntries()} query={query()} selectedKey={selectedKey()} revealDetail={reveal => { revealDetail = reveal }}
        rowSelected={!taskSelected()}
        expanded={() => view().expanded ?? []}
        onExpanded={keys => updateView({ expanded: keys.slice(-MAX_EXPANDED) })}
        markRead={key => {
          if (!key.startsWith("mission:")) return key.startsWith("schedule:") ? recurrence.markRead(key) : scheduled.markRead(key)
          const id = key.slice("mission:".length), entry = missionEntries().find(item => item.key === key)
          const unseen = rowQuestions().get(id)?.unseen ?? [], finished = entry?.mark === "done"
          // Like a session hierarchy: clears the finished-unseen tasks and the Mission's own completion.
          return unseen.length || finished ? () => batch(() => {
            markMissionTasksSeen(completionScope(), id, rowQuestions().get(id)?.facts ?? [], true,
              Math.max(directoryTaskMarks().get(id)?.through ?? 0, mapsById().get(id)?.updatedAt ?? 0, rows().find(row => row.id === id)?.updatedAt ?? 0))
            if (finished) markMissionsFinishedSeen(completionScope(), [id], rows().filter(value => value.status === "completed"), true)
          }) : undefined
        }}
        paging={<>{recurrence.listView()}{scheduled.listView()}
          <MissionListPaging instanceId={props.instanceId} active={treeShown()}
            taskMarksError={[...directoryTaskMarks().values()].some(value => Boolean(value.failure))}
            taskMarksLoading={[...directoryTaskMarks().values()].some(value => Boolean(value.failure && value.loading))}
            onTaskMarksRetry={() => { for (const [id, value] of directoryTaskMarks()) if (value.failure) void missionStore.more(props.instanceId, `task-marks:${id}`, true) }}
            scheduleMore={Boolean(scheduled.next())} scheduleLoading={scheduled.loading()} scheduleError={scheduled.error()}
            onScheduleMore={scheduled.more} onScheduleRetry={scheduled.retry} /></>}
        onSelect={entry => {
          retireSchedule()
          const admitted = beginGesture({ instanceId: props.instanceId, sessionId: props.activeSessionId() ?? null })
          const [kind, id] = [entry.key.slice(0, entry.key.indexOf(":")), entry.key.slice(entry.key.indexOf(":") + 1)]
          if (kind === "schedule" || kind === "scheduled") {
            // Capture this displayed result before selection starts any reads. A
            // restored selection or a later success never inherits this gesture.
            const acknowledge = entry.mark === "done" ? (kind === "schedule" ? recurrence : scheduled).markRead(entry.key) : undefined
            if (treeShown() && documentAttention() && !editor()) acknowledge?.()
            intent++
            const follow = viewing()
            batch(() => {
              updateView(kind === "schedule" ? { selected: undefined, selectedRecurrence: id, selectedScheduled: undefined, selectedTask: undefined }
                : { selected: undefined, selectedRecurrence: undefined, selectedScheduled: id, selectedTask: undefined })
              if (follow) navigateMissionProjectView(props.instanceId, { reader: scheduleTarget(id, kind === "scheduled") }, admitted)
            })
            // A red row asks for an answer: open its passage's question, as for a Mission row.
            if (follow || entry.mark === "permission") {
              const origin = navigationOrigin("discover", admitted), instanceId = props.instanceId
              const client = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
              setPendingSchedule({ key: entry.key, origin, reader: follow, answer: entry.mark === "permission",
                current: () => origin.current() && !editor() && instances().get(instanceId)?.client === client
                  && getOpenCodeInstanceGeneration(instanceId) === generation })
            }
          }
          else {
            batch(() => { followReader(id, admitted); selectMission(id) })
            // A red flag asks for an answer: like a session row, open the asking
            // conversation with its question focused in the dock.
            const question = rowQuestions().get(id)?.flag[0]
            if (question) {
              void openOneTimeActor(id, question.sessionId, question.request, navigationOrigin("selected", admitted))
            }
          }
        }}
        preview={key => key.startsWith("mission:")
          ? <MissionTaskPreview instanceId={props.instanceId} missionId={key.slice("mission:".length)} activity={state().activity}
              active={treeShown()}
              selected={(value, task) => isSelectedTask(value.id, task.id)}
              onSelect={(value, task) => selectTask(value.id, task.id)}
              onAnswer={async (value, sessionId, request) => { await openOneTimeActor(value.id, sessionId, request, navigationOrigin("row")) }} />
          : key.startsWith("schedule:") ? recurrence.preview(key.slice("schedule:".length))
            : scheduled.preview(key.slice("scheduled:".length))}
        detail={<>
      {recurrence.view()}
      {scheduled.view()}

      {/* The selection's detail is the selected row's children. */}
      {/* A parked failed read remains retryable through the refresh button. */}
       <Show when={selectedRow() && !selectedOneTimeId() && state().status !== "error"}><p role="status">{props.t(missionStore.mapMissing(props.instanceId, selectedRow()!.id)
         ? "missions.control.reader.missing" : "missions.control.loading")}</p></Show>
      <Show when={selectedOneTimeId()} keyed>{id => {
        const summary = createMemo(() => selectedOneTimeRow()?.id === id ? selectedOneTimeRow() : undefined)
        const selected = createMemo(() => selectedOneTimeMap()?.id === id ? selectedOneTimeMap() : undefined)
        const labelSource = createMemo<MissionPanelMap | MissionSummary>(previous => (selected() ?? summary()) ?? previous!)
        // The selected task takes the header toolbar.
        const readTask = createMemo(() => taskSelection(selected(), state().activity))
        return <section id={detailId} class="mission-detail" aria-label={missionDisplayTitle(labelSource())}>
          <MissionSelectedActions instanceId={props.instanceId} summary={summary()} mission={selected()} active={props.isActive?.() ?? true}
            disabled={Boolean(editor())} messagingDisabled={messagingDisabled()}
            reading={isReading({ missionId: id, kind: "overview" })} onToggleReader={() => void read({ missionId: id, kind: "overview" })}
            coordinatorActivity={state().activity?.missions.find(item => item.missionId === id)?.actors
              .find(actor => actor.sessionId === labelSource().coordinatorSessionId)?.state}
            working={missionActivityWorking(state().activity?.missions.find(item => item.missionId === id)?.actors)}
            onOpenCoordinator={() => void openOneTimeActor(id, labelSource().coordinatorSessionId)}
            interrupted={missionEntries().find(entry => entry.key === `mission:${id}`)?.mark === "interrupted"}
            onAdmitted={refreshVisible} registerRetry={registerRetry} onRevealDetail={() => revealDetail?.()}
            editDisabled={Boolean(editor()) || !selected() || selected()!.status !== "active"} deleteDisabled={Boolean(editor())}
            onEdit={() => { const map = selected(); if (map) openEditor({ kind: "edit", mission: map }) }}
            onDelete={() => openEditor({ kind: "delete", mission: selected(), deleteTarget: { id, revision: labelSource().revision, title: labelSource().title } })}
             task={readTask()} taskPending={taskSelected()} taskReading={Boolean(readTask()) && isReading({ missionId: id, kind: "task", itemId: readTask()!.task.id })}
            onToggleTask={() => { const task = readTask(); if (task) void read({ missionId: id, kind: "task", itemId: task.task.id }) }}
            onOpenTask={sessionId => void openOneTimeActor(id, sessionId)} />
          <Show when={selectedOneTimeExpanded() && missionStore.tasksLoaded(props.instanceId, id)}>{tracking()}</Show>
        </section>
      }}</Show>
      </>} />

      <Show when={!selectedSchedule() && !selectedScheduled() && scheduled.entries().length === 0 && recurrence.entries().length === 0}><Switch>
        <Match when={initialLoading() && rows().length === 0}>
          <StateMessage icon={<span class="inline-flex animate-spin"><Loader2 class="h-5 w-5" /></span>} title={props.t("missions.control.loading")} />
        </Match>
        <Match when={state().status === "unavailable"}>
          <StateMessage
            icon={<AlertTriangle class="h-5 w-5" />}
            title={props.t("missions.control.unavailable.title")}
            detail={props.t(UNAVAILABLE_DETAIL[state().reason ?? "plugin-unavailable"])}
            action={state().reason === "workspace-unavailable" ? undefined : props.t(state().reason === "host-unavailable"
              ? "missions.control.unavailable.diagnostics" : "missions.control.unavailable.openCode")}
            onAction={() => void (state().reason === "host-unavailable" ? openSettingsRow("info", "server-diagnostics") : openSettings("opencode"))}
          />
        </Match>
        <Match when={state().status === "error" && rows().length === 0}>
          <StateMessage
            icon={<AlertTriangle class="h-5 w-5" />}
            title={props.t("missions.control.error.title")}
            detail={state().error ?? props.t("missions.control.error.detail")}
            action={props.t("missions.control.retry")}
            onAction={() => void missionStore.refresh(props.instanceId)}
          />
        </Match>
        <Match when={state().status === "ready" && rows().length === 0 && !editor()}>
          <StateMessage
            icon={<Flag class="h-5 w-5" />}
            title={props.t("missions.control.empty.title")}
            detail={props.t("missions.control.empty.detail")}
          />
        </Match>
      </Switch></Show>
      <Show when={state().cleanupUnavailable}><p class="mission-control-stale" role="alert">{props.t("missions.cleanup.error.unconfirmed")}</p></Show>
      <Show when={missionStore.progress(props.instanceId, "cleanups").more || missionStore.progress(props.instanceId, "cleanups").failure}>
        <MissionPanelPaging instanceId={props.instanceId} lane="cleanups" />
      </Show>
      <Show when={cleanupPending()}><MissionCleanupPanel instanceId={props.instanceId} cleanups={state().cleanups ?? []}
        disabled={Boolean(editor()) || !["ready", "loading"].includes(state().status) || Boolean(state().cleanupUnavailable)} active={props.isActive?.() ?? true}
        refresh={() => missionStore.refresh(props.instanceId)} /></Show>
    </section>
    </MissionTaskToolbarActive.Provider></MissionActionSlot.Provider></MissionViewScope>
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
      <button type="button" class="window-action" onClick={props.onAction}>{props.action}</button>
    </Show>
  </div>
)

function statusKey(status: MissionPanelMap["status"]): string {
  return `missions.control.status.${status}`
}

export default MissionControl
