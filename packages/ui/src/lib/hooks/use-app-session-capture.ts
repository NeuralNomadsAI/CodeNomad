import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { listen } from "@tauri-apps/api/event"
import { getLogger } from "../logger"
import {
  acknowledgeNativeClientStateNavigationFlush,
  acknowledgeNativeClientStateRendererFlush,
} from "../native/client-state"
import { isElectronHost, isLocalWindow, isTauriHost } from "../runtime-env"
import {
  clientStateIsPrimary,
  flushClientState,
  restorePreviousStateEnabled,
  updateRestorableSession,
  type RestorableSessionState,
  type RestorableTabState,
  type RestorableWorkspaceTabState,
} from "../../stores/client-state"
import { normalizeWorkspacePath, shouldEnableSessionCapture } from "../../stores/app-session-reconciliation"
import {
  createRestorableSessionPreservation,
  mapRestoredWorkspaces,
  markPreservedWorkspaceRemoved,
  markPreservedWorkspaceReopened,
  markRestoredTab,
  mergeRestorableSessionState,
  unmapRestoredWorkspace,
  type RestorableSessionPreservation,
  type RestorableWorkspaceRuntimeAuthority,
  type RestoredWorkspaceMapping,
} from "../../stores/app-session-snapshot-merge"
import { activeAppTabId, appTabs, getInstanceAppTabId } from "../../stores/app-tabs"
import { instances } from "../../stores/instances"
import {
  activeParentSessionId,
  activeSessionId,
  getAuthoritativeDraftSessionIdsForInstance,
  getAuthoritativelyDeletedSessionIdsForInstance,
  getSessionDraftPromptsForInstance,
  getSessions,
  hasAuthoritativeSessionSelection,
} from "../../stores/sessions"
import { messageStoreBus } from "../../stores/message-v2/bus"
import type { ScrollSnapshot } from "../../stores/message-v2/types"
import {
  getAuthoritativeAttachmentSessionIdsForInstance,
  getSessionAttachmentsForInstance,
} from "../../stores/attachments"
import { serializeDraftAttachments } from "../../stores/client-state-attachments-codec"
import { onInstanceLifecycleAuthority } from "../../stores/instance-lifecycle-authority"
import { getPersistedGenerationRecovery, type PersistedGenerationRecovery } from "../../stores/session-generation-recovery"

const log = getLogger("actions")
const MESSAGE_SCROLL_SCOPE = "message-stream"
const MAX_CAPTURED_SCROLL_SNAPSHOTS = 96
const CAPTURE_DEBOUNCE_MS = 100

interface AppSessionCaptureController {
  beginRestore(snapshot: RestorableSessionState): void
  markRestoredTab(
    tabIndex: number,
    unavailableSessionIds?: ReadonlySet<string>,
    restoredTabId?: string | null,
  ): void
  mapWorkspaces(mappings: readonly RestoredWorkspaceMapping[]): void
  unmapWorkspace(runtimeTabId: string): void
  prepareCapture(snapshotExisted: boolean, restoreCompleted: boolean): void
  startCapture(): void
}

function captureScrollSnapshots(instanceId: string): Record<string, ScrollSnapshot> {
  const store = messageStoreBus.getInstance(instanceId)
  if (!store) return {}

  const suffix = `:${MESSAGE_SCROLL_SCOPE}`
  const snapshots = Object.entries(store.state.scrollState)
    .filter(([key]) => key.endsWith(suffix))
    .map(([key, snapshot]) => ({ sessionId: key.slice(0, -suffix.length), snapshot }))
    .filter((entry) => Boolean(entry.sessionId))
    .sort((left, right) => right.snapshot.updatedAt - left.snapshot.updatedAt)
    .slice(0, MAX_CAPTURED_SCROLL_SNAPSHOTS)

  const result: Record<string, ScrollSnapshot> = {}
  for (const { sessionId, snapshot } of snapshots) result[sessionId] = { ...snapshot }
  return result
}

function captureUnseenIdleMarkers(instanceId: string): Record<string, number> {
  return Object.fromEntries(
    getSessions(instanceId)
      .filter((session) => session.status === "idle" && typeof session.idleSince === "number")
      .map((session) => [session.id, session.idleSince as number]),
  )
}

function captureGenerationRecovery(instanceId: string): Record<string, PersistedGenerationRecovery> {
  const result: Record<string, PersistedGenerationRecovery> = {}
  for (const session of getSessions(instanceId)) {
    const recovery = getPersistedGenerationRecovery(session.status, session.generationRecovery)
    if (recovery) result[session.id] = recovery
  }
  return result
}

