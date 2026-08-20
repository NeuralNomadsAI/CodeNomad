import { createSignal } from "solid-js"
import type { Instance, LogEntry } from "../types/instance"
import type { PermissionReply, PermissionRequest } from "../types/permission"
import { getPermissionSessionId, mergePermissionRequest } from "../types/permission"
import { buildInstanceBaseUrl, sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import type { WorkspaceDescriptor, WorkspaceEventPayload, WorkspaceLogEntry } from "../../../server/src/api-types"
import { ensureInstanceConfigLoaded } from "./instance-config"
import {
  fetchSessions,
  loadMessages,
  fetchAgents,
  fetchProviders,
  getActiveCatalogLocation,
  clearInstanceDraftPrompts,
  clearSessionListRequestState,
  clearSessionCatalogState,
  clearInstanceDeletedSessionAuthority,
  clearInstanceSessionExpansionState,
  clearInstanceSessionSelection,
  resetSessionPagination,
} from "./sessions"
import {
  ensureWorktreesLoaded,
  getWorktrees,
  reloadWorktrees,
} from "./worktrees"
import { getRootClient } from "./opencode-client"
import { buildV2RequestLocations } from "./request-locations"
import { fetchCommands, clearCommands } from "./commands"
import { getInstanceRefreshTargets, type InstanceRefreshTarget } from "./instance-invalidation"
import { ConnectionResyncGate } from "./connection-resync-gate"
import { serverSettings } from "./preferences"
import {
  reconcileSessionPendingState,
  activeSessionId,
  messagesLoaded,
  sessions,
  setSessionPendingForm,
  setSessionPendingPermission,
  invalidateSessionMessageLoad,
} from "./session-state"
import { setHasInstances } from "./ui"
import { messageStoreBus } from "./message-v2/bus"
import { applyOpenCodeDataEvent, destroyOpenCodeData, projectOpenCodeMessages } from "./opencode-data"
import { upsertPermissionV2, removePermissionV2, removeMessageV2 } from "./message-v2/bridge"
import {
  clearRepliedPermissions,
  hasRepliedPermission,
  markPermissionReplied,
  pruneRepliedPermissions,
} from "./permission-replies"
import {
  clearPermissionAutoAcceptForInstance,
  isPermissionAutoAcceptEnabled,
  resolvePermissionAutoAcceptFamilyRoot,
  setPermissionAutoAcceptEnabled,
  setPermissionAutoAcceptFamilyRootResolver,
  togglePermissionAutoAccept,
} from "./permission-auto-accept"
import { clearCacheForInstance } from "../lib/global-cache"
import { getLogger } from "../lib/logger"
import { clearInstanceMetadata } from "./instance-metadata"
import { showWorkspaceLaunchError } from "./launch-errors"
import { showToastNotification } from "../lib/notifications"
import { tGlobal } from "../lib/i18n"
import { loadInstanceMetadata } from "../lib/hooks/use-instance-metadata"
import {
  addFormToQueue,
  clearFormQueue as clearStoredFormQueue,
  getFormQueue,
  formRequestOptions,
  removeFormFromQueue,
  type FormAnswer,
  type FormWithLocation,
} from "./forms"
import { invalidateFilesystemCaches } from "../lib/filesystem-events"
import { detachInstanceTabMembership, requestInstanceTabClose } from "./app-tab-membership"
import { waitForLatestWorkspaceLoadResult } from "./workspace-load-readiness"
import { clearInstanceAttachments } from "./attachments"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { getUnavailableWorkspaceIds } from "./app-session-reconciliation"
import { getAbortReason } from "./app-session-restore-timeout"
import { AbortCreatedWorkspaceCleanup } from "./abort-created-workspace-cleanup"
import { TrailingResyncCoordinator, waitForSettledPrerequisite } from "../lib/trailing-resync"
import { retryWithBackoff } from "../lib/retry-utils"
import { cancelRestoreCreation } from "./restore-creation-cancellation"
import {
  RestoreWorkspaceCommitGates, type RestoreWorkspaceCommitGate, type RestoreWorkspaceTerminal,
} from "./restore-workspace-commit-gates"
import { WorkspaceListReconciliationFence } from "./workspace-list-reconciliation-fence"

const log = getLogger("api")

setPermissionAutoAcceptFamilyRootResolver((instanceId, sessionId) => {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return sessionId
  return resolvePermissionAutoAcceptFamilyRoot(sessionId, (id) => instanceSessions.get(id))
})

// Server is authoritative for Yolo state; mirror toggles (incl. from other
// clients) arriving over the CodeNomad server event stream into the local
// projection so the badge/switch stay in sync.
serverEvents.on("yolo.stateChanged", (event) => {
  if (event.type !== "yolo.stateChanged") return
  const { instanceId, sessionId, enabled } = event
  if (typeof instanceId !== "string" || typeof sessionId !== "string" || typeof enabled !== "boolean") return
  log.info(`[SSE] Yolo state changed: ${instanceId}:${sessionId} -> ${enabled}`)
  setPermissionAutoAcceptEnabled(instanceId, sessionId, enabled)
})

// When the server auto-accepts a permission, clean up the UI queue immediately
// instead of waiting for the OpenCode permission.replied SSE event (which may
// be delayed or missed on a flaky connection). This preserves the #424
// invariant: auto-accept cleanup happens at the queue level, not tied to
// external event timing.
serverEvents.on("yolo.autoAccepted", (event) => {
  if (event.type !== "yolo.autoAccepted") return
  const { instanceId, permissionId } = event
  if (typeof instanceId !== "string" || typeof permissionId !== "string") return
  markPermissionReplied(instanceId, permissionId)
  removePermissionFromQueue(instanceId, permissionId)
  removePermissionV2(instanceId, permissionId)
})

const [instances, setInstances] = createSignal<Map<string, Instance>>(new Map())

const [activeInstanceId, setActiveInstanceId] = createSignal<string | null>(null)
const [instanceLogs, setInstanceLogs] = createSignal<Map<string, LogEntry[]>>(new Map())
const [logStreamingState, setLogStreamingState] = createSignal<Map<string, boolean>>(new Map())

// Interruption queues per instance
const [permissionQueues, setPermissionQueues] = createSignal<Map<string, PermissionRequest[]>>(new Map())
const [activePermissionId, setActivePermissionId] = createSignal<Map<string, string | null>>(new Map())

class InterruptionRegistry<T extends { id: string }> {
  private readonly enqueuedAt = new Map<string, number>()
  private readonly sessionCounts = new Map<string, Map<string, number>>()

  ensureEnqueuedAt(request: T): number {
    const existing = this.enqueuedAt.get(request.id)
    if (existing) return existing
    const now = Date.now()
    this.enqueuedAt.set(request.id, now)
    return now
  }

  enqueuedAtFor(requestId: string): number {
    return this.enqueuedAt.get(requestId) ?? Date.now()
  }

  remove(_instanceId: string, requestId: string): void {
    this.enqueuedAt.delete(requestId)
  }

  increment(instanceId: string, sessionId: string): void {
    const counts = this.sessionCounts.get(instanceId) ?? new Map<string, number>()
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1)
    this.sessionCounts.set(instanceId, counts)
  }

  decrement(instanceId: string, sessionId: string): number {
    const counts = this.sessionCounts.get(instanceId)
    const next = Math.max(0, (counts?.get(sessionId) ?? 0) - 1)
    if (next) counts?.set(sessionId, next)
    else counts?.delete(sessionId)
    if (counts?.size === 0) this.sessionCounts.delete(instanceId)
    return next
  }

  sessionIds(instanceId: string): IterableIterator<string> {
    return this.sessionCounts.get(instanceId)?.keys() ?? new Map<string, number>().keys()
  }

  clear(instanceId: string, requests: readonly T[], clearPending: (sessionId: string) => void): void {
    requests.forEach(({ id }) => this.enqueuedAt.delete(id))
    for (const sessionId of this.sessionCounts.get(instanceId)?.keys() ?? []) clearPending(sessionId)
    this.sessionCounts.delete(instanceId)
  }
}

const permissionRegistry = new InterruptionRegistry<PermissionRequest>()
const formRegistry = new InterruptionRegistry<FormWithLocation>()

type InterruptionKind = "permission" | "form"

type ActiveInterruption = { kind: InterruptionKind; id: string } | null

const [activeInterruption, setActiveInterruption] = createSignal<Map<string, ActiveInterruption>>(new Map())

