import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { listen } from "@tauri-apps/api/event"
import { getLogger } from "../logger"
import {
  acknowledgeNativeClientStateNavigationFlush,
  acknowledgeNativeClientStateRendererFlush,
} from "../native/client-state"
import { isElectronHost, isLocalWindow, isTauriHost, isWebHost } from "../runtime-env"
import {
  clientStateIsPrimary,
  flushClientState,
  loadedClientSnapshotExists,
  loadedRestorableSession,
  restorePreviousStateEnabled,
  updateRestorableSession,
  type RestorableSessionState,
  type RestorableTabState,
  type RestorableWorkspaceTabState,
} from "../../stores/client-state"
import { releaseAppSessionRestoreGate } from "../../stores/app-session-restore-gate"
import {
  getUnavailableRestoredSessionIds,
  normalizeWorkspacePath,
  reconcileWorkspaceTabs,
  resolveRestoredActiveTabId,
  resolveRestoredSessionSelection,
  shouldEnableSessionCapture,
  shouldRestoreSessionState,
} from "../../stores/app-session-reconciliation"
import {
  getAbortReason,
  RestoreTimeoutError,
  runWithRestoreDeadline,
  withRestoreTimeout,
  type RestoreActivity,
} from "../../stores/app-session-restore-timeout"
import { completeAbortableRestoreHydration } from "../../stores/abortable-restore-creation"
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
import {
  activeAppTabId,
  appTabs,
  getInstanceAppTabId,
  getSidecarAppTabId,
  selectAppTab,
  setAppTabOrder,
} from "../../stores/app-tabs"
import {
  createInstance,
  disposeRestoreCreatedInstance,
  releaseRestoreCreatedInstance,
  instances,
  waitForInitialWorkspaceLoad,
  waitForInstanceInitialHydration,
} from "../../stores/instances"
import { openSidecarTab, SidecarNotFoundError } from "../../stores/sidecars"
import {
  activeParentSessionId,
  activeSessionId,
  getAuthoritativeDraftSessionIdsForInstance,
  getAuthoritativelyDeletedSessionIdsForInstance,
  getSessionDraftPromptsForInstance,
  getSessions,
  hasAuthoritativeSessionSelection,
  hydrateActiveSessionSelection,
  hydrateSessionIdleMarkers,
  hydrateSessionGenerationRecovery,
} from "../../stores/sessions"
import { messageStoreBus, type MessageScrollSnapshotSeed } from "../../stores/message-v2/bus"
import type { ScrollSnapshot } from "../../stores/message-v2/types"
import {
  getAuthoritativeAttachmentSessionIdsForInstance,
  getSessionAttachmentsForInstance,
} from "../../stores/attachments"
import {
  serializeDraftAttachments,
} from "../../stores/client-state-attachments-codec"
import { hydrateWorkspacePromptState } from "../../stores/app-session-prompt-hydration"
import { onInstanceLifecycleAuthority } from "../../stores/instance-lifecycle-authority"
import { getPersistedGenerationRecovery, type PersistedGenerationRecovery } from "../../stores/session-generation-recovery"

const log = getLogger("actions")
const MESSAGE_SCROLL_SCOPE = "message-stream"
const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"
const MAX_CAPTURED_SCROLL_SNAPSHOTS = 96
const CAPTURE_DEBOUNCE_MS = 100
// The startup gate is held for at most 60 seconds. Initial discovery gets 15
// seconds, while each combined workspace or SideCar operation gets 30 seconds.
const INITIAL_WORKSPACE_LOAD_TIMEOUT_MS = 15_000
const RESTORE_OPERATION_TIMEOUT_MS = 30_000
const STARTUP_RESTORE_TIMEOUT_MS = 60_000

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
  for (const { sessionId, snapshot } of snapshots) {
    result[sessionId] = { ...snapshot }
  }
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
    if (tab.kind === "sidecar") {
      return { kind: "sidecar", sidecarId: tab.sidecarTab.sidecarId }
    }

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