function captureRestorableSessionState(
  authoritativeScrollSessionIdsByInstance: ReadonlyMap<string, ReadonlySet<string>>,
): {
  state: RestorableSessionState
  tabIds: string[]
  authorities: Array<RestorableWorkspaceRuntimeAuthority | undefined>
} {
  const tabs = appTabs()
  const nextOccurrenceByPath = new Map<string, number>()
  const occurrenceByInstanceId = new Map<string, number>()
  for (const instance of instances().values()) {
    const pathKey = normalizeWorkspacePath(instance.folder)
    const occurrence = nextOccurrenceByPath.get(pathKey) ?? 0
    nextOccurrenceByPath.set(pathKey, occurrence + 1)
    occurrenceByInstanceId.set(instance.id, occurrence)
  }
  const restorableTabs: RestorableTabState[] = tabs.map((tab) => {
    if (tab.kind === "sidecar") return { kind: "sidecar", sidecarId: tab.sidecarTab.sidecarId }

    const draftState = serializeDraftAttachments(
      getSessionDraftPromptsForInstance(tab.instance.id),
      getSessionAttachmentsForInstance(tab.instance.id),
    )
    const result: RestorableWorkspaceTabState = {
      kind: "workspace",
      folder: tab.instance.folder,
      occurrence: occurrenceByInstanceId.get(tab.instance.id) ?? 0,
      drafts: draftState.drafts,
      attachments: draftState.attachments,
      scrollSnapshots: captureScrollSnapshots(tab.instance.id),
      unseenIdleSince: captureUnseenIdleMarkers(tab.instance.id),
      generationRecovery: captureGenerationRecovery(tab.instance.id),
    }
    if (tab.instance.projectName) result.projectName = tab.instance.projectName
    if (tab.instance.binaryPath) result.binaryPath = tab.instance.binaryPath

    const parentSessionId = activeParentSessionId().get(tab.instance.id)
    const sessionId = activeSessionId().get(tab.instance.id)
    if (parentSessionId) result.activeParentSessionId = parentSessionId
    if (sessionId) result.activeSessionId = sessionId
    return result
  })

  return {
    state: {
      tabs: restorableTabs,
      activeTabIndex: tabs.findIndex((tab) => tab.id === activeAppTabId()),
    },
    tabIds: tabs.map((tab) => tab.id),
    authorities: tabs.map((tab) => tab.kind === "instance" ? {
      drafts: getAuthoritativeDraftSessionIdsForInstance(tab.instance.id),
      attachments: getAuthoritativeAttachmentSessionIdsForInstance(tab.instance.id),
      scrollSnapshots: authoritativeScrollSessionIdsByInstance.get(tab.instance.id),
      idleMarkers: new Set(getSessions(tab.instance.id).map((session) => session.id)),
      generationRecovery: new Set(getSessions(tab.instance.id).map((session) => session.id)),
      deletedSessions: getAuthoritativelyDeletedSessionIdsForInstance(tab.instance.id),
      sessionSelection: hasAuthoritativeSessionSelection(tab.instance.id),
    } : undefined),
  }
}