function syncHasInstancesFlag() {
  const readyExists = Array.from(instances().values()).some((instance) => instance.status === "ready")
  setHasInstances(readyExists)
}

interface DisconnectedInstanceInfo {
  id: string
  folder: string
  reason: string
}
const [disconnectedInstance, setDisconnectedInstance] = createSignal<DisconnectedInstanceInfo | null>(null)

const MAX_LOG_ENTRIES = 1000

const pendingDisposeRequests = new Map<string, Promise<boolean>>()
const pendingRehydrations = new Map<string, Promise<void>>()
const initialHydrations = new Map<string, Promise<void>>()
const initialSessionHydrations = new Map<string, Promise<void>>()
const initialWorkspaceMetadataHydrations = new Map<string, Promise<void>>()
const pendingRequestSyncEpochs = new Map<string, number>()
const pendingPermissionMutationEpochs = new Map<string, number>()
const pendingFormMutationEpochs = new Map<string, number>()
const pendingRequestSyncGenerations = new Map<string, number>()
const pendingRequestSyncs = new Map<string, {
  generation: number
  token: { cancelled: boolean }
  promise: Promise<void>
}>()
const pendingRequestSyncSuperseded = new Error("Pending request sync was superseded")
let nextPendingRequestSyncGeneration = 0

function bumpEpoch(epochs: Map<string, number>, instanceId: string): void {
  epochs.set(instanceId, (epochs.get(instanceId) ?? 0) + 1)
}

function invalidatePendingRequestSync(instanceId: string): void {
  bumpEpoch(pendingRequestSyncEpochs, instanceId)
  bumpEpoch(pendingPermissionMutationEpochs, instanceId)
  bumpEpoch(pendingFormMutationEpochs, instanceId)
}
type RestoreWorkspaceDescriptor = WorkspaceDescriptor & { reused?: boolean }
const workspaceListReconciliationFence = new WorkspaceListReconciliationFence()

const restoreCreatedWorkspaceCleanup = new AbortCreatedWorkspaceCleanup<RestoreWorkspaceDescriptor>({
  discardWorkspace: (workspace) => {
    if (!workspace.requestId) return Promise.reject(new Error(`Restore workspace ${workspace.id} has no creation request`))
    return serverApi.cancelWorkspaceCreation(workspace.requestId)
  },
  restoreWorkspace: (workspace) => {
    workspaceListReconciliationFence.markMutation(workspace.id)
    upsertWorkspace(workspace)
  },
  onPermanentFailure: (workspace, error) => {
    log.error("Failed to cancel restore workspace ownership; restored it to the UI", {
      workspaceId: workspace.id,
      error,
    })
  },
})
let restoreCreationRequestSequence = 0
const restoreCreationCommitGates = new RestoreWorkspaceCommitGates<RestoreWorkspaceDescriptor>()

const connectionResyncs = new TrailingResyncCoordinator(
  async (instanceId) => {
    await waitForSettledPrerequisite(initialHydrations.get(instanceId))
    const instance = instances().get(instanceId)
    if (!instance?.client || instance.status !== "ready") return
    await Promise.all([
      fetchSessions(instanceId, { reset: true }),
      syncPendingRequests(instanceId),
      refreshVolatileInstanceState(instanceId),
    ])
    const loadedMessages = messagesLoaded().get(instanceId) ?? new Set<string>()
    for (const sessionId of loadedMessages) invalidateSessionMessageLoad(instanceId, sessionId)
    const activeId = activeSessionId().get(instanceId)
    if (activeId && loadedMessages.has(activeId)) await loadMessages(instanceId, activeId, { force: true })
    reconcilePendingSessionIndicators(instanceId)
  },
  (instanceId, error) => {
    log.warn("Failed to resync sessions after instance connection", { instanceId, error })
  },
)
const connectionResyncGate = new ConnectionResyncGate()

function resyncConnectedInstance(instanceId: string): void {
  void connectionResyncs.request(instanceId)
}

const allInstanceRefreshTargets: readonly InstanceRefreshTarget[] = ["agents", "providers", "commands", "metadata", "filesystem"]
const volatileInstanceRefreshes = new Map<string, { promise: Promise<void>; pending: Set<InstanceRefreshTarget> }>()

function refreshVolatileInstanceState(
  instanceId: string,
  targets: readonly InstanceRefreshTarget[] = allInstanceRefreshTargets,
): Promise<void> {
  const existing = volatileInstanceRefreshes.get(instanceId)
  if (existing) {
    for (const target of targets) existing.pending.add(target)
    return existing.promise
  }
  const instance = instances().get(instanceId)
  if (!instance?.client || instance.status !== "ready") return Promise.resolve()
  const client = instance.client

  const state = { promise: Promise.resolve(), pending: new Set(targets) }
  state.promise = (async () => {
    do {
      const current = new Set(state.pending)
      state.pending.clear()
      if (current.has("filesystem")) invalidateFilesystemCaches(instanceId)
      const requests: Promise<unknown>[] = []
      const location = getActiveCatalogLocation(instanceId)
      if (current.has("agents")) requests.push(fetchAgents(instanceId, location, true))
      if (current.has("providers")) requests.push(fetchProviders(instanceId, location, true))
      if (current.has("commands")) requests.push(fetchCommands(instanceId, client, getActiveCatalogLocation(instanceId)))
      if (current.has("metadata")) requests.push(loadInstanceMetadata(instance, { force: true }))
      await Promise.all(requests)
    } while (state.pending.size)
  })().finally(() => {
    if (volatileInstanceRefreshes.get(instanceId) === state) volatileInstanceRefreshes.delete(instanceId)
  })
  volatileInstanceRefreshes.set(instanceId, state)
  return state.promise
}

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus") return
  const shouldResync = connectionResyncGate.observe(event.instanceId, event.status, event.reason)
  if (event.status !== "connected") return
  if (disconnectedInstance()?.id === event.instanceId) {
    setDisconnectedInstance(null)
  }
  if (shouldResync) resyncConnectedInstance(event.instanceId)
})

function createRestoreCreationRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `restore-${globalThis.crypto.randomUUID()}`
  }
  restoreCreationRequestSequence += 1
  return `restore-${Date.now().toString(36)}-${restoreCreationRequestSequence.toString(36)}`
}

type InstanceReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

const instanceReadyWaiters = new Map<string, Set<InstanceReadyWaiter>>()

function settleInstanceReadyWaiters(instanceId: string, error?: Error): void {
  const waiters = instanceReadyWaiters.get(instanceId)
  if (!waiters) return
  instanceReadyWaiters.delete(instanceId)
  for (const waiter of waiters) {
    if (error) {
      waiter.reject(error)
    } else {
      waiter.resolve()
    }
  }
}

function reconcilePendingSessionIndicators(instanceId: string): void {
  reconcileSessionPendingState(
    instanceId,
    new Set(permissionRegistry.sessionIds(instanceId)),
    new Set(formRegistry.sessionIds(instanceId)),
  )
}

function workspaceDescriptorToInstance(descriptor: WorkspaceDescriptor, projectName?: string): Instance {
  const existing = instances().get(descriptor.id)
  return {
    id: descriptor.id,
    folder: descriptor.path,
    projectName: projectName ?? existing?.projectName ?? descriptor.name,
    port: descriptor.port ?? existing?.port ?? 0,
    pid: descriptor.pid ?? existing?.pid ?? 0,
    proxyPath: descriptor.proxyPath,
    status: descriptor.status,
    error: descriptor.error,
    client: existing?.client ?? null,
    metadata: existing?.metadata,
    binaryPath: descriptor.binaryId ?? descriptor.binaryLabel ?? existing?.binaryPath,
    binaryLabel: descriptor.binaryLabel,
    binaryVersion: descriptor.binaryVersion ?? existing?.binaryVersion,
    environmentVariables: existing?.environmentVariables ?? serverSettings().environmentVariables ?? {},
  }
}

function upsertWorkspace(descriptor: WorkspaceDescriptor, projectName?: string) {
  const mapped = workspaceDescriptorToInstance(descriptor, projectName)
  if (instances().has(descriptor.id)) {
    updateInstance(descriptor.id, mapped)
  } else {
    addInstance(mapped)
  }

  if (descriptor.status === "ready") {
    attachClient(descriptor)
    settleInstanceReadyWaiters(descriptor.id)
  } else if (descriptor.status === "error" || descriptor.status === "stopped") {
    settleInstanceReadyWaiters(
      descriptor.id,
      new Error(descriptor.error || `Workspace ${descriptor.id} did not become ready`),
    )
  }
}

