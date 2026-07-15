import { onCleanup, onMount } from "solid-js"
import { getLogger } from "../logger"
import { isWebHost } from "../runtime-env"
import { useAppSessionCapture, type AppSessionCaptureController } from "./use-app-session-capture"
import {
  clientStateIsPrimary, loadedRestorableSession, restorePreviousStateEnabled,
  type RestorableSessionState, type RestorableWorkspaceTabState,
} from "../../stores/client-state"
import { releaseAppSessionRestoreGate } from "../../stores/app-session-restore-gate"
import {
  getUnavailableRestoredSessionIds, normalizeWorkspacePath, reconcileWorkspaceTabs,
  resolveRestoredActiveTabId, resolveRestoredSessionSelection, shouldRestoreSessionState,
} from "../../stores/app-session-reconciliation"
import { getAbortReason, runAbortable } from "../../stores/app-session-restore-timeout"
import {
  activeAppTabId, appTabOrderRevision, appTabSelectionRevision, getInstanceAppTabId,
  getSidecarAppTabId, selectAppTab, setAppTabOrder,
} from "../../stores/app-tabs"
import {
  createInstance, disposeRestoreCreatedInstance, releaseRestoreCreatedInstance, instances,
  waitForInitialWorkspaceLoad, waitForInstanceInitialSessionHydration,
} from "../../stores/instances"
import { openSidecarTab, SidecarNotFoundError } from "../../stores/sidecars"
import {
  getSessions, hasAuthoritativeSessionSelection, hydrateActiveSessionSelection,
  hydrateSessionGenerationRecovery, hydrateSessionIdleMarkers,
} from "../../stores/sessions"
import { messageStoreBus, type MessageScrollSnapshotSeed } from "../../stores/message-v2/bus"
import { hydrateWorkspacePromptState } from "../../stores/app-session-prompt-hydration"
const log = getLogger("actions")
const MESSAGE_SCROLL_SCOPE = "message-stream"
const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"
const INITIAL_LOAD_TIMEOUT_MS = 15_000
const OPERATION_TIMEOUT_MS = 30_000
const CREATE_TIMEOUT_MS = OPERATION_TIMEOUT_MS * 2
const MINIMUM_STARTUP_TIMEOUT_MS = 60_000
function startupTimeout(snapshot: RestorableSessionState): number {
  const counts = new Map<string, number>()
  for (const tab of snapshot.tabs) if (tab.kind === "workspace") {
    const path = normalizeWorkspacePath(tab.folder)
    counts.set(path, (counts.get(path) ?? 0) + 1)
  }
  return Math.max(MINIMUM_STARTUP_TIMEOUT_MS,
    INITIAL_LOAD_TIMEOUT_MS + Math.max(1, ...counts.values()) * CREATE_TIMEOUT_MS + 5_000)
}
function restoreWorkspaceState(instanceId: string, snapshot: RestorableWorkspaceTabState): Set<string> {
  const sessions = getSessions(instanceId)
  const validIds = new Set(sessions.map(({ id }) => id))
  const unavailable = getUnavailableRestoredSessionIds(sessions, {
    activeParentSessionId: snapshot.activeParentSessionId, activeSessionId: snapshot.activeSessionId,
    draftSessionIds: Object.keys(snapshot.drafts), attachmentSessionIds: Object.keys(snapshot.attachments),
    scrollSessionIds: Object.keys(snapshot.scrollSnapshots), idleMarkerSessionIds: Object.keys(snapshot.unseenIdleSince),
    generationRecoverySessionIds: Object.keys(snapshot.generationRecovery),
  }, [NO_SESSION_DRAFT_SESSION_ID])
  hydrateWorkspacePromptState(instanceId, snapshot, validIds, NO_SESSION_DRAFT_SESSION_ID)
  hydrateSessionIdleMarkers(instanceId, snapshot.unseenIdleSince)
  hydrateSessionGenerationRecovery(instanceId, snapshot.generationRecovery)
  const scrollSeeds: MessageScrollSnapshotSeed[] = Object.entries(snapshot.scrollSnapshots)
    .filter(([sessionId]) => validIds.has(sessionId))
    .map(([sessionId, scrollSnapshot]) => ({ sessionId, scope: MESSAGE_SCROLL_SCOPE, snapshot: scrollSnapshot }))
  messageStoreBus.seedScrollSnapshots(instanceId, scrollSeeds)
  if (!hasAuthoritativeSessionSelection(instanceId)) {
    const selection = resolveRestoredSessionSelection(sessions, snapshot.activeParentSessionId, snapshot.activeSessionId)
    hydrateActiveSessionSelection(instanceId, selection?.parentSessionId ?? null, selection?.activeSessionId ?? null)
  }
  return unavailable
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
      if ((current && current !== ownedActiveTabId) || (!requested && ownedActiveTabId)) return
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
async function restoreTabs(context: RestoreContext): Promise<void> {
  const { snapshot, signal, capture } = context
  const sidecars = snapshot.tabs.map((tab, index) => tab.kind === "sidecar" ? restoreSidecar(tab, index) : undefined)
  try {
    await runAbortable(async (operationSignal) => {
      await waitForInitialWorkspaceLoad()
      if (operationSignal.aborted) throw getAbortReason(operationSignal)
    }, { timeoutMs: INITIAL_LOAD_TIMEOUT_MS, message: "Timed out loading initial workspaces", signal })
  } catch (error) {
    log.error("Failed to load workspaces before restoring app session", error)
    return Promise.all(sidecars).then(() => undefined)
  }
  if (signal.aborted) return Promise.all(sidecars).then(() => undefined)
  const matches = reconcileWorkspaceTabs(snapshot.tabs.map((tab) => tab.kind === "workspace"
    ? { kind: tab.kind, folderPath: tab.folder, occurrence: tab.occurrence }
    : { kind: tab.kind }), Array.from(instances().values()).map(({ id, folder }) => ({ id, folderPath: folder })))
  const existing = matches.filter(({ existingWorkspaceId }) => existingWorkspaceId)
  const missing = matches.filter(({ existingWorkspaceId }) => !existingWorkspaceId)
  existing.forEach(({ tabIndex, existingWorkspaceId }) =>
    capture.recordRestoredTab(tabIndex, getInstanceAppTabId(existingWorkspaceId!)))
  const claimedIds = new Set(existing.map(({ existingWorkspaceId }) => existingWorkspaceId!))
  context.applyOrder()
  const restoredIds = capture.restoredTabIds()
  const provisionalId = resolveRestoredActiveTabId(restoredIds, snapshot.activeTabIndex)
  if (provisionalId) context.selectActive(provisionalId, provisionalId === restoredIds[snapshot.activeTabIndex])
  const groups = new Map<string, typeof missing>()
  for (const match of missing) {
    const path = normalizeWorkspacePath(match.descriptor.folderPath)
    groups.set(path, [...groups.get(path) ?? [], match])
  }
  for (const group of groups.values()) group.sort((a, b) =>
    a.descriptor.occurrence - b.descriptor.occurrence || a.tabIndex - b.tabIndex)
  const restoreWorkspace = async (match: (typeof matches)[number]) => {
    if (signal.aborted) return
    const tab = snapshot.tabs[match.tabIndex]
    if (!tab || tab.kind !== "workspace") return
    let createdId: string | null = null
    try {
      const instanceId = await runAbortable(async (operationSignal) => {
        const existingId = match.existingWorkspaceId
        const create = (forceNew: boolean) => createInstance(tab.folder, tab.binaryPath, tab.projectName, {
          activate: false, signal: operationSignal, forceNew,
          onCreateCommit: (id) => capture.recordRestoredTab(match.tabIndex, getInstanceAppTabId(id)),
        })
        let creation = existingId || isWebHost() ? null : await create(match.descriptor.occurrence > 0)
        if (creation && claimedIds.has(creation.instanceId)) {
          if (!creation.reused && creation.requestId) await releaseRestoreCreatedInstance(creation.instanceId, creation.requestId)
          creation = await create(true)
        }
        const id = existingId ?? creation?.instanceId ?? null
        if (!id) return null
        claimedIds.add(id)
        const created = creation?.reused === false
        if (created) createdId = id
        try {
          await runAbortable(() => waitForInstanceInitialSessionHydration(id), { signal: operationSignal })
          const tabId = getInstanceAppTabId(id)
          if (created && creation?.requestId) await releaseRestoreCreatedInstance(id, creation.requestId)
          if (operationSignal.aborted) throw getAbortReason(operationSignal)
          capture.recordRestoredTab(match.tabIndex, tabId, restoreWorkspaceState(id, tab))
          if (match.tabIndex === snapshot.activeTabIndex) context.selectActive(tabId, true)
        } catch (error) {
          if (operationSignal.aborted && !existingId) {
            capture.recordRestoredTab(match.tabIndex, null)
            if (created) await disposeRestoreCreatedInstance(id)
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
        capture.recordRestoredTab(match.tabIndex, null)
        await disposeRestoreCreatedInstance(createdId)
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
  await Promise.all([
    ...existing.map(restoreWorkspace),
    ...Array.from(groups.values(), async (group) => { for (const match of group) await restoreWorkspace(match) }),
    ...sidecars,
  ])
}
export function useAppSessionRestore(): void {
  const capture = useAppSessionCapture()
  const controller = new AbortController()
  let disposed = false
  onMount(() => {
    const snapshot = loadedRestorableSession()
    void (async () => {
      try {
        if (!shouldRestoreSessionState(clientStateIsPrimary(), restorePreviousStateEnabled(), snapshot)) return capture.start()
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
