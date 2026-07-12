import { onCleanup, onMount } from "solid-js"
import { getLogger } from "../logger"
import { isWebHost } from "../runtime-env"
import { useAppSessionCapture } from "./use-app-session-capture"
import {
  clientStateIsPrimary,
  loadedClientSnapshotExists,
  loadedRestorableSession,
  restorePreviousStateEnabled,
  type RestorableSessionState,
  type RestorableWorkspaceTabState,
} from "../../stores/client-state"
import { releaseAppSessionRestoreGate } from "../../stores/app-session-restore-gate"
import {
  getUnavailableRestoredSessionIds,
  normalizeWorkspacePath,
  reconcileWorkspaceTabs,
  resolveRestoredActiveTabId,
  resolveRestoredSessionSelection,
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
import type { RestoredWorkspaceMapping } from "../../stores/app-session-snapshot-merge"
import {
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
  waitForInstanceInitialSessionHydration,
} from "../../stores/instances"
import { openSidecarTab, SidecarNotFoundError } from "../../stores/sidecars"
import {
  getSessions,
  hydrateActiveSessionSelection,
  hydrateSessionExpansion,
  hydrateSessionIdleMarkers,
  hydrateSessionGenerationRecovery,
} from "../../stores/sessions"
import { messageStoreBus, type MessageScrollSnapshotSeed } from "../../stores/message-v2/bus"
import { hydrateWorkspacePromptState } from "../../stores/app-session-prompt-hydration"

const log = getLogger("actions")
const MESSAGE_SCROLL_SCOPE = "message-stream"
const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"
// The startup gate is held for at most 60 seconds. Initial discovery gets 15
// seconds, while each combined workspace or SideCar operation gets 30 seconds.
const INITIAL_WORKSPACE_LOAD_TIMEOUT_MS = 15_000
const RESTORE_OPERATION_TIMEOUT_MS = 30_000
const MINIMUM_STARTUP_RESTORE_TIMEOUT_MS = 60_000
const STARTUP_RESTORE_GRACE_MS = 5_000

function getStartupRestoreTimeoutMs(snapshot: RestorableSessionState): number {
  const sequentialOperationBudget = INITIAL_WORKSPACE_LOAD_TIMEOUT_MS
    + snapshot.tabs.length * RESTORE_OPERATION_TIMEOUT_MS
    + STARTUP_RESTORE_GRACE_MS
  return Math.max(MINIMUM_STARTUP_RESTORE_TIMEOUT_MS, sequentialOperationBudget)
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
    expandedSessionIds: snapshot.expandedSessionIds,
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
  hydrateSessionExpansion(instanceId, snapshot.expandedSessionIds)

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
            hydrate: waitForInstanceInitialSessionHydration,
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
  const capture = useAppSessionCapture()
  let disposed = false

  onMount(() => {
    const primary = clientStateIsPrimary()
    const restoreEnabled = restorePreviousStateEnabled()
    const snapshotExisted = loadedClientSnapshotExists()
    const snapshot = loadedRestorableSession()

    void (async () => {
      let restoreCompleted = false
      try {
        if (shouldRestoreSessionState(primary, restoreEnabled, snapshot)) {
          capture.beginRestore(snapshot!)
          await runWithRestoreDeadline(
            (isRestoreActive, restoreSignal) => restoreAppSession(
              snapshot!,
              isRestoreActive,
              restoreSignal,
              capture.markRestoredTab,
              capture.mapWorkspaces,
              capture.unmapWorkspace,
            ),
            getStartupRestoreTimeoutMs(snapshot!),
            "Timed out restoring the saved app session",
          )
          restoreCompleted = true
        }
      } catch (error) {
        log.error("Failed to restore app session", error)
      } finally {
        if (disposed) return
        capture.prepareCapture(snapshotExisted, restoreCompleted)
        releaseAppSessionRestoreGate()
        capture.startCapture()
      }
    })()
  })

  onCleanup(() => {
    disposed = true
    releaseAppSessionRestoreGate()
  })
}