function attachClient(descriptor: WorkspaceDescriptor) {
  const instance = instances().get(descriptor.id)
  if (!instance) return

  const nextPort = descriptor.port ?? instance.port
  const nextProxyPath = descriptor.proxyPath

  if (instance.client && instance.proxyPath === nextProxyPath) {
    if (nextPort && instance.port !== nextPort) {
      updateInstance(descriptor.id, { port: nextPort })
    }
    return
  }

  if (instance.client) {
    sdkManager.destroyClientsForInstance(descriptor.id)
    destroyOpenCodeData(descriptor.id)
  }

  const client = sdkManager.createClient(descriptor.id, nextProxyPath)
  updateInstance(descriptor.id, {
    client,
    port: nextPort ?? 0,
    proxyPath: nextProxyPath,
    status: "ready",
  })
  sseManager.seedStatusIfMissing(descriptor.id, "connecting")
  const sessionHydration = startInstanceSessionHydration(descriptor.id)
  initialSessionHydrations.set(descriptor.id, sessionHydration.sessions)
  initialWorkspaceMetadataHydrations.set(descriptor.id, sessionHydration.workspaceMetadata)
  const hydration = hydrateInstanceData(descriptor.id, {
    propagateErrors: true,
    sessionHydration: sessionHydration.sessions,
    workspaceMetadataHydration: sessionHydration.workspaceMetadata,
  })
  initialHydrations.set(descriptor.id, hydration)
  void hydration.catch((error) => {
    log.error("Failed to hydrate instance data", error)
  })
}

function waitForInstanceReady(instanceId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (instance?.status === "ready" && instance.client) {
    return Promise.resolve()
  }
  if (instance?.status === "error" || instance?.status === "stopped") {
    return Promise.reject(new Error(instance.error || `Workspace ${instanceId} did not become ready`))
  }

  return new Promise<void>((resolve, reject) => {
    const waiter = { resolve, reject }
    const waiters = instanceReadyWaiters.get(instanceId) ?? new Set<InstanceReadyWaiter>()
    waiters.add(waiter)
    instanceReadyWaiters.set(instanceId, waiters)

    const current = instances().get(instanceId)
    if (current?.status === "ready" && current.client) {
      settleInstanceReadyWaiters(instanceId)
    } else if (current?.status === "error" || current?.status === "stopped") {
      settleInstanceReadyWaiters(
        instanceId,
        new Error(current.error || `Workspace ${instanceId} did not become ready`),
      )
    }
  })
}

async function waitForInstanceInitialHydration(instanceId: string): Promise<void> {
  await waitForInstanceReady(instanceId)
  await initialHydrations.get(instanceId)
}

async function waitForInstanceInitialSessionHydration(instanceId: string): Promise<void> {
  await waitForInstanceReady(instanceId)
  await initialSessionHydrations.get(instanceId)
}

async function waitForInstanceWorkspaceMetadataHydration(instanceId: string): Promise<void> {
  await waitForInstanceReady(instanceId)
  await initialWorkspaceMetadataHydrations.get(instanceId)
}

function releaseInstanceResources(instanceId: string) {
  const instance = instances().get(instanceId)
  if (!instance) return

  if (instance.client) {
    sdkManager.destroyClientsForInstance(instanceId)
  }
  destroyOpenCodeData(instanceId)
  sseManager.seedStatus(instanceId, "disconnected")
}

async function syncPendingPermissions(
  instanceId: string,
  propagateErrors = false,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return
  const mutationEpoch = pendingPermissionMutationEpochs.get(instanceId) ?? 0

  try {
    const syncStartedAt = Date.now()
    const remote: PermissionRequest[] = []
    for (const location of buildV2RequestLocations(instance.folder, getWorktrees(instanceId))) {
      const response = await instance.client.permission.request.list({ location })
      log.info("permission.request.list", { instanceId, location, resolvedLocation: response.location })
      remote.push(...response.data)
    }

    const remotePendingIds = new Set(remote.map((request) => request.id))
    if (!isCurrent() || (pendingPermissionMutationEpochs.get(instanceId) ?? 0) !== mutationEpoch) {
      if (propagateErrors) throw pendingRequestSyncSuperseded
      return
    }
    pruneRepliedPermissions(instanceId, remotePendingIds, syncStartedAt)

    const pendingRemote = remote.filter((request) => !hasRepliedPermission(instanceId, request.id))
    const remoteIds = new Set(pendingRemote.map((request) => request.id))
    const local = getPermissionQueue(instanceId)

    // Remove any stale local permissions missing from server.
    for (const entry of local) {
      if (!remoteIds.has(entry.id)) {
        removePermissionFromQueue(instanceId, entry.id)
        removePermissionV2(instanceId, entry.id)
      }
    }

    // Upsert all server-side pending permissions.
    for (const permission of pendingRemote) {
      const queuedPermission = addPermissionToQueue(instanceId, permission) ?? permission
      upsertPermissionV2(instanceId, queuedPermission)
    }
    reconcilePendingSessionIndicators(instanceId)
  } catch (error) {
    log.warn("Failed to sync pending permissions", { instanceId, error })
    if (propagateErrors) throw error
  }
}

async function syncPendingForms(
  instanceId: string,
  propagateErrors = false,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return
  const mutationEpoch = pendingFormMutationEpochs.get(instanceId) ?? 0

  try {
    const remote: FormWithLocation[] = []
    for (const location of buildV2RequestLocations(instance.folder, getWorktrees(instanceId))) {
      const response = await instance.client.form.request.list({ location })
      remote.push(...response.data.map((form) => form.sessionID === "global"
        ? { ...form, location: response.location }
        : form))
    }
    if (!isCurrent() || (pendingFormMutationEpochs.get(instanceId) ?? 0) !== mutationEpoch) {
      if (propagateErrors) throw pendingRequestSyncSuperseded
      return
    }
    replacePendingForms(instanceId, remote)
    reconcilePendingSessionIndicators(instanceId)
  } catch (error) {
    log.warn("Failed to sync pending forms", { instanceId, error })
    if (propagateErrors) throw error
  }
}

async function runPendingRequestSync(
  instanceId: string,
  generation: number,
  token: { cancelled: boolean },
): Promise<void> {
  for (let attempt = 0; attempt < 3 && !token.cancelled; attempt += 1) {
    const epoch = (pendingRequestSyncEpochs.get(instanceId) ?? 0) + 1
    pendingRequestSyncEpochs.set(instanceId, epoch)
    const isCurrent = () => !token.cancelled
      && pendingRequestSyncEpochs.get(instanceId) === epoch
      && pendingRequestSyncGenerations.get(instanceId) === generation
    try {
      await Promise.all([
        syncPendingPermissions(instanceId, true, isCurrent),
        syncPendingForms(instanceId, true, isCurrent),
      ])
      return
    } catch (error) {
      if (error !== pendingRequestSyncSuperseded) throw error
    }
  }
  if (!token.cancelled && pendingRequestSyncGenerations.get(instanceId) === generation) {
    throw new Error("Pending request sync did not stabilize")
  }
}

function syncPendingRequests(
  instanceId: string,
  registerInvalidation?: (invalidate: () => void) => void,
): Promise<void> {
  const generation = pendingRequestSyncGenerations.get(instanceId)
  if (generation === undefined) return Promise.resolve()
  const existing = pendingRequestSyncs.get(instanceId)
  if (existing?.generation === generation) {
    registerInvalidation?.(() => {
      if (pendingRequestSyncs.get(instanceId)?.token !== existing.token) return
      existing.token.cancelled = true
      invalidatePendingRequestSync(instanceId)
      pendingRequestSyncs.delete(instanceId)
    })
    return existing.promise
  }
  const token = { cancelled: false }
  const promise = runPendingRequestSync(instanceId, generation, token).finally(() => {
    if (pendingRequestSyncs.get(instanceId)?.promise === promise) pendingRequestSyncs.delete(instanceId)
  })
  pendingRequestSyncs.set(instanceId, { generation, token, promise })
  registerInvalidation?.(() => {
    if (pendingRequestSyncs.get(instanceId)?.token !== token) return
    token.cancelled = true
    invalidatePendingRequestSync(instanceId)
    pendingRequestSyncs.delete(instanceId)
  })
  return promise
}

