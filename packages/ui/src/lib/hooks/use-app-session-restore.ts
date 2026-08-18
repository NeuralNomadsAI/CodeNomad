import { onCleanup, onMount } from "solid-js"
import { getLogger } from "../logger"
import { isWebHost } from "../runtime-env"
import { useAppSessionCapture, type AppSessionCaptureController } from "./use-app-session-capture"
import {
  clientStateIsPrimary, loadedRestorableSession, restorePreviousStateEnabled,
  type RestorableSessionState,
} from "../../stores/client-state"
import { releaseAppSessionRestoreGate } from "../../stores/app-session-restore-gate"
import { setShowFolderSelection } from "../../stores/ui"
import {
  reconcileWorkspaceTabs, resolveRestoredActiveTabId, shouldRestoreSessionState,
} from "../../stores/app-session-reconciliation"
import { getAbortReason, runAbortable } from "../../stores/app-session-restore-timeout"
import {
  activeAppTabId, appTabOrderRevision, appTabSelectionRevision, getInstanceAppTabId,
  getSidecarAppTabId, selectAppTab, setAppTabOrder,
} from "../../stores/app-tabs"
import {
  cancelRestoreCreationRequest, createInstance, disposeRestoreCreatedInstance, releaseRestoreCreatedInstance, instances,
  waitForInitialWorkspaceLoad, waitForInstanceInitialSessionHydration,
} from "../../stores/instances"
import { openSidecarTab, SidecarNotFoundError } from "../../stores/sidecars"
import {
  hydrateRestoredWorkspaceState, seedRestoredWorkspaceScrollSnapshots,
} from "../../stores/app-session-workspace-hydration"
import { runWithSerializedCommits } from "../../stores/app-session-restore-queue"
import { shouldWaitForSavedSessionList } from "../../stores/app-session-restore-readiness"
import { waitForSettledPrerequisite } from "../trailing-resync"
const log = getLogger("actions")
const INITIAL_LOAD_TIMEOUT_MS = 15_000
const OPERATION_TIMEOUT_MS = 30_000
const CREATE_TIMEOUT_MS = OPERATION_TIMEOUT_MS * 2
const CLEANUP_TIMEOUT_MS = 5_000
const MINIMUM_STARTUP_TIMEOUT_MS = 60_000
function startupTimeout(snapshot: RestorableSessionState): number {
  const workspaceCount = snapshot.tabs.filter((tab) => tab.kind === "workspace").length
  return Math.max(MINIMUM_STARTUP_TIMEOUT_MS,
    INITIAL_LOAD_TIMEOUT_MS + Math.max(1, workspaceCount) * (CREATE_TIMEOUT_MS + CLEANUP_TIMEOUT_MS) + 5_000)
}
async function disposeFailedRestoreWorkspace(instanceId: string): Promise<void> {
  const cleanup = disposeRestoreCreatedInstance(instanceId)
  try {
    await runAbortable(() => cleanup, {
      timeoutMs: CLEANUP_TIMEOUT_MS,
      message: `Timed out cleaning up restored workspace ${instanceId}`,
    })
  } catch (error) {
    log.warn("Restore workspace cleanup continues in the background", { instanceId, error })
  }
}
function createRestoreContext(snapshot: RestorableSessionState, signal: AbortSignal, capture: AppSessionCaptureController) {
  const orderRevision = appTabOrderRevision()
  const selectionRevision = appTabSelectionRevision()
  let ownedActiveTabId: string | null = null
  return {
    snapshot, signal, capture,
    selectActive(tabId: string | null, requested: boolean) {
      if (appTabSelectionRevision() !== selectionRevision) return
      const current = activeAppTabId()
      if (!requested && (current || ownedActiveTabId)) return
      selectAppTab(tabId, { source: "restore" })
      ownedActiveTabId = tabId
    },
    applyOrder() {
      if (appTabOrderRevision() === orderRevision) {
        setAppTabOrder(capture.restoredTabIds().filter((id): id is string => Boolean(id)))
      }
    },
  }
}
type RestoreContext = ReturnType<typeof createRestoreContext>
const waitForWorkspaceMountAdoption = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function restoreTabs(context: RestoreContext): Promise<void> {
  const { snapshot, signal, capture } = context
  const sidecars = snapshot.tabs.map((tab, index) => tab.kind === "sidecar" ? restoreSidecar(tab, index) : undefined)
  try {
    await runAbortable(async (operationSignal) => {
      await waitForInitialWorkspaceLoad(operationSignal)
      if (operationSignal.aborted) throw getAbortReason(operationSignal)
    }, { timeoutMs: INITIAL_LOAD_TIMEOUT_MS, message: "Timed out loading initial workspaces", signal })
  } catch (error) {
    log.error("Failed to load workspaces before restoring app session", error)
    return Promise.all(sidecars).then(() => undefined)
  }
  if (signal.aborted) return Promise.all(sidecars).then(() => undefined)
  const matches = reconcileWorkspaceTabs(snapshot.tabs.map((tab) => tab.kind === "workspace"
    ? { kind: tab.kind, folderPath: tab.folder, occurrence: tab.occurrence }
     : { kind: tab.kind }), Array.from(instances().values())
       .map(({ id, folder, status }) => ({ id, folderPath: folder, status })))
  const existing = matches.filter(({ existingWorkspaceId }) => existingWorkspaceId)
  const missing = matches.filter(({ existingWorkspaceId }) => !existingWorkspaceId)
  existing.forEach(({ tabIndex, existingWorkspaceId }) => {
    const tab = snapshot.tabs[tabIndex]
    if (tab?.kind === "workspace") seedRestoredWorkspaceScrollSnapshots(existingWorkspaceId!, tab)
    capture.recordRestoredTab(tabIndex, getInstanceAppTabId(existingWorkspaceId!))
  })
  const claimedIds = new Set(existing.map(({ existingWorkspaceId }) => existingWorkspaceId!))
  context.applyOrder()
  const restoredIds = capture.restoredTabIds()
  const provisionalId = resolveRestoredActiveTabId(restoredIds, snapshot.activeTabIndex)
  if (provisionalId) context.selectActive(provisionalId, provisionalId === restoredIds[snapshot.activeTabIndex])
  const restoreWorkspace = async (
    match: (typeof matches)[number],
    waitForCreateCommit?: Promise<void>,
    finishCreateCommit?: () => void,
  ) => {
    if (signal.aborted) return
    const tab = snapshot.tabs[match.tabIndex]
    if (!tab || tab.kind !== "workspace") return
    let createdId: string | null = null
    const canCommitCreation = capture.createRestoredTabCommitGuard(match.tabIndex)
    try {
      const instanceId = await runAbortable(async (operationSignal) => {
        const existingId = match.existingWorkspaceId
        const create = (forceNew: boolean) => createInstance(tab.folder, tab.projectName, {
          activate: false, signal: operationSignal, forceNew,
          waitForCreateCommit: waitForCreateCommit ? () => waitForCreateCommit : undefined,
          shouldCreateCommit: canCommitCreation,
          onBeforeCreateCommit: (id) => seedRestoredWorkspaceScrollSnapshots(id, tab),
          onCreateCommit: (id) => capture.recordRestoredTab(match.tabIndex, getInstanceAppTabId(id)),
        })
        let creation = existingId || isWebHost() ? null : await create(match.descriptor.occurrence > 0)
        if (creation && claimedIds.has(creation.instanceId)) {
          if (operationSignal.aborted) throw getAbortReason(operationSignal)
          if (creation.requestId) await cancelRestoreCreationRequest(creation.instanceId, creation.requestId)
          creation = await create(true)
        }
        if (creation && finishCreateCommit) await waitForWorkspaceMountAdoption()
        finishCreateCommit?.()
        const id = existingId ?? creation?.instanceId ?? null
        if (!id) return null
        claimedIds.add(id)
        const created = creation?.reused === false
        if (created) createdId = id
        try {
          const tabId = getInstanceAppTabId(id)
          const isCurrentBinding = () => capture.hasRestoredTabBinding(match.tabIndex, tabId)
          if (!isCurrentBinding()) return id
          // Restore the exact saved session before the potentially expensive
          // all-worktree list walk. Only wait for that authoritative list when
          // direct session hydration could not resolve the saved selection.
          let unavailable = await hydrateRestoredWorkspaceState(id, tab, operationSignal, isCurrentBinding)
          if (shouldWaitForSavedSessionList(tab.activeParentSessionId, tab.activeSessionId, unavailable)) {
            await runAbortable(
              () => waitForSettledPrerequisite(waitForInstanceInitialSessionHydration(id)),
              { signal: operationSignal },
            )
            if (!isCurrentBinding()) return id
            unavailable = await hydrateRestoredWorkspaceState(id, tab, operationSignal, isCurrentBinding)
          }
          if (operationSignal.aborted) throw getAbortReason(operationSignal)
          if (!unavailable || !isCurrentBinding()) return id
          if (creation?.requestId) await releaseRestoreCreatedInstance(id, creation.requestId)
          if (operationSignal.aborted) throw getAbortReason(operationSignal)
          if (capture.settleRestoredTab(match.tabIndex, tabId, tabId, unavailable)
            && match.tabIndex === snapshot.activeTabIndex) context.selectActive(tabId, true)
        } catch (error) {
          if (!existingId && creation?.requestId) {
            capture.settleRestoredTab(match.tabIndex, getInstanceAppTabId(id), null)
            if (created) createdId = null
            await disposeFailedRestoreWorkspace(id)
          }
          throw error
        }
        return id
      }, {
        timeoutMs: match.existingWorkspaceId ? OPERATION_TIMEOUT_MS : CREATE_TIMEOUT_MS,
        message: `Timed out restoring workspace ${tab.folder}`, signal,
      })
      if (!signal.aborted && !instanceId) {
        log.info("Skipped automatic remote workspace launch while restoring browser state", { folder: tab.folder })
      }
    } catch (error) {
      if (createdId) {
        capture.settleRestoredTab(match.tabIndex, getInstanceAppTabId(createdId), null)
        await disposeFailedRestoreWorkspace(createdId)
      }
      if (!signal.aborted) log.warn("Skipped workspace while restoring app session", { folder: tab.folder, error })
    }
  }
  async function restoreSidecar(tab: Extract<RestorableSessionState["tabs"][number], { kind: "sidecar" }>,
    index: number) {
    if (signal.aborted) return
    try {
      const opened = await runAbortable((operationSignal) => openSidecarTab(tab.sidecarId, {
        activate: false, propagateLoadErrors: true, signal: operationSignal,
      }), { timeoutMs: OPERATION_TIMEOUT_MS, message: `Timed out restoring SideCar ${tab.sidecarId}`, signal })
      if (signal.aborted) return
      const tabId = getSidecarAppTabId(opened.token)
      capture.recordRestoredTab(index, tabId, new Set())
      if (index === snapshot.activeTabIndex) context.selectActive(tabId, true)
    } catch (error) {
      if (error instanceof SidecarNotFoundError) capture.recordRestoredTab(index, null, new Set())
      if (!signal.aborted) log.warn("Skipped SideCar while restoring app session", { sidecarId: tab.sidecarId, error })
    }
  }
  const restoreMissing = () => runWithSerializedCommits(
    [...missing].sort((a, b) => a.tabIndex - b.tabIndex),
    (match, waitForCommit, finishCommit) => restoreWorkspace(match, waitForCommit, finishCommit),
  )
  await Promise.all([...existing.map((match) => restoreWorkspace(match)), restoreMissing(), ...sidecars])
}
export function useAppSessionRestore(): void {
  const capture = useAppSessionCapture()
  const controller = new AbortController()
  let disposed = false
  onMount(() => {
    const snapshot = loadedRestorableSession()
    const shouldRestore = shouldRestoreSessionState(clientStateIsPrimary(), restorePreviousStateEnabled(), snapshot)
    setShowFolderSelection(snapshot?.homeActive === true)
    void (async () => {
      try {
        await capture.ready
        if (!shouldRestore) return capture.start()
        capture.start(snapshot!)
        await runAbortable(async (signal) => {
          const context = createRestoreContext(snapshot!, signal, capture)
          await restoreTabs(context)
          if (signal.aborted) return
          context.applyOrder()
          if (!activeAppTabId()) {
            context.selectActive(resolveRestoredActiveTabId(capture.restoredTabIds(), snapshot!.activeTabIndex), true)
          }
        }, {
          timeoutMs: startupTimeout(snapshot!), message: "Timed out restoring the saved app session", signal: controller.signal,
        })
      } catch (error) {
        log.error("Failed to restore app session", error)
      } finally {
        if (!disposed) releaseAppSessionRestoreGate()
      }
    })()
  })
  onCleanup(() => {
    disposed = true
    controller.abort(new Error("App session restore disposed"))
    releaseAppSessionRestoreGate()
  })
}
