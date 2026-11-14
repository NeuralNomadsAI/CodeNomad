import { batch, createEffect, onCleanup, onMount, untrack } from "solid-js"
import { getLogger } from "../logger"
import { isWebHost } from "../runtime-env"
import { backendIdOf, LOCAL_BACKEND_ID } from "../backend-identity"
import { captureState, useAppSessionCapture, type AppSessionCaptureController } from "./use-app-session-capture"
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
  activeAppTabId, appTabs, appTabOrderRevision, appTabSelectionRevision, attachInstanceTab, getInstanceAppTabId,
  getSidecarAppTabId, selectAppTab, setAppTabOrder,
} from "../../stores/app-tabs"
import {
  createInstance, closeWorkspace, releaseRestoreCreatedInstance, instances,
  waitForInitialWorkspaceLoad, waitForInstanceInitialSessionHydration,
} from "../../stores/instances"
import { openSidecarTab, SidecarNotFoundError } from "../../stores/sidecars"
import {
  hydrateRestoredWorkspaceState, seedRestoredWorkspaceState,
} from "../../stores/app-session-workspace-hydration"
import { runWithSerializedCommits } from "../../stores/app-session-restore-queue"
import { shouldWaitForSavedSessionList } from "../../stores/app-session-restore-readiness"
import { waitForSettledPrerequisite } from "../trailing-resync"
import { HttpResponseError } from "../retryable-file-search"
import { registerOpenCodeRestoreRecovery } from "../../stores/opencode-setup"
import { backendRegistry } from "../../stores/remote-backends"
import { preferences, preferencesForBackend } from "../../stores/preferences"
import { addRemoteRestoreTab, remoteRestoreTabs, removeRemoteRestoreTab } from "../../stores/remote-restore-tabs"
import { replaceRestoredAppTab } from "../../stores/app-tabs"
import { onInstanceLifecycleAuthority, publishInstanceLifecycleAuthority } from "../../stores/instance-lifecycle-authority"
import { generateUUID } from "../client-identity"
import { detachInstanceTabMembership } from "../../stores/app-tab-membership"
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
function createRestoreContext(snapshot: RestorableSessionState, signal: AbortSignal, capture: AppSessionCaptureController, onUpdateRequired: () => void) {
  const orderRevision = appTabOrderRevision()
  const selectionRevision = appTabSelectionRevision()
  let ownedActiveTabId: string | null = null
  return {
    snapshot, signal, capture, onUpdateRequired,
    deferredWorkspaces: new Map<number, () => boolean>(),
    attemptedRemoteCreates: new Set<number>(),
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
function hasLocalRestoredTab(capture: AppSessionCaptureController, index: number): boolean {
  const tabId = capture.restoredTabIds()[index]
  return Boolean(tabId && appTabs().some(tab => tab.id === tabId && tab.kind !== "remote-restore"))
}
const waitForWorkspaceMountAdoption = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function reconcileRestoredWorkspaces({ snapshot, capture }: RestoreContext) {
  const tabs = appTabs()
  const bindings = capture.restoredTabIds().map(id => {
    const tab = tabs.find(tab => tab.id === id)
    return tab?.kind === "instance" ? tab.instance.id : tab?.kind === "remote-restore" ? tab.instanceId : undefined
  })
  const reserved = new Set(tabs.flatMap(tab => tab.kind === "instance" ? [tab.instance.id]
    : tab.kind === "remote-restore" && tab.instanceId ? [tab.instanceId] : []))
  const live = [...instances().values()].map(instance => ({
    id: instance.id, folderPath: instance.folder, status: instance.status, backendId: instance.backendId,
  }))
  return reconcileWorkspaceTabs(snapshot.tabs.map(tab => tab.kind === "workspace"
    ? { kind: tab.kind, folderPath: tab.folder, occurrence: tab.occurrence, backendId: tab.backendId }
    : { kind: tab.kind }), live).map(match => {
      const bound = live.find(instance => instance.id === bindings[match.tabIndex]
        && instance.status !== "stopped" && instance.status !== "error")
      // Inventory positions can compact after a refusal. A tab's binding owns
      // its drafts even when another occurrence now occupies its saved position.
      return { ...match, existingWorkspaceId: bound?.id
        ?? (match.existingWorkspaceId && !reserved.has(match.existingWorkspaceId) ? match.existingWorkspaceId : null) }
    })
}
async function restoreTabs(context: RestoreContext, retryIndexes?: ReadonlyMap<number, () => boolean>): Promise<void> {
  const { snapshot, signal, capture } = context
  const sidecars = retryIndexes ? [] : snapshot.tabs.map((tab, index) => tab.kind === "sidecar" ? restoreSidecar(tab, index) : undefined)
  let localInventoryReady = true
  try {
    await runAbortable(async (operationSignal) => {
      await waitForInitialWorkspaceLoad(operationSignal)
      if (operationSignal.aborted) throw getAbortReason(operationSignal)
    }, { timeoutMs: INITIAL_LOAD_TIMEOUT_MS, message: "Timed out loading initial workspaces", signal })
  } catch (error) {
    log.error("Failed to load workspaces before restoring app session", error)
    if (preferences().multiBackend !== true || !snapshot.tabs.some(tab => tab.kind === "workspace" && backendIdOf(tab) !== LOCAL_BACKEND_ID)) {
      return Promise.all(sidecars).then(() => undefined)
    }
    localInventoryReady = false
  }
  if (signal.aborted) return Promise.all(sidecars).then(() => undefined)
  const matches = reconcileRestoredWorkspaces(context)
    .filter(match => !retryIndexes || (retryIndexes.get(match.tabIndex)?.() && !hasLocalRestoredTab(capture, match.tabIndex)))
    .filter(match => { const tab = snapshot.tabs[match.tabIndex]; return localInventoryReady || tab.kind === "workspace" && backendIdOf(tab) !== LOCAL_BACKEND_ID })
  const existing = matches.filter(({ existingWorkspaceId }) => existingWorkspaceId)
  const missing = matches.filter(({ existingWorkspaceId }) => !existingWorkspaceId)
  batch(() => {
    existing.forEach(({ tabIndex, existingWorkspaceId }) => {
      const tab = snapshot.tabs[tabIndex]
      if (tab?.kind === "workspace") seedRestoredWorkspaceState(existingWorkspaceId!, tab)
      capture.recordRestoredTab(tabIndex, getInstanceAppTabId(existingWorkspaceId!))
      attachInstanceTab(existingWorkspaceId!, { source: "restore" })
    })
    context.applyOrder()
    const requestedId = capture.restoredTabIds()[snapshot.activeTabIndex]
    if (requestedId && hasLocalRestoredTab(capture, snapshot.activeTabIndex)) context.selectActive(requestedId, true)
    else if (existing[0]) context.selectActive(getInstanceAppTabId(existing[0].existingWorkspaceId!), false)
  })
  const restoreWorkspace = async (
    match: (typeof matches)[number],
    waitForCreateCommit?: Promise<void>,
    finishCreateCommit?: () => void,
  ) => {
    if (signal.aborted) return
    const tab = snapshot.tabs[match.tabIndex]
    if (!tab || tab.kind !== "workspace") return
    const canCommitCreation = retryIndexes?.get(match.tabIndex) ?? capture.createRestoredTabCommitGuard(match.tabIndex)
    if (!canCommitCreation()) return
    let workspaceOpened = false
    try {
      const binding = await runAbortable(async (operationSignal) => {
        const existingId = match.existingWorkspaceId
        const backendId = backendIdOf(tab)
        const remote = backendId !== LOCAL_BACKEND_ID
        const backend = remote ? await backendRegistry.ensure(backendId) : undefined
        if (remote && (!backend || backendRegistry.state(backendId) !== "compatible")) return null
        if (!canCommitCreation() || operationSignal.aborted) return null
        const admittedId = remote ? reconcileRestoredWorkspaces(context)
          .find(candidate => candidate.tabIndex === match.tabIndex)?.existingWorkspaceId : undefined
        const reusableId = existingId ?? admittedId
        if (remote && !reusableId && context.attemptedRemoteCreates.has(match.tabIndex)) return null
        const create = () => createInstance(tab.folder, tab.projectName, {
          ...(backend ? { backend } : {}),
          signal: operationSignal,
          waitForCreateCommit: waitForCreateCommit ? () => waitForCreateCommit : undefined,
          shouldCreateCommit: id => canCommitCreation() && (!hasLocalRestoredTab(capture, match.tabIndex)
            || capture.restoredTabIds()[match.tabIndex] === getInstanceAppTabId(id)),
          onBeforeCreateCommit: (id) => seedRestoredWorkspaceState(id, tab),
          onCreateCommit: (id) => {
            if (!remote || canCommitCreation()) capture.recordRestoredTab(match.tabIndex, getInstanceAppTabId(id))
            else void closeWorkspace(id).catch(() => {})
          },
        })
        if (remote && !reusableId) context.attemptedRemoteCreates.add(match.tabIndex)
        const creation = reusableId || isWebHost() && !remote ? null : await create()
        if (creation && finishCreateCommit) await waitForWorkspaceMountAdoption()
        finishCreateCommit?.()
        if (remote && !canCommitCreation()) return null
        const id = reusableId ?? creation?.instanceId ?? null
        if (!id) return null
        const tabId = getInstanceAppTabId(id)
        // Project selection belongs to the restored tab binding, not to the
        // slower conversation hydration (which can also settle in capture).
        batch(() => {
          const placeholder = remoteRestoreTabs().find(value => value.snapshot === tab)
          if (remote) replaceRestoredAppTab(placeholder?.id ?? "", tabId, () => {
            seedRestoredWorkspaceState(id, tab)
            capture.recordRestoredTab(match.tabIndex, tabId)
            attachInstanceTab(id, { source: "restore" })
            if (placeholder) removeRemoteRestoreTab(placeholder.id)
          })
          else attachInstanceTab(id, { source: "restore" })
          context.applyOrder()
          // Do not let automatic fallback masquerade as user selection between
          // attaching a recovered tab and restoring the saved active project.
          if (capture.restoredTabIds()[match.tabIndex] === tabId) context.selectActive(tabId, match.tabIndex === snapshot.activeTabIndex)
        })
        return { id, tabId, requestId: creation?.requestId }
      }, {
        timeoutMs: match.existingWorkspaceId ? OPERATION_TIMEOUT_MS : CREATE_TIMEOUT_MS,
        message: `Timed out restoring workspace ${tab.folder}`, signal,
      })
      if (!binding) return
      workspaceOpened = true
      context.attemptedRemoteCreates.delete(match.tabIndex)
      const { id, tabId, requestId } = binding
      const isCurrentBinding = () => capture.hasRestoredTabBinding(match.tabIndex, tabId)
      if (!isCurrentBinding()) return
      // Once its tab is bound, a usable workspace survives transient session
      // errors/timeouts. Creation rollback no longer owns this project.
      if (requestId) void releaseRestoreCreatedInstance(id, requestId).catch((error) => {
        log.warn("Failed to release restored workspace creation ownership", { instanceId: id, error })
      })
      await runAbortable(async (operationSignal) => {
          if (!isCurrentBinding()) return
          // Restore the exact saved session before the potentially expensive
          // all-worktree list walk. Only wait for that authoritative list when
          // direct session hydration could not resolve the saved selection.
          let unavailable = await hydrateRestoredWorkspaceState(id, tab, operationSignal, isCurrentBinding)
          if (shouldWaitForSavedSessionList(tab.activeParentSessionId, tab.activeSessionId, unavailable)) {
            await runAbortable(
              () => waitForSettledPrerequisite(waitForInstanceInitialSessionHydration(id)),
              { signal: operationSignal },
            )
            if (!isCurrentBinding()) return
            unavailable = await hydrateRestoredWorkspaceState(id, tab, operationSignal, isCurrentBinding)
          }
          if (operationSignal.aborted) throw getAbortReason(operationSignal)
          if (!unavailable || !isCurrentBinding()) return
          capture.settleRestoredTab(match.tabIndex, tabId, tabId, unavailable)
      }, {
        timeoutMs: OPERATION_TIMEOUT_MS,
        message: `Timed out restoring sessions for ${tab.folder}`, signal,
      })
    } catch (error) {
      if (error instanceof HttpResponseError && error.status >= 400 && error.status < 500
        && error.status !== 408 && error.status !== 429) context.attemptedRemoteCreates.delete(match.tabIndex)
      // Only a definitive runtime refusal before a tab was bound is retryable.
      // Timeouts, lost replies and later hydration failures are never replayed.
      if (backendIdOf(tab) === LOCAL_BACKEND_ID && !signal.aborted && !workspaceOpened && !hasLocalRestoredTab(capture, match.tabIndex)
        && error instanceof HttpResponseError && error.status === 426 && error.message === "opencode_update_required") {
        context.deferredWorkspaces.set(match.tabIndex, canCommitCreation)
        context.onUpdateRequired()
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
    [...missing].sort((a, b) => Number(b.tabIndex === snapshot.activeTabIndex) - Number(a.tabIndex === snapshot.activeTabIndex) || a.tabIndex - b.tabIndex),
    (match, waitForCommit, finishCommit) => restoreWorkspace(match, waitForCommit, finishCommit),
  )
  await Promise.all([...existing.map((match) => restoreWorkspace(match)), restoreMissing(), ...sidecars])
}
export function useAppSessionRestore(): void {
  const capture = useAppSessionCapture()
  const controller = new AbortController()
  let disposed = false
  let context: RestoreContext | undefined
  let initialRestore = Promise.resolve()
  let recovering: Promise<void> | undefined
  let unregisterRecovery = () => {}
  const remoteRecoveries = new Map<string, Promise<void>>()
  let startupComplete = false
  const retryRemote = (backendId: string): Promise<void> => {
    const pending = remoteRecoveries.get(backendId)
    if (pending) return pending
    const flight = (async () => {
      await initialRestore
      if (!context || disposed || !clientStateIsPrimary() || preferences().multiBackend !== true) return
      const backend = await backendRegistry.ensure(backendId)
      if (!backend) return
      await backendRegistry.retryWorkspaces(backendId)
      const indexes = new Map(context.snapshot.tabs.flatMap((tab, index) => {
        const placeholder = remoteRestoreTabs().find(value => value.snapshot === tab)
        if (!placeholder || tab.kind !== "workspace" || backendIdOf(tab) !== backendId) return []
        const current = capture.createRestoredTabCommitGuard(index)
        return [[index, () => current() && remoteRestoreTabs().includes(placeholder)] as const]
      }))
      await restoreTabs({ ...context, signal: controller.signal }, indexes)
    })().finally(() => { if (remoteRecoveries.get(backendId) === flight) remoteRecoveries.delete(backendId) })
    remoteRecoveries.set(backendId, flight)
    return flight
  }
  const addPlaceholder = (tab: Extract<RestorableSessionState["tabs"][number], { kind: "workspace" }>, index: number, id = `remote-restore:${generateUUID()}`, instanceId?: string) => {
    capture.recordRestoredTab(index, id)
    addRemoteRestoreTab({ id, kind: "remote-restore", snapshot: tab, instanceId,
      retry: () => retryRemote(backendIdOf(tab)),
      remove() {
        const binding = capture.restoredTabIds()[index]
        const workspaceId = binding?.startsWith("instance:") ? binding.slice("instance:".length) : instanceId
        removeRemoteRestoreTab(id)
        capture.removeRestoredTab(index)
        if (workspaceId && instances().has(workspaceId)) void closeWorkspace(workspaceId).catch(() => {})
      },
    })
    return id
  }
  const stopLifecycle = onInstanceLifecycleAuthority(event => {
    if (!startupComplete || event.type !== "unavailable" || backendIdOf(event) === LOCAL_BACKEND_ID
      || preferences().multiBackend !== true || !appTabs().some(tab => tab.id === getInstanceAppTabId(event.instanceId))) return
    const captured = captureState(new Map())
    const index = captured.tabIds.indexOf(getInstanceAppTabId(event.instanceId))
    const tab = captured.state.tabs[index]
    if (tab?.kind !== "workspace") return
    batch(() => {
      if (!context) {
        capture.start(captured.state)
        captured.tabIds.forEach((id, index) => capture.recordRestoredTab(index, id))
        context = createRestoreContext(captured.state, controller.signal, capture, offerRecovery)
      }
      const sourceIndex = capture.preserveRemotePlaceholder(captured.tabIds[index], tab)
      if (sourceIndex < 0) return
      context.snapshot.tabs[sourceIndex] = tab
      const id = `remote-restore:${generateUUID()}`
      replaceRestoredAppTab(captured.tabIds[index], id, () => {
        addPlaceholder(tab, sourceIndex, id, event.instanceId)
        detachInstanceTabMembership(event.instanceId)
      })
    })
    // Inventory publication owns reconciliation; only explicit Retry recreates projects.
  })
  createEffect(() => {
    if (preferences().multiBackend !== true) return
    const unavailable = appTabs().filter(tab => tab.kind === "instance" && backendIdOf(tab.instance) !== LOCAL_BACKEND_ID
      && ["unreachable", "unauthorized", "refused"].includes(backendRegistry.state(backendIdOf(tab.instance))))
    untrack(() => {
      if (!startupComplete) return
      for (const tab of unavailable) if (tab.kind === "instance") {
        const captured = captureState(new Map())
        const saved = captured.state.tabs[captured.tabIds.indexOf(tab.id)]
        if (saved?.kind !== "workspace") continue
        publishInstanceLifecycleAuthority({ type: "unavailable", instanceId: tab.instance.id, folder: saved.folder,
          occurrence: saved.occurrence ?? 0, backendId: saved.backendId })
      }
    })
  })
  const canRecover = () => !disposed && clientStateIsPrimary() && restorePreviousStateEnabled() && Boolean(loadedRestorableSession())
  const resumeRestoration = (): Promise<void> => {
    // A new explicit Continue may consume a fresh refusal while a sibling is
    // still recovering. Process that request after the current pass, not as a
    // join that would silently lose the consumed continuation.
    if (recovering) return recovering.then(resumeRestoration)
    return recovering = (async () => {
      // Collect all concurrent refusals, even if setup finishes during startup.
      await initialRestore
      // Late refusals from that pass may have re-registered this continuation
      // after setup consumed it. Drain them before a retry can offer new work.
      unregisterRecovery()
      if (!context || !canRecover()) return
      const retryIndexes = new Map([...context.deferredWorkspaces]
        .filter(([index, current]) => current() && !hasLocalRestoredTab(capture, index))
        .map(([index, current]) => [index, () => canRecover() && current()] as const))
      context.deferredWorkspaces.clear()
      if (!retryIndexes.size) return
      await runAbortable(async signal => {
        await restoreTabs({ ...context!, signal }, retryIndexes)
        if (!signal.aborted) context!.applyOrder()
      }, { signal: controller.signal, timeoutMs: startupTimeout(context.snapshot) })
    })().catch(error => {
      if (!disposed) log.error("Failed to resume saved workspaces after OpenCode setup", error)
    }).finally(() => { recovering = undefined })
  }
  const offerRecovery = () => {
    unregisterRecovery()
    unregisterRecovery = registerOpenCodeRestoreRecovery(resumeRestoration)
  }
  onMount(() => {
    const snapshot = loadedRestorableSession()
    const shouldRestore = shouldRestoreSessionState(clientStateIsPrimary(), restorePreviousStateEnabled(), snapshot)
    setShowFolderSelection(snapshot?.homeActive === true)
    initialRestore = (async () => {
      try {
        await capture.ready
        if (!shouldRestore) return capture.start()
        if (snapshot!.tabs.some(tab => tab.kind === "workspace" && backendIdOf(tab) !== LOCAL_BACKEND_ID)) {
          await preferencesForBackend(LOCAL_BACKEND_ID).ensureLoaded().catch(error => log.warn("Failed to load restore backend policy", error))
        }
        capture.start(snapshot!)
        await runAbortable(async (signal) => {
          context = createRestoreContext(snapshot!, signal, capture, offerRecovery)
          if (preferences().multiBackend === true) batch(() => {
            snapshot!.tabs.forEach((tab, index) => {
              if (tab.kind !== "workspace" || backendIdOf(tab) === LOCAL_BACKEND_ID) return
              addPlaceholder(tab, index)
            })
            context!.applyOrder()
            const requested = capture.restoredTabIds()[snapshot!.activeTabIndex]
            if (requested) context!.selectActive(requested, true)
          })
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
        startupComplete = true
        if (!disposed) releaseAppSessionRestoreGate()
      }
    })()
  })
  onCleanup(() => {
    disposed = true
    unregisterRecovery()
    stopLifecycle()
    for (const tab of remoteRestoreTabs()) removeRemoteRestoreTab(tab.id)
    controller.abort(new Error("App session restore disposed"))
    releaseAppSessionRestoreGate()
  })
}