function startInstanceSessionHydration(instanceId: string, force = false): {
  sessions: Promise<void>
  workspaceMetadata: Promise<void>
} {
  const worktreeHydration = force
    ? reloadWorktrees(instanceId)
    : ensureWorktreesLoaded(instanceId)
  const workspaceMetadata = worktreeHydration.then(async () => {
    const instance = instances().get(instanceId)
    if (instance?.client) await loadInstanceMetadata(instance, { force }).catch((error) => {
      log.warn("Failed to load project metadata before session hydration", { instanceId, error })
    })
  })
  const sessions = workspaceMetadata.then(async () => {
    resetSessionPagination(instanceId)
    await fetchSessions(instanceId).catch((error) => {
      log.error("Failed to hydrate sessions", { instanceId, error })
    })
  })
  return { sessions, workspaceMetadata }
}

async function hydrateInstanceData(instanceId: string, options?: {
  force?: boolean
  propagateErrors?: boolean
  sessionHydration?: Promise<void>
  workspaceMetadataHydration?: Promise<void>
}) {
  try {
    const hydration = options?.sessionHydration
      ? {
          sessions: options.sessionHydration,
          workspaceMetadata: options.workspaceMetadataHydration ?? Promise.resolve(),
        }
      : startInstanceSessionHydration(instanceId, options?.force)
    await hydration.sessions
    await hydration.workspaceMetadata
    await fetchAgents(instanceId)
    await fetchProviders(instanceId)
    await ensureInstanceConfigLoaded(instanceId)
    const instance = instances().get(instanceId)
    if (!instance?.client) return
    await fetchCommands(instanceId, instance.client, getActiveCatalogLocation(instanceId))
    await syncPendingRequests(instanceId)
  } catch (error) {
    log.error("Failed to fetch initial data", error)
    if (options?.propagateErrors) throw error
  }
}

async function postInstanceDispose(instanceId: string): Promise<boolean> {
  const instance = instances().get(instanceId)
  if (!instance?.proxyPath) {
    throw new Error("Instance not ready")
  }

  const baseUrl = buildInstanceBaseUrl(instance.proxyPath)
  const url = new URL("instance/dispose", baseUrl)

  const response = await fetch(url.toString(), {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
    },
  })

  if (!response.ok) {
    const message = await response.text().catch(() => "")
    throw new Error(message || `Dispose request failed with ${response.status}`)
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    const data = await response.json().catch(() => undefined)
    if (typeof data === "boolean") return data
    if (data && typeof data === "object" && "data" in (data as any)) {
      return Boolean((data as any).data)
    }
    return Boolean(data)
  }

  const text = await response.text().catch(() => "")
  if (text.trim() === "true") return true
  if (text.trim() === "false") return false
  return Boolean(text)
}

function clearReloadableInstanceState(instanceId: string): void {
  clearCacheForInstance(instanceId)
  clearCommands(instanceId)
  clearInstanceMetadata(instanceId)
  messageStoreBus.clearInstanceScrollSnapshots(instanceId)
  clearPermissionQueue(instanceId)
  clearPendingFormQueue(instanceId)
}

async function rehydrateInstance(instanceId: string, options?: { reason?: string }): Promise<void> {
  if (pendingRehydrations.has(instanceId)) {
    return pendingRehydrations.get(instanceId)
  }

  const promise = (async () => {
    const instance = instances().get(instanceId)
    if (!instance?.client) {
      return
    }

    log.info("Rehydrating instance", { instanceId, reason: options?.reason })
    clearReloadableInstanceState(instanceId)

    await hydrateInstanceData(instanceId, { force: true })
  })().finally(() => {
    pendingRehydrations.delete(instanceId)
  })

  pendingRehydrations.set(instanceId, promise)
  return promise
}

async function disposeInstance(instanceId: string): Promise<boolean> {
  if (pendingDisposeRequests.has(instanceId)) {
    return pendingDisposeRequests.get(instanceId)!
  }

  const promise = (async () => {
    const ok = await postInstanceDispose(instanceId)
    if (ok) {
      await rehydrateInstance(instanceId, { reason: "disposed" })
    }
    return ok
  })().finally(() => {
    pendingDisposeRequests.delete(instanceId)
  })

  pendingDisposeRequests.set(instanceId, promise)
  return promise
}

async function refreshWorkspaceList(): Promise<void> {
  const requestFence = workspaceListReconciliationFence.begin()
  const removalCandidates = new Set(instances().keys())
  try {
    const workspaces = await serverApi.fetchWorkspaces()
    if (!workspaceListReconciliationFence.isCurrent(requestFence)) return
    const remoteIds = new Set(workspaces.map(({ id }) => id))
    for (const workspace of workspaces) {
      if (!workspaceListReconciliationFence.allows(requestFence, workspace.id)) continue
      restoreCreatedWorkspaceCleanup.trackPendingRequest(workspace)
      if (restoreCreationCommitGates.deferRefreshWorkspace(workspace)) continue
      if (restoreCreatedWorkspaceCleanup.owns(workspace.id)) {
        restoreCreatedWorkspaceCleanup.track(workspace)
        continue
      }
      upsertWorkspace(workspace)
    }
    const unchangedCandidates = [...removalCandidates]
      .filter((id) => workspaceListReconciliationFence.allows(requestFence, id))
    for (const instanceId of getUnavailableWorkspaceIds(
      unchangedCandidates, remoteIds, (id) => restoreCreatedWorkspaceCleanup.owns(id),
    )) {
      releaseInstanceResources(instanceId)
      removeInstance(instanceId, { authoritative: false })
    }
  } finally {
    workspaceListReconciliationFence.complete(requestFence)
  }
}

const initialWorkspaceLoad = (async function initializeWorkspaces(): Promise<{ error?: unknown }> {
  try {
    await refreshWorkspaceList()
    return {}
  } catch (error) {
    log.error("Failed to load workspaces", error)
    return { error }
  }
})()
let latestWorkspaceLoad = initialWorkspaceLoad
const workspaceLoadChangeListeners = new Set<() => void>()

function publishLatestWorkspaceLoad(load: Promise<{ error?: unknown }>) {
  latestWorkspaceLoad = load
  workspaceLoadChangeListeners.forEach((listener) => listener())
}

function waitForWorkspaceLoadChange(
  current: Promise<{ error?: unknown }>,
  signal?: AbortSignal,
): Promise<void> {
  if (latestWorkspaceLoad !== current) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      workspaceLoadChangeListeners.delete(onChange)
      signal?.removeEventListener("abort", onAbort)
    }
    const onChange = () => { cleanup(); resolve() }
    const onAbort = () => { cleanup(); reject(signal?.reason) }
    workspaceLoadChangeListeners.add(onChange)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (latestWorkspaceLoad !== current) onChange()
  })
}

serverEvents.onOpen(() => {
  publishLatestWorkspaceLoad(refreshWorkspaceList().then(
    () => ({}),
    (error) => {
      log.warn("Failed to reconcile workspaces after event reconnect", error)
      return { error }
    },
  ))
})

async function waitForInitialWorkspaceLoad(signal?: AbortSignal): Promise<void> {
  await waitForLatestWorkspaceLoadResult(
    initialWorkspaceLoad,
    () => latestWorkspaceLoad,
    waitForWorkspaceLoadChange,
    signal,
  )
}


serverEvents.on("*", (event) => handleWorkspaceEvent(event))

function handleWorkspaceEvent(event: WorkspaceEventPayload) {
  const workspaceId = event.type === "workspace.log"
    ? event.entry.workspaceId
    : "workspace" in event
      ? event.workspace.id
      : "workspaceId" in event && typeof event.workspaceId === "string"
        ? event.workspaceId
        : null
  if (workspaceId && event.type !== "workspace.log") {
    workspaceListReconciliationFence.markMutation(workspaceId)
  }
  if ("workspace" in event) {
    restoreCreatedWorkspaceCleanup.trackPendingRequest(event.workspace)
    if (restoreCreationCommitGates.deferWorkspace(event.workspace)) return
  }
  if (event.type === "workspace.stopped"
    && restoreCreationCommitGates.deferStopped(event.workspaceId, event.reason)) {
    return
  }
  if (workspaceId && restoreCreatedWorkspaceCleanup.shouldIgnoreEvent(workspaceId)) {
    return
  }

  switch (event.type) {
    case "workspace.created":
      upsertWorkspace(event.workspace)
      break
    case "workspace.started":
      upsertWorkspace(event.workspace)
      break
    case "workspace.error":
      upsertWorkspace(event.workspace)
      showWorkspaceLaunchError(event.workspace)
      clearPermissionAutoAcceptForInstance(event.workspace.id)
      clearSyncedYoloSessionsForInstance(event.workspace.id)
      break
    case "workspace.stopped":
      requestInstanceTabClose(event.workspaceId)
      restoreCreatedWorkspaceCleanup.release(event.workspaceId)
      releaseInstanceResources(event.workspaceId)
      removeInstance(event.workspaceId, { authoritative: event.reason === "deleted" })
      break
    case "workspace.log":
      handleWorkspaceLog(event.entry)
      break
    default:
      break
  }
}