function getWorkspaceSessionReferences(snapshot: RestorableWorkspaceTabState) {
  return {
    activeParentSessionId: snapshot.activeParentSessionId,
    activeSessionId: snapshot.activeSessionId,
    draftSessionIds: Object.keys(snapshot.drafts),
    attachmentSessionIds: Object.keys(snapshot.attachments),
    scrollSessionIds: Object.keys(snapshot.scrollSnapshots),
    idleMarkerSessionIds: Object.keys(snapshot.unseenIdleSince),
    generationRecoverySessionIds: Object.keys(snapshot.generationRecovery),
  }
}

function restoreWorkspaceState(instanceId: string, snapshot: RestorableWorkspaceTabState): Set<string> {
  const availableSessions = getSessions(instanceId)
  const validSessionIds = new Set(availableSessions.map((session) => session.id))
  const unavailableSessionIds = getUnavailableRestoredSessionIds(
    availableSessions,
    getWorkspaceSessionReferences(snapshot),
    [NO_SESSION_DRAFT_SESSION_ID],
  )

  hydrateWorkspacePromptState(instanceId, snapshot, validSessionIds, NO_SESSION_DRAFT_SESSION_ID)
  hydrateSessionIdleMarkers(instanceId, snapshot.unseenIdleSince)
  hydrateSessionGenerationRecovery(instanceId, snapshot.generationRecovery)

  const scrollSeeds: MessageScrollSnapshotSeed[] = []
  for (const [sessionId, scrollSnapshot] of Object.entries(snapshot.scrollSnapshots)) {
    if (!validSessionIds.has(sessionId)) continue
    scrollSeeds.push({ sessionId, scope: MESSAGE_SCROLL_SCOPE, snapshot: scrollSnapshot })
  }
  messageStoreBus.seedScrollSnapshots(instanceId, scrollSeeds)

  const selection = resolveRestoredSessionSelection(
    availableSessions,
    snapshot.activeParentSessionId,
    snapshot.activeSessionId,
  )
  if (!selection) {
    hydrateActiveSessionSelection(instanceId, null, null)
    return unavailableSessionIds
  }
  hydrateActiveSessionSelection(instanceId, selection.parentSessionId, selection.activeSessionId)
  return unavailableSessionIds
}

