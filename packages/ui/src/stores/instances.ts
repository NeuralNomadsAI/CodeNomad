import { createSignal } from "solid-js"
import type { Instance, LogEntry } from "../types/instance"
import type { LspStatus } from "@opencode-ai/sdk/v2"
import type { PermissionReply, PermissionRequest, PermissionSource } from "../types/permission"
import { getPermissionSessionId, mergePermissionRequest } from "../types/permission"
import type { QuestionRequest, QuestionSource } from "../types/question"
import { getQuestionSessionId } from "../types/question"
import { requestData } from "../lib/opencode-api"
import { buildInstanceBaseUrl, sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import type { WorkspaceDescriptor, WorkspaceEventPayload, WorkspaceLogEntry } from "../../../server/src/api-types"
import { ensureInstanceConfigLoaded } from "./instance-config"
import {
  fetchSessions,
  fetchAgents,
  fetchProviders,
  loadMessages,
  clearInstanceDraftPrompts,
  clearSessionListRequestState,
  clearInstanceDeletedSessionAuthority,
  clearInstanceSessionExpansionState,
  clearInstanceSessionSelection,
  resetSessionPagination,
} from "./sessions"
import {
  ensureWorktreesLoaded,
  ensureWorktreeMapLoaded,
  getWorktrees,
  reloadWorktreeMap,
  reloadWorktrees,
} from "./worktrees"
import { getRootClient } from "./opencode-client"
import { clearOpenCodeWorkspaceCache, getOpenCodeWorkspaceIdForSession, getOpenCodeWorkspaceIdForWorktree, reloadOpenCodeWorkspaces, syncOpenCodeWorkspaces } from "./opencode-workspaces"
import { fetchCommands, clearCommands } from "./commands"
import { serverSettings } from "./preferences"
import {
  reconcileSessionPendingState,
  activeSessionId,
  invalidateSessionMessageLoad,
  invalidateOwnedSessionMessageLoads,
  getSessionRoot,
  purgeInstanceSessionState,
  sessions,
  setSessionPendingPermission,
  setSessionPendingQuestion,
  resetInstanceSessionRequestState,
} from "./session-state"
import { setHasInstances } from "./ui"
import { messageStoreBus } from "./message-v2/bus"
import { clearPendingDeltasForInstance } from "./delta-buffer"
import { upsertPermissionV2, removePermissionV2, upsertQuestionV2, removeQuestionV2 } from "./message-v2/bridge"
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
import { mergeInstanceMetadata, clearInstanceMetadata } from "./instance-metadata"
import { showWorkspaceLaunchError } from "./launch-errors"
import { activeSidecarToken } from "./sidecars"
import { buildV2RequestLocations, type V2RequestLocationSnapshot } from "./request-locations"
import { showToastNotification } from "../lib/notifications"
import { tGlobal } from "../lib/i18n"
import { appSessionRestoreGateActive } from "./app-session-restore-gate"
import { clearInstanceAttachments } from "./attachments"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { getUnavailableWorkspaceIds } from "./app-session-reconciliation"
import { getAbortReason } from "./app-session-restore-timeout"
import { AbortCreatedWorkspaceCleanup } from "./abort-created-workspace-cleanup"
import { TrailingResyncCoordinator, waitForSettledPrerequisite } from "../lib/trailing-resync"
import { retryWithBackoff } from "../lib/retry-utils"
import { getVisibleSessionMemoryIds } from "./session-memory"
import { cancelRestoreCreation } from "./restore-creation-cancellation"
import {
  RestoreWorkspaceCommitGates, type RestoreWorkspaceCommitGate, type RestoreWorkspaceTerminal,
} from "./restore-workspace-commit-gates"
import { WorkspaceListReconciliationFence } from "./workspace-list-reconciliation-fence"

const log = getLogger("api")
const RECONNECT_LIST_TIMEOUT_MS = 5_000

async function waitForReconnectPrerequisite(prerequisite: Promise<void> | undefined, signal?: AbortSignal): Promise<void> {
  if (!signal) return waitForSettledPrerequisite(prerequisite)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    await Promise.race([waitForSettledPrerequisite(prerequisite), aborted])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

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
let workspaceListInitialized = false
sseManager.shouldHandleEvent = (instanceId) => !workspaceListInitialized || instances().has(instanceId)

const [activeInstanceId, writeActiveInstanceId] = createSignal<string | null>(null)

function setActiveInstanceId(instanceId: string | null): void {
  const previousInstanceId = activeInstanceId()
  if (previousInstanceId && previousInstanceId !== instanceId) {
    const previousSessionId = activeSessionId().get(previousInstanceId)
    if (previousSessionId) {
      invalidateOwnedSessionMessageLoads(previousInstanceId, getSessionRoot(previousInstanceId, previousSessionId)?.id ?? previousSessionId)
    }
  }
  writeActiveInstanceId(instanceId)
}
const [instanceLogs, setInstanceLogs] = createSignal<Map<string, LogEntry[]>>(new Map())
const [logStreamingState, setLogStreamingState] = createSignal<Map<string, boolean>>(new Map())

// Interruption queues (permissions + questions) per instance
const [permissionQueues, setPermissionQueues] = createSignal<Map<string, PermissionRequest[]>>(new Map())
const [activePermissionId, setActivePermissionId] = createSignal<Map<string, string | null>>(new Map())

const [questionQueues, setQuestionQueues] = createSignal<Map<string, QuestionRequest[]>>(new Map())
const [activeQuestionId, setActiveQuestionId] = createSignal<Map<string, string | null>>(new Map())
type AnsweredQuestion = { answeredAt: number; missingPasses: number }
const answeredQuestionIdsByInstance = new Map<string, Map<string, AnsweredQuestion>>()
const ANSWERED_QUESTION_TOMBSTONE_TTL_MS = 10 * 60 * 1_000
const MAX_ANSWERED_QUESTION_TOMBSTONES = 4_096
class InterruptionRegistry<T extends { id: string }, S extends string> {
  private readonly enqueuedAt = new Map<string, number>()
  private readonly mutationVersions = new Map<string, number>()
  private readonly sources = new Map<string, Map<string, S>>()
  private readonly sessionCounts = new Map<string, Map<string, number>>()
  private mutationVersion = 0

  constructor(private readonly defaultSource: S) {}

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

  markMutation(requestId: string): void {
    this.mutationVersions.set(requestId, ++this.mutationVersion)
  }

  snapshotMutationVersion(): number {
    return this.mutationVersion
  }

  wasMutatedAfter(requestId: string, version: number): boolean {
    return (this.mutationVersions.get(requestId) ?? 0) > version
  }

  setSource(instanceId: string, requestId: string, source: S): void {
    const sources = this.sources.get(instanceId) ?? new Map<string, S>()
    sources.set(requestId, source)
    this.sources.set(instanceId, sources)
  }

  getSource(instanceId: string, requestId: string): S {
    return this.sources.get(instanceId)?.get(requestId) ?? this.defaultSource
  }

  remove(instanceId: string, requestId: string): void {
    this.enqueuedAt.delete(requestId)
    this.mutationVersions.delete(requestId)
    const sources = this.sources.get(instanceId)
    sources?.delete(requestId)
    if (sources?.size === 0) this.sources.delete(instanceId)
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
    requests.forEach(({ id }) => {
      this.enqueuedAt.delete(id)
      this.mutationVersions.delete(id)
    })
    this.sources.delete(instanceId)
    for (const sessionId of this.sessionCounts.get(instanceId)?.keys() ?? []) clearPending(sessionId)
    this.sessionCounts.delete(instanceId)
  }
}

const permissionRegistry = new InterruptionRegistry<PermissionRequest, PermissionSource>("v2")
const questionRegistry = new InterruptionRegistry<QuestionRequest, QuestionSource>("v2")

type InterruptionKind = "permission" | "question"

type ActiveInterruption = { kind: InterruptionKind; id: string } | null

async function getV2RequestLocations(instanceId: string, topologyComplete = true): Promise<V2RequestLocationSnapshot> {
  const instance = instances().get(instanceId)
  const worktrees = getWorktrees(instanceId)
  const workspaceBySlug = new Map<string, string>()

  for (const worktree of worktrees) {
    if (!worktree.slug || worktree.slug === "root") continue
    const workspace = await getOpenCodeWorkspaceIdForWorktree(instanceId, worktree.slug).catch((error) => {
      log.warn("Failed to resolve OpenCode workspace for pending requests", { instanceId, slug: worktree.slug, error })
      return null
    })
    if (!workspace) continue
    workspaceBySlug.set(worktree.slug, workspace)
  }

  const snapshot = buildV2RequestLocations(instance?.folder, worktrees, workspaceBySlug)
  return { ...snapshot, complete: topologyComplete && snapshot.complete }
}

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
type InitialHydration = { promise: Promise<void>; controller: AbortController; authority: number }
const initialHydrations = new Map<string, InitialHydration>()
const initialSessionHydrations = new Map<string, Promise<void>>()
const initialWorkspaceMetadataHydrations = new Map<string, Promise<void>>()
const hydrationAuthorities = new Map<string, number>()
let hydrationAuthoritySequence = 0

function claimHydrationAuthority(instanceId: string): number {
  const authority = ++hydrationAuthoritySequence
  hydrationAuthorities.set(instanceId, authority)
  return authority
}

function hasHydrationAuthority(instanceId: string, authority: number): boolean {
  return hydrationAuthorities.get(instanceId) === authority
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
    const instance = instances().get(instanceId)
    if (!instance?.client || instance.status !== "ready") return
    const initialHydration = initialHydrations.get(instanceId)
    await retryWithBackoff(
      (signal) => waitForReconnectPrerequisite(initialHydration?.promise, signal),
      { maxAttempts: 1, timeoutMs: RECONNECT_LIST_TIMEOUT_MS },
    ).catch((error) => {
      if (initialHydration && initialHydrations.get(instanceId) === initialHydration) {
        initialHydration.controller.abort(error)
        initialHydrations.delete(instanceId)
        initialSessionHydrations.delete(instanceId)
        initialWorkspaceMetadataHydrations.delete(instanceId)
      }
      log.warn("Initial hydration did not settle before reconnect resync", { instanceId, error })
    })
    if (!isInstanceRuntimeCurrent(instanceId, instance)) return
    const reconnectAuthority = claimHydrationAuthority(instanceId)
    const hasCommitAuthority = () => hasHydrationAuthority(instanceId, reconnectAuthority) &&
      isInstanceRuntimeCurrent(instanceId, instance)
    if (!hasCommitAuthority()) return
    const worktreeTopologyComplete = await retryWithBackoff((signal) => reloadWorktrees(instanceId, signal), {
      maxAttempts: 1,
      timeoutMs: RECONNECT_LIST_TIMEOUT_MS,
    }).catch((error) => {
      log.warn("Failed to refresh worktrees after instance connection", { instanceId, error })
      return false
    })
    if (!hasCommitAuthority()) return
    await reloadOpenCodeWorkspaces(instanceId)
    if (!hasCommitAuthority()) return
    const sessionScopeComplete = worktreeTopologyComplete && (await getV2RequestLocations(instanceId, true)).complete
    const refreshedSessionIds = await retryWithBackoff((signal) => fetchSessions(instanceId, {
      reset: false,
      authoritativeDeletes: sessionScopeComplete,
      signal,
      hasCommitAuthority,
    }), { maxAttempts: 1, timeoutMs: RECONNECT_LIST_TIMEOUT_MS }).catch((error) => {
      log.warn("Failed to refresh sessions after instance connection", { instanceId, error })
      return new Set<string>()
    })
    if (!hasCommitAuthority()) return
    const interruptionSyncs = await Promise.allSettled([
      retryWithBackoff((signal) => syncPendingPermissions(instanceId, instance, signal, worktreeTopologyComplete), {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 200,
        timeoutMs: RECONNECT_LIST_TIMEOUT_MS,
      }),
      retryWithBackoff((signal) => syncPendingQuestions(instanceId, instance, signal, worktreeTopologyComplete), {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 200,
        timeoutMs: RECONNECT_LIST_TIMEOUT_MS,
      }),
    ])
    for (const result of interruptionSyncs) {
      if (result.status === "rejected") log.warn("Failed to resync pending requests after instance connection", { instanceId, error: result.reason })
    }
    if (!hasCommitAuthority()) return
    const residentSessionIds = messageStoreBus.getInstance(instanceId)?.getResidentSessionIds() ?? []
    const activeId = activeSessionId().get(instanceId)
    const visibleSessionIds = getVisibleSessionMemoryIds(instanceId)
    const reloadSessionIds = new Set(visibleSessionIds)
    if (activeId) reloadSessionIds.add(activeId)
    const knownSessions = sessions().get(instanceId)
    for (const sessionId of new Set([...residentSessionIds, ...reloadSessionIds])) {
      if (knownSessions?.has(sessionId)) invalidateSessionMessageLoad(instanceId, sessionId)
    }
    await Promise.all(Array.from(reloadSessionIds)
      .filter((sessionId) => knownSessions?.has(sessionId))
      .map((sessionId) => loadMessages(instanceId, sessionId, {
        force: true,
        timeoutMs: RECONNECT_LIST_TIMEOUT_MS,
        applySessionRevert: refreshedSessionIds.has(sessionId),
      })))
  },
  (instanceId, error) => {
    log.warn("Failed to resync sessions after instance connection", { instanceId, error })
  },
)

function resyncConnectedInstance(instanceId: string): void {
  void connectionResyncs.request(instanceId)
}

sseManager.onConnectionRestored = (instanceId) => {
  if (disconnectedInstance()?.id === instanceId) {
    setDisconnectedInstance(null)
  }
  resyncConnectedInstance(instanceId)
}

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
    new Set(questionRegistry.sessionIds(instanceId)),
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

function ensureActiveInstanceSelected(): void {
  if (appSessionRestoreGateActive()) return
  if (activeSidecarToken()) return

  const current = activeInstanceId()
  const instanceMap = instances()
  if (current && instanceMap.has(current)) return

  for (const [id, instance] of instanceMap.entries()) {
    if (instance.status === "ready") {
      setActiveInstanceId(id)
      return
    }
  }
}

function upsertWorkspace(descriptor: WorkspaceDescriptor, projectName?: string) {
  const mapped = workspaceDescriptorToInstance(descriptor, projectName)
  if (instances().has(descriptor.id)) {
    const { client: _client, port: _port, proxyPath: _proxyPath, ...metadata } = mapped
    updateInstance(descriptor.id, metadata)
  } else {
    addInstance(mapped)
  }

  if (descriptor.status === "ready") {
    attachClient(descriptor)
    // If no tab is currently selected (common after UI refresh),
    // auto-select the first ready instance.
    ensureActiveInstanceSelected()
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
  const runtimeChanged = Boolean(instance.client && (
    (descriptor.pid && instance.attachedPid !== descriptor.pid) || instance.proxyPath !== nextProxyPath
  ))

  if (!runtimeChanged && instance.client && instance.proxyPath === nextProxyPath) {
    if (nextPort && instance.port !== nextPort) {
      updateInstance(descriptor.id, { port: nextPort })
    }
    return
  }

  if (instance.client) {
    initialHydrations.get(descriptor.id)?.controller.abort(new Error("Instance runtime replaced"))
    clearOpenCodeWorkspaceCache(descriptor.id)
    clearPendingDeltasForInstance(descriptor.id)
    if (runtimeChanged) clearReloadableInstanceState(descriptor.id)
    sdkManager.destroyClientsForInstance(descriptor.id)
  }

  const client = sdkManager.createClient(descriptor.id, nextProxyPath)
  updateInstance(descriptor.id, {
    client,
    port: nextPort ?? 0,
    proxyPath: nextProxyPath,
    attachedPid: descriptor.pid ?? instance.pid,
    status: "ready",
  })
  sseManager.seedStatusIfMissing(descriptor.id, "connecting")
  const controller = new AbortController()
  const authority = claimHydrationAuthority(descriptor.id)
  const hasCommitAuthority = () => hasHydrationAuthority(descriptor.id, authority)
  const sessionHydration = startInstanceSessionHydration(descriptor.id, false, controller.signal, hasCommitAuthority)
  initialSessionHydrations.set(descriptor.id, sessionHydration.sessions)
  initialWorkspaceMetadataHydrations.set(descriptor.id, sessionHydration.workspaceMetadata)
  const hydration = hydrateInstanceData(descriptor.id, {
    propagateErrors: true,
    sessionHydration: sessionHydration.sessions,
    workspaceMetadataHydration: sessionHydration.workspaceMetadata,
    signal: controller.signal,
    hasCommitAuthority,
  })
  initialHydrations.set(descriptor.id, { promise: hydration, controller, authority })
  if (sseManager.getStatuses().get(descriptor.id) === "connected") {
    resyncConnectedInstance(descriptor.id)
  }
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
  await initialHydrations.get(instanceId)?.promise
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
  clearOpenCodeWorkspaceCache(instanceId)
  sseManager.seedStatus(instanceId, "disconnected")
}

async function syncPendingPermissions(instanceId: string, expectedInstance?: Instance, signal?: AbortSignal, topologyComplete = true): Promise<void> {
  const instance = expectedInstance ?? instances().get(instanceId)
  if (!instance?.client) return
  const isCurrent = () => isInstanceRuntimeCurrent(instanceId, instance) && !signal?.aborted
  if (!isCurrent()) return

  try {
    const syncStartedAt = Date.now()
    const mutationVersion = permissionRegistry.snapshotMutationVersion()
    const remote: Array<{ request: PermissionRequest; source: PermissionSource }> = []
    let requestFailed = false
    try {
      const legacyRemote = await requestData<PermissionRequest[]>(
        (instance.client.permission.list as any)(undefined, signal ? { signal } : undefined),
        "permission.list",
      )
      if (!isCurrent()) return
      for (const permission of legacyRemote) remote.push({ request: permission, source: "legacy" })
    } catch (error) {
      if (!isCurrent()) return
      requestFailed = true
      log.warn("Failed to sync legacy pending permissions", { instanceId, error })
    }

    const locationSnapshot = await getV2RequestLocations(instanceId, topologyComplete)
    if (!isCurrent()) return
    let complete = locationSnapshot.complete && !requestFailed
    for (const location of locationSnapshot.locations) {
      try {
        const response = await requestData<{ location?: unknown; data: PermissionRequest[] }>(
          (instance.client.v2.permission.request.list as any)({ location }, signal ? { signal } : undefined),
          "v2.permission.request.list",
        )
        if (!isCurrent()) return
        log.info("v2.permission.request.list", { instanceId, location, resolvedLocation: response.location })
        for (const permission of response.data) remote.push({ request: permission, source: "v2" })
      } catch (error) {
        if (!isCurrent()) return
        complete = false
        requestFailed = true
        log.warn("Failed to sync a permission request location", { instanceId, location, error })
      }
    }

    if (!isCurrent()) return
    const remotePendingIds = new Set(remote.map((item) => item.request.id))
    if (complete) pruneRepliedPermissions(instanceId, remotePendingIds, syncStartedAt)

    const pendingRemote = remote.filter((item) => !hasRepliedPermission(instanceId, item.request.id))
    const remoteIds = new Set(pendingRemote.map((item) => item.request.id))
    const local = getPermissionQueue(instanceId)

    if (complete) {
      for (const entry of local) {
        if (!remoteIds.has(entry.id) && !permissionRegistry.wasMutatedAfter(entry.id, mutationVersion)) {
          markPermissionReplied(instanceId, entry.id)
          removePermissionFromQueue(instanceId, entry.id)
          removePermissionV2(instanceId, entry.id)
        }
      }
    }

    // Upsert all server-side pending permissions.
    for (const { request: permission, source } of pendingRemote) {
      const queuedPermission = addPermissionToQueue(instanceId, permission, source) ?? permission
      upsertPermissionV2(instanceId, queuedPermission)
    }
    reconcilePendingSessionIndicators(instanceId)
    if (requestFailed) throw new Error("One or more permission request locations failed")
  } catch (error) {
    log.warn("Failed to sync pending permissions", { instanceId, error })
    throw error
  }
}

async function syncPendingQuestions(instanceId: string, expectedInstance?: Instance, signal?: AbortSignal, topologyComplete = true): Promise<void> {
  const instance = expectedInstance ?? instances().get(instanceId)
  if (!instance?.client) return
  const isCurrent = () => isInstanceRuntimeCurrent(instanceId, instance) && !signal?.aborted
  if (!isCurrent()) return

  try {
    const syncStartedAt = Date.now()
    const mutationVersion = questionRegistry.snapshotMutationVersion()
    const remote: Array<{ request: QuestionRequest; source: QuestionSource }> = []
    let requestFailed = false
    try {
      const legacyRemote = await requestData<QuestionRequest[]>(
        (instance.client.question.list as any)(undefined, signal ? { signal } : undefined),
        "question.list",
      )
      if (!isCurrent()) return
      for (const request of legacyRemote) remote.push({ request, source: "legacy" })
    } catch (error) {
      if (!isCurrent()) return
      requestFailed = true
      log.warn("Failed to sync legacy pending questions", { instanceId, error })
    }

    const locationSnapshot = await getV2RequestLocations(instanceId, topologyComplete)
    if (!isCurrent()) return
    let complete = locationSnapshot.complete && !requestFailed
    for (const location of locationSnapshot.locations) {
      try {
        const response = await requestData<{ location?: unknown; data: QuestionRequest[] }>(
          (instance.client.v2.question.request.list as any)({ location }, signal ? { signal } : undefined),
          "v2.question.request.list",
        )
        if (!isCurrent()) return
        log.info("v2.question.request.list", { instanceId, location, resolvedLocation: response.location })
        for (const request of response.data) remote.push({ request, source: "v2" })
      } catch (error) {
        if (!isCurrent()) return
        complete = false
        requestFailed = true
        log.warn("Failed to sync a question request location", { instanceId, location, error })
      }
    }

    if (!isCurrent()) return
    const remotePendingIds = new Set(remote.map((item) => item.request.id))
    if (complete) pruneAnsweredQuestions(instanceId, remotePendingIds, syncStartedAt)
    const pendingRemote = remote.filter((item) => !hasAnsweredQuestion(instanceId, item.request.id))
    const remoteIds = new Set(pendingRemote.map((item) => item.request.id))
    const local = getQuestionQueue(instanceId)

    if (complete) {
      for (const entry of local) {
        if (!remoteIds.has(entry.id) && !questionRegistry.wasMutatedAfter(entry.id, mutationVersion)) {
          markQuestionAnswered(instanceId, entry.id)
          removeQuestionFromQueue(instanceId, entry.id)
          removeQuestionV2(instanceId, entry.id)
        }
      }
    }

    // Upsert all server-side pending questions.
    for (const { request, source } of pendingRemote) {
      questionRegistry.ensureEnqueuedAt(request)
      addQuestionToQueue(instanceId, request, source)
      upsertQuestionV2(instanceId, request)
    }
    reconcilePendingSessionIndicators(instanceId)
    if (requestFailed) throw new Error("One or more question request locations failed")
  } catch (error) {
    log.warn("Failed to sync pending questions", { instanceId, error })
    throw error
  }
}

function startInstanceSessionHydration(
  instanceId: string,
  force = false,
  signal?: AbortSignal,
  hasCommitAuthority: () => boolean = () => true,
): {
  sessions: Promise<void>
  workspaceMetadata: Promise<void>
} {
  const worktreeMapHydration = force
    ? reloadWorktreeMap(instanceId)
    : ensureWorktreeMapLoaded(instanceId)
  const worktreeHydration = force
    ? reloadWorktrees(instanceId, signal)
    : ensureWorktreesLoaded(instanceId, signal)
  const sessions = Promise.all([worktreeHydration, worktreeMapHydration]).then(async () => {
    signal?.throwIfAborted()
    if (!hasCommitAuthority()) return
    resetSessionPagination(instanceId)
    await fetchSessions(instanceId, { signal, hasCommitAuthority }).catch((error) => {
      log.error("Failed to hydrate sessions", { instanceId, error })
    })
    signal?.throwIfAborted()
  })
  const workspaceMetadata = worktreeHydration.then(async () => {
    signal?.throwIfAborted()
    if (!hasCommitAuthority()) return
    await Promise.all([worktreeMapHydration, syncOpenCodeWorkspaces(instanceId)])
  })
  return { sessions, workspaceMetadata }
}

async function hydrateInstanceData(instanceId: string, options?: {
  force?: boolean
  propagateErrors?: boolean
  sessionHydration?: Promise<void>
  workspaceMetadataHydration?: Promise<void>
  signal?: AbortSignal
  hasCommitAuthority?: () => boolean
}) {
  const hasCommitAuthority = () => !options?.signal?.aborted && (options?.hasCommitAuthority?.() ?? true)
  try {
    const hydration = options?.sessionHydration
      ? {
          sessions: options.sessionHydration,
          workspaceMetadata: options.workspaceMetadataHydration ?? Promise.resolve(),
        }
      : startInstanceSessionHydration(instanceId, options?.force, options?.signal, hasCommitAuthority)
    await hydration.sessions
    if (!hasCommitAuthority()) return
    await hydration.workspaceMetadata
    if (!hasCommitAuthority()) return
    await fetchAgents(instanceId, options?.signal, hasCommitAuthority)
    if (!hasCommitAuthority()) return
    await fetchProviders(instanceId, options?.signal, hasCommitAuthority)
    if (!hasCommitAuthority()) return
    await ensureInstanceConfigLoaded(instanceId)
    if (!hasCommitAuthority()) return
    const instance = instances().get(instanceId)
    if (!instance?.client) return
    await fetchCommands(
      instanceId,
      instance.client,
      () => hasCommitAuthority() && isInstanceRuntimeCurrent(instanceId, instance),
      options?.signal,
    )
    if (!hasCommitAuthority()) return
    await Promise.all([
      syncPendingPermissions(instanceId, instance, options?.signal),
      syncPendingQuestions(instanceId, instance, options?.signal),
    ])
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
  resetInstanceSessionRequestState(instanceId)
  clearCacheForInstance(instanceId)
  clearCommands(instanceId)
  clearInstanceMetadata(instanceId)
  messageStoreBus.clearInstanceScrollSnapshots(instanceId)
  clearPermissionQueue(instanceId)
  clearRepliedPermissions(instanceId)
  clearQuestionQueue(instanceId)
  answeredQuestionIdsByInstance.delete(instanceId)
}

async function rehydrateInstance(instanceId: string, options?: { reason?: string }): Promise<void> {
  if (pendingRehydrations.has(instanceId)) {
    return pendingRehydrations.get(instanceId)
  }

  const instance = instances().get(instanceId)
  const promise = (async () => {
    if (!instance?.client) {
      return
    }

    log.info("Rehydrating instance", { instanceId, reason: options?.reason })
    clearReloadableInstanceState(instanceId)

    await hydrateInstanceData(instanceId, { force: true })
    if (!isInstanceRuntimeCurrent(instanceId, instance)) return
  })().finally(() => {
    if (pendingRehydrations.get(instanceId) === promise) pendingRehydrations.delete(instanceId)
  })

  pendingRehydrations.set(instanceId, promise)
  return promise
}

async function disposeInstance(instanceId: string): Promise<boolean> {
  if (pendingDisposeRequests.has(instanceId)) {
    return pendingDisposeRequests.get(instanceId)!
  }

  const instance = instances().get(instanceId)
  const promise = (async () => {
    const ok = await postInstanceDispose(instanceId)
    if (ok && isInstanceRuntimeCurrent(instanceId, instance)) {
      await rehydrateInstance(instanceId, { reason: "disposed" })
    }
    return ok
  })().finally(() => {
    if (pendingDisposeRequests.get(instanceId) === promise) pendingDisposeRequests.delete(instanceId)
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
    ensureActiveInstanceSelected()
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
  } finally {
    workspaceListInitialized = true
  }
})()
let latestWorkspaceLoad = initialWorkspaceLoad

serverEvents.onOpen(() => {
  latestWorkspaceLoad = refreshWorkspaceList().then(
    () => ({}),
    (error) => {
      log.warn("Failed to reconcile workspaces after event reconnect", error)
      return { error }
    },
  )
})

async function waitForInitialWorkspaceLoad(): Promise<void> {
  let load = initialWorkspaceLoad
  while (true) {
    const result = await load
    if (result.error !== undefined) throw result.error
    if (load === latestWorkspaceLoad) return
    load = latestWorkspaceLoad
  }
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
  setInstances((prev) => {
    const next = new Map(prev)
    next.set(instance.id, { ...instance, runtimeToken: Symbol(instance.id) })
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
      next.set(id, {
        ...instance,
        ...updates,
        runtimeToken: (updates.client !== undefined && updates.client !== instance.client) ||
          (updates.pid !== undefined && updates.pid !== instance.pid) ||
          (updates.proxyPath !== undefined && updates.proxyPath !== instance.proxyPath)
          ? Symbol(id)
          : instance.runtimeToken,
      })
    }
    return next
  })
  syncHasInstancesFlag()
}

function isInstanceRuntimeCurrent(instanceId: string, captured: Instance | undefined): boolean {
  const current = instances().get(instanceId)
  return Boolean(current && captured && current.runtimeToken === captured.runtimeToken)
}

function removeInstance(id: string, options: { authoritative?: boolean } = {}) {
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
  clearQuestionQueue(id)
  answeredQuestionIdsByInstance.delete(id)
  clearInstanceMetadata(id)
  clearPermissionAutoAcceptForInstance(id)
  clearSyncedYoloSessionsForInstance(id)
  initialHydrations.get(id)?.controller.abort(new Error(`Workspace ${id} was removed`))
  initialHydrations.delete(id)
  initialSessionHydrations.delete(id)
  initialWorkspaceMetadataHydrations.delete(id)
  pendingDisposeRequests.delete(id)
  pendingRehydrations.delete(id)
  hydrationAuthorities.delete(id)
  settleInstanceReadyWaiters(id, new Error(`Workspace ${id} was removed before it became ready`))

  if (activeInstanceId() === id) {
    setActiveInstanceId(nextActiveId)
  }

  // Clean up session indexes and drafts for removed instance
  clearCacheForInstance(id)
  messageStoreBus.unregisterInstance(id)
  clearInstanceDraftPrompts(id)
  clearSessionListRequestState(id)
  clearInstanceAttachments(id)
  clearInstanceDeletedSessionAuthority(id)
  clearInstanceSessionExpansionState(id)
  clearInstanceSessionSelection(id)
  purgeInstanceSessionState(id)
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
  binaryPath?: string,
  projectName?: string,
  options?: {
    activate?: boolean
    signal?: AbortSignal
    shouldCreateCommit?: () => boolean
    onCreateCommit?: (instanceId: string) => void
    waitForCreateCommit?: () => Promise<void>
    forceNew?: boolean
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
      binaryPath,
      requestId: restoreRequestId,
      forceNew: options?.forceNew,
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
      upsertWorkspace(committedWorkspace, reused ? undefined : projectName)
      options?.onCreateCommit?.(workspace.id)
      if (!reused && (options?.activate ?? true)) setActiveInstanceId(workspace.id)
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

function stopInstance(id: string) {
  const instance = instances().get(id)
  if (!instance) return

  workspaceListReconciliationFence.markMutation(id)
  releaseInstanceResources(id)
  removeInstance(id)

  if (restoreCreatedWorkspaceCleanup.owns(id)) {
    void restoreCreatedWorkspaceCleanup.discardTracked(id, { retainTombstone: true })
      .then(() => serverApi.deleteWorkspace(id))
      .catch((error) => log.error("Failed to stop restore-tracked workspace", error))
    return
  }

  void serverApi.deleteWorkspace(id).catch((error) => {
    log.error("Failed to stop workspace", error)
    showToastNotification({
      message: tGlobal("app.stopInstance.toast.error"),
      variant: "error",
    })
  })
}

async function fetchLspStatus(instanceId: string): Promise<LspStatus[] | undefined> {
  const instance = instances().get(instanceId)
  if (!instance) {
    log.warn("[LSP] Skipping status fetch; instance not found", { instanceId })
    return undefined
  }
  if (!instance.client) {
    log.warn("[LSP] Skipping status fetch; client not ready", { instanceId })
    return undefined
  }
  const lsp = instance.client.lsp
  if (!lsp?.status) {
    log.warn("[LSP] Skipping status fetch; API unavailable", { instanceId })
    return undefined
  }
  log.info("lsp.status", { instanceId })
  return await requestData<LspStatus[]>(lsp.status(), "lsp.status")
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

function getQuestionQueue(instanceId: string): QuestionRequest[] {
  const queue = questionQueues().get(instanceId)
  if (!queue) {
    return []
  }
  return queue
}

function getQuestionQueueLength(instanceId: string): number {
  return getQuestionQueue(instanceId).length
}

function getQuestionEnqueuedAtForInstance(instanceId: string, requestId: string): number {
  // Ensure we have a stable timestamp for sorting/ordering.
  const queue = getQuestionQueue(instanceId)
  const match = queue.find((q) => q.id === requestId)
  if (match) {
    return questionRegistry.ensureEnqueuedAt(match)
  }
  return questionRegistry.enqueuedAtFor(requestId)
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
  const questions = getQuestionQueue(instanceId)
  const firstPermission = permissions[0]
  const firstQuestion = questions[0]
  if (!firstPermission && !firstQuestion) return null
  if (firstPermission && !firstQuestion) return { kind: "permission", id: firstPermission.id }
  if (firstQuestion && !firstPermission) return { kind: "question", id: firstQuestion.id }

  const permTime = firstPermission ? permissionRegistry.ensureEnqueuedAt(firstPermission) : Number.MAX_SAFE_INTEGER
  const quesTime = firstQuestion ? questionRegistry.ensureEnqueuedAt(firstQuestion) : Number.MAX_SAFE_INTEGER
  if (permTime <= quesTime) return { kind: "permission", id: firstPermission.id }
  return { kind: "question", id: firstQuestion!.id }
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

  setActiveQuestionId((prev) => {
    const next = new Map(prev)
    if (nextActive?.kind === "question") {
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

function addPermissionToQueue(instanceId: string, permission: PermissionRequest, source?: PermissionSource): PermissionRequest | undefined {
  let inserted = false
  let updated = false
  let previousPermission: PermissionRequest | undefined
  let queuedPermission = permission
  permissionRegistry.markMutation(permission.id)
  if (source) permissionRegistry.setSource(instanceId, permission.id, source)

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

function addQuestionToQueue(instanceId: string, request: QuestionRequest, source: QuestionSource = "v2"): void {
  let inserted = false
  questionRegistry.markMutation(request.id)
  questionRegistry.setSource(instanceId, request.id, source)

  setQuestionQueues((prev) => {
    const next = new Map(prev)
    const queue = next.get(instanceId) ?? ([] as QuestionRequest[])

    if (queue.some((q) => q.id === request.id)) {
      return next
    }

    questionRegistry.ensureEnqueuedAt(request)
    const updatedQueue = [...queue, request].sort((a, b) => {
      return questionRegistry.ensureEnqueuedAt(a) - questionRegistry.ensureEnqueuedAt(b)
    })
    next.set(instanceId, updatedQueue)
    inserted = true
    return next
  })

  if (!inserted) {
    return
  }

  recomputeActiveInterruption(instanceId)

  const sessionId = getQuestionSessionId(request)
  if (sessionId) {
    questionRegistry.increment(instanceId, sessionId)
    setSessionPendingQuestion(instanceId, sessionId, true)

  }
}

function removeQuestionFromQueue(instanceId: string, requestId: string): void {
  const removedSessionId = getQuestionSessionId(getQuestionQueue(instanceId).find((q) => q.id === requestId))

  setQuestionQueues((prev) => {
    const next = new Map(prev)
    const queue = next.get(instanceId) ?? ([] as QuestionRequest[])
    const filtered = queue.filter((item) => item.id !== requestId)

    if (filtered.length > 0) {
      next.set(instanceId, filtered)
    } else {
      next.delete(instanceId)
    }
    return next
  })

  questionRegistry.remove(instanceId, requestId)
  recomputeActiveInterruption(instanceId)

  if (removedSessionId) {
    const remaining = questionRegistry.decrement(instanceId, removedSessionId)
    setSessionPendingQuestion(instanceId, removedSessionId, remaining > 0)
  }
}

function clearQuestionQueue(instanceId: string): void {
  questionRegistry.clear(instanceId, getQuestionQueue(instanceId), (sessionId) => {
    setSessionPendingQuestion(instanceId, sessionId, false)
  })
  setQuestionQueues((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  setActiveQuestionId((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  recomputeActiveInterruption(instanceId)
}

function markQuestionAnswered(instanceId: string, requestId: string, answeredAt = Date.now()): void {
  if (!requestId) return
  const answered = answeredQuestionIdsByInstance.get(instanceId) ?? new Map<string, AnsweredQuestion>()
  pruneExpiredAnsweredQuestions(answered, answeredAt)
  answered.delete(requestId)
  answered.set(requestId, { answeredAt, missingPasses: 0 })
  while (answered.size > MAX_ANSWERED_QUESTION_TOMBSTONES) answered.delete(answered.keys().next().value!)
  answeredQuestionIdsByInstance.set(instanceId, answered)
}

function hasAnsweredQuestion(instanceId: string, requestId: string, now = Date.now()): boolean {
  const answered = answeredQuestionIdsByInstance.get(instanceId)
  if (!answered) return false
  pruneExpiredAnsweredQuestions(answered, now)
  if (answered.size === 0) answeredQuestionIdsByInstance.delete(instanceId)
  return answered.has(requestId)
}

function pruneAnsweredQuestions(instanceId: string, remotePendingIds: Set<string>, syncStartedAt: number): void {
  const answered = answeredQuestionIdsByInstance.get(instanceId)
  if (!answered) return
  pruneExpiredAnsweredQuestions(answered, syncStartedAt)
  for (const [requestId, state] of answered) {
    if (remotePendingIds.has(requestId)) {
      state.missingPasses = 0
      continue
    }
    if (syncStartedAt < state.answeredAt) continue
    if (state.missingPasses > 0) answered.delete(requestId)
    else state.missingPasses += 1
  }
  if (answered.size === 0) answeredQuestionIdsByInstance.delete(instanceId)
}

function pruneExpiredAnsweredQuestions(answered: Map<string, AnsweredQuestion>, now: number): void {
  for (const [requestId, state] of answered) {
    if (now - state.answeredAt < ANSWERED_QUESTION_TOMBSTONE_TTL_MS) break
    answered.delete(requestId)
  }
}

function clearSessionInterruptions(instanceId: string, sessionId: string): void {
  for (const permission of [...getPermissionQueue(instanceId)]) {
    if (getPermissionSessionId(permission) !== sessionId) continue
    removePermissionFromQueue(instanceId, permission.id)
    removePermissionV2(instanceId, permission.id)
  }
  for (const question of [...getQuestionQueue(instanceId)]) {
    if (getQuestionSessionId(question) !== sessionId) continue
    removeQuestionFromQueue(instanceId, question.id)
    removeQuestionV2(instanceId, question.id)
  }
}

function setActivePermissionIdForInstance(instanceId: string, permissionId: string): void {
  setActiveInterruptionForInstance(instanceId, { kind: "permission", id: permissionId })
}

function setActiveQuestionIdForInstance(instanceId: string, requestId: string): void {
  setActiveInterruptionForInstance(instanceId, { kind: "question", id: requestId })
}

async function sendQuestionReply(
  instanceId: string,
  sessionId: string,
  requestId: string,
  answers: string[][],
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  try {
    const client = getRootClient(instanceId)
    const source = questionRegistry.getSource(instanceId, requestId)

    if (source === "legacy") {
      const workspace = sessionId ? await getOpenCodeWorkspaceIdForSession(instanceId, sessionId) : null
      if (!isInstanceRuntimeCurrent(instanceId, instance)) return
      await requestData(
        client.question.reply({
          requestID: requestId,
          ...(workspace ? { workspace } : {}),
          answers,
        }),
        "question.reply",
      )
    } else {
      await requestData(
        client.v2.session.question.reply({
          sessionID: sessionId,
          requestID: requestId,
          questionV2Reply: { answers },
        }),
        "v2.session.question.reply",
      )
    }

    if (!isInstanceRuntimeCurrent(instanceId, instance)) return
    markQuestionAnswered(instanceId, requestId)
    removeQuestionFromQueue(instanceId, requestId)
    removeQuestionV2(instanceId, requestId)
  } catch (error) {
    log.error("Failed to send question reply", error)
    throw error
  }
}

async function sendQuestionReject(instanceId: string, sessionId: string, requestId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  try {
    const client = getRootClient(instanceId)
    const source = questionRegistry.getSource(instanceId, requestId)

    if (source === "legacy") {
      const workspace = sessionId ? await getOpenCodeWorkspaceIdForSession(instanceId, sessionId) : null
      if (!isInstanceRuntimeCurrent(instanceId, instance)) return
      await requestData(
        client.question.reject({
          requestID: requestId,
          ...(workspace ? { workspace } : {}),
        }),
        "question.reject",
      )
    } else {
      await requestData(
        client.v2.session.question.reject({
          sessionID: sessionId,
          requestID: requestId,
        }),
        "v2.session.question.reject",
      )
    }

    if (!isInstanceRuntimeCurrent(instanceId, instance)) return
    markQuestionAnswered(instanceId, requestId)
    removeQuestionFromQueue(instanceId, requestId)
    removeQuestionV2(instanceId, requestId)
  } catch (error) {
    log.error("Failed to send question reject", error)
    throw error
  }
}

async function sendPermissionResponse(
  instanceId: string,
  sessionId: string,
  requestId: string,
  reply: PermissionReply,
  message?: string,
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  try {
    const client = getRootClient(instanceId)
    const source = permissionRegistry.getSource(instanceId, requestId)

    if (source === "legacy") {
      const workspace = sessionId ? await getOpenCodeWorkspaceIdForSession(instanceId, sessionId) : null
      if (!isInstanceRuntimeCurrent(instanceId, instance)) return
      await requestData(
        client.permission.reply({
          requestID: requestId,
          ...(workspace ? { workspace } : {}),
          reply,
          ...(message ? { message } : {}),
        }),
        "permission.reply",
      )
    } else {
      await requestData(
        client.v2.session.permission.reply({
          sessionID: sessionId,
          requestID: requestId,
          reply,
          ...(message ? { message } : {}),
        }),
        "v2.session.permission.reply",
      )
    }

    if (!isInstanceRuntimeCurrent(instanceId, instance)) return
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

sseManager.onLspUpdated = async (instanceId) => {
  log.info("lsp.updated", { instanceId })
  try {
    const lspStatus = await fetchLspStatus(instanceId)
    if (!lspStatus) {
      return
    }
    mergeInstanceMetadata(instanceId, { lspStatus })
  } catch (error) {
    log.error("Failed to refresh LSP status", error)
  }
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

  try {
    stopInstance(pending.id)
  } catch (error) {
    log.error("Failed to stop disconnected instance", error)
  } finally {
    setDisconnectedInstance(null)
  }
}

export {
  instances,
  activeInstanceId,
  setActiveInstanceId,
  addInstance,
  updateInstance,
  isInstanceRuntimeCurrent,
  removeInstance,
  clearSessionInterruptions,
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
  // Permission + question management
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
  questionQueues,
  activeQuestionId,
  activeInterruption,
  getQuestionQueue,
  getQuestionQueueLength,
  getQuestionEnqueuedAtForInstance,
  addQuestionToQueue,
  hasAnsweredQuestion,
  markQuestionAnswered,
  removeQuestionFromQueue,
  clearQuestionQueue,
  sendQuestionReply,
  sendQuestionReject,
  setActiveQuestionIdForInstance,
  disconnectedInstance,
  acknowledgeDisconnectedInstance,
  fetchLspStatus,
  disposeInstance,
  reconcilePendingSessionIndicators,
  clearReloadableInstanceState,
}
