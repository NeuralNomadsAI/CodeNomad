import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { getLogger } from "../logger"
import { acknowledgeNativeClientStateNavigationFlush, acknowledgeNativeClientStateRendererFlush } from "../native/client-state"
import { isElectronHost, isLocalWindow, isTauriHost, isWebHost } from "../runtime-env"
import {
  clientStateIsPrimary, flushClientState, loadedRestorableSession, restorePreviousStateEnabled, updateRestorableSession,
  flushWorkspaceFileDraftsForClose, WorkspaceDraftFlushError,
  type RestorableSessionState, type RestorableTabState, type RestorableWorkspaceTabState,
} from "../../stores/client-state"
import { tGlobal } from "../i18n"
import { showToastNotification } from "../notifications"
import { storage } from "../storage"
import { completeWebSessionRestore, markWebSessionRecordsReleased } from "../web-session-client-state"
import { matchesRestoredServer, workspaceInstallationKey } from "../../stores/app-session-reconciliation"
import {
  createRestorableSessionPreservation, createRestoredTabCommitGuard, markPreservedWorkspaceRemoved,
  markPreservedWorkspaceReopened, markPreservedWorkspaceUnavailable,
  getPreservedWorkspaceReopenTarget, getPreservedWorkspaceState,
  hasRestoredTabBinding, mergeRestorableSessionState, recordRestoredTab,
  retirePreservedWorkspacePrompts,
  settleRestoredTab as settlePreservedTab, type RestorableSessionPreservation,
  type RestorableWorkspaceRuntimeAuthority,
} from "../../stores/app-session-snapshot-merge"
import { activeAppTab, activeAppTabId, appTabs, getInstanceAppTabId } from "../../stores/app-tabs"
import { openInstanceTabIds } from "../../stores/app-tab-membership"
import { backendRegistry } from "../../stores/remote-backends"
import { appSessionRestoreGateActive } from "../../stores/app-session-restore-gate"
import { saveReloadTabSelection } from "../native/reload-tab-selection"
import { cancelUnattachedWorkspaceCreations, closeWorkspace, holdWorkspaceCommits, instances, resumeWorkspaceCreations } from "../../stores/instances"
import {
  activeParentSessionId, activeSessionId, expandedSessions, getAuthoritativeDraftSessionIdsForInstance, getPersistentExpandedSessionIds,
  getAuthoritativeSessionExpansionIdsForInstance, getAuthoritativelyDeletedSessionIdsForInstance,
  getSessionDraftPromptsForInstance, getSessions,
  hasAuthoritativeSessionSelection,
} from "../../stores/sessions"
import { MESSAGE_STREAM_SCROLL_SCOPE, messageStoreBus } from "../../stores/message-v2/bus"
import type { ScrollSnapshot } from "../../stores/message-v2/types"
import { trackSessionDraftChanges } from "../../stores/session-state"
import { getAuthoritativeAttachmentSessionIdsForInstance, getSessionAttachmentsForInstance, trackSessionAttachmentChanges } from "../../stores/attachments"
import { closedDraftSnapshotAuthority, omitSupersededClosedDrafts, pendingClosedDrafts } from "../../stores/closed-workspace-drafts"
import { serializeDraftAttachments } from "../../stores/client-state-attachments-codec"
import { onInstanceLifecycleAuthority } from "../../stores/instance-lifecycle-authority"
import { getPersistedGenerationRecovery, type PersistedGenerationRecovery } from "../../stores/session-generation-recovery"
import { captureSeenInterruptions, seenInterruptionsRevision } from "../../stores/session-interruption-seen"
import { hydrateWorkspacePromptState, recoverDeletedWorkspacePrompts } from "../../stores/app-session-prompt-hydration"
import { captureSessionOutlineIndexes, outlineCacheRevision } from "../../stores/session-outline"
import { captureSessionCatalog } from "../../stores/session-catalog-persistence"
import { getSessionCheckpoint, getSessionTopology, sessions as sessionRows } from "../../stores/session-state"
import type { SessionRows } from "../../stores/session-projection"
import { captureTabViewState } from "../../stores/tab-view-state"
import {
  hydrateRestoredWorkspaceState, NO_SESSION_DRAFT_SESSION_ID,
} from "../../stores/app-session-workspace-hydration"
const log = getLogger("actions")
const MAX_CAPTURED_SCROLL_SNAPSHOTS = 96
const CAPTURE_DEBOUNCE_MS = 500
const RESTORE_CAPTURE_MAX_WAIT_MS = 2_000
const NO_SESSION_ROWS: SessionRows = new Map()
const capturedSessionData = new WeakMap<object, {
  rows: SessionRows
  seenRevision: ReturnType<typeof seenInterruptionsRevision>
  runtime: ReturnType<typeof captureRuntimeState>
  catalogRows: SessionRows
  catalog: ReturnType<typeof captureSessionCatalog>
}>()
function captureScrollSnapshots(instanceId: string): Record<string, ScrollSnapshot> {
  const store = messageStoreBus.getInstance(instanceId)
  if (!store) return {}
  const suffix = `:${MESSAGE_STREAM_SCROLL_SCOPE}`
  return Object.fromEntries(Object.entries(store.state.scrollState)
    .filter(([key]) => key.endsWith(suffix))
    .map(([key, snapshot]) => ({ sessionId: key.slice(0, -suffix.length), snapshot }))
    .filter(({ sessionId }) => Boolean(sessionId))
    .sort((a, b) => b.snapshot.updatedAt - a.snapshot.updatedAt)
    .slice(0, MAX_CAPTURED_SCROLL_SNAPSHOTS)
    .map(({ sessionId, snapshot }) => [sessionId, { ...snapshot }]))
}
function captureRuntimeState(
  instanceId: string, rows: SessionRows,
): Pick<RestorableWorkspaceTabState, "unseenIdleSince" | "generationRecovery" | "seenInterruptions"> {
  const unseenIdleSince: Record<string, number> = {}
  const generationRecovery: Record<string, PersistedGenerationRecovery> = {}
  for (const session of rows.values()) {
    if (session.status === "idle" && typeof session.idleSince === "number") unseenIdleSince[session.id] = session.idleSince
    const recovery = getPersistedGenerationRecovery(session.status, session.generationRecovery)
    if (recovery) generationRecovery[session.id] = recovery
  }
  const seenInterruptions = captureSeenInterruptions(instanceId, rows.values())
  return { unseenIdleSince, generationRecovery, ...(Object.keys(seenInterruptions).length ? { seenInterruptions } : {}) }
}
export function captureState(scrollAuthority: ReadonlyMap<string, ReadonlySet<string>>, reuseCatalog = false) {
  const tabs = appTabs()
  const occurrenceKey = (project: Pick<RestorableWorkspaceTabState, "folder" | "backendId" | "serverId">) =>
    workspaceInstallationKey(project.folder, project.backendId, project.serverId)
  const nextOccurrence = new Map<string, number>()
  const occurrenceByInstance = new Map<string, number>()
  const reservedOccurrences = new Map<string, Set<number>>()
  const suspended = new Set(tabs.flatMap(tab => tab.kind === "remote-restore" && tab.instanceId
    && matchesRestoredServer(tab.snapshot, instances().get(tab.instanceId)?.serverId) ? [tab.instanceId] : []))
  for (const tab of tabs) if (tab.kind === "remote-restore") {
    const key = occurrenceKey(tab.snapshot)
    const reserved = reservedOccurrences.get(key) ?? new Set<number>()
    reserved.add(tab.snapshot.occurrence ?? 0)
    reservedOccurrences.set(key, reserved)
  }
  for (const instance of instances().values()) {
    if (suspended.has(instance.id)) continue
    const path = occurrenceKey(instance)
    let occurrence = nextOccurrence.get(path) ?? 0
    while (reservedOccurrences.get(path)?.has(occurrence)) occurrence++
    nextOccurrence.set(path, occurrence + 1)
    occurrenceByInstance.set(instance.id, occurrence)
  }
  const restorableTabs: RestorableTabState[] = tabs.map((tab) => {
    if (tab.kind === "blank") return { kind: "blank" }
    if (tab.kind === "sidecar") return { kind: "sidecar", sidecarId: tab.sidecarTab.sidecarId }
    if (tab.kind === "remote-restore") return tab.snapshot
    const id = tab.instance.id
    const rows = sessionRows().get(id) ?? NO_SESSION_ROWS
    const seenRevision = seenInterruptionsRevision()
    let sessionData = capturedSessionData.get(tab)
    if (!sessionData || sessionData.rows !== rows || sessionData.seenRevision !== seenRevision
      || (!reuseCatalog && sessionData.catalogRows !== rows)) {
      const checkpoint = reuseCatalog || sessionData?.catalogRows === rows ? sessionData : undefined
      sessionData = {
        rows, seenRevision,
        runtime: sessionData?.rows === rows && sessionData.seenRevision === seenRevision
          ? sessionData.runtime : captureRuntimeState(id, rows),
        catalogRows: checkpoint?.catalogRows ?? rows,
        catalog: checkpoint ? checkpoint.catalog : captureSessionCatalog([...rows.values()], tab),
      }
      capturedSessionData.set(tab, sessionData)
    }
    const parentId = activeParentSessionId().get(id)
    const sessionId = activeSessionId().get(id)
    const expansionAuthority = getAuthoritativeSessionExpansionIdsForInstance(id)
    const expanded = getPersistentExpandedSessionIds(id)
    const prioritySessionIds = [sessionId, "__no_session_draft__"].filter((value): value is string => Boolean(value))
    const pending = pendingClosedDrafts(id)
    const live = serializeDraftAttachments(
      getSessionDraftPromptsForInstance(id), getSessionAttachmentsForInstance(id), prioritySessionIds,
    )
    const deletedSessions = getAuthoritativelyDeletedSessionIdsForInstance(id)
    const catalog = sessionData.catalog
    const result: RestorableWorkspaceTabState = {
      kind: "workspace", folder: tab.instance.folder, occurrence: occurrenceByInstance.get(id) ?? 0, workspaceId: id,
      ...(tab.instance.backendId ? { backendId: tab.instance.backendId } : {}),
      ...(tab.instance.serverId ? { serverId: tab.instance.serverId } : {}),
      drafts: { ...pending.drafts, ...live.drafts },
      attachments: { ...pending.attachments, ...live.attachments },
      ...sessionData.runtime, scrollSnapshots: captureScrollSnapshots(id),
      outlineIndexes: captureSessionOutlineIndexes(id, deletedSessions),
      sessionCatalog: reuseCatalog && deletedSessions.size && catalog?.some(row => deletedSessions.has(row.id))
        ? catalog.filter(row => !deletedSessions.has(row.id)) : catalog,
      viewState: captureTabViewState(id),
      expandedSessionIds: [
        ...expanded.filter((sessionId) => expansionAuthority.has(sessionId)),
        ...expanded.filter((sessionId) => !expansionAuthority.has(sessionId)),
      ],
    }
    if (tab.instance.projectName) result.projectName = tab.instance.projectName
    if (tab.instance.binaryPath) result.binaryPath = tab.instance.binaryPath
    if (parentId) result.activeParentSessionId = parentId
    if (sessionId) result.activeSessionId = sessionId
    return result
  })
  const authorities: Array<RestorableWorkspaceRuntimeAuthority | undefined> = tabs.map((tab) => {
    if (tab.kind !== "instance") return undefined
    const id = tab.instance.id
    const rows = capturedSessionData.get(tab)!.rows
    const closed = closedDraftSnapshotAuthority(id)
    return {
      drafts: new Set([...getAuthoritativeDraftSessionIdsForInstance(id), ...closed]),
      attachments: new Set([...getAuthoritativeAttachmentSessionIdsForInstance(id), ...closed]),
      scrollSnapshots: scrollAuthority.get(id), idleMarkers: rows, generationRecovery: rows,
      sessionExpansion: getAuthoritativeSessionExpansionIdsForInstance(id),
      deletedSessions: getAuthoritativelyDeletedSessionIdsForInstance(id),
      sessionSelection: hasAuthoritativeSessionSelection(id),
    }
  })
  return {
    state: {
      tabs: restorableTabs,
      activeTabIndex: tabs.findIndex(({ id }) => id === activeAppTabId()),
    },
    tabIds: tabs.map(({ id }) => id), authorities,
  }
}
export type WorkspaceReleaseResults = ReadonlyMap<string, Promise<"released" | "unconfirmed">>