async function restoreWorkspaceTabs(
  snapshot: RestorableSessionState,
  restoredTabIds: (string | null)[],
  isRestoreActive: RestoreActivity,
  restoreSignal: AbortSignal,
  updatePreservation: (
    tabIndex: number,
    unavailableSessionIds?: ReadonlySet<string>,
    restoredTabId?: string | null,
  ) => void,
  mapWorkspaces: (mappings: readonly RestoredWorkspaceMapping[]) => void,
  unmapWorkspace: (runtimeTabId: string) => void,
): Promise<void> {
  const workspaceMatches = reconcileWorkspaceTabs(
    snapshot.tabs.map((tab) =>
      tab.kind === "workspace"
        ? { kind: tab.kind, folderPath: tab.folder, occurrence: tab.occurrence }
        : { kind: tab.kind },
    ),
    Array.from(instances().values()).map((instance) => ({ id: instance.id, folderPath: instance.folder })),
  )

  const existingMatches = workspaceMatches.filter((match) => match.existingWorkspaceId)
  const missingMatches = workspaceMatches.filter((match) => !match.existingWorkspaceId)
  mapWorkspaces(existingMatches.map((match) => ({
    sourceIndex: match.tabIndex,
    runtimeTabId: getInstanceAppTabId(match.existingWorkspaceId!),
  })))
  const firstTabIndexByPath = new Map<string, number>()
  for (const match of missingMatches) {
    const path = normalizeWorkspacePath(match.descriptor.folderPath)
    const firstIndex = firstTabIndexByPath.get(path)
    if (firstIndex === undefined || match.tabIndex < firstIndex) firstTabIndexByPath.set(path, match.tabIndex)
  }
  missingMatches.sort((left, right) => {
    const leftPath = normalizeWorkspacePath(left.descriptor.folderPath)
    const rightPath = normalizeWorkspacePath(right.descriptor.folderPath)
    const groupOrder = (firstTabIndexByPath.get(leftPath) ?? left.tabIndex)
      - (firstTabIndexByPath.get(rightPath) ?? right.tabIndex)
    return groupOrder || left.descriptor.occurrence - right.descriptor.occurrence
  })

  for (const match of [...existingMatches, ...missingMatches]) {
    if (!isRestoreActive()) return
    const tab = snapshot.tabs[match.tabIndex]
    if (!tab || tab.kind !== "workspace") continue

    try {
      const instanceId = await withRestoreTimeout(async (operationSignal) => {
        const existingId = match.existingWorkspaceId
        const id = existingId ?? (isWebHost()
          ? null
          : await createInstance(tab.folder, tab.binaryPath, tab.projectName, {
              activate: false,
              signal: operationSignal,
              onCreateCommit: (createdId) => mapWorkspaces([{
                sourceIndex: match.tabIndex,
                runtimeTabId: getInstanceAppTabId(createdId),
              }]),
            }))
        if (!id) return null

        const restoredTabId = getInstanceAppTabId(id)
        restoredTabIds[match.tabIndex] = restoredTabId
        updatePreservation(
          match.tabIndex,
          getUnavailableRestoredSessionIds(
            [],
            getWorkspaceSessionReferences(tab),
            [NO_SESSION_DRAFT_SESSION_ID],
          ),
          restoredTabId,
        )

        try {
          await completeAbortableRestoreHydration(id, {
            signal: operationSignal,
            hydrate: waitForInstanceInitialHydration,
            commit: (hydratedId) => {
              updatePreservation(match.tabIndex, restoreWorkspaceState(hydratedId, tab), restoredTabId)
              if (!existingId) releaseRestoreCreatedInstance(hydratedId)
            },
            discard: existingId ? undefined : async (discardedId) => {
              unmapWorkspace(getInstanceAppTabId(discardedId))
              await disposeRestoreCreatedInstance(discardedId)
            },
            retainOnAbort: (reason) => {
              if (!(reason instanceof RestoreTimeoutError)) return false
              if (!existingId) releaseRestoreCreatedInstance(id)
              return true
            },
          })
        } catch (error) {
          if (!existingId && !operationSignal.aborted) releaseRestoreCreatedInstance(id)
          throw error
        }
        return id
      }, RESTORE_OPERATION_TIMEOUT_MS, `Timed out restoring workspace ${tab.folder}`, restoreSignal)
      if (!isRestoreActive()) return
      if (!instanceId) {
        log.info("Skipped automatic remote workspace launch while restoring browser state", { folder: tab.folder })
        continue
      }
    } catch (error) {
      if (!isRestoreActive()) return
      const retained = Boolean(restoredTabIds[match.tabIndex])
      log.warn(retained
        ? "Retained workspace after session hydration failed during app restore"
        : "Skipped workspace while restoring app session", { folder: tab.folder, error })
    }
  }
}

async function restoreSidecarTabs(
  snapshot: RestorableSessionState,
  restoredTabIds: (string | null)[],
  isRestoreActive: RestoreActivity,
  restoreSignal: AbortSignal,
  updatePreservation: (
    tabIndex: number,
    unavailableSessionIds?: ReadonlySet<string>,
    restoredTabId?: string | null,
  ) => void,
): Promise<void> {
  for (let index = 0; index < snapshot.tabs.length; index += 1) {
    if (!isRestoreActive()) return
    const tab = snapshot.tabs[index]
    if (!tab || tab.kind !== "sidecar") continue
    try {
      const opened = await withRestoreTimeout(
        (operationSignal) => openSidecarTab(tab.sidecarId, {
          activate: false,
          propagateLoadErrors: true,
          signal: operationSignal,
        }),
        RESTORE_OPERATION_TIMEOUT_MS,
        `Timed out restoring SideCar ${tab.sidecarId}`,
        restoreSignal,
      )
      if (!isRestoreActive()) return
      restoredTabIds[index] = getSidecarAppTabId(opened.token)
      updatePreservation(index, undefined, restoredTabIds[index])
    } catch (error) {
      if (error instanceof SidecarNotFoundError) updatePreservation(index)
      if (!isRestoreActive()) return
      log.warn("Skipped SideCar while restoring app session", { sidecarId: tab.sidecarId, error })
    }
  }
}