function handleWorkspaceLog(entry: WorkspaceLogEntry) {
  const logEntry: LogEntry = {
    timestamp: new Date(entry.timestamp).getTime(),
    level: (entry.level as LogEntry["level"]) ?? "info",
    message: entry.message,
  }
  addLog(entry.workspaceId, logEntry)
}

function ensureLogContainer(id: string) {
  setInstanceLogs((prev) => {
    if (prev.has(id)) {
      return prev
    }
    const next = new Map(prev)
    next.set(id, [])
    return next
  })
}

function ensureLogStreamingState(id: string) {
  setLogStreamingState((prev) => {
    if (prev.has(id)) {
      return prev
    }
    const next = new Map(prev)
    next.set(id, false)
    return next
  })
}

function removeLogContainer(id: string) {
  setInstanceLogs((prev) => {
    if (!prev.has(id)) {
      return prev
    }
    const next = new Map(prev)
    next.delete(id)
    return next
  })
  setLogStreamingState((prev) => {
    if (!prev.has(id)) {
      return prev
    }
    const next = new Map(prev)
    next.delete(id)
    return next
  })
}

function getInstanceLogs(instanceId: string): LogEntry[] {
  return instanceLogs().get(instanceId) ?? []
}

function isInstanceLogStreaming(instanceId: string): boolean {
  return logStreamingState().get(instanceId) ?? false
}

function setInstanceLogStreaming(instanceId: string, enabled: boolean) {
  ensureLogStreamingState(instanceId)
  setLogStreamingState((prev) => {
    const next = new Map(prev)
    next.set(instanceId, enabled)
    return next
  })
  if (!enabled) {
    clearLogs(instanceId)
  }
}

function addInstance(instance: Instance) {
  const occurrence = Array.from(instances().values())
    .filter((existing) => normalizeInstanceFolderPath(existing.folder) === normalizeInstanceFolderPath(instance.folder))
    .length
  pendingRequestSyncGenerations.set(instance.id, ++nextPendingRequestSyncGeneration)
  setInstances((prev) => {
    const next = new Map(prev)
    next.set(instance.id, instance)
    return next
  })
  ensureLogContainer(instance.id)
  ensureLogStreamingState(instance.id)
  publishInstanceLifecycleAuthority({
    type: "opened",
    instanceId: instance.id,
    folder: instance.folder,
    occurrence,
  })
  syncHasInstancesFlag()
}

function updateInstance(id: string, updates: Partial<Instance>) {
  setInstances((prev) => {
    const next = new Map(prev)
    const instance = next.get(id)
    if (instance) {
      next.set(id, { ...instance, ...updates })
    }
    return next
  })
  syncHasInstancesFlag()
}

function removeInstance(id: string, options: { authoritative?: boolean } = {}) {
  detachInstanceTabMembership(id)
  connectionResyncGate.clear(id)
  const removedInstance = instances().get(id)
  const removedOccurrence = removedInstance
    ? Array.from(instances().values())
        .filter((instance) => normalizeInstanceFolderPath(instance.folder) === normalizeInstanceFolderPath(removedInstance.folder))
        .findIndex((instance) => instance.id === id)
    : -1
  if (removedInstance && removedOccurrence >= 0 && options.authoritative === false) {
    publishInstanceLifecycleAuthority({
      type: "unavailable",
      instanceId: id,
      folder: removedInstance.folder,
      occurrence: removedOccurrence,
    })
  }
  let nextActiveId: string | null = null

  setInstances((prev) => {
    if (!prev.has(id)) {
      return prev
    }

    const keys = Array.from(prev.keys())
    const index = keys.indexOf(id)
    const next = new Map(prev)
    next.delete(id)

    if (activeInstanceId() === id) {
      if (index > 0) {
        const prevKey = keys[index - 1]
        nextActiveId = prevKey ?? null
      } else {
        const remainingKeys = Array.from(next.keys())
        nextActiveId = remainingKeys.length > 0 ? (remainingKeys[0] ?? null) : null
      }
    }

    return next
  })

  removeLogContainer(id)
  clearCommands(id)
  clearPermissionQueue(id)
  clearRepliedPermissions(id)
  clearPendingFormQueue(id)
  clearInstanceMetadata(id)
  clearPermissionAutoAcceptForInstance(id)
  clearSyncedYoloSessionsForInstance(id)
  initialHydrations.delete(id)
  initialSessionHydrations.delete(id)
  initialWorkspaceMetadataHydrations.delete(id)
  invalidatePendingRequestSync(id)
  pendingRequestSyncGenerations.delete(id)
  settleInstanceReadyWaiters(id, new Error(`Workspace ${id} was removed before it became ready`))

  if (activeInstanceId() === id) {
    setActiveInstanceId(nextActiveId)
  }

  // Clean up session indexes and drafts for removed instance
  clearCacheForInstance(id)
  messageStoreBus.unregisterInstance(id)
  clearInstanceDraftPrompts(id)
  clearSessionListRequestState(id)
  clearSessionCatalogState(id)
  clearInstanceAttachments(id)
  clearInstanceDeletedSessionAuthority(id)
  clearInstanceSessionExpansionState(id)
  clearInstanceSessionSelection(id)
  if (removedInstance && removedOccurrence >= 0 && options.authoritative !== false) {
    publishInstanceLifecycleAuthority({
      type: "removed",
      instanceId: id,
      folder: removedInstance.folder,
      occurrence: removedOccurrence,
    })
  }
  syncHasInstancesFlag()
}

function removeRestoreCreatedInstanceFromUi(instanceId: string): void {
  workspaceListReconciliationFence.markMutation(instanceId)
  if (instances().has(instanceId)) {
    releaseInstanceResources(instanceId)
    removeInstance(instanceId, { authoritative: false })
  }
}

function disposeRestoreWorkspaceResponse(workspace: RestoreWorkspaceDescriptor): Promise<void> {
  if (workspace.reused !== true) removeRestoreCreatedInstanceFromUi(workspace.id)
  return restoreCreatedWorkspaceCleanup.discardCreated(workspace, { retainTombstone: workspace.reused !== true })
}

function disposeRestoreCreatedInstance(instanceId: string): Promise<void> {
  const workspace = restoreCreatedWorkspaceCleanup.get(instanceId)
  if (!workspace) return Promise.resolve()
  if (workspace.reused !== true) removeRestoreCreatedInstanceFromUi(instanceId)
  return restoreCreatedWorkspaceCleanup.discardTracked(instanceId, { retainTombstone: workspace.reused !== true })
}

async function releaseRestoreCreatedInstance(instanceId: string, requestId: string): Promise<void> {
  await restoreCreatedWorkspaceCleanup.releaseAfter(instanceId, () =>
    retryWithBackoff(() => serverApi.releaseWorkspaceCreation(instanceId, requestId), {
      maxAttempts: 4,
      initialDelayMs: 250,
      maxDelayMs: 2_000,
      backoffMultiplier: 4,
    }))
}

async function cancelRestoreCreationRequest(instanceId: string | undefined, requestId: string): Promise<void> {
  await cancelRestoreCreation(requestId)
  if (instanceId) restoreCreatedWorkspaceCleanup.forgetRequest(instanceId, requestId)
}

function claimRestoreCreatedInstanceForUser(instanceId: string): void {
  const workspace = restoreCreatedWorkspaceCleanup.get(instanceId)
  if (!workspace?.requestId) return
  void releaseRestoreCreatedInstance(instanceId, workspace.requestId).catch((error) => {
    log.warn("Failed to transfer restore workspace creation ownership to the user", { instanceId, error })
  })
}

async function settleRestoreWorkspaceTerminal(
  workspace: RestoreWorkspaceDescriptor,
  terminal: RestoreWorkspaceTerminal,
): Promise<void> {
  if (terminal.status === "stopped") {
    restoreCreatedWorkspaceCleanup.release(workspace.id)
    removeRestoreCreatedInstanceFromUi(workspace.id)
    return
  }
  await disposeRestoreWorkspaceResponse(workspace)
}