export function useAppSessionCapture(): AppSessionCaptureController {
  const [startupFinished, setStartupFinished] = createSignal(false)
  const [captureAllowed, setCaptureAllowed] = createSignal(false)
  const captureEnabled = () => captureAllowed() && startupFinished() && clientStateIsPrimary() && restorePreviousStateEnabled()
  let disposed = false
  let captureTimer: ReturnType<typeof setTimeout> | null = null
  let capturePreservation: RestorableSessionPreservation | null = null
  const authoritativeScrollSessionIdsByInstance = new Map<string, Set<string>>()

  const markScrollSessionAuthoritative = (instanceId: string, sessionId: string) => {
    const sessionIds = authoritativeScrollSessionIdsByInstance.get(instanceId) ?? new Set<string>()
    sessionIds.add(sessionId)
    authoritativeScrollSessionIdsByInstance.set(instanceId, sessionIds)
  }
  const captureMergedState = () => {
    const captured = captureRestorableSessionState(authoritativeScrollSessionIdsByInstance)
    return mergeRestorableSessionState(captured.state, capturePreservation, {
      currentTabIds: captured.tabIds,
      currentTabAuthorities: captured.authorities,
    })
  }
  const persistCurrentState = () => {
    if (!captureEnabled() || disposed) return
    updateRestorableSession(captureMergedState())
  }
  const flushCurrentState = async () => {
    if (captureTimer !== null) {
      clearTimeout(captureTimer)
      captureTimer = null
    }
    if (captureEnabled()) updateRestorableSession(captureMergedState())
    await flushClientState()
  }
  const scheduleCapture = () => {
    if (!captureEnabled() || disposed) return
    if (captureTimer !== null) clearTimeout(captureTimer)
    captureTimer = setTimeout(() => {
      captureTimer = null
      persistCurrentState()
    }, CAPTURE_DEBOUNCE_MS)
  }

  const stopListeningForScrollChanges = messageStoreBus.onScrollSnapshotChanged((instanceId, sessionId, scope) => {
    if (scope !== MESSAGE_SCROLL_SCOPE) return
    markScrollSessionAuthoritative(instanceId, sessionId)
    scheduleCapture()
  })
  const stopListeningForClearedSessions = messageStoreBus.onSessionCleared((instanceId, sessionId) => {
    markScrollSessionAuthoritative(instanceId, sessionId)
    scheduleCapture()
  })
  const stopListeningForDestroyedInstances = messageStoreBus.onInstanceDestroyed((instanceId) => {
    authoritativeScrollSessionIdsByInstance.delete(instanceId)
  })
  const stopListeningForInstanceLifecycleAuthority = onInstanceLifecycleAuthority((event) => {
    if (!capturePreservation) return
    const workspace = {
      runtimeTabId: getInstanceAppTabId(event.instanceId),
      folder: event.folder,
      occurrence: event.occurrence,
    }
    capturePreservation = event.type === "removed"
      ? markPreservedWorkspaceRemoved(capturePreservation, workspace)
      : markPreservedWorkspaceReopened(capturePreservation, workspace)
    scheduleCapture()
  })

  createEffect(() => {
    if (!captureEnabled()) return
    const tabs = appTabs()
    activeAppTabId()
    activeParentSessionId()
    activeSessionId()
    for (const tab of tabs) {
      if (tab.kind !== "instance") continue
      getSessions(tab.instance.id)
      getSessionDraftPromptsForInstance(tab.instance.id)
      getSessionAttachmentsForInstance(tab.instance.id)
    }
    scheduleCapture()
  })

  onMount(() => {
    const handlePageHide = () => void flushCurrentState()
    const handleBeforeUnload = () => void flushCurrentState()
    window.addEventListener("pagehide", handlePageHide)
    window.addEventListener("beforeunload", handleBeforeUnload)

    let stopTauriFlushListener: (() => void) | null = null
    let stopTauriNavigationFlushListener: (() => void) | null = null
    let nativeHooksDisposed = false
    if (isElectronHost() && isLocalWindow()) {
      window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ = flushCurrentState
    } else if (isTauriHost() && isLocalWindow()) {
      void listen("client-state:flush-requested", () => {
        void flushCurrentState()
          .then(() => acknowledgeNativeClientStateRendererFlush())
          .catch((error) => log.error("Failed to flush client state for native shutdown", error))
      }).then((unlisten) => {
        if (nativeHooksDisposed) unlisten()
        else stopTauriFlushListener = unlisten
      }).catch((error) => log.error("Failed to listen for native client-state flush requests", error))
      void listen<{ generation: number }>("client-state:navigation-flush-requested", (event) => {
        void flushCurrentState()
          .then(() => acknowledgeNativeClientStateNavigationFlush(event.payload.generation))
          .catch((error) => log.error("Failed to flush client state for native navigation", error))
      }).then((unlisten) => {
        if (nativeHooksDisposed) unlisten()
        else stopTauriNavigationFlushListener = unlisten
      }).catch((error) => log.error("Failed to listen for native client-state navigation requests", error))
    }

    onCleanup(() => {
      nativeHooksDisposed = true
      window.removeEventListener("pagehide", handlePageHide)
      window.removeEventListener("beforeunload", handleBeforeUnload)
      stopTauriFlushListener?.()
      stopTauriNavigationFlushListener?.()
      if (window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ === flushCurrentState) {
        delete window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__
      }
    })
  })

  onCleanup(() => {
    void flushCurrentState()
    disposed = true
    stopListeningForScrollChanges()
    stopListeningForClearedSessions()
    stopListeningForDestroyedInstances()
    stopListeningForInstanceLifecycleAuthority()
  })

  return {
    beginRestore(snapshot) {
      capturePreservation = createRestorableSessionPreservation(snapshot)
    },
    markRestoredTab(tabIndex, unavailableSessionIds, restoredTabId) {
      if (!capturePreservation) return
      capturePreservation = markRestoredTab(capturePreservation, tabIndex, unavailableSessionIds, restoredTabId)
    },
    mapWorkspaces(mappings) {
      if (!capturePreservation) return
      capturePreservation = mapRestoredWorkspaces(capturePreservation, mappings)
    },
    unmapWorkspace(runtimeTabId) {
      if (!capturePreservation) return
      capturePreservation = unmapRestoredWorkspace(capturePreservation, runtimeTabId)
    },
    prepareCapture(snapshotExisted, restoreCompleted) {
      setCaptureAllowed(shouldEnableSessionCapture(snapshotExisted, restoreCompleted))
    },
    startCapture() {
      setStartupFinished(true)
    },
  }
}
