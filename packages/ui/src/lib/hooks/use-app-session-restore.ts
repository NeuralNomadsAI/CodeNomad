import { batch, createEffect, onCleanup, onMount, untrack } from "solid-js"
import { getLogger } from "../logger"
import { isWebHost } from "../runtime-env"
import { backendIdOf, LOCAL_BACKEND_ID } from "../backend-identity"
import { backends } from "../backend-client"
import { backendEvents } from "../server-events"
import { captureState, useAppSessionCapture, type AppSessionCaptureController, type WorkspaceReleaseResults } from "./use-app-session-capture"
import {
  clientStateIsPrimary, loadedRestorableSession, restorePreviousStateEnabled,
  type RestorableSessionState,
} from "../../stores/client-state"
import { releaseAppSessionRestoreGate } from "../../stores/app-session-restore-gate"
import {
  matchesRestoredServer, reconcileWorkspaceTabs, resolveRestoredActiveTabId, shouldRestoreSessionState,
} from "../../stores/app-session-reconciliation"
import { getAbortReason, runAbortable } from "../../stores/app-session-restore-timeout"
import {
  activeAppTabId, appendBlankTab, appTabs, appTabOrderRevision, appTabSelectionRevision, attachInstanceTab, getInstanceAppTabId,
  getSidecarAppTabId, selectAppTab, setAppTabOrder,
} from "../../stores/app-tabs"
import {
  createInstance, closeWorkspace, releaseRestoreCreatedInstance, instances, pendingWorkspaceCommit, refreshWorkspaceList,
  waitForInitialWorkspaceLoad, waitForInstanceInitialSessionHydration, workspaceOpeningSignal,
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
import { applyReloadTabSelection } from "../native/reload-tab-selection"
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
function createRestoreContext(snapshot: RestorableSessionState, signal: AbortSignal, capture: AppSessionCaptureController,
  onUpdateRequired: () => void, releases?: WorkspaceReleaseResults) {
  const orderRevision = appTabOrderRevision()
  const selectionRevision = appTabSelectionRevision()
  let ownedActiveTabId: string | null = null
  return {
    snapshot, signal, capture, onUpdateRequired, releases,
    recoveryPasses: new Map<string, Promise<void>>(),
    reusableReleasedIds: new Set<string>(),
    deferredWorkspaces: new Map<number, () => boolean>(),
    attemptedCreates: new Set<number>(),
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

function refreshRestoreInventory(backendId: string, signal: AbortSignal, releaseCheck = false) {
  return runAbortable(async operationSignal => {
    if (backendId === LOCAL_BACKEND_ID) {
      if (!await refreshWorkspaceList(backendId, undefined, operationSignal)) throw new Error("Primary inventory superseded")
    } else if (releaseCheck && backendRegistry.state(backendId) === "compatible") {
      // An optional reuse probe must not mark a compatible backend unavailable on failure.
      const backend = backends.get(backendId)
      const attachment = backendEvents.signal(backendId)
      if (!backend || !attachment || !await refreshWorkspaceList(backendId, backend.api,
        AbortSignal.any([attachment, operationSignal]))) throw new Error("Remote inventory superseded")
    } else {
      if (!await backendRegistry.ensure(backendId)) throw new Error("Remote inventory unavailable")
      operationSignal.throwIfAborted()
      await backendRegistry.retryWorkspaces(backendId, { invalidate: releaseCheck })
    }
  }, { signal, timeoutMs: INITIAL_LOAD_TIMEOUT_MS, message: "Timed out refreshing workspace inventory" })
}

async function checkReleaseResults(context: RestoreContext, backendId: string, signal: AbortSignal): Promise<boolean> {
  if (!context.releases?.size) return false
  const results = await runAbortable(() => Promise.all(context.snapshot.tabs.flatMap(tab => {
    if (tab.kind !== "workspace" || backendIdOf(tab) !== backendId || !tab.workspaceId) return []
    const result = context.releases?.get(tab.workspaceId)
    return result ? [result.then(outcome => outcome === "unconfirmed" ? tab.workspaceId : undefined)] : []
  })), { signal, timeoutMs: OPERATION_TIMEOUT_MS })
  // A failed DELETE might have taken effect; only a subsequent inventory can confirm presence.
  const unconfirmed = results.filter((id): id is string => !!id)
  if (!unconfirmed.length) return false
  for (const id of unconfirmed) context.reusableReleasedIds.delete(id)
  try {
    await refreshRestoreInventory(backendId, signal, true)
    for (const id of unconfirmed) context.reusableReleasedIds.add(id)
  } catch (error) {
    if (!signal.aborted) log.warn("Could not confirm released workspace records; restoring without reuse", error)
  }
  return true
}
function hasLocalRestoredTab(capture: AppSessionCaptureController, index: number): boolean {
  const tabId = capture.restoredTabIds()[index]
  return Boolean(tabId && appTabs().some(tab => tab.id === tabId && tab.kind !== "remote-restore"))
}
const waitForWorkspaceMountAdoption = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function reconcileRestoredWorkspaces({ snapshot, capture, reusableReleasedIds }: RestoreContext) {
  const tabs = appTabs()
  const bindings = capture.restoredTabIds().map(id => {
    const tab = tabs.find(tab => tab.id === id)
    return tab?.kind === "instance" ? tab.instance.id : tab?.kind === "remote-restore" ? tab.instanceId : undefined
  })
  const reserved = new Set(tabs.flatMap(tab => tab.kind === "instance" ? [tab.instance.id]
    : tab.kind === "remote-restore" && tab.instanceId && matchesRestoredServer(tab.snapshot, instances().get(tab.instanceId)?.serverId)
      ? [tab.instanceId] : []))
  const live = [...instances().values()].map(instance => ({
    id: instance.id, folderPath: instance.folder, status: instance.status, backendId: instance.backendId, serverId: instance.serverId,
  }))
  return reconcileWorkspaceTabs(snapshot.tabs.map(tab => tab.kind === "workspace"
    ? { ...tab, workspaceId: isWebHost() || tab.workspaceId && reusableReleasedIds.has(tab.workspaceId) ? tab.workspaceId : undefined, folderPath: tab.folder }
    : { kind: tab.kind }), live).map(match => {
      const saved = snapshot.tabs[match.tabIndex]
      const bound = live.find(instance => saved.kind === "workspace" && matchesRestoredServer(saved, instance.serverId)
        && instance.id === bindings[match.tabIndex]
        && instance.status !== "stopped" && instance.status !== "error")
      // Inventory positions can compact after a refusal. A tab's binding owns
      // its drafts even when another occurrence now occupies its saved position.
      return { ...match, existingWorkspaceId: bound?.id
        ?? (match.existingWorkspaceId && !reserved.has(match.existingWorkspaceId) ? match.existingWorkspaceId : null) }
    })
}
async function restoreTabs(context: RestoreContext, retryIndexes?: ReadonlyMap<number, () => boolean>,
  primaryInventoryReady = false): Promise<void> {
  const { snapshot, signal, capture } = context
  const openingSignal = workspaceOpeningSignal(signal)
  const sidecars = retryIndexes ? [] : snapshot.tabs.map((tab, index) => tab.kind === "sidecar" ? restoreSidecar(tab, index) : undefined)
  let localInventoryReady = true
  try {
    if (!primaryInventoryReady) await runAbortable(async (operationSignal) => {
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
  for (let pending; (pending = pendingWorkspaceCommit(openingSignal));) await pending
  const matches = reconcileRestoredWorkspaces(context)
    .filter(match => !retryIndexes || (retryIndexes.get(match.tabIndex)?.() && !hasLocalRestoredTab(capture, match.tabIndex)))
    .filter(match => { const tab = snapshot.tabs[match.tabIndex]; return localInventoryReady || tab.kind === "workspace" && backendIdOf(tab) !== LOCAL_BACKEND_ID })
  const existing = matches.filter(({ existingWorkspaceId }) => existingWorkspaceId)
  const missing = matches.filter(({ existingWorkspaceId }) => !existingWorkspaceId)
  batch(() => {
    existing.forEach(({ tabIndex, existingWorkspaceId }) => {
      const tab = snapshot.tabs[tabIndex]
      if (tab?.kind !== "workspace" || backendIdOf(tab) !== LOCAL_BACKEND_ID) return
      seedRestoredWorkspaceState(existingWorkspaceId!, tab)
      capture.recordRestoredTab(tabIndex, getInstanceAppTabId(existingWorkspaceId!))
      attachInstanceTab(existingWorkspaceId!, { source: "restore" })
    })
    context.applyOrder()
    const requestedId = capture.restoredTabIds()[snapshot.activeTabIndex]
    if (requestedId && hasLocalRestoredTab(capture, snapshot.activeTabIndex)) context.selectActive(requestedId, true)
    else {
      const first = existing.find(({ tabIndex }) => hasLocalRestoredTab(capture, tabIndex))
      if (first) context.selectActive(getInstanceAppTabId(first.existingWorkspaceId!), false)
    }
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
        const retainOccurrence = remote || isWebHost() || remoteRestoreTabs().some(placeholder => placeholder.snapshot === tab)
        const backend = remote ? await backendRegistry.ensure(backendId) : undefined
        if (remote && (!backend || backendRegistry.state(backendId) !== "compatible"
          || !matchesRestoredServer(tab, backendRegistry.serverId(backendId)))) return null
        if (!canCommitCreation() || operationSignal.aborted) return null
        const admittedId = remote ? reconcileRestoredWorkspaces(context)
          .find(candidate => candidate.tabIndex === match.tabIndex)?.existingWorkspaceId : undefined
        const reusableId = remote ? admittedId : existingId
        if (retainOccurrence && !reusableId && context.attemptedCreates.has(match.tabIndex)) return null
        const create = () => createInstance(tab.folder, tab.projectName, {
          ...(backend ? { backend } : {}),
          signal: operationSignal,
          waitForCreateCommit: waitForCreateCommit ? () => waitForCreateCommit : undefined,
          shouldCreateCommit: id => canCommitCreation() && (!hasLocalRestoredTab(capture, match.tabIndex)
            || capture.restoredTabIds()[match.tabIndex] === getInstanceAppTabId(id)),
          onBeforeCreateCommit: (id) => seedRestoredWorkspaceState(id, tab),
          onCreateCommit: (id) => {
            if (!retainOccurrence || canCommitCreation()) capture.recordRestoredTab(match.tabIndex, getInstanceAppTabId(id))
            else void closeWorkspace(id).catch(() => {})
          },
        })
        if (retainOccurrence && !reusableId) context.attemptedCreates.add(match.tabIndex)
        const creation = reusableId ? null : await create()
        if (creation && finishCreateCommit) await waitForWorkspaceMountAdoption()
        finishCreateCommit?.()
        for (let pending; (pending = pendingWorkspaceCommit(operationSignal));) await pending
        if (retainOccurrence && !canCommitCreation()) return null
        const id = reusableId ?? creation?.instanceId ?? null
        if (!id) return null
        const tabId = getInstanceAppTabId(id)
        // Project selection belongs to the restored tab binding, not to the
        // slower conversation hydration (which can also settle in capture).
        batch(() => {
          const placeholder = remoteRestoreTabs().find(value => value.snapshot === tab)
          if (retainOccurrence) replaceRestoredAppTab(placeholder?.id ?? "", tabId, () => {
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
        message: `Timed out restoring workspace ${tab.folder}`, signal: openingSignal,
      })
      if (!binding) return
      workspaceOpened = true
      context.attemptedCreates.delete(match.tabIndex)
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
        && error.status !== 408 && error.status !== 499) context.attemptedCreates.delete(match.tabIndex)
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
  const capture = useAppSessionCapture(recoverReleasedTabs)
  const controller = new AbortController()
  let disposed = false
  let context: RestoreContext | undefined
  let initialRestore = Promise.resolve()
  let recovering: Promise<void> | undefined
  let unregisterRecovery = () => {}
  const workspaceRecoveries = new Map<string, Promise<void>>()
  let startupComplete = false
  const retryWorkspaces = (backendId: string): Promise<void> => {
    const pending = workspaceRecoveries.get(backendId)
    if (pending) return pending
    const flight = (async () => {
      await initialRestore
      const current = context
      if (!current || disposed) return
      await current.recoveryPasses.get(backendId)
      if (context !== current || disposed) return
      if (backendId !== LOCAL_BACKEND_ID && preferences().multiBackend !== true) return
      const indexes = new Map(current.snapshot.tabs.flatMap((tab, index) => {
        const placeholder = remoteRestoreTabs().find(value => value.snapshot === tab)
        if (!placeholder || tab.kind !== "workspace" || backendIdOf(tab) !== backendId) return []
        const current = capture.createRestoredTabCommitGuard(index)
        return [[index, () => current() && remoteRestoreTabs().includes(placeholder)] as const]
      }))
      if (!indexes.size) return
      if (!await checkReleaseResults(current, backendId, controller.signal)) await refreshRestoreInventory(backendId, controller.signal)
      if (context === current) await restoreTabs({ ...current, signal: controller.signal }, indexes, backendId === LOCAL_BACKEND_ID)
    })().finally(() => workspaceRecoveries.delete(backendId))
    workspaceRecoveries.set(backendId, flight)
    return flight
  }
  const addPlaceholder = (tab: Extract<RestorableSessionState["tabs"][number], { kind: "workspace" }>, index: number, id = `remote-restore:${generateUUID()}`, instanceId?: string) => {
    capture.recordRestoredTab(index, id)
    addRemoteRestoreTab({ id, kind: "remote-restore", snapshot: tab, instanceId,
      retry: () => retryWorkspaces(backendIdOf(tab)),
      remove({ retainWorkspace = false } = {}) {
        const binding = capture.restoredTabIds()[index]
        const workspaceId = binding?.startsWith("instance:") ? binding.slice("instance:".length) : instanceId
        removeRemoteRestoreTab(id)
        capture.removeRestoredTab(index)
        const instance = workspaceId ? instances().get(workspaceId) : undefined
        if (!retainWorkspace && instance && matchesRestoredServer(tab, instance.serverId)
          && matchesRestoredServer(tab, backendRegistry.serverId(backendIdOf(tab)))) void closeWorkspace(instance.id).catch(() => {})
      },
    })
    return id
  }
  function recoverReleasedTabs(snapshot: RestorableSessionState, releases: WorkspaceReleaseResults) {
    if (disposed || !snapshot.tabs.some(tab => tab.kind === "workspace")) return
    const live = appTabs()
    const recovery = createRestoreContext(snapshot, controller.signal, capture, offerRecovery, releases)
    const indexes = new Map<string, Map<number, () => boolean>>()
    const sidecars = live.filter(tab => tab.kind === "sidecar")
    const blanks = live.filter(tab => tab.kind === "blank")
    batch(() => {
      capture.start(snapshot)
      context = recovery
      for (const tab of live) {
        if (tab.kind === "instance") detachInstanceTabMembership(tab.instance.id)
        else if (tab.kind === "remote-restore") removeRemoteRestoreTab(tab.id)
      }
      snapshot.tabs.forEach((tab, index) => {
        if (tab.kind === "sidecar") {
          const match = sidecars.findIndex(candidate => candidate.sidecarTab.sidecarId === tab.sidecarId)
          capture.recordRestoredTab(index, match < 0 ? null : sidecars.splice(match, 1)[0].id)
          return
        }
        if (tab.kind === "blank") {
          capture.recordRestoredTab(index, blanks.shift()?.id ?? appendBlankTab())
          return
        }
        addPlaceholder(tab, index)
        const backendId = backendIdOf(tab)
        const group = indexes.get(backendId) ?? new Map<number, () => boolean>()
        group.set(index, capture.createRestoredTabCommitGuard(index))
        indexes.set(backendId, group)
      })
      recovery.applyOrder()
      recovery.selectActive(capture.restoredTabIds()[snapshot.activeTabIndex] ?? null, true)
    })
    // Use the same attempt/Retry path as startup, without reopening live SideCars.
    for (const [backendId, group] of indexes) {
      const pass = initialRestore.then(async () => {
        if (context !== recovery || disposed) return
        try {
          const checked = await checkReleaseResults(recovery, backendId, controller.signal)
          if (context === recovery) await restoreTabs(recovery, group, checked && backendId === LOCAL_BACKEND_ID)
        } catch (error) {
          if (!disposed) log.error("Failed to restore projects after cancelled shutdown", error)
        }
      })
      recovery.recoveryPasses.set(backendId, pass)
    }
  }
  const stopLifecycle = onInstanceLifecycleAuthority(event => {
    if (event.type !== "unavailable" || backendIdOf(event) === LOCAL_BACKEND_ID
      || preferences().multiBackend !== true) return
    const runtimeTabId = getInstanceAppTabId(event.instanceId)
    if (!appTabs().some(tab => tab.id === runtimeTabId)) return
    batch(() => {
      let retained = capture.getUnavailableWorkspace(runtimeTabId)
      if (!context) {
        if (!startupComplete) return
        const captured = captureState(new Map())
        const index = captured.tabIds.indexOf(runtimeTabId)
        const snapshot = captured.state.tabs[index]
        if (snapshot?.kind !== "workspace") return
        capture.start(captured.state)
        captured.tabIds.forEach((id, index) => capture.recordRestoredTab(index, id))
        context = createRestoreContext(captured.state, controller.signal, capture, offerRecovery)
        retained = { index, snapshot }
      }
      if (!retained) return
      context.snapshot.tabs[retained.index] = retained.snapshot
      const id = `remote-restore:${generateUUID()}`
      replaceRestoredAppTab(runtimeTabId, id, () => {
        addPlaceholder(retained.snapshot, retained.index, id, event.instanceId)
        detachInstanceTabMembership(event.instanceId)
      })
    })
  })
  createEffect(() => {
    if (preferences().multiBackend !== true) return
    const unavailable = appTabs().filter(tab => tab.kind === "instance" && backendIdOf(tab.instance) !== LOCAL_BACKEND_ID
      && ["idle", "unreachable", "unauthorized", "refused"].includes(backendRegistry.state(backendIdOf(tab.instance))))
    untrack(() => {
      if (!startupComplete) return
      for (const tab of unavailable) if (tab.kind === "instance") {
        const captured = captureState(new Map())
        const saved = captured.state.tabs[captured.tabIds.indexOf(tab.id)]
        if (saved?.kind !== "workspace") continue
        publishInstanceLifecycleAuthority({ type: "unavailable", instanceId: tab.instance.id, folder: saved.folder,
          occurrence: saved.occurrence ?? 0, backendId: saved.backendId, serverId: saved.serverId })
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
      await context?.recoveryPasses.get(LOCAL_BACKEND_ID)
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
    const snapshot = applyReloadTabSelection(loadedRestorableSession())
    const shouldRestore = shouldRestoreSessionState(clientStateIsPrimary(), restorePreviousStateEnabled(), snapshot)
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
          batch(() => {
            snapshot!.tabs.forEach((tab, index) => {
              if (tab.kind === "blank") {
                capture.recordRestoredTab(index, appendBlankTab())
              } else if (tab.kind === "workspace"
                && (backendIdOf(tab) === LOCAL_BACKEND_ID ? isWebHost() : preferences().multiBackend === true)) {
                addPlaceholder(tab, index)
              }
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
        if (!disposed) {
          releaseAppSessionRestoreGate()
          capture.commitRestore()
        }
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