export function useAppSessionCapture(recoverReleasedTabs?: (snapshot: RestorableSessionState, results: WorkspaceReleaseResults) => void) {
  const [started, setStarted] = createSignal(false)
  const enabled = () => started() && clientStateIsPrimary() && restorePreviousStateEnabled()
  // Single-row publications carry forward this token when persisted inputs
  // did not change. Bulk publications conservatively invalidate the workspace.
  const checkpointSessions = createMemo(() => {
    return enabled() ? appTabs().flatMap(tab => tab.kind === "instance" ? [getSessionCheckpoint(tab.instance.id)] : []) : []
  }, [], { equals: (before, after) => before.length === after.length && before.every((value, index) => value === after[index]) })
  const promptTopology = createMemo(() => {
    return enabled() ? appTabs().flatMap(tab => tab.kind === "instance" ? [getSessionTopology(tab.instance.id)] : []) : []
  }, [], { equals: (before, after) => before.length === after.length && before.every((value, index) => value === after[index]) })
  const scrollAuthority = new Map<string, Set<string>>()
  const instanceLifecycleTokens = new Map<string, number>()
  let nextInstanceLifecycleToken = 0
  let disposed = false
  const hydrationController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let restoreDeadline: ReturnType<typeof setTimeout> | null = null
  const cancelRestoreDeadline = () => {
    if (restoreDeadline !== null) clearTimeout(restoreDeadline)
    restoreDeadline = null
  }
  const cancelCapture = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    cancelRestoreDeadline()
  }
  let preservation: RestorableSessionPreservation | null = null
  let nativeFallbackState: RestorableSessionState | null = null
  const hydratePreservedPrompts = (instanceId: string, recoverOnly = false) => {
    if (!preservation) return
    const instance = instances().get(instanceId)
    if (!instance) return
    const runtimeTabId = getInstanceAppTabId(instanceId)
    const source = getPreservedWorkspaceState(preservation, { runtimeTabId, folder: instance.folder, occurrence: 0, backendId: instance.backendId })
    if (!source || !matchesRestoredServer(source, instance.serverId)) return
    const snapshot = omitSupersededClosedDrafts(instanceId, source)
    if (!recoverOnly) hydrateWorkspacePromptState(
      instanceId,
      snapshot,
      new Set(getSessions(instanceId).map(({ id }) => id)),
      NO_SESSION_DRAFT_SESSION_ID,
    )
    const consumed = recoverDeletedWorkspacePrompts(instanceId, snapshot)
    if (consumed) retirePreservedWorkspacePrompts(preservation, runtimeTabId, consumed)
  }
  const mergedState = (reuseCatalog = false) => {
    // Flush can run before the hydration effect; move prompt bytes before
    // merge applies the native deletion tombstones to the saved tab.
    for (const instanceId of openInstanceTabIds()) hydratePreservedPrompts(instanceId, true)
    const captured = captureState(scrollAuthority, reuseCatalog)
    return mergeRestorableSessionState(captured.state, preservation, {
      currentTabIds: captured.tabIds, currentTabAuthorities: captured.authorities,
    })
  }
  const recoveryState = () => {
    if (enabled()) return mergedState()
    if (!started() && clientStateIsPrimary() && restorePreviousStateEnabled()) return loadedRestorableSession() ?? undefined
    return captureState(scrollAuthority).state
  }
  let nativeShutdownGeneration: number | null = null
  let releasing: Promise<unknown> | undefined
  let releaseResults: WorkspaceReleaseResults = new Map()
  let preparedTabs: RestorableSessionState | undefined
  const captureWorkspaceRecords = () => {
    const records = new Map<string, Pick<RestorableWorkspaceTabState, "backendId" | "serverId">>()
    for (const tab of appTabs()) {
      if (tab.kind === "instance") records.set(tab.instance.id, tab.instance)
      if (tab.kind === "remote-restore" && tab.instanceId && tab.snapshot.backendId
        && matchesRestoredServer(tab.snapshot, backendRegistry.serverId(tab.snapshot.backendId))) {
        records.set(tab.instanceId, tab.snapshot)
      }
    }
    return records
  }
  let preparedRecords: ReturnType<typeof captureWorkspaceRecords> | undefined
  let unlockInput: (() => void) | undefined
  let navigationGeneration: number | null = null
  const lockInput = () => {
    if (unlockInput) return
    // Close can keep this document visible while the host saves its snapshot.
    const root = document.documentElement
    const wasInert = root.inert
    root.inert = true
    // Keys retargeted to the document can still reach global shortcuts.
    const blockShortcut = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener("keydown", blockShortcut, true)
    unlockInput = () => {
      root.inert = wasInert
      window.removeEventListener("keydown", blockShortcut, true)
      unlockInput = undefined
    }
  }
  const resumeCapture = () => {
    resumeWorkspaceCreations()
    // If startup has not begun, it can still restore directly from the loaded snapshot.
    if (releasing && preparedTabs && started()) recoverReleasedTabs?.(preparedTabs, releaseResults)
    preparedTabs = undefined
    preparedRecords = undefined
    nativeShutdownGeneration = null
    releasing = undefined
    releaseResults = new Map()
    if (navigationGeneration === null) unlockInput?.()
    schedule(true)
  }
  const capture = (reuseCatalog = false) => {
    if (reuseCatalog) cancelRestoreDeadline()
    else cancelCapture()
    if (enabled() && !disposed && !releasing && nativeShutdownGeneration === null) {
      const state = mergedState(reuseCatalog)
      if (state.tabs.length > 0) nativeFallbackState = state
      updateRestorableSession(state)
    }
  }
  const schedule = (bounded = false) => {
    if (!enabled() || disposed || releasing || nativeShutdownGeneration !== null) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(capture, CAPTURE_DEBOUNCE_MS)
    // Bounded restore captures reuse the encoded catalog and leave its quiet save armed.
    if (bounded) restoreDeadline ??= setTimeout(() => capture(true), RESTORE_CAPTURE_MAX_WAIT_MS)
  }
  const flush = async (nativeShutdownGenerationRequest?: number) => {
    const nativeShutdown = nativeShutdownGenerationRequest !== undefined
    if (nativeShutdown) {
      nativeShutdownGeneration = nativeShutdownGenerationRequest
      holdWorkspaceCommits()
      lockInput()
    }
    // Record a scroll that has not settled yet; it may reschedule the capture cleared below.
    messageStoreBus.flushScrollSnapshots()
    cancelCapture()
    if (enabled() && !releasing) {
      const current = mergedState()
      const state = nativeShutdown
        && current.tabs.length === 0
        && (nativeFallbackState?.tabs.length ?? 0) > 0
        ? nativeFallbackState!
        : current
      updateRestorableSession(state)
      if (nativeShutdown) preparedTabs = state
    } else if (nativeShutdown && !releasing && recoverReleasedTabs) {
      preparedTabs = recoveryState()
    }
    if (nativeShutdown && !releasing) preparedRecords = captureWorkspaceRecords()
    await Promise.all([
      flushClientState(),
      flushWorkspaceFileDraftsForClose(),
      ...(nativeShutdown ? [storage.flushWrites()] : []),
    ]).catch(error => {
      if (error instanceof WorkspaceDraftFlushError) {
        showToastNotification({ category: "files", message: tGlobal("filesPanel.draftLimit"), variant: "error" })
      }
      throw error
    })
  }
  const cancelNavigation = (generation: number) => {
    if (navigationGeneration !== generation) return
    navigationGeneration = null
    if (nativeShutdownGeneration === null && !releasing) unlockInput?.()
  }
  const flushNavigation = async (generation: number) => {
    navigationGeneration = generation
    lockInput()
    try { await flush() } catch (error) {
      cancelNavigation(generation)
      throw error
    }
  }
  const release = (deleteTabs = true) => {
    if (releasing) return releasing
    // Only occurrences owned at capture can be released by record ID.
    const records = preparedRecords ?? captureWorkspaceRecords()
    const cancellations = cancelUnattachedWorkspaceCreations(new Set(records.keys()))
    const results = new Map<string, Promise<"released" | "unconfirmed">>()
    if (deleteTabs) for (const [id, tab] of records) {
      if (tab.backendId && !matchesRestoredServer(tab, backendRegistry.serverId(tab.backendId))) continue
      results.set(id, closeWorkspace(id, { keepalive: true, silent: true }).then(() => "released", () => "unconfirmed"))
    }
    releaseResults = results
    return releasing = Promise.allSettled([
      cancellations, ...results.values(),
    ])
  }
  const awaitRelease = async () => {
    lockInput()
    // The local backend also carries the remote relay. Quit has to send
    // releases before stopping it, and must be able to recover on refusal.
    if (recoverReleasedTabs) preparedTabs ??= recoveryState()
    const pending = release()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, 750) })])
    } finally {
      clearTimeout(timer)
    }
  }
  const nativeUnlisteners: Array<() => void> = []
  let nativeDisposed = false
  const nativeView = isTauriHost() && isLocalWindow() ? getCurrentWebview() : undefined
  const register = (event: string, acknowledge: (generation: number) => void | Promise<void>, nativeShutdown: boolean) => nativeView!.listen<{
    generation: number
    prepareGeneration?: number
  }>(event, ({ payload: { generation, prepareGeneration } }) => {
    // A replacement document can receive release without having seen prepare.
    if (prepareGeneration !== undefined) nativeShutdownGeneration = prepareGeneration
    void (prepareGeneration !== undefined ? awaitRelease() : nativeShutdown ? flush(generation) : flushNavigation(generation))
      .then(() => acknowledge(generation)).catch((error) => log.error(`Failed to handle ${event}`, error))
  }).then((unlisten) => {
    if (nativeDisposed) unlisten()
    else nativeUnlisteners.push(unlisten)
  }).catch((error) => log.error(`Failed to listen for ${event}`, error))
  const ready = nativeView
    ? Promise.all([
        register("client-state:flush-requested", acknowledgeNativeClientStateRendererFlush, true),
        register("client-state:navigation-flush-requested", acknowledgeNativeClientStateNavigationFlush, false),
        nativeView.listen<{ generation: number }>("client-state:navigation-flush-cancelled", ({ payload }) => {
          cancelNavigation(payload.generation)
        }).then((unlisten) => {
          if (nativeDisposed) unlisten()
          else nativeUnlisteners.push(unlisten)
        }),
        nativeView.listen<{ generation: number }>("client-state:flush-cancelled", ({ payload }) => {
          if (nativeShutdownGeneration !== payload.generation) return
          resumeCapture()
        }).then((unlisten) => {
          if (nativeDisposed) unlisten()
          else nativeUnlisteners.push(unlisten)
        }),
      ]).then(() => undefined)
    : Promise.resolve()
  const markScrollAuthority = (instanceId: string, sessionId: string) => {
    const sessionIds = scrollAuthority.get(instanceId) ?? new Set<string>()
    sessionIds.add(sessionId)
    scrollAuthority.set(instanceId, sessionIds)
    schedule(true)
  }
  const cleanups = [
    messageStoreBus.onScrollSnapshotChanged((instanceId, sessionId, scope) => {
      if (scope === MESSAGE_STREAM_SCROLL_SCOPE) markScrollAuthority(instanceId, sessionId)
    }),
    messageStoreBus.onSessionCleared(markScrollAuthority),
    messageStoreBus.onInstanceDestroyed((instanceId) => {
      scrollAuthority.delete(instanceId)
      instanceLifecycleTokens.delete(instanceId)
    }),
    onInstanceLifecycleAuthority((event) => {
      if (releasing || !(event.projectTab || event.type === "unavailable" && openInstanceTabIds().has(event.instanceId))) return
      const lifecycleToken = ++nextInstanceLifecycleToken
      instanceLifecycleTokens.set(event.instanceId, lifecycleToken)
      // A fresh page has no startup snapshot. Capture live work before an
      // unavailable workspace is removed during backend-restart reconciliation.
      if (!preservation && event.type === "unavailable") {
        const captured = captureState(scrollAuthority)
        preservation = createRestorableSessionPreservation(captured.state)
        captured.tabIds.forEach((id, index) => recordRestoredTab(preservation!, index, id))
      }
      if (!preservation) {
        if (event.type === "removed") {
          const authoritativeState = captureState(scrollAuthority).state
          nativeFallbackState = authoritativeState.tabs.length > 0 ? authoritativeState : null
        }
        schedule()
        return
      }
      const workspace = { runtimeTabId: getInstanceAppTabId(event.instanceId), folder: event.folder, occurrence: event.occurrence,
        backendId: event.backendId, serverId: event.serverId }
      if (event.type === "unavailable") {
        const captured = captureState(scrollAuthority)
        const index = captured.tabIds.indexOf(workspace.runtimeTabId)
        const tab = index < 0 ? undefined : captured.state.tabs[index]
        markPreservedWorkspaceUnavailable(
          preservation,
          workspace,
          tab?.kind === "workspace" ? tab : undefined,
          index < 0 ? undefined : captured.authorities[index],
        )
        schedule()
        return
      }
      if (event.type === "removed") {
        markPreservedWorkspaceRemoved(preservation, workspace)
        const authoritativeState = mergedState()
        nativeFallbackState = authoritativeState.tabs.length > 0 ? authoritativeState : null
      } else {
        const target = getPreservedWorkspaceReopenTarget(preservation, workspace)
        markPreservedWorkspaceReopened(preservation, workspace)
        const snapshot = target?.snapshot
        const sourceIndex = target?.sourceIndex ?? -1
        const isCurrentBinding = () => Boolean(
          preservation
          && instanceLifecycleTokens.get(event.instanceId) === lifecycleToken
          && instances().has(event.instanceId)
          && hasRestoredTabBinding(preservation, sourceIndex, workspace.runtimeTabId),
        )
        // Seed the independent local composer before either native-read batch can recover into it.
        if (snapshot && isCurrentBinding()) hydrateWorkspacePromptState(event.instanceId,
          omitSupersededClosedDrafts(event.instanceId, snapshot), new Set(), NO_SESSION_DRAFT_SESSION_ID, true)
        if (snapshot && instances().has(event.instanceId)) void Promise.resolve().then(() => {
          if (!isCurrentBinding()) return null
          return hydrateRestoredWorkspaceState(event.instanceId, snapshot, hydrationController.signal, isCurrentBinding)
        }).then((unavailable) => {
          if (!unavailable || !preservation || !isCurrentBinding()) return
          settlePreservedTab(preservation, sourceIndex, workspace.runtimeTabId, workspace.runtimeTabId, unavailable)
          schedule()
        }).catch((error) => {
          if (!hydrationController.signal.aborted && isCurrentBinding()) {
            log.warn("Failed to restore preserved state for reopened workspace", { instanceId: event.instanceId, error })
          }
        })
      }
      schedule()
    }),
  ]
  createEffect(() => {
    if (!enabled()) return
    checkpointSessions()
    schedule()
  })
  createEffect(() => {
    if (!enabled()) return
    const tabs = appTabs()
    activeAppTabId(); activeParentSessionId(); activeSessionId(); expandedSessions()
    outlineCacheRevision(); seenInterruptionsRevision()
    for (const tab of tabs) if (tab.kind === "instance") {
      captureTabViewState(tab.instance.id)
    }
    schedule(true)
  })
  createEffect(() => {
    if (!enabled()) return
    trackSessionDraftChanges()
    trackSessionAttachmentChanges()
    schedule(true)
  })
  createEffect(() => {
    if (!enabled()) return
    const tabs = appTabs()
    promptTopology()
    for (const tab of tabs) if (tab.kind === "instance") {
      getAuthoritativelyDeletedSessionIdsForInstance(tab.instance.id)
      untrack(() => hydratePreservedPrompts(tab.instance.id))
    }
  })
  onMount(() => {
    const web = isWebHost()
    const pageHide = (event: PageTransitionEvent) => {
      if (event.persisted || releasing) return
      if (web) void flush().catch(error => log.warn("Could not flush client state", error))
      void release(!web || markWebSessionRecordsReleased())
    }
    const nativeFlush: NonNullable<Window["__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__"]> = async closing => {
      if (closing === "cancel") resumeCapture()
      else if (closing === "navigation-cancel") cancelNavigation(0)
      else if (closing === "navigation") await flushNavigation(0)
      else if (closing === "prepare") await flush(0)
      else if (closing === "release") await awaitRelease()
      else await flush()
    }
    const electronLocal = isElectronHost() && isLocalWindow()
    const saveSelection = () => {
      const tab = enabled() && !appSessionRestoreGateActive()
        ? activeAppTab()
        : undefined
      saveReloadTabSelection(tab?.kind === "instance"
        ? { kind: "workspace", workspaceId: tab.instance.id, backendId: tab.instance.backendId, serverId: tab.instance.serverId, folder: tab.instance.folder }
        : tab?.kind === "remote-restore" ? tab.snapshot
        : tab?.kind === "sidecar" ? { kind: "sidecar", sidecarId: tab.sidecarTab.sidecarId } : undefined)
    }
    window.addEventListener("pagehide", pageHide)
    if (electronLocal) window.addEventListener("pagehide", saveSelection)
    if (isElectronHost() || isTauriHost()) window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ = nativeFlush
    onCleanup(() => {
      if (electronLocal) window.removeEventListener("pagehide", saveSelection)
      window.removeEventListener("pagehide", pageHide)
      if (window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ === nativeFlush) {
        delete window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__
      }
    })
  })
  onCleanup(() => {
    disposed = true
    unlockInput?.()
    cancelCapture()
    hydrationController.abort(new Error("App session capture disposed"))
    nativeDisposed = true
    nativeUnlisteners.forEach((unlisten) => unlisten())
    cleanups.forEach((cleanup) => cleanup())
  })
  return {
    ready,
    commitRestore() {
      if (!isWebHost()) return
      completeWebSessionRestore()
      schedule()
    },
    start(snapshot?: RestorableSessionState) {
      if (snapshot) preservation = createRestorableSessionPreservation(snapshot)
      nativeFallbackState = snapshot?.tabs.length ? snapshot : null
      setStarted(true)
    },
    recordRestoredTab(index: number, tabId: string | null, unavailable?: ReadonlySet<string>) {
      if (!preservation) return
      recordRestoredTab(preservation, index, tabId, unavailable)
      schedule()
    },
    createRestoredTabCommitGuard(index: number) {
      const owner = preservation
      if (!owner) return () => false
      const current = createRestoredTabCommitGuard(owner, index)
      return () => preservation === owner && current()
    },
    removeRestoredTab(index: number) {
      const tab = preservation?.sourceTabs[index]
      if (!preservation || tab?.kind !== "workspace") return
      preservation.results[index] = { status: "removed" }
      preservation.removalRevisions[index] = (preservation.removalRevisions[index] ?? 0) + 1
      const current = mergedState()
      nativeFallbackState = current.tabs.length ? current : null
      schedule()
    },
    getUnavailableWorkspace(tabId: string) {
      if (!preservation) return
      const index = preservation.results.findIndex(result => result.runtimeTabId === tabId && result.runtimeUnavailable)
      // The unavailable lifecycle event already merged live and not-yet-hydrated state.
      const snapshot = preservation.sourceTabs[index]
      if (snapshot?.kind === "workspace") return { index, snapshot }
    },
    hasRestoredTabBinding(index: number, expectedRuntimeTabId: string) {
      return preservation ? hasRestoredTabBinding(preservation, index, expectedRuntimeTabId) : false
    },
    settleRestoredTab(
      index: number,
      expectedRuntimeTabId: string,
      tabId: string | null,
      unavailable?: ReadonlySet<string>,
    ) {
      if (!preservation || !settlePreservedTab(preservation, index, expectedRuntimeTabId, tabId, unavailable)) return false
      schedule()
      return true
    },
    restoredTabIds: () => preservation?.results.map((result) =>
      "runtimeTabId" in result ? result.runtimeTabId ?? null : null) ?? [],
  }
}
export type AppSessionCaptureController = ReturnType<typeof useAppSessionCapture>