async function createInstance(
  folder: string,
  projectName?: string,
  options?: {
    signal?: AbortSignal
    shouldCreateCommit?: () => boolean
    onBeforeCreateCommit?: (instanceId: string) => void
    onCreateCommit?: (instanceId: string) => void
    waitForCreateCommit?: () => Promise<void>
  },
): Promise<{ instanceId: string; reused: boolean; requestId?: string }> {
  const restoreRequestId = options?.signal ? createRestoreCreationRequestId() : undefined
  if (restoreRequestId) restoreCreatedWorkspaceCleanup.beginRequest(restoreRequestId)
  const commitGate: RestoreWorkspaceCommitGate<RestoreWorkspaceDescriptor> | undefined = restoreRequestId && options?.waitForCreateCommit
    ? restoreCreationCommitGates.begin(restoreRequestId, options.waitForCreateCommit(), folder)
    : undefined
  let cancellationRequest: Promise<boolean> | null = null
  let requestResolved = false
  let terminalHandled = false
  const cancelPendingCreation = () => {
    if (!restoreRequestId) return
    const trackedCleanup = restoreCreatedWorkspaceCleanup.quarantineRequest(restoreRequestId)
    cancellationRequest ??= trackedCleanup
      ? trackedCleanup.then(() => true)
      : cancelRestoreCreationRequest(undefined, restoreRequestId)
          .then(() => true, (error) => {
            log.warn("Failed to cancel restore workspace creation", { requestId: restoreRequestId, error })
            return false
          })
  }
  options?.signal?.addEventListener("abort", cancelPendingCreation, { once: true })

  try {
    if (options?.signal?.aborted) throw getAbortReason(options.signal)
    const workspace = await serverApi.createWorkspace({
      path: folder,
      name: projectName,
      requestId: restoreRequestId,
    }, { signal: options?.signal })
    requestResolved = true
    const reused = workspace.reused === true
    if (restoreRequestId) restoreCreationCommitGates.bindResponse(restoreRequestId, workspace.id)
    if (options?.signal?.aborted) {
      if (workspace.requestId) await disposeRestoreWorkspaceResponse(workspace)
      throw getAbortReason(options.signal)
    }
    if (options?.signal && workspace.requestId) {
      const observed = restoreRequestId
        ? restoreCreationCommitGates.resolve(restoreRequestId, workspace).workspace
        : workspace
      restoreCreatedWorkspaceCleanup.track({
        ...observed,
        requestId: observed.requestId ?? workspace.requestId,
        ...(reused ? { reused: true as const } : {}),
      })
    }
    else if (!options?.signal) restoreCreatedWorkspaceCleanup.releaseTombstoneForUserCreate(workspace.id)
    if (commitGate) await commitGate.wait
    if (options?.signal?.aborted) {
      if (workspace.requestId) await disposeRestoreWorkspaceResponse(workspace)
      throw getAbortReason(options.signal)
    }
    const resolution = restoreRequestId
      ? restoreCreationCommitGates.resolve(restoreRequestId, workspace)
      : { workspace }
    const committedWorkspace: RestoreWorkspaceDescriptor = {
      ...resolution.workspace,
      requestId: resolution.workspace.requestId ?? workspace.requestId,
      ...(reused ? { reused: true } : {}),
    }
    if (restoreRequestId) restoreCreatedWorkspaceCleanup.track(committedWorkspace)
    const terminal = resolution.terminal ?? (committedWorkspace.status === "error" || committedWorkspace.status === "stopped"
      ? { status: committedWorkspace.status, message: committedWorkspace.error }
      : undefined)
    if (terminal) {
      terminalHandled = true
      await settleRestoreWorkspaceTerminal(committedWorkspace, terminal)
      throw new Error(terminal.message || `Restore-created workspace ${workspace.id} ${terminal.status}`)
    }
    const discarded = restoreCreatedWorkspaceCleanup.shouldIgnoreEvent(workspace.id)
      || options?.shouldCreateCommit?.() === false
    if (!discarded) {
      workspaceListReconciliationFence.markMutation(workspace.id)
      options?.onBeforeCreateCommit?.(workspace.id)
      upsertWorkspace(committedWorkspace, reused ? undefined : projectName)
      options?.onCreateCommit?.(workspace.id)
    }
    if (discarded) {
      if (workspace.requestId) await disposeRestoreWorkspaceResponse(workspace)
      throw new Error(`Restore-created workspace ${workspace.id} was closed before startup completed`)
    }
    return { instanceId: workspace.id, reused, requestId: workspace.requestId }
  } catch (error) {
    if (!terminalHandled && commitGate?.terminal && commitGate.workspace) {
      terminalHandled = true
      await settleRestoreWorkspaceTerminal(commitGate.workspace, commitGate.terminal)
    }
    if (!options?.signal?.aborted) log.error("Failed to create workspace", error)
    throw error
  } finally {
    options?.signal?.removeEventListener("abort", cancelPendingCreation)
    if (restoreRequestId) {
      restoreCreationCommitGates.end(restoreRequestId)
      const pendingCancellation = cancellationRequest as Promise<boolean> | null
      if (requestResolved || !pendingCancellation) {
        restoreCreatedWorkspaceCleanup.finishRequest(restoreRequestId)
      } else {
        void pendingCancellation.then((cancelled) => {
          if (cancelled) restoreCreatedWorkspaceCleanup.finishRequest(restoreRequestId)
        })
      }
    }
  }
}

function normalizeInstanceFolderPath(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "")
  const windowsLike = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(trimmed)
  if (!windowsLike) {
    return trimmed
  }

  return trimmed.replace(/\\/g, "/").toLowerCase()
}

function getExistingInstanceForFolder(folder: string): Instance | null {
  if (!folder) return null
  const target = normalizeInstanceFolderPath(folder)
  const matches = Array.from(instances().values()).filter((instance) => {
    if (instance.status === "stopped") return false
    return normalizeInstanceFolderPath(instance.folder) === target
  })

  if (matches.length === 0) return null

  const activeId = activeInstanceId()
  return matches.find((instance) => instance.id === activeId) ?? matches.find((instance) => instance.status === "ready") ?? matches[0] ?? null
}

function updateProjectNameForFolder(folder: string, projectName: string): void {
  const name = projectName.trim()
  if (!folder || !name) return
  const target = normalizeInstanceFolderPath(folder)
  for (const instance of instances().values()) {
    if (instance.status === "stopped") continue
    if (normalizeInstanceFolderPath(instance.folder) === target) {
      updateInstance(instance.id, { projectName: name })
    }
  }
}

const stopInstanceRequests = new Map<string, Promise<void>>()

function stopInstance(id: string): Promise<void> {
  const instance = instances().get(id)
  if (!instance) return Promise.resolve()
  const pending = stopInstanceRequests.get(id)
  if (pending) return pending

  const request = serverApi.deleteWorkspace(id)
    .catch((error) => {
      log.error("Failed to stop workspace", error)
      try {
        showToastNotification({
          message: tGlobal("app.stopInstance.toast.error"),
          variant: "error",
        })
      } finally {
        throw error
      }
    })
    .finally(() => {
      stopInstanceRequests.delete(id)
    })
  stopInstanceRequests.set(id, request)
  return request
}

function getActiveInstance(): Instance | null {
  const id = activeInstanceId()
  return id ? instances().get(id) || null : null
}

function addLog(id: string, entry: LogEntry) {
  if (!isInstanceLogStreaming(id)) {
    return
  }

  setInstanceLogs((prev) => {
    const next = new Map(prev)
    const existing = next.get(id) ?? []
    const updated = existing.length >= MAX_LOG_ENTRIES ? [...existing.slice(1), entry] : [...existing, entry]
    next.set(id, updated)
    return next
  })
}

function clearLogs(id: string) {
  setInstanceLogs((prev) => {
    if (!prev.has(id)) {
      return prev
    }
    const next = new Map(prev)
    next.set(id, [])
    return next
  })
}

// Permission management functions
function getPermissionQueue(instanceId: string): PermissionRequest[] {
  const queue = permissionQueues().get(instanceId)
  if (!queue) {
    return []
  }
  return queue
}

function getPermissionQueueLength(instanceId: string): number {
  return getPermissionQueue(instanceId).length
}

