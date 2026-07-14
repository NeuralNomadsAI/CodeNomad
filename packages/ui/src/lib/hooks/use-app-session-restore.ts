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
  runWithRestoreDeadline,
  withRestoreTimeout,
  type RestoreActivity,
} from "../../stores/app-session-restore-timeout"
import { completeAbortableRestoreHydration } from "../../stores/abortable-restore-creation"
import type { RestoredWorkspaceMapping } from "../../stores/app-session-snapshot-merge"
import {
  activeAppTabId,
  appTabOrderRevision,
  appTabSelectionRevision,
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
  hasAuthoritativeSessionSelection,
  hydrateActiveSessionSelection,
  hydrateSessionIdleMarkers,
  hydrateSessionGenerationRecovery,
} from "../../stores/sessions"
import { messageStoreBus, type MessageScrollSnapshotSeed } from "../../stores/message-v2/bus"
import { hydrateWorkspacePromptState } from "../../stores/app-session-prompt-hydration"

const log = getLogger("actions")
const MESSAGE_SCROLL_SCOPE = "message-stream"
const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"
// Independent tab operations share one concurrent startup window.
const INITIAL_WORKSPACE_LOAD_TIMEOUT_MS = 15_000
const RESTORE_OPERATION_TIMEOUT_MS = 30_000
const RESTORE_CREATE_WITH_ALIAS_RETRY_TIMEOUT_MS = RESTORE_OPERATION_TIMEOUT_MS * 2
const MINIMUM_STARTUP_RESTORE_TIMEOUT_MS = 60_000
const STARTUP_RESTORE_GRACE_MS = 5_000

function getStartupRestoreTimeoutMs(snapshot: RestorableSessionState): number {
  const workspaceGroupSizes = new Map<string, number>()
  let largestSequentialGroup = 1
  for (const tab of snapshot.tabs) {
    if (tab.kind !== "workspace") continue
    const path = normalizeWorkspacePath(tab.folder)
    const size = (workspaceGroupSizes.get(path) ?? 0) + 1
    workspaceGroupSizes.set(path, size)
    largestSequentialGroup = Math.max(largestSequentialGroup, size)
  }
  const concurrentOperationBudget = INITIAL_WORKSPACE_LOAD_TIMEOUT_MS
    + largestSequentialGroup * RESTORE_CREATE_WITH_ALIAS_RETRY_TIMEOUT_MS
    + STARTUP_RESTORE_GRACE_MS
  return Math.max(MINIMUM_STARTUP_RESTORE_TIMEOUT_MS, concurrentOperationBudget)
}