async function restoreAppSession(
  snapshot: RestorableSessionState,
  isRestoreActive: RestoreActivity,
  restoreSignal: AbortSignal,
  updatePreservation: (
    tabIndex: number,
    unavailableSessionIds?: ReadonlySet<string>,
    restoredTabId?: string | null,
  ) => void,
  mapWorkspaces: (mappings: readonly RestoredWorkspaceMapping[]) => void,
  unmapWorkspace: (runtimeTabId: string) => void,
): Promise<void> {
  try {
    await withRestoreTimeout(
      async (operationSignal) => {
        await waitForInitialWorkspaceLoad()
        if (operationSignal.aborted) throw getAbortReason(operationSignal)
      },
      INITIAL_WORKSPACE_LOAD_TIMEOUT_MS,
      "Timed out loading initial workspaces",
      restoreSignal,
    )
  } catch (error) {
    log.error("Failed to load workspaces before restoring app session", error)
    return
  }
  if (!isRestoreActive()) return

  const restoredTabIds = Array<string | null>(snapshot.tabs.length).fill(null)
  await restoreWorkspaceTabs(
    snapshot,
    restoredTabIds,
    isRestoreActive,
    restoreSignal,
    updatePreservation,
    mapWorkspaces,
    unmapWorkspace,
  )
  await restoreSidecarTabs(snapshot, restoredTabIds, isRestoreActive, restoreSignal, updatePreservation)
  if (!isRestoreActive()) return

  const restoredOrder = restoredTabIds.filter((tabId): tabId is string => Boolean(tabId))
  setAppTabOrder(restoredOrder)
  selectAppTab(resolveRestoredActiveTabId(restoredTabIds, snapshot.activeTabIndex))
}

export function useAppSessionRestore(): void {
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
    const primary = clientStateIsPrimary()
    const restoreEnabled = restorePreviousStateEnabled()
    const snapshotExisted = loadedClientSnapshotExists()
    const snapshot = loadedRestorableSession()

    void (async () => {
      let restoreCompleted = false
      try {
        if (shouldRestoreSessionState(primary, restoreEnabled, snapshot)) {
          capturePreservation = createRestorableSessionPreservation(snapshot!)
          await runWithRestoreDeadline(
            (isRestoreActive, restoreSignal) => restoreAppSession(
              snapshot!,
              isRestoreActive,
              restoreSignal,
              (tabIndex, unavailableSessionIds, restoredTabId) => {
                capturePreservation = markRestoredTab(
                  capturePreservation!,
                  tabIndex,
                  unavailableSessionIds,
                  restoredTabId,
                )
              },
              (mappings) => {
                capturePreservation = mapRestoredWorkspaces(capturePreservation!, mappings)
              },
              (runtimeTabId) => {
                capturePreservation = unmapRestoredWorkspace(capturePreservation!, runtimeTabId)
              },
            ),
            STARTUP_RESTORE_TIMEOUT_MS,
            "Timed out restoring the saved app session",
          )
          restoreCompleted = true
        }
      } catch (error) {
        log.error("Failed to restore app session", error)
      } finally {
        if (disposed) return
        setCaptureAllowed(shouldEnableSessionCapture(snapshotExisted, restoreCompleted))
        releaseAppSessionRestoreGate()
        setStartupFinished(true)
      }
    })()

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
      })
        .then((unlisten) => {
          if (nativeHooksDisposed) {
            unlisten()
          } else {
            stopTauriFlushListener = unlisten
          }
        })
        .catch((error) => log.error("Failed to listen for native client-state flush requests", error))
      void listen<{ generation: number }>("client-state:navigation-flush-requested", (event) => {
        void flushCurrentState()
          .then(() => acknowledgeNativeClientStateNavigationFlush(event.payload.generation))
          .catch((error) => log.error("Failed to flush client state for native navigation", error))
      })
        .then((unlisten) => {
          if (nativeHooksDisposed) {
            unlisten()
          } else {
            stopTauriNavigationFlushListener = unlisten
          }
        })
        .catch((error) => log.error("Failed to listen for native client-state navigation requests", error))
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
    releaseAppSessionRestoreGate()
  })
}
