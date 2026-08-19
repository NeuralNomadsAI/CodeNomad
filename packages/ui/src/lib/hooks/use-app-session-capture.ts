import { createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { listen } from "@tauri-apps/api/event"
import { getLogger } from "../logger"
import { acknowledgeNativeClientStateNavigationFlush, acknowledgeNativeClientStateRendererFlush } from "../native/client-state"
import { isElectronHost, isLocalWindow, isTauriHost } from "../runtime-env"
import {
  clientStateIsPrimary, flushClientState, restorePreviousStateEnabled, updateRestorableSession,
  type RestorableSessionState, type RestorableTabState, type RestorableWorkspaceTabState,
} from "../../stores/client-state"
import { normalizeWorkspacePath } from "../../stores/app-session-reconciliation"
import {
  createRestorableSessionPreservation, createRestoredTabCommitGuard, markPreservedWorkspaceRemoved,
  markPreservedWorkspaceReopened, markPreservedWorkspaceUnavailable,
  getPreservedWorkspaceReopenTarget, getPreservedWorkspaceState,
  hasRestoredTabBinding, mergeRestorableSessionState, recordRestoredTab,
  settleRestoredTab as settlePreservedTab, type RestorableSessionPreservation,
  type RestorableWorkspaceRuntimeAuthority,
} from "../../stores/app-session-snapshot-merge"
import { activeAppTabId, appTabs, getInstanceAppTabId } from "../../stores/app-tabs"
import { showFolderSelection } from "../../stores/ui"
import { instances, waitForInstanceInitialSessionHydration } from "../../stores/instances"
import {
  activeParentSessionId, activeSessionId, expandedSessions, getAuthoritativeDraftSessionIdsForInstance,
  getAuthoritativeSessionExpansionIdsForInstance, getAuthoritativelyDeletedSessionIdsForInstance,
  getSessionDraftPromptsForInstance, getSessions,
  hasAuthoritativeSessionSelection,
} from "../../stores/sessions"
import { messageStoreBus } from "../../stores/message-v2/bus"
import type { ScrollSnapshot } from "../../stores/message-v2/types"
import { getAuthoritativeAttachmentSessionIdsForInstance, getSessionAttachmentsForInstance } from "../../stores/attachments"
import { serializeDraftAttachments } from "../../stores/client-state-attachments-codec"
import { onInstanceLifecycleAuthority } from "../../stores/instance-lifecycle-authority"
import { getPersistedGenerationRecovery, type PersistedGenerationRecovery } from "../../stores/session-generation-recovery"
import { hydrateWorkspacePromptState } from "../../stores/app-session-prompt-hydration"
import {
  hydrateRestoredWorkspaceState, NO_SESSION_DRAFT_SESSION_ID,
} from "../../stores/app-session-workspace-hydration"
const log = getLogger("actions")
const MESSAGE_SCROLL_SCOPE = "message-stream"
const MAX_CAPTURED_SCROLL_SNAPSHOTS = 96
const CAPTURE_DEBOUNCE_MS = 100
function captureScrollSnapshots(instanceId: string): Record<string, ScrollSnapshot> {
  const store = messageStoreBus.getInstance(instanceId)
  if (!store) return {}
  const suffix = `:${MESSAGE_SCROLL_SCOPE}`
  return Object.fromEntries(Object.entries(store.state.scrollState)
    .filter(([key]) => key.endsWith(suffix))
    .map(([key, snapshot]) => ({ sessionId: key.slice(0, -suffix.length), snapshot }))
    .filter(({ sessionId }) => Boolean(sessionId))
    .sort((a, b) => b.snapshot.updatedAt - a.snapshot.updatedAt)
    .slice(0, MAX_CAPTURED_SCROLL_SNAPSHOTS)
    .map(({ sessionId, snapshot }) => [sessionId, { ...snapshot }]))
}
function captureRuntimeState(instanceId: string): Pick<RestorableWorkspaceTabState, "unseenIdleSince" | "generationRecovery"> {
  const unseenIdleSince: Record<string, number> = {}
  const generationRecovery: Record<string, PersistedGenerationRecovery> = {}
  for (const session of getSessions(instanceId)) {
    if (session.status === "idle" && typeof session.idleSince === "number") unseenIdleSince[session.id] = session.idleSince
    const recovery = getPersistedGenerationRecovery(session.status, session.generationRecovery)
    if (recovery) generationRecovery[session.id] = recovery
  }
  return { unseenIdleSince, generationRecovery }
}
function captureState(scrollAuthority: ReadonlyMap<string, ReadonlySet<string>>) {
  const tabs = appTabs()
  const nextOccurrence = new Map<string, number>()
  const occurrenceByInstance = new Map<string, number>()
  for (const instance of instances().values()) {
    const path = normalizeWorkspacePath(instance.folder)
    const occurrence = nextOccurrence.get(path) ?? 0
    nextOccurrence.set(path, occurrence + 1)
    occurrenceByInstance.set(instance.id, occurrence)
  }
  const restorableTabs: RestorableTabState[] = tabs.map((tab) => {
    if (tab.kind === "sidecar") return { kind: "sidecar", sidecarId: tab.sidecarTab.sidecarId }
    const id = tab.instance.id
    const parentId = activeParentSessionId().get(id)
    const sessionId = activeSessionId().get(id)
    const expansionAuthority = getAuthoritativeSessionExpansionIdsForInstance(id)
    const expanded = [...(expandedSessions().get(id) ?? [])]
    const prioritySessionIds = [sessionId, "__no_session_draft__"].filter((value): value is string => Boolean(value))
    const result: RestorableWorkspaceTabState = {
      kind: "workspace", folder: tab.instance.folder, occurrence: occurrenceByInstance.get(id) ?? 0,
      ...serializeDraftAttachments(
        getSessionDraftPromptsForInstance(id), getSessionAttachmentsForInstance(id), prioritySessionIds,
      ),
      ...captureRuntimeState(id), scrollSnapshots: captureScrollSnapshots(id),
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
    const sessionIds = new Set(getSessions(id).map(({ id }) => id))
    return {
      drafts: getAuthoritativeDraftSessionIdsForInstance(id),
      attachments: getAuthoritativeAttachmentSessionIdsForInstance(id),
      scrollSnapshots: scrollAuthority.get(id), idleMarkers: sessionIds, generationRecovery: sessionIds,
      sessionExpansion: getAuthoritativeSessionExpansionIdsForInstance(id),
      deletedSessions: getAuthoritativelyDeletedSessionIdsForInstance(id),
      sessionSelection: hasAuthoritativeSessionSelection(id),
    }
  })
  return {
    state: {
      tabs: restorableTabs,
      activeTabIndex: tabs.findIndex(({ id }) => id === activeAppTabId()),
      ...(showFolderSelection() ? { homeActive: true } : {}),
    },
    tabIds: tabs.map(({ id }) => id), authorities,
  }
}
export function useAppSessionCapture() {
  const [started, setStarted] = createSignal(false)
  const enabled = () => started() && clientStateIsPrimary() && restorePreviousStateEnabled()
  const scrollAuthority = new Map<string, Set<string>>()
  const instanceLifecycleTokens = new Map<string, number>()
  let nextInstanceLifecycleToken = 0
  let disposed = false
  let nativeShutdownStarted = false
  const hydrationController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let preservation: RestorableSessionPreservation | null = null
  let nativeFallbackState: RestorableSessionState | null = null
  const hydratePreservedPrompts = (instanceId: string) => {
    if (!preservation) return
    const instance = instances().get(instanceId)
    if (!instance) return
    const snapshot = getPreservedWorkspaceState(preservation, {
      runtimeTabId: getInstanceAppTabId(instanceId), folder: instance.folder, occurrence: 0,
    })
    if (!snapshot) return
    hydrateWorkspacePromptState(
      instanceId,
      snapshot,
      new Set(getSessions(instanceId).map(({ id }) => id)),
      NO_SESSION_DRAFT_SESSION_ID,
    )
  }
  const mergedState = () => {
    const captured = captureState(scrollAuthority)
    return mergeRestorableSessionState(captured.state, preservation, {
      currentTabIds: captured.tabIds, currentTabAuthorities: captured.authorities,
    })
  }
  const capture = () => {
    timer = null
    if (enabled() && !disposed && !nativeShutdownStarted) {
      const state = mergedState()
      if (state.tabs.length > 0) nativeFallbackState = state
      updateRestorableSession(state)
    }
  }
  const schedule = () => {
    if (!enabled() || disposed || nativeShutdownStarted) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(capture, CAPTURE_DEBOUNCE_MS)
  }
  const flush = async (nativeShutdown = false) => {
    if (nativeShutdown) nativeShutdownStarted = true
    if (timer) clearTimeout(timer)
    timer = null
    if (enabled()) {
      const current = mergedState()
      const state = nativeShutdown
        && current.tabs.length === 0
        && (nativeFallbackState?.tabs.length ?? 0) > 0
        ? nativeFallbackState!
        : current
      updateRestorableSession(state)
    }
    await flushClientState()
  }
  const nativeUnlisteners: Array<() => void> = []
  let nativeDisposed = false
  const register = <T,>(event: string, acknowledge: (payload: T) => void | Promise<void>, nativeShutdown: boolean) => listen<T>(event, ({ payload }) => {
    void flush(nativeShutdown).then(() => acknowledge(payload)).catch((error) => log.error(`Failed to handle ${event}`, error))
  }).then((unlisten) => {
    if (nativeDisposed) unlisten()
    else nativeUnlisteners.push(unlisten)
  }).catch((error) => log.error(`Failed to listen for ${event}`, error))
  const ready = isTauriHost() && isLocalWindow()
    ? Promise.all([
        register<{ generation: number }>("client-state:flush-requested",
          ({ generation }) => acknowledgeNativeClientStateRendererFlush(generation), true),
        register<{ generation: number }>("client-state:navigation-flush-requested",
          ({ generation }) => acknowledgeNativeClientStateNavigationFlush(generation), false),
      ]).then(() => undefined)
    : Promise.resolve()
  const markScrollAuthority = (instanceId: string, sessionId: string) => {
    const sessionIds = scrollAuthority.get(instanceId) ?? new Set<string>()
    sessionIds.add(sessionId)
    scrollAuthority.set(instanceId, sessionIds)
    schedule()
  }
  const cleanups = [
    messageStoreBus.onScrollSnapshotChanged((instanceId, sessionId, scope) => {
      if (scope === MESSAGE_SCROLL_SCOPE) markScrollAuthority(instanceId, sessionId)
    }),
    messageStoreBus.onSessionCleared(markScrollAuthority),
    messageStoreBus.onInstanceDestroyed((instanceId) => {
      scrollAuthority.delete(instanceId)
      instanceLifecycleTokens.delete(instanceId)
    }),
    onInstanceLifecycleAuthority((event) => {
      const lifecycleToken = ++nextInstanceLifecycleToken
      instanceLifecycleTokens.set(event.instanceId, lifecycleToken)
      if (!preservation) {
        if (event.type === "removed") {
          const authoritativeState = captureState(scrollAuthority).state
          nativeFallbackState = authoritativeState.tabs.length > 0 ? authoritativeState : null
        }
        schedule()
        return
      }
      const workspace = { runtimeTabId: getInstanceAppTabId(event.instanceId), folder: event.folder, occurrence: event.occurrence }
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
        if (snapshot && instances().has(event.instanceId)) void waitForInstanceInitialSessionHydration(event.instanceId).then(() => {
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
    const tabs = appTabs()
    activeAppTabId(); activeParentSessionId(); activeSessionId(); expandedSessions(); showFolderSelection()
    for (const tab of tabs) if (tab.kind === "instance") {
      getSessions(tab.instance.id)
      getSessionDraftPromptsForInstance(tab.instance.id)
      getSessionAttachmentsForInstance(tab.instance.id)
    }
    schedule()
  })
  createEffect(() => {
    if (!enabled()) return
    const tabs = appTabs()
    for (const tab of tabs) if (tab.kind === "instance") {
      getSessions(tab.instance.id)
      untrack(() => hydratePreservedPrompts(tab.instance.id))
    }
  })
  onMount(() => {
    const flushNow = () => void flush()
    const useBrowserLifecycleFlush = !isLocalWindow()
    if (useBrowserLifecycleFlush) {
      window.addEventListener("pagehide", flushNow)
      window.addEventListener("beforeunload", flushNow)
    }
    if (isElectronHost() && isLocalWindow()) window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ = flush
    onCleanup(() => {
      if (useBrowserLifecycleFlush) {
        window.removeEventListener("pagehide", flushNow)
        window.removeEventListener("beforeunload", flushNow)
      }
      if (window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ === flush) {
        delete window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__
      }
    })
  })
  onCleanup(() => {
    disposed = true
    if (timer) clearTimeout(timer)
    timer = null
    hydrationController.abort(new Error("App session capture disposed"))
    nativeDisposed = true
    nativeUnlisteners.forEach((unlisten) => unlisten())
    cleanups.forEach((cleanup) => cleanup())
  })
  return {
    ready,
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
      return preservation ? createRestoredTabCommitGuard(preservation, index) : () => false
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