function restoreWorkspaceState(instanceId: string, snapshot: RestorableWorkspaceTabState): Set<string> {
  const availableSessions = getSessions(instanceId)
  const validSessionIds = new Set(availableSessions.map((session) => session.id))
  const unavailableSessionIds = getUnavailableRestoredSessionIds(availableSessions, {
    activeParentSessionId: snapshot.activeParentSessionId,
    activeSessionId: snapshot.activeSessionId,
    draftSessionIds: Object.keys(snapshot.drafts),
    attachmentSessionIds: Object.keys(snapshot.attachments),
    scrollSessionIds: Object.keys(snapshot.scrollSnapshots),
    idleMarkerSessionIds: Object.keys(snapshot.unseenIdleSince),
    generationRecoverySessionIds: Object.keys(snapshot.generationRecovery),
  }, [NO_SESSION_DRAFT_SESSION_ID])

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
  if (hasAuthoritativeSessionSelection(instanceId)) {
    return unavailableSessionIds
  }
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
  selectRestoredActive: (tabId: string, requested: boolean) => void,
  applyRestoredOrder: (tabIds: string[]) => void,
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
  for (const match of existingMatches) {
    restoredTabIds[match.tabIndex] = getInstanceAppTabId(match.existingWorkspaceId!)
  }
  const claimedWorkspaceIds = new Set(existingMatches.map((match) => match.existingWorkspaceId!))
  applyRestoredOrder(restoredTabIds.filter((tabId): tabId is string => Boolean(tabId)))
  const provisionalActiveTabId = resolveRestoredActiveTabId(restoredTabIds, snapshot.activeTabIndex)
  if (provisionalActiveTabId) {
    selectRestoredActive(provisionalActiveTabId, provisionalActiveTabId === restoredTabIds[snapshot.activeTabIndex])
  }

  const missingMatchesByPath = new Map<string, typeof missingMatches>()
  for (const match of missingMatches) {
    const path = normalizeWorkspacePath(match.descriptor.folderPath)
    const group = missingMatchesByPath.get(path) ?? []
    group.push(match)
    missingMatchesByPath.set(path, group)
  }
  for (const group of missingMatchesByPath.values()) {
    group.sort((left, right) => left.descriptor.occurrence - right.descriptor.occurrence || left.tabIndex - right.tabIndex)
  }

  const restoreMatch = async (match: (typeof workspaceMatches)[number]): Promise<void> => {
    if (!isRestoreActive()) return
    const tab = snapshot.tabs[match.tabIndex]
    if (!tab || tab.kind !== "workspace") return

    let restoreCreatedId: string | null = null
    try {
      const instanceId = await withRestoreTimeout(async (operationSignal) => {
        const existingId = match.existingWorkspaceId
        const createMissingInstance = (forceNew: boolean) => createInstance(tab.folder, tab.binaryPath, tab.projectName, {
          activate: false,
          signal: operationSignal,
          forceNew,
          onCreateCommit: (createdId) => mapWorkspaces([{
            sourceIndex: match.tabIndex,
            runtimeTabId: getInstanceAppTabId(createdId),
          }]),
        })
        let creationResult = existingId || isWebHost()
          ? null
          : await createMissingInstance(match.descriptor.occurrence > 0)
        if (creationResult && claimedWorkspaceIds.has(creationResult.instanceId)) {
          if (!creationResult.reused && creationResult.requestId) {
            await releaseRestoreCreatedInstance(creationResult.instanceId, creationResult.requestId)
          }
          creationResult = await createMissingInstance(true)
        }
        const id = existingId ?? creationResult?.instanceId ?? null
        if (!id) return null
        claimedWorkspaceIds.add(id)
        const createdByRestore = creationResult?.reused === false
        if (createdByRestore) restoreCreatedId = id

        await completeAbortableRestoreHydration(id, {
          signal: operationSignal,
          hydrate: waitForInstanceInitialSessionHydration,
          commit: async (hydratedId) => {
            const restoredTabId = getInstanceAppTabId(hydratedId)
            if (createdByRestore && creationResult?.requestId) {
              await releaseRestoreCreatedInstance(hydratedId, creationResult.requestId)
            }
            if (operationSignal.aborted) throw getAbortReason(operationSignal)
            restoredTabIds[match.tabIndex] = restoredTabId
            updatePreservation(match.tabIndex, restoreWorkspaceState(hydratedId, tab), restoredTabId)
            if (match.tabIndex === snapshot.activeTabIndex) selectRestoredActive(restoredTabId, true)
          },
          discard: existingId ? undefined : async (discardedId) => {
            unmapWorkspace(getInstanceAppTabId(discardedId))
            if (createdByRestore) await disposeRestoreCreatedInstance(discardedId)
          },
        })
        return id
      }, match.existingWorkspaceId ? RESTORE_OPERATION_TIMEOUT_MS : RESTORE_CREATE_WITH_ALIAS_RETRY_TIMEOUT_MS, `Timed out restoring workspace ${tab.folder}`, restoreSignal)
      if (!isRestoreActive()) return
      if (!instanceId) {
        log.info("Skipped automatic remote workspace launch while restoring browser state", { folder: tab.folder })
        return
      }
    } catch (error) {
      if (restoreCreatedId) {
        unmapWorkspace(getInstanceAppTabId(restoreCreatedId))
        await disposeRestoreCreatedInstance(restoreCreatedId)
      }
      if (!isRestoreActive()) return
      log.warn("Skipped workspace while restoring app session", { folder: tab.folder, error })
    }
  }

  await Promise.all([
    ...existingMatches.map(restoreMatch),
    ...Array.from(missingMatchesByPath.values(), async (group) => {
      for (const match of group) await restoreMatch(match)
    }),
  ])
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
  selectRestoredActive: (tabId: string, requested: boolean) => void,
): Promise<void> {
  await Promise.all(snapshot.tabs.map(async (tab, index) => {
    if (!isRestoreActive()) return
    if (!tab || tab.kind !== "sidecar") return
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
      if (index === snapshot.activeTabIndex) selectRestoredActive(restoredTabIds[index]!, true)
    } catch (error) {
      if (error instanceof SidecarNotFoundError) updatePreservation(index)
      if (!isRestoreActive()) return
      log.warn("Skipped SideCar while restoring app session", { sidecarId: tab.sidecarId, error })
    }
  }))
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
  const restoredTabIds = Array<string | null>(snapshot.tabs.length).fill(null)
  const initialOrderRevision = appTabOrderRevision()
  const initialSelectionRevision = appTabSelectionRevision()
  let restoreOwnedActiveTabId: string | null = null
  const selectRestoredActive = (tabId: string, requested: boolean) => {
    if (appTabSelectionRevision() !== initialSelectionRevision) return
    const current = activeAppTabId()
    if (current && current !== restoreOwnedActiveTabId) return
    if (!requested && restoreOwnedActiveTabId) return
    selectAppTab(tabId, { source: "restore" })
    restoreOwnedActiveTabId = tabId
  }
  const applyRestoredOrder = (tabIds: string[]) => {
    if (appTabOrderRevision() !== initialOrderRevision) return
    setAppTabOrder(tabIds)
  }
  const workspaceRestoration = (async () => {
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
    await restoreWorkspaceTabs(
      snapshot,
      restoredTabIds,
      isRestoreActive,
      restoreSignal,
      updatePreservation,
      mapWorkspaces,
      unmapWorkspace,
      selectRestoredActive,
      applyRestoredOrder,
    )
  })()
  const sidecarRestoration = restoreSidecarTabs(
    snapshot,
    restoredTabIds,
    isRestoreActive,
    restoreSignal,
    updatePreservation,
    selectRestoredActive,
  )
  await Promise.all([workspaceRestoration, sidecarRestoration])
  if (!isRestoreActive()) return

  const restoredOrder = restoredTabIds.filter((tabId): tabId is string => Boolean(tabId))
  applyRestoredOrder(restoredOrder)
  if (!activeAppTabId() && appTabSelectionRevision() === initialSelectionRevision) {
    selectAppTab(resolveRestoredActiveTabId(restoredTabIds, snapshot.activeTabIndex), { source: "restore" })
  }
}

export function useAppSessionRestore(): void {
  const capture = useAppSessionCapture()
  const restoreController = new AbortController()
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
          capture.prepareCapture(snapshotExisted, false)
          capture.startCapture()
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
            restoreController.signal,
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
    restoreController.abort(new Error("App session restore disposed"))
    releaseAppSessionRestoreGate()
  })
}
