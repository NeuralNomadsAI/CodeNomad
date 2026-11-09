import { For, Match, Show, Switch, batch, createComputed, createEffect, createMemo, createSignal, createUniqueId, onCleanup, untrack, type Component, type JSX } from "solid-js"
import { AlertTriangle, Flag, Loader2, RefreshCw, Settings } from "lucide-solid"

import type { MissionActivityProjection, MissionPanelMap } from "../../../../../../../server/src/api-types"
import type { MissionUnavailableReason } from "../../../../../../../server/src/missions/model"
import { missionTaskExecutionEvidence } from "../../../../../../../server/src/missions/execution-evidence"
import type { MissionTaskMark } from "../../../../../../../server/src/missions/mission-task-marks"
import { activateMissionDemand, deactivateMissionDemand, missionStore } from "../../../../../stores/missions"
import { activeParentSessionId, getAuthoritativelyDeletedSessionIdsForInstance, hydrateRestoredSessionChain, sessions, setActiveSessionFromList } from "../../../../../stores/sessions"
import { getOpenCodeInstanceGeneration } from "../../../../../stores/opencode-data"
import { instances, getPermissionQueue } from "../../../../../stores/instances"
import { getFormQueue } from "../../../../../stores/forms"
import { focusInterruption } from "../../../../../stores/interruption-navigation"
import { getSessionPreview, showSessionChatFor } from "../../../../../stores/session-previews"
import { MAX_EXPANDED, forgetMissionView, markMissionsFinishedSeen, missionFinishedSeen, missionProjectView, updateMissionProjectView,
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
import { missionMark, type MissionPickerEntry } from "../../../../mission-picker-model"
import { createDocumentAttention } from "../../../../session/session-idle-attention"
import { MissionSelectedActions } from "../../../../mission-selected-actions"
import type { MissionControlRetry } from "../../../../mission-lifecycle-controls"
import { missionActivityWorking } from "../../../../mission-native-execution-model"
import { MISSION_ROW_TITLE_MAX, missionDisplayTitle, missionRelativeTime } from "../../../../../lib/mission-display"
import { useI18n } from "../../../../../lib/i18n"
import { MissionCleanupPanel } from "../../../../mission-cleanup"
import { missionCleanupPending } from "../../../../../lib/mission-cleanup"
import { openSettings } from "../../../../../stores/settings-screen"
import { createMissionRecurrenceList } from "../../../../mission-recurrence-list"
import { missionTaskConversation } from "../../../../mission-task-navigation"
import { conversationActivity, missionTaskRowState } from "../../../../mission-task-tree"
import { MissionTaskActions, type MissionTaskSelection } from "../../../../mission-task-actions"
import { MissionTaskPreview } from "../../../../mission-task-preview"
import { missionDerivedSessionIncludes, missionDerivedTaskSession, useMissionTaskSessionDemand } from "../../../../../stores/mission-task-sessions"
import { useMissionCurrentPassage } from "../../../../../stores/mission-recurrence"
import { createMissionViewFence, createReportedChanges } from "../../../../../lib/mission-view-fence"
import { sessionListRestored } from "../../../../../stores/session-list-restoration"
import { createMissionScheduleList } from "../../../../mission-schedule-list"
import { MissionPanelScope, MissionViewScope } from "../../../../mission-panel-scope"
import { MissionPanelPaging } from "../../../../mission-panel-paging"
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
  const scope = () => instances().get(props.instanceId)?.folder ?? props.instanceId
  const selectedMissionId = () => missionProjectView(scope()).selected
  const selectedSchedule = () => missionProjectView(scope()).selectedRecurrence
  const selectedScheduled = () => missionProjectView(scope()).selectedScheduled
  const editorScope = () => JSON.stringify([props.instanceId, scope()])
  const editor = () => missionEditor(editorScope())
  const [navigationError, setNavigationError] = createSignal(false)
  const [recurrenceRefresh, setRecurrenceRefresh] = createSignal(0)
  // The selected item's unconfirmed control, resent only by an explicit refresh click.
  const [controlRetry, setControlRetry] = createSignal<MissionControlRetry>()
  const [refreshing, setRefreshing] = createSignal(false)
  // The open editor's passive scheduling reads share the toolbar's update icon.
  const [editorReading, setEditorReading] = createSignal(false)
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
    store: MissionQuestionStore = missionStore, observedFamily = family(value.id)) => {
    const pages = currentMissionObservations(store, props.instanceId, value.id)
    return value.coordinatorSessionId === id
      || missionIncludesSession([...value.actors, ...store.observedActors(props.instanceId, value.id), ...pages.flatMap(page => page.context.actors)], id, observedFamily)
      || pages.some(page => page.requests.items.some(item => item.request.sessionID === id))
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
  const selectMission = (id: string) => { intent++; updateMissionProjectView(scope(), { selected: id, selectedRecurrence: undefined, selectedScheduled: undefined, selectedTask: undefined }) }
  // The panel has one selection: a row, or instead one task (of a one-time Mission, or of
  // the selected schedule's passage, whose row stays selected underneath).
  const selectedTaskKey = () => missionProjectView(scope()).selectedTask
  const isSelectedTask = (missionId: string, taskId: string) => selectedTaskKey()?.missionId === missionId && selectedTaskKey()?.taskId === taskId
  // While the eye is pressed (a Mission or task reader is open), the reader follows the selection.
  const viewing = () => {
    const reader = missionProjectView(scope()).reader
    return Boolean(reader) && reader!.kind !== "playbook"
  }
  const selectTask = (missionId: string, taskId: string) => {
    intent++
    const passage = passageSchedule() !== undefined && mission()?.id === missionId
    batch(() => {
      updateMissionProjectView(scope(), passage ? { selectedTask: { missionId, taskId } }
        : { selected: missionId, selectedRecurrence: undefined, selectedScheduled: undefined, selectedTask: { missionId, taskId } })
      if (viewing()) updateMissionProjectView(scope(), { reader: readerTarget({ missionId, kind: "task", itemId: taskId }) })
    })
  }
  // A chosen one-time Mission takes the open reader to its summary.
  const followReader = (id: string) => {
    const reader = missionProjectView(scope()).reader
    if (!viewing() || !reader?.recurrence && reader?.missionId === id && reader.kind === "overview") return
    updateMissionProjectView(scope(), { reader: { missionId: id, kind: "overview" } })
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
  // Playbook details need no Mission or conversation; the editor stays open beside them. Reading is
  // not a panel intent: the editor's operation stays current, and the reader change itself fences
  // in-flight conversation navigation (conversationEpoch).
  const showPlaybook = (template: MissionPanelMap["template"], taskMode: "native" | "independent") => {
    batch(() => {
      showSessionChatFor(props.activeSessionId() ?? "", scope())
      updateMissionProjectView(scope(), { reader: { missionId: template, kind: "playbook", taskMode } })
    })
    props.onRevealConversation?.()
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

  const passageSchedule = () => selectedSchedule() ?? selectedScheduled()
  const [scheduledCurrent, setScheduledCurrent] = createSignal<string>()
  const currentPassage = useMissionCurrentPassage({ instanceId: () => props.instanceId, projectID,
    directory: scope, scheduleID: () => selectedSchedule() ?? scheduledCurrent(), owner: () => selectedScheduled() ? "scheduled" : "daily", active: () => props.isActive?.() ?? true, refresh: recurrenceRefresh })
  const passageStore = () => currentPassage.inventory() ?? missionStore
  const mission = createMemo(() => passageSchedule() ? currentPassage.snapshot()?.scheduleID === passageSchedule() ? currentPassage.snapshot()?.mission : undefined
    : missions().find((candidate) => candidate.id === selectedMissionId()))
  // The selected one-time Mission's detail needs its full map, even when it is closed.
  // Only the instance and selection identities drive the registration, never store publications.
  const wantOwner = `selection:${createUniqueId()}`
  const wantedMission = createMemo(() => selectedSchedule() || selectedScheduled() ? undefined : selectedMissionId())
  createEffect(() => {
    const instanceId = props.instanceId, id = wantedMission()
    untrack(() => missionStore.want(instanceId, wantOwner, id))
    onCleanup(() => missionStore.want(instanceId, wantOwner, undefined))
  })
  const observedActivity = () => passageSchedule() ? currentPassage.snapshot()?.activity : state().activity
  // Open questions of a mission's declared actors and observed family.
  const openRequests = (id: string, actors: readonly { sessionId: string }[], activity?: MissionActivityProjection) => selectMissionAttention({ actors,
    forms: getFormQueue(props.instanceId), permissions: getPermissionQueue(props.instanceId), tasks: [],
    family: activity?.missions.find(item => item.missionId === id)?.family })
    .filter(item => item.open && item.sessionId && item.kind !== "blocked").length
  const currentRequests = () => {
    const value = mission(), passageID = currentPassage.snapshot()?.passageID
    if (!passageSchedule() || !value || !passageID) return
    const store = passageStore(), actors = [...value.actors, ...store.observedActors(props.instanceId, value.id)]
    const known = new Set(currentMissionObservations(store, props.instanceId, value.id).flatMap(page => page.requests.items.map(item => `${item.kind}:${item.request.id}`)))
    return { passageID, count: Math.max(known.size, openRequests(value.id, actors, observedActivity())) }
  }
  const readerTarget = (target: MissionReaderTarget): MissionReaderTarget => {
    const current = currentPassage.snapshot()
    return target.kind !== "recurrence" && target.kind !== "playbook" && passageSchedule() && current?.mission && current.passageID ? { ...target, recurrence: {
      instanceId: props.instanceId, projectID: current.projectID, scheduleID: current.scheduleID, passageID: current.passageID,
      ...(current.source?.owner === "scheduled" ? { owner: "scheduled" as const } : {}),
    } } : target
  }
  const selectedFamily = () => observedActivity()?.missions.find(item => item.missionId === mission()?.id)?.family

  const navigationOrigin = () => {
    const instanceId = props.instanceId, viewScope = scope(), viewCurrent = captureView(), operation = ++intent
    const schedule = passageSchedule(), passage = currentPassage.snapshot()?.passageID
    let epoch = conversationEpoch
    return { instanceId, scope: viewScope,
      current: () => viewCurrent() && operation === intent && scope() === viewScope && epoch === conversationEpoch
        && passageSchedule() === schedule && (!schedule || currentPassage.snapshot()?.passageID === passage),
      // Adopt only our guarded synchronous batch, never an awaited external change.
      adoptConversation: () => { epoch = conversationEpoch },
    }
  }

  const openActor = async (sessionId: string, origin = navigationOrigin(), afterSelection?: () => void,
    missionId = mission()?.id): Promise<boolean> => {
    const scheduleID = passageSchedule(), passageID = currentPassage.snapshot()?.passageID
    const client = instances().get(origin.instanceId)?.client, generation = getOpenCodeInstanceGeneration(origin.instanceId)
    const authorized = () => passageSchedule() === scheduleID && (!scheduleID || currentPassage.snapshot()?.passageID === passageID)
      && (scheduleID ? Boolean(mission()?.id === missionId && includesSession(mission()!, sessionId, passageStore(), selectedFamily()))
        : missions().some(value => value.id === missionId && includesSession(value, sessionId))
          || rows().some(row => row.id === missionId && includesSession({ ...row, projectID: projectID() ?? "", actors: row.actorSessionIds.map(id => ({ sessionId: id })) }, sessionId)))
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
         missionDerivedTaskSession(props.instanceId, value, task.key), [...value.actors, ...passageStore().observedActors(props.instanceId, value.id)]) : value?.coordinatorSessionId
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
  const onOpenActor = async (id: string, request?: { id: string; kind: "form" | "permission" }, missionId?: string) => {
    const origin = navigationOrigin()
    await openActor(id, origin, () => {
      if (!origin.current() || !request) return
      const queue = request.kind === "form" ? getFormQueue(origin.instanceId) : getPermissionQueue(origin.instanceId)
      if (queue.some(item => item.id === request.id && item.sessionID === id)) focusInterruption(origin.instanceId, id, request.id, request.kind)
    }, missionId)
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
  const clickFence = () => {
    const viewCurrent = captureView(), operation = intent, epoch = conversationEpoch, instanceId = props.instanceId
    const client = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
    return () => viewCurrent() && operation === intent && epoch === conversationEpoch && !editor()
      && instances().get(instanceId)?.client === client && getOpenCodeInstanceGeneration(instanceId) === generation
  }
  const [pendingAnswer, setPendingAnswer] = createSignal<{ key: string; current: () => boolean; passageID?: string }>()
  const [pendingReader, setPendingReader] = createSignal<{ key: string; current: () => boolean }>()
  const scheduleTarget = (id: string, scheduled: boolean): MissionReaderTarget => ({ kind: "recurrence", missionId: id,
    instanceId: props.instanceId, projectID: projectID(), ...(scheduled ? { scheduleOwner: "scheduled" as const } : {}) })
  createEffect(() => {
    const pending = pendingReader()
    if (!pending) return
    if (selectedKey() !== pending.key || !untrack(pending.current)) { setPendingReader(undefined); return }
    const snapshot = currentPassage.snapshot()
    if (!snapshot || snapshot.scheduleID !== passageSchedule() || currentPassage.loading()) return
    setPendingReader(undefined)
    if (snapshot.mission && snapshot.passageID && !currentPassage.error())
      untrack(() => updateMissionProjectView(scope(), { reader: readerTarget({ missionId: snapshot.mission!.id, kind: "overview" }) }))
  })
  createEffect(() => {
    const pending = pendingAnswer()
    if (!pending) return
    if (selectedKey() !== pending.key || !untrack(pending.current)) { setPendingAnswer(undefined); return }
    // A failed read before any passage is shown, or a schedule with no current passage,
    // retires the intent: it never waits for a later read.
    const snapshot = currentPassage.snapshot()
    if ((currentPassage.error() && !mission()) || (!currentPassage.loading() && snapshot?.scheduleID === passageSchedule() && !snapshot?.passageID)) {
      setPendingAnswer(undefined); return
    }
    // Only the passage first read after the click: a replacement retires the intent.
    const passageID = snapshot?.passageID ?? undefined
    if (passageID && pending.passageID === undefined) pending.passageID = passageID
    else if (pending.passageID !== undefined && passageID !== pending.passageID) { setPendingAnswer(undefined); return }
    // Tracked: reruns as the passage, its activity and its request windows arrive.
    const question = passageQuestion()
    if (!question) {
      // Discovery settled without a question (it was answered meanwhile): retire the
      // intent, so a later unrelated question never triggers it.
      const value = mission()
      if (value && observedActivity()?.missions.some(item => item.missionId === value.id) && !currentPassage.loading()
        && !passageStore().reading(props.instanceId)) setPendingAnswer(undefined)
      return
    }
    setPendingAnswer(undefined)
    untrack(() => void onOpenActor(question.sessionId, question.request))
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
      untrack(() => { if (stillCurrent()) updateMissionProjectView(scope(), { selectedTask: undefined }) })
      return
    }
    untrack(() => void demand.store.loadTasks(props.instanceId, demand.value.id, { ids: [selection.taskId] }).then(result => {
      if (result === "read" && stillCurrent() && !mission()?.tasks.some(task => task.id === selection.taskId))
        updateMissionProjectView(scope(), { selectedTask: undefined })
    }))
  })
  createEffect(() => {
    const selection = selectedTaskKey(), snapshot = currentPassage.snapshot()
    // A positively read replacement/no-current passage retires its former task selection.
    if (selection && passageSchedule() && snapshot && snapshot.scheduleID === passageSchedule() && !currentPassage.loading()
      && !currentPassage.error() && snapshot.mission?.id !== selection.missionId)
      untrack(() => updateMissionProjectView(scope(), { selectedTask: undefined }))
  })
  createEffect(() => {
    const snapshot = currentPassage.snapshot(), reader = missionProjectView(scope()).reader
    if (!passageSchedule() || !snapshot || snapshot.scheduleID !== passageSchedule() || currentPassage.loading() || currentPassage.error() || !reader) return
    const scheduleReader = reader.kind === "recurrence" && !reader.itemId && reader.missionId === snapshot.scheduleID
      && reader.instanceId === props.instanceId && reader.projectID === projectID()
      && Boolean(reader.scheduleOwner === "scheduled") === Boolean(selectedScheduled())
    const passageReader = reader.recurrence?.scheduleID === snapshot.scheduleID && reader.recurrence.passageID !== snapshot.passageID
    if (!(scheduleReader && snapshot.mission && snapshot.passageID) && !passageReader) return
    untrack(() => updateMissionProjectView(scope(), { reader: snapshot.mission && snapshot.passageID
      ? readerTarget({ missionId: snapshot.mission.id, kind: "overview" }) : scheduleTarget(snapshot.scheduleID, Boolean(selectedScheduled())) }))
  })
  // A schedule's current passage: its selected task takes the toolbar from the schedule's.
  const passageTask = createMemo(() => passageSchedule() ? taskSelection(mission(), observedActivity(), passageStore()) : undefined)
  const tracking = () => <>
    <Show when={passageSchedule()}>
      <Show when={currentPassage.loading() && !currentPassage.snapshot()?.mission}><p role="status">{props.t("missions.control.loading")}</p></Show>
      <Show when={currentPassage.error()}><p role="status">{props.t(currentPassage.snapshot()?.mission ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
    </Show>
    <MissionPanelScope value={passageStore}><Show when={mission()}>{selected => <>
      <Show when={passageTask()?.task.key} keyed>{_key => <MissionTaskActions readOnly instanceId={props.instanceId} mission={selected()}
        selection={passageTask()!} disabled onAdmitted={refreshVisible}
        reading={isReading({ missionId: selected().id, kind: "task", itemId: passageTask()!.task.id })}
        onToggleReader={() => { const task = passageTask(); if (task) void read({ missionId: selected().id, kind: "task", itemId: task.task.id }) }}
        onOpenConversation={id => void openActor(id)} />}</Show>
      <MissionTracking instanceId={props.instanceId} mission={selected()} activity={observedActivity()}
        active={treeShown()} selected={task => isSelectedTask(selected().id, task.id)} onSelect={task => selectTask(selected().id, task.id)}
        onOpenActor={onOpenActor} /></>}</Show></MissionPanelScope>
  </>
  const recurrence = createMissionRecurrenceList({ get instanceId() { return props.instanceId }, get scope() { return scope() },
    get projectID() { return projectID() }, active: () => props.isActive?.() ?? true, get refresh() { return recurrenceRefresh() },
    get onRead() { return props.onRevealConversation }, get selectedSchedule() { return selectedSchedule() },
    get tracking() { return tracking() }, detailId, registerRetry,
    get selectedRequests() { return selectedSchedule() ? currentRequests() : undefined },
    get passage() {
      const passage = mission()
      if (!passage) return undefined
      const overview: MissionReaderTarget = { missionId: passage.id, kind: "overview" }
      return { reading: isReading(overview), onToggle: () => void read(overview),
        onOpenConversation: () => void openActor(passage.coordinatorSessionId) }
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
      status: [stateText, mark === "permission" ? props.t("missionsPanel.task.input") : "",
        childActivity === "permission" ? props.t("missionsPanel.row.taskInput") : "",
        missionRelativeTime(value.updatedAt, locale())].filter(Boolean).join(" · ") }
  }))
  // The saved Mission ID survives ownership conversion in another window, including
  // cold restoration. Point-read that selection; absence never triggers an inventory scan.
  const unifiedSelection = () => selectedScheduled() ?? (selectedSchedule() ? undefined : selectedMissionId())
  const scheduled = createMissionScheduleList({ get instanceId() { return props.instanceId }, get directory() { return scope() },
    get selectedRequests() { return selectedScheduled() ? currentRequests() : undefined },
    onPassage: setScheduledCurrent,
    onNoPassage: id => {
      if (selectedScheduled() !== id) return
      const reader = missionProjectView(scope()).reader
      batch(() => {
        if (selectedTaskKey()) updateMissionProjectView(scope(), { selectedTask: undefined })
        if (reader?.recurrence?.scheduleID === id && reader.recurrence.owner === "scheduled")
          updateMissionProjectView(scope(), { reader: scheduleTarget(id, true) })
      })
    },
    get tracking() { return selectedScheduled() ? tracking() : undefined },
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
        updateMissionProjectView(scope(), { reader: close ? undefined : target })
        if (!close) props.onRevealConversation?.()
      } }
    },
    get projectID() { return projectID() }, active: visible, enabled: () => !editor(), get refresh() { return recurrenceRefresh() },
    get selected() { return unifiedSelection() }, detailId, onEdit: id => openEditor({ kind: "edit", scheduleID: id }),
    onDeleted: id => { if (selectedScheduled() === id) updateMissionProjectView(scope(), { selectedScheduled: undefined }) },
    onOpenConversation: id => void (async () => {
      const view = captureView(), selected = selectedScheduled(), instanceId = props.instanceId
      const generation = getOpenCodeInstanceGeneration(instanceId)
      const current = () => view() && selectedScheduled() === selected && scheduled.ownsSession(id)
        && getOpenCodeInstanceGeneration(instanceId) === generation
      if (!current()) return
      try {
        await hydrateRestoredSessionChain(instanceId, [id], undefined, current)
        if (!current() || !sessions().get(instanceId)?.has(id)) return
        batch(() => { setActiveSessionFromList(instanceId, id); showSessionChatFor(id, scope()); updateMissionProjectView(scope(), { reader: undefined }) })
        props.onRevealConversation?.()
      } catch { if (current()) setNavigationError(true) }
    })() })
  createEffect(() => {
    const id = unifiedSelection()
    if (!visible() || editor() || !id) return
    const representation = scheduled.representation(id)
    if (representation === "one-time" && selectedScheduled() === id) selectMission(id)
    else if (representation === "schedule" && selectedScheduled() !== id) {
      intent++
      updateMissionProjectView(scope(), { selected: undefined, selectedRecurrence: undefined, selectedScheduled: id })
    }
  })
  const pickerEntries = () => {
    const unified = scheduled.entries(), ids = new Set(unified.map(row => row.key.slice("scheduled:".length)))
    return [...missionEntries().filter(row => !ids.has(row.key.slice("mission:".length))), ...recurrence.entries(), ...unified]
  }
  const selectedRow = () => selectedSchedule() || selectedScheduled() ? undefined : rows().find(row => row.id === selectedMissionId())
  const selectedKey = () => selectedScheduled() ? `scheduled:${selectedScheduled()}` : selectedSchedule() ? `schedule:${selectedSchedule()}` : selectedRow() ? `mission:${selectedRow()!.id}` : undefined
  const selectedOneTime = () => selectedSchedule() || selectedScheduled() ? undefined : mission()
  const selectedOneTimeId = () => selectedOneTime()?.id
  const creating = () => editor()?.kind === "create"
  // Like an idle session, a completed Mission stays green until this window shows it;
  // the creation form hides the selected detail.
  const documentAttention = createDocumentAttention()
  createEffect(() => {
    if (!["ready", "loading", "error"].includes(state().status) || state().projectID !== projectID()) return
    const completed = rows().filter(value => value.status === "completed")
    const shown = (props.isActive?.() ?? true) && documentAttention() && !creating() && selectedOneTime()?.projectID === projectID() && selectedOneTime()?.status === "completed"
      ? [selectedOneTime()!.id] : []
    const viewScope = completionScope()
    untrack(() => markMissionsFinishedSeen(viewScope, shown, completed, true))
  })
  const refreshLabel = () => props.t(controlRetry()?.pending() ? "missions.control.refreshResend" : "missions.control.refresh")
  const reading = () => refreshing() || missionStore.reading(props.instanceId) || currentPassage.inventory()?.reading(props.instanceId)
    || recurrence.loading() || scheduled.loading() || currentPassage.loading() || editorReading()
  /** Read-only reconciliation first; only a control still unconfirmed by that
   * read is resent, with its original identity, from this explicit click. */
  const refresh = async () => {
    if (refreshing()) return
    const retry = controlRetry(), instanceId = props.instanceId
    setRefreshing(true)
    try {
      const mapRead = missionStore.refresh(instanceId)
      const [, read] = await Promise.allSettled([mapRead, retry?.reconcile(mapRead)])
      setRecurrenceRefresh(value => value + 1)
      // A skipped, failed or superseded read never leads to a resend.
      const witnessed = read.status === "fulfilled" && read.value === true
      if (retry && witnessed && controlRetry() === retry && props.instanceId === instanceId && retry.pending()) await retry.resend()
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
            title={refreshLabel()} disabled={state().status === "loading" || refreshing()} onClick={() => void refresh()}>
            <Show when={reading()} fallback={<RefreshCw class="h-4 w-4" />}>
              <Loader2 class="h-4 w-4 animate-spin" />
            </Show>
          </button>
        </>} />
      </header>
      <For each={rows().map(row => row.id)}>{id => {
        useMissionTaskSessionDemand({ instanceId: () => props.instanceId, mission: () => rowQuestions().get(id)?.sessionContext,
          active: () => visible() && treeShown() && Boolean(rowQuestions().get(id)?.observeNative), pulse: () => state().activity?.generatedAt })
        return null
      }}</For>
      <Show when={passageSchedule() && taskSelected() && !passageTask()}><MissionActionBar task label={props.t("missionsPanel.picker.actions")} reading={false} /></Show>
      <Show when={navigationError()}><p class="mission-control-stale" role="alert">{props.t("sessionList.reload.error")}</p></Show>
      <Show when={editor()} keyed>{action => {
        let completionCurrent: () => boolean = () => false
        // Live view activity; each operation captures its own view fence.
        return <MissionEditor instanceId={props.instanceId} viewDirectory={directory()} projectID={projectID()} action={action}
        active={() => (props.isActive?.() ?? true) && editor() === action}
        onDispose={draft => settleMissionEditor(action, draft === null ? action : draft && { ...action, draft })}
        captureOperation={() => {
          const origin = captureView(), operation = intent
          completionCurrent = () => origin() && operation === intent
          return completionCurrent
        }}
        onCancel={closeEditor} onOpenPreferences={openPreferences} onShowPlaybook={showPlaybook}
        onReopen={() => {
          // The edit reopens on the newest map, read first: the one it opened on is outdated.
          // The form stays as it opened until this settles; a failed read rejects, so it says so.
          const view = captureView()
          return missionStore.refresh(props.instanceId).then(() => {
            if (!view() || editor() !== action) return
            if (missionStore.state(props.instanceId).status !== "ready") throw new Error("The mission map could not be read")
            const current = missions().find(mission => mission.id === action.mission?.id)
            if (current) openEditor({ kind: "edit", mission: current })
          })
        }}
        onRecurrenceRefresh={() => setRecurrenceRefresh(value => value + 1)}
        onReading={setEditorReading}
        onRecurrenceSaved={() => { if (!completionCurrent() || editor() !== action) return; settleMissionEditor(action); setRecurrenceRefresh(value => value + 1) }}
        onSaved={(saved, scheduleID) => {
          if (!completionCurrent() || editor() !== action) return
          const instanceId = props.instanceId, current = completionCurrent
          settleMissionEditor(action)
          setRecurrenceRefresh(value => value + 1)
          if (scheduleID) updateMissionProjectView(scope(), { selectedScheduled: scheduleID, selectedRecurrence: undefined })
          if (!saved && action.mission) forgetMissionView(scope(), action.mission.id)
          void missionStore.refresh(instanceId).then(() => {
            const id = saved?.id ?? scheduleID
            if (id && current() && !editor()) selectMission(id)
          })
        }} />
      }}</Show>
      <Show when={state().status === "error" && rows().length > 0}>
        <div class="mission-control-stale" role="status">
          <AlertTriangle class="h-3.5 w-3.5" aria-hidden="true" />
          {props.t("missions.control.error.stale")}
        </div>
      </Show>

      <MissionRows entries={pickerEntries()} query={query()} selectedKey={selectedKey()} revealDetail={reveal => { revealDetail = reveal }}
        rowSelected={!taskSelected()}
        expanded={() => missionProjectView(scope()).expanded ?? []}
        onExpanded={keys => updateMissionProjectView(scope(), { expanded: keys.slice(-MAX_EXPANDED) })}
        markRead={key => {
          if (!key.startsWith("mission:")) return undefined
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
          const [kind, id] = [entry.key.slice(0, entry.key.indexOf(":")), entry.key.slice(entry.key.indexOf(":") + 1)]
          if (kind === "schedule" || kind === "scheduled") {
            intent++
            const follow = viewing()
            batch(() => {
              updateMissionProjectView(scope(), kind === "schedule" ? { selected: undefined, selectedRecurrence: id, selectedScheduled: undefined, selectedTask: undefined }
                : { selected: undefined, selectedRecurrence: undefined, selectedScheduled: id, selectedTask: undefined })
              if (follow) updateMissionProjectView(scope(), { reader: scheduleTarget(id, kind === "scheduled") })
            })
            setPendingReader(follow ? { key: entry.key, current: clickFence() } : undefined)
            // A red row asks for an answer: open its passage's question, as for a Mission row.
            setPendingAnswer(entry.mark === "permission" ? { key: entry.key, current: clickFence() } : undefined)
          }
          else {
            batch(() => { followReader(id); selectMission(id) })
            // A red flag asks for an answer: like a session row, open the asking
            // conversation with its question focused in the dock.
            const question = rowQuestions().get(id)?.flag[0]
            if (question) void onOpenActor(question.sessionId, question.request, id)
          }
        }}
        expandable={key => key.startsWith("mission:")}
        preview={key => <MissionTaskPreview instanceId={props.instanceId} missionId={key.slice("mission:".length)} activity={state().activity}
          active={treeShown()}
          selected={(value, task) => isSelectedTask(value.id, task.id)}
          onSelect={(value, task) => selectTask(value.id, task.id)}
          onAnswer={(value, sessionId, request) => void onOpenActor(sessionId, request, value.id)} />}
        detail={<>
      {recurrence.view()}
      {scheduled.view()}

      {/* The selection's detail is the selected row's children. */}
      {/* A parked failed read keeps the stale banner and the refresh button instead. */}
       <Show when={selectedRow() && !mission() && state().status !== "error"}><p role="status">{props.t(missionStore.mapMissing(props.instanceId, selectedRow()!.id)
         ? "missions.control.reader.missing" : "missions.control.loading")}</p></Show>
      <Show when={selectedOneTimeId()} keyed>{id => {
        // Keep the last known snapshot while the keyed detail is being disposed.
        const selected = createMemo<MissionPanelMap>(previous => missions().find(value => value.id === id) ?? previous!)
        // The selected task takes the header toolbar.
        const readTask = createMemo(() => taskSelection(selected(), state().activity))
        return <section id={detailId} class="mission-detail" aria-label={missionDisplayTitle(selected())}>
          <MissionSelectedActions instanceId={props.instanceId} mission={selected()} active={props.isActive?.() ?? true}
            disabled={Boolean(editor())} messagingDisabled={messagingDisabled()}
            reading={isReading({ missionId: id, kind: "overview" })} onToggleReader={() => void read({ missionId: id, kind: "overview" })}
            coordinatorActivity={state().activity?.missions.find(item => item.missionId === id)?.actors
              .find(actor => actor.sessionId === selected().coordinatorSessionId)?.state}
            working={missionActivityWorking(state().activity?.missions.find(item => item.missionId === id)?.actors)}
            onOpenCoordinator={() => void openActor(selected().coordinatorSessionId)}
            interrupted={missionEntries().find(entry => entry.key === `mission:${id}`)?.mark === "interrupted"}
            onAdmitted={refreshVisible} registerRetry={registerRetry} onRevealDetail={() => revealDetail?.()}
            editDisabled={Boolean(editor()) || selected().status !== "active"} deleteDisabled={Boolean(editor())}
            onEdit={() => openEditor({ kind: "edit", mission: selected() })}
            onDelete={() => openEditor({ kind: "delete", mission: selected() })}
             task={readTask()} taskPending={taskSelected()} taskReading={Boolean(readTask()) && isReading({ missionId: id, kind: "task", itemId: readTask()!.task.id })}
            onToggleTask={() => { const task = readTask(); if (task) void read({ missionId: id, kind: "task", itemId: task.task.id }) }}
            onOpenTask={sessionId => void openActor(sessionId)} />
          {tracking()}
        </section>
      }}</Show>
      </>} />

      <Show when={!selectedSchedule() && !selectedScheduled() && scheduled.entries().length === 0 && recurrence.entries().length === 0}><Switch>
        <Match when={state().status === "loading" && rows().length === 0}>
          <StateMessage icon={<Loader2 class="h-5 w-5 animate-spin" />} title={props.t("missions.control.loading")} />
        </Match>
        <Match when={state().status === "unavailable"}>
          <StateMessage
            icon={<AlertTriangle class="h-5 w-5" />}
            title={props.t("missions.control.unavailable.title")}
            detail={props.t(UNAVAILABLE_DETAIL[state().reason ?? "plugin-unavailable"])}
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
      <button type="button" class="button-secondary px-3" onClick={props.onAction}>{props.action}</button>
    </Show>
  </div>
)

function statusKey(status: MissionPanelMap["status"]): string {
  return `missions.control.status.${status}`
}

export default MissionControl