function hasPendingPermission(instanceId: string, permissionId: string): boolean {
  return getPermissionQueue(instanceId).some((permission) => permission.id === permissionId)
}

function getPermissionEnqueuedAtForInstance(instanceId: string, permissionId: string): number {
  const queue = getPermissionQueue(instanceId)
  const match = queue.find((permission) => permission.id === permissionId)
  if (match) {
    return permissionRegistry.ensureEnqueuedAt(match)
  }
  return permissionRegistry.enqueuedAtFor(permissionId)
}

function computeActiveInterruption(instanceId: string): ActiveInterruption {
  const permissions = getPermissionQueue(instanceId)
  const forms = getFormQueue(instanceId)
  const candidates: Array<{ kind: InterruptionKind; id: string; enqueuedAt: number }> = []
  if (permissions[0]) candidates.push({
    kind: "permission",
    id: permissions[0].id,
    enqueuedAt: permissionRegistry.ensureEnqueuedAt(permissions[0]),
  })
  if (forms[0]) candidates.push({
    kind: "form",
    id: forms[0].id,
    enqueuedAt: formRegistry.ensureEnqueuedAt(forms[0]),
  })
  candidates.sort((left, right) => left.enqueuedAt - right.enqueuedAt)
  const first = candidates[0]
  return first ? { kind: first.kind, id: first.id } : null
}

function setActiveInterruptionForInstance(instanceId: string, nextActive: ActiveInterruption): void {
  setActiveInterruption((prev) => {
    const next = new Map(prev)
    if (!nextActive) {
      next.set(instanceId, null)
    } else {
      next.set(instanceId, nextActive)
    }
    return next
  })

  setActivePermissionId((prev) => {
    const next = new Map(prev)
    if (nextActive?.kind === "permission") {
      next.set(instanceId, nextActive.id)
    } else {
      next.set(instanceId, null)
    }
    return next
  })

}

function recomputeActiveInterruption(instanceId: string): void {
  setActiveInterruptionForInstance(instanceId, computeActiveInterruption(instanceId))
}

function addPermissionToQueue(instanceId: string, permission: PermissionRequest): PermissionRequest | undefined {
  bumpEpoch(pendingPermissionMutationEpochs, instanceId)
  let inserted = false
  let updated = false
  let previousPermission: PermissionRequest | undefined
  let queuedPermission = permission
  setPermissionQueues((prev) => {
    const next = new Map(prev)
    const queue = next.get(instanceId) ?? []
    const existingIndex = queue.findIndex((p) => p.id === permission.id)

    if (existingIndex !== -1) {
      previousPermission = queue[existingIndex]
      queuedPermission = mergePermissionRequest(previousPermission, permission)
      const updatedQueue = queue.slice()
      updatedQueue[existingIndex] = queuedPermission
      next.set(instanceId, updatedQueue.sort((a, b) => permissionRegistry.ensureEnqueuedAt(a) - permissionRegistry.ensureEnqueuedAt(b)))
      updated = true
      return next
    }

    permissionRegistry.ensureEnqueuedAt(queuedPermission)
    const updatedQueue = [...queue, queuedPermission].sort((a, b) => permissionRegistry.ensureEnqueuedAt(a) - permissionRegistry.ensureEnqueuedAt(b))
    next.set(instanceId, updatedQueue)
    inserted = true
    return next
  })

  if (!inserted && !updated) {
    return undefined
  }

  recomputeActiveInterruption(instanceId)

  const previousSessionId = previousPermission ? getPermissionSessionId(previousPermission) : undefined
  const sessionId = getPermissionSessionId(queuedPermission)
  if (previousSessionId && previousSessionId !== sessionId) {
    const remaining = permissionRegistry.decrement(instanceId, previousSessionId)
    setSessionPendingPermission(instanceId, previousSessionId, remaining > 0)
  }

  if (sessionId) {
    if (inserted || previousSessionId !== sessionId) {
      permissionRegistry.increment(instanceId, sessionId)
    }
    setSessionPendingPermission(instanceId, sessionId, true)

  }

  return queuedPermission
}

function removePermissionFromQueue(instanceId: string, permissionId: string): void {
  bumpEpoch(pendingPermissionMutationEpochs, instanceId)
  let removedPermission: PermissionRequest | null = null

  setPermissionQueues((prev) => {
    const next = new Map(prev)
    const queue = next.get(instanceId) ?? []
    const filtered: PermissionRequest[] = []

    for (const item of queue) {
      if (item.id === permissionId) {
        removedPermission = item
        continue
      }
      filtered.push(item)
    }

    if (filtered.length > 0) {
      next.set(instanceId, filtered)
    } else {
      next.delete(instanceId)
    }
    return next
  })

  recomputeActiveInterruption(instanceId)
  permissionRegistry.remove(instanceId, permissionId)

  const removed = removedPermission
  if (removed) {
    const removedSessionId = getPermissionSessionId(removed)
    if (removedSessionId) {
      const remaining = permissionRegistry.decrement(instanceId, removedSessionId)
      setSessionPendingPermission(instanceId, removedSessionId, remaining > 0)
    }
  }
}

function togglePermissionAutoAcceptForSession(instanceId: string, sessionId: string): void {
  const wasEnabled = isPermissionAutoAcceptEnabled(instanceId, sessionId)
  togglePermissionAutoAccept(instanceId, sessionId)
  void serverApi
    .toggleYolo(instanceId, sessionId)
    .then((state) => {
      setPermissionAutoAcceptEnabled(instanceId, sessionId, state.enabled)
    })
    .catch((error) => {
      log.warn("Failed to toggle Yolo on server", { instanceId, sessionId, error })
      // revert to the pre-toggle state (not a naive flip, which can be wrong
      // if an SSE yolo.stateChanged arrived between toggle and catch)
      setPermissionAutoAcceptEnabled(instanceId, sessionId, wasEnabled)
    })
}

/**
 * Sessions whose Yolo state has been backfilled from the server. The server is
 * authoritative but only pushes changes (`yolo.stateChanged`); a freshly
 * connected client must fetch the effective state for a session so the badge
 * matches reality from the start. De-duped per session and reset on SSE
 * reconnect so state re-syncs after a server restart.
 */
const syncedYoloSessions = new Set<string>()

export function ensureYoloStateSynced(instanceId: string, sessionId: string): void {
  if (!instanceId || !sessionId || sessionId === "info") return
  const key = `${instanceId}:${sessionId}`
  if (syncedYoloSessions.has(key)) return
  syncedYoloSessions.add(key)
  void serverApi
    .getYoloState(instanceId, sessionId)
    .then((state) => {
      setPermissionAutoAcceptEnabled(instanceId, sessionId, state.enabled)
    })
    .catch((error) => {
      // allow retry on next activation (e.g. instance not ready yet)
      syncedYoloSessions.delete(key)
      log.warn("Failed to sync Yolo state", { instanceId, sessionId, error })
    })
}

serverEvents.onOpen(() => {
  syncedYoloSessions.clear()
})

function clearSyncedYoloSessionsForInstance(instanceId: string): void {
  const prefix = `${instanceId}:`
  for (const key of Array.from(syncedYoloSessions)) {
    if (key.startsWith(prefix)) {
      syncedYoloSessions.delete(key)
    }
  }
}

