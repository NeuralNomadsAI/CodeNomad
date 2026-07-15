import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
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
  createRestorableSessionPreservation, markPreservedWorkspaceRemoved, markPreservedWorkspaceReopened,
  mergeRestorableSessionState, recordRestoredTab, type RestorableSessionPreservation,
  type RestorableWorkspaceRuntimeAuthority,
} from "../../stores/app-session-snapshot-merge"
import { activeAppTabId, appTabs, getInstanceAppTabId } from "../../stores/app-tabs"
import { instances } from "../../stores/instances"
import {
  activeParentSessionId, activeSessionId, getAuthoritativeDraftSessionIdsForInstance,
  getAuthoritativelyDeletedSessionIdsForInstance, getSessionDraftPromptsForInstance, getSessions,
  hasAuthoritativeSessionSelection,
} from "../../stores/sessions"
import { messageStoreBus } from "../../stores/message-v2/bus"
import type { ScrollSnapshot } from "../../stores/message-v2/types"
import { getAuthoritativeAttachmentSessionIdsForInstance, getSessionAttachmentsForInstance } from "../../stores/attachments"
import { serializeDraftAttachments } from "../../stores/client-state-attachments-codec"
import { onInstanceLifecycleAuthority } from "../../stores/instance-lifecycle-authority"
import { getPersistedGenerationRecovery, type PersistedGenerationRecovery } from "../../stores/session-generation-recovery"
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
    const prioritySessionIds = [sessionId, "__no_session_draft__"].filter((value): value is string => Boolean(value))
    const result: RestorableWorkspaceTabState = {
      kind: "workspace", folder: tab.instance.folder, occurrence: occurrenceByInstance.get(id) ?? 0,
      ...serializeDraftAttachments(
        getSessionDraftPromptsForInstance(id), getSessionAttachmentsForInstance(id), prioritySessionIds,
      ),
      ...captureRuntimeState(id), scrollSnapshots: captureScrollSnapshots(id),
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
      deletedSessions: getAuthoritativelyDeletedSessionIdsForInstance(id),
      sessionSelection: hasAuthoritativeSessionSelection(id),
    }
  })
  return {
    state: { tabs: restorableTabs, activeTabIndex: tabs.findIndex(({ id }) => id === activeAppTabId()) },
    tabIds: tabs.map(({ id }) => id), authorities,
  }
}
export function useAppSessionCapture() {
  const [started, setStarted] = createSignal(false)
  const enabled = () => started() && clientStateIsPrimary() && restorePreviousStateEnabled()
  const scrollAuthority = new Map<string, Set<string>>()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let preservation: RestorableSessionPreservation | null = null
  const mergedState = () => {
    const captured = captureState(scrollAuthority)
    return mergeRestorableSessionState(captured.state, preservation, {
      currentTabIds: captured.tabIds, currentTabAuthorities: captured.authorities,
    })
  }
  const capture = () => {
    timer = null
    if (enabled() && !disposed) updateRestorableSession(mergedState())
  }
  const schedule = () => {
    if (!enabled() || disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(capture, CAPTURE_DEBOUNCE_MS)
  }
  const flush = async () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (enabled()) updateRestorableSession(mergedState())
    await flushClientState()
  }
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
    messageStoreBus.onInstanceDestroyed((instanceId) => scrollAuthority.delete(instanceId)),
    onInstanceLifecycleAuthority((event) => {
      if (!preservation) return
      const workspace = { runtimeTabId: getInstanceAppTabId(event.instanceId), folder: event.folder, occurrence: event.occurrence }
      const mark = event.type === "removed" ? markPreservedWorkspaceRemoved : markPreservedWorkspaceReopened
      mark(preservation, workspace)
      schedule()
    }),
  ]
  createEffect(() => {
    if (!enabled()) return
    const tabs = appTabs()
    activeAppTabId(); activeParentSessionId(); activeSessionId()
    for (const tab of tabs) if (tab.kind === "instance") {
      getSessions(tab.instance.id)
      getSessionDraftPromptsForInstance(tab.instance.id)
      getSessionAttachmentsForInstance(tab.instance.id)
    }
    schedule()
  })
  onMount(() => {
    const flushNow = () => void flush()
    const nativeUnlisteners: Array<() => void> = []
    let nativeDisposed = false
    window.addEventListener("pagehide", flushNow)
    window.addEventListener("beforeunload", flushNow)
    if (isElectronHost() && isLocalWindow()) window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ = flush
    else if (isTauriHost() && isLocalWindow()) {
      const register = <T,>(event: string, acknowledge: (payload: T) => void | Promise<void>) => void listen<T>(event, ({ payload }) => {
        void flush().then(() => acknowledge(payload)).catch((error) => log.error(`Failed to handle ${event}`, error))
      }).then((unlisten) => nativeDisposed ? unlisten() : nativeUnlisteners.push(unlisten))
        .catch((error) => log.error(`Failed to listen for ${event}`, error))
      register<{ generation: number }>("client-state:flush-requested",
        ({ generation }) => acknowledgeNativeClientStateRendererFlush(generation))
      register<{ generation: number }>("client-state:navigation-flush-requested",
        ({ generation }) => acknowledgeNativeClientStateNavigationFlush(generation))
    }
    onCleanup(() => {
      nativeDisposed = true
      window.removeEventListener("pagehide", flushNow)
      window.removeEventListener("beforeunload", flushNow)
      nativeUnlisteners.forEach((unlisten) => unlisten())
      if (window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ === flush) {
        delete window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__
      }
    })
  })
  onCleanup(() => {
    void flush()
    disposed = true
    cleanups.forEach((cleanup) => cleanup())
  })
  return {
    start(snapshot?: RestorableSessionState) {
      if (snapshot) preservation = createRestorableSessionPreservation(snapshot)
      setStarted(true)
    },
    recordRestoredTab(index: number, tabId: string | null, unavailable?: ReadonlySet<string>) {
      if (!preservation) return
      recordRestoredTab(preservation, index, tabId, unavailable)
      schedule()
    },
    restoredTabIds: () => preservation?.results.map((result) =>
      "runtimeTabId" in result ? result.runtimeTabId ?? null : null) ?? [],
  }
}
export type AppSessionCaptureController = ReturnType<typeof useAppSessionCapture>