function clearPermissionQueue(instanceId: string): void {
  bumpEpoch(pendingPermissionMutationEpochs, instanceId)
  permissionRegistry.clear(instanceId, getPermissionQueue(instanceId), (sessionId) => {
    setSessionPendingPermission(instanceId, sessionId, false)
  })
  setPermissionQueues((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  setActivePermissionId((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  recomputeActiveInterruption(instanceId)
}

function setActivePermissionIdForInstance(instanceId: string, permissionId: string): void {
  setActiveInterruptionForInstance(instanceId, { kind: "permission", id: permissionId })
}

async function sendPermissionResponse(
  instanceId: string,
  _sessionId: string,
  requestId: string,
  reply: PermissionReply,
  message?: string,
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  try {
    const permission = getPermissionQueue(instanceId).find((entry) => entry.id === requestId)
    if (!permission) throw new Error(`Permission request not found: ${requestId}`)
    await getRootClient(instanceId).permission.reply({
      sessionID: permission.sessionID,
      requestID: requestId,
      reply,
      ...(message ? { message } : {}),
    })

    markPermissionReplied(instanceId, requestId)
    // Remove from both local queues after successful response; the SSE replied event
    // is still accepted, but the UI no longer depends on receiving it.
    removePermissionFromQueue(instanceId, requestId)
    removePermissionV2(instanceId, requestId)
  } catch (error) {
    log.error("Failed to send permission response", error)
    throw error
  }
}

async function sendFormReply(instanceId: string, formId: string, answer: FormAnswer): Promise<void> {
  const form = getFormQueue(instanceId).find((item) => item.id === formId)
  if (!form) throw new Error(`Form request not found: ${formId}`)
  bumpEpoch(pendingFormMutationEpochs, instanceId)
  await getRootClient(instanceId).form.reply(
    { sessionID: form.sessionID, formID: form.id, answer },
    formRequestOptions(form),
  )
  removePendingForm(instanceId, form.id)
}

let pendingFormAddedHandler: ((instanceId: string, form: FormWithLocation) => void) | undefined

function setPendingFormAddedHandler(handler: (instanceId: string, form: FormWithLocation) => void): void {
  pendingFormAddedHandler = handler
}

function addPendingForm(instanceId: string, form: FormWithLocation): FormWithLocation | undefined {
  bumpEpoch(pendingFormMutationEpochs, instanceId)
  const previous = getFormQueue(instanceId).find((item) => item.id === form.id)
  addFormToQueue(instanceId, form)
  formRegistry.ensureEnqueuedAt(form)
  if (previous?.sessionID && previous.sessionID !== form.sessionID) {
    const remaining = formRegistry.decrement(instanceId, previous.sessionID)
    setSessionPendingForm(instanceId, previous.sessionID, remaining > 0)
  }
  if (!previous || previous.sessionID !== form.sessionID) formRegistry.increment(instanceId, form.sessionID)
  setSessionPendingForm(instanceId, form.sessionID, true)
  recomputeActiveInterruption(instanceId)
  if (!previous) pendingFormAddedHandler?.(instanceId, form)
  return previous ? undefined : form
}

function removePendingForm(instanceId: string, formId: string): void {
  bumpEpoch(pendingFormMutationEpochs, instanceId)
  const form = getFormQueue(instanceId).find((item) => item.id === formId)
  removeFormFromQueue(instanceId, formId)
  formRegistry.remove(instanceId, formId)
  if (form) {
    const remaining = formRegistry.decrement(instanceId, form.sessionID)
    setSessionPendingForm(instanceId, form.sessionID, remaining > 0)
  }
  recomputeActiveInterruption(instanceId)
}

function replacePendingForms(instanceId: string, forms: readonly FormWithLocation[]): void {
  const ids = new Set(forms.map((form) => form.id))
  for (const form of getFormQueue(instanceId)) {
    if (!ids.has(form.id)) removePendingForm(instanceId, form.id)
  }
  for (const form of forms) addPendingForm(instanceId, form)
}

function clearPendingFormQueue(instanceId: string): void {
  bumpEpoch(pendingFormMutationEpochs, instanceId)
  formRegistry.clear(instanceId, getFormQueue(instanceId), (sessionId) => {
    setSessionPendingForm(instanceId, sessionId, false)
  })
  clearStoredFormQueue(instanceId)
  recomputeActiveInterruption(instanceId)
}

async function sendFormCancel(instanceId: string, formId: string): Promise<void> {
  const form = getFormQueue(instanceId).find((item) => item.id === formId)
  if (!form) throw new Error(`Form request not found: ${formId}`)
  bumpEpoch(pendingFormMutationEpochs, instanceId)
  await getRootClient(instanceId).form.cancel(
    { sessionID: form.sessionID, formID: form.id },
    formRequestOptions(form),
  )
  removePendingForm(instanceId, form.id)
}

function handleInstanceInvalidation(instanceId: string, event: Parameters<NonNullable<typeof sseManager.onInvalidation>>[1]): void {
  const instance = instances().get(instanceId)
  if (!instance?.client) return
  const data = applyOpenCodeDataEvent(instanceId, instance.folder, event)
  const sessionId = "sessionID" in event.data && typeof event.data.sessionID === "string"
    ? event.data.sessionID
    : event.type === "form.created"
      ? event.data.form.sessionID
      : undefined
  if (sessionId && event.type.startsWith("session.")) projectOpenCodeMessages(instanceId, sessionId, data)
  if (sessionId && event.type === "session.inbox.cancelled") {
    removeMessageV2(instanceId, event.data.inboxID, sessionId)
  }
  if (sessionId && event.type === "session.revert.committed") {
    for (const messageId of messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId)) {
      if (messageId >= event.data.to) removeMessageV2(instanceId, messageId, sessionId)
    }
  }
  if (sessionId && (event.type === "permission.asked" || event.type === "permission.replied")) {
    const remote = (data.session.permission.list(sessionId) ?? []).filter((permission) => !hasRepliedPermission(instanceId, permission.id))
    for (const permission of remote) {
      const queued = addPermissionToQueue(instanceId, permission) ?? permission
      upsertPermissionV2(instanceId, queued)
    }
    if (event.type === "permission.replied") {
      removePermissionFromQueue(instanceId, event.data.requestID)
      removePermissionV2(instanceId, event.data.requestID)
    }
  }
  if (sessionId && event.type.startsWith("form.")) {
    const remote = data.session.form.list(sessionId, sessionId === "global" ? event.location : undefined) ?? []
    for (const form of remote) addPendingForm(instanceId, form)
    if (event.type === "form.replied" || event.type === "form.cancelled") removePendingForm(instanceId, event.data.id)
  }
  const targets = getInstanceRefreshTargets(event.type)
  if (targets.length) void refreshVolatileInstanceState(instanceId, targets)
}

sseManager.onInvalidation = handleInstanceInvalidation

sseManager.onConnectionLost = (instanceId, reason) => {
  const instance = instances().get(instanceId)
  if (!instance) {
    return
  }

  setDisconnectedInstance({
    id: instanceId,
    folder: instance.folder,
    reason,
  })
}

sseManager.onInstanceDisposed = (sourceInstanceId, event) => {
  const directory = event?.properties?.directory
  if (!directory) {
    void rehydrateInstance(sourceInstanceId, { reason: "disposed" })
    return
  }

  const matchingInstanceIds: string[] = []
  for (const instance of instances().values()) {
    if (instance.folder === directory) {
      matchingInstanceIds.push(instance.id)
    }
  }

  if (matchingInstanceIds.length === 0) {
    void rehydrateInstance(sourceInstanceId, { reason: "disposed" })
    return
  }

  for (const instanceId of matchingInstanceIds) {
    void rehydrateInstance(instanceId, { reason: "disposed" })
  }
}

async function acknowledgeDisconnectedInstance(): Promise<void> {
  const pending = disconnectedInstance()
  if (!pending) {
    return
  }

  setDisconnectedInstance(null)
}

export {
  instances,
  activeInstanceId,
  setActiveInstanceId,
  addInstance,
  updateInstance,
  removeInstance,
  createInstance,
  cancelRestoreCreationRequest,
  disposeRestoreCreatedInstance,
  releaseRestoreCreatedInstance,
  claimRestoreCreatedInstanceForUser,
  waitForInitialWorkspaceLoad,
  waitForInstanceReady,
  waitForInstanceInitialHydration,
  waitForInstanceInitialSessionHydration,
  waitForInstanceWorkspaceMetadataHydration,
  getExistingInstanceForFolder,
  updateProjectNameForFolder,
  stopInstance,
  getActiveInstance,
  addLog,
  clearLogs,
  instanceLogs,
  getInstanceLogs,
  isInstanceLogStreaming,
  setInstanceLogStreaming,
  // Permission and form management
  permissionQueues,
  activePermissionId,
  getPermissionQueue,
  getPermissionQueueLength,
  getPermissionEnqueuedAtForInstance,
  addPermissionToQueue,
  removePermissionFromQueue,
  markPermissionReplied,
  hasRepliedPermission,
  togglePermissionAutoAcceptForSession,
  clearPermissionQueue,
  sendPermissionResponse,
  setActivePermissionIdForInstance,
  activeInterruption,
  sendFormReply,
  sendFormCancel,
  addPendingForm,
  removePendingForm,
  setPendingFormAddedHandler,
  disconnectedInstance,
  acknowledgeDisconnectedInstance,
  disposeInstance,
  reconcilePendingSessionIndicators,
  syncPendingRequests,
  invalidatePendingRequestSync,
  refreshVolatileInstanceState,
  handleInstanceInvalidation,
  clearReloadableInstanceState,
}
