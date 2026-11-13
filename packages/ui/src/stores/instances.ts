import { createSignal } from "solid-js"
import type { Instance, LogEntry } from "../types/instance"
import type { PermissionReply, PermissionRequest } from "../types/permission"
import { getPermissionSessionId, mergePermissionRequest } from "../types/permission"
import { consumeFormAnswerInteraction, type FormAnswerInteraction } from "../lib/form-answer-interaction"
import { sseManager } from "../lib/sse-manager"
import { serverApi } from "../lib/api-client"
import { backendEvents as serverEvents } from "../lib/server-events"
import { captureBackendOperation } from "../lib/backend-operation"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import type { BackendEventPayload } from "../lib/backend-events"
import { backends, backendOf, type BackendClient } from "../lib/backend-client"
import { captureWorkspaceOperation, workspaceRequestKey, type WorkspaceOperationReceipt } from "./workspace-operation-receipt"
import type { WorkspaceDescriptor, WorkspaceLogEntry } from "../../../server/src/api-types"
import { PENDING_RECONCILIATION_HEADER, PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS } from "../../../server/src/api-types"
import { ensureInstanceConfigLoaded } from "./instance-config"
import {
  fetchSessions,
  loadMessages,
  fetchAgents,
  fetchProviders,
  getActiveCatalogLocation,
  refreshSessionCatalog,
  clearInstanceDraftPrompts,
  clearSessionListRequestState,
  clearSessionCatalogState,
  clearInstanceDeletedSessionAuthority,
  clearInstanceSessionExpansionState,
  clearInstanceSessionSelection,
} from "./sessions"
import { forgetSessionListRestoration } from "./session-list-restoration"
import {
  ensureWorktreesLoaded,
  getWorktrees,
  reloadWorktrees,
  getPendingWorktreeLocations,
  clearPendingWorktreeMoves,
} from "./worktrees"
import { getRootClient } from "./opencode-client"
import { refreshSessionRuntimeStatus } from "./session-api"
import { buildV2RequestLocations, locationAuthorityKey, locationWorkspaceID, requestLocationOptions, toRequestLocation, type RequestLocation } from "./request-locations"
import { backgroundReads } from "../lib/background-read-queue"
import { normalizeWorkspacePath, workspaceIdentity } from "./app-session-reconciliation"
import { claimPendingRecoveryNotice, pendingRecoveryNoticeKey, releasePendingRecoveryNotices } from "./pending-recovery-notices"
import { fetchCommands, clearCommands } from "./commands"
import { getInstanceRefreshTargets, type InstanceRefreshTarget } from "./instance-invalidation"
import { ConnectionResyncGate } from "./connection-resync-gate"
import { preferencesForBackend } from "./preferences"
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
import {
  applyOpenCodeDataEvent, destroyOpenCodeData, finishOpenCodeDataEvent, projectOpenCodeMessages, syncOpenCodeSessionInbox, type OpenCodeDataEventAdmission,
} from "./opencode-data"
import {
  cancelTranscriptProjections,
  scheduleTranscriptProjection,
  setTranscriptProjectionGates,
  takeTranscriptProjection,
} from "./opencode-projection-frame"
import { isSessionTranscriptVisible } from "./session-transcript-visibility"
import { updateSessionInfo } from "./message-v2/session-info"
import { isLatestWindow } from "./message-v2/message-window"
import { upsertPermissionV2, removePermissionV2, removeMessageV2 } from "./message-v2/bridge"
import {
  clearRepliedPermissions,
  hasRepliedPermission,
  markPermissionReplied,
} from "./permission-replies"
import { clearSettledForms, hasSettledForm, markFormSettled } from "./form-settlements"
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
import { getInstanceLabel } from "../lib/instance-label"
import { HttpResponseError } from "../lib/retryable-file-search"
import {
  batchIssue, combinePendingFailures, describePendingRecovery, hydrationCause, PendingRecoveryError, recoveryCauseOf, refusedDirectories,
  type PendingRecoveryCause, type RecoveryDirectory, type RecoverySnapshot,
} from "./pending-recovery-cause"
import { loadInstanceMetadata, loadInstanceProjectMetadata } from "../lib/hooks/use-instance-metadata"
import {
  addFormToQueue,
  clearFormQueue as clearStoredFormQueue,
  getFormQueue,
  formRequestOptions,
  removeFormFromQueue,
  type FormAnswer,
  type FormWithLocation,
} from "./forms"
import { invalidateFilesystemCaches, queueFilesystemInvalidation } from "../lib/filesystem-events"
import { detachInstanceTabMembership, openInstanceTabIds, requestInstanceTabClose } from "./app-tab-membership"
import { waitForLatestWorkspaceLoadResult } from "./workspace-load-readiness"
import { clearInstanceAttachments } from "./attachments"
import { clearInstanceSeenInterruptions } from "./session-interruption-seen"
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
import { BackendWorkspaceListReconciliationFence } from "./workspace-list-reconciliation-fence"
import { backendIdOf, instanceKey, LOCAL_BACKEND_ID, parseInstanceKey } from "../lib/backend-identity"
import type { BackendId } from "../lib/backend-transport"
import { usesClientState } from "../lib/runtime-env"

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
  yoloOperations.set(`${instanceId}:${sessionId}`, captureInstanceOperation(instanceId))
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
type RequestLocationRegistry = Map<string, Map<string, { key: string; location: RequestLocation }>>
const permissionRequestLocations: RequestLocationRegistry = new Map()
const formRequestLocations: RequestLocationRegistry = new Map()

type RequestAuthorityLocation = RequestLocation | { directory: string }

function requestLocationKey(location?: RequestAuthorityLocation | string): string | undefined {
  if (!location) return undefined
  if (typeof location === "string") return locationAuthorityKey({ directory: normalizeWorkspacePath(location) })
  if (!location.directory) return undefined
  return locationAuthorityKey({ ...location, directory: normalizeWorkspacePath(location.directory) })
}

function rememberRequestLocation(registry: RequestLocationRegistry, instanceId: string, requestId: string, location?: RequestAuthorityLocation | string): void {
  const key = requestLocationKey(location)
  if (!key) return
  const entries = registry.get(instanceId) ?? new Map<string, { key: string; location: RequestLocation }>()
  // Comparison keys are normalized, but dispatch must retain native spelling.
  entries.set(requestId, { key, location: typeof location === "string" ? { directory: location } : { ...location } })
  registry.set(instanceId, entries)
}

function forgetRequestLocation(registry: RequestLocationRegistry, instanceId: string, requestId: string): void {
  const entries = registry.get(instanceId)
  if (!entries) return
  entries.delete(requestId)
  if (!entries.size) registry.delete(instanceId)
}

function rememberedRequestLocation(registry: RequestLocationRegistry, instanceId: string, requestId: string): RequestLocation | undefined {
  return registry.get(instanceId)?.get(requestId)?.location
}

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

// Stop events whose instance cleanup waits for the tab to unmount.
const pendingWorkspaceStops = new Map<string, symbol>()
const initialHydrations = new Map<string, Promise<void>>()
const initialSessionHydrations = new Map<string, Promise<void>>()
const initialWorkspaceMetadataHydrations = new Map<string, Promise<void>>()
const pendingRequestSyncEpochs = new Map<string, number>()
const successfulPendingRecoveries = new Map<string, number>()
const pendingPermissionMutationEpochs = new Map<string, number>()
const pendingFormMutationEpochs = new Map<string, number>()
const pendingRequestSyncGenerations = new Map<string, number>()
const pendingRequestSyncs = new Map<string, {
  generation: number
  targeted: boolean
  token: { cancelled: boolean }
  promise: Promise<void>
}>()
const pendingRequestLiveness = new Map<string, Promise<void>>()
const pendingOperationOwners = new WeakMap<Promise<void>, () => boolean>()

function captureInstanceOperation(instanceId: string, parent?: AbortSignal) {
  const client = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  return captureBackendOperation(instanceId, parent, () => instances().get(instanceId)?.client === client
    && getOpenCodeInstanceGeneration(instanceId) === generation)
}
const pendingRequestControllers = new Map<string, Set<AbortController>>()
const [incompletePendingRecovery, setIncompletePendingRecovery] = createSignal<ReadonlySet<string>>(new Set())
export { incompletePendingRecovery }
const notifiedPendingRecovery = new Set<string>()
const failedPendingRecoveries = new Map<string, number>()
// A single incomplete scan usually recovers on the next 30-second liveness pass.
// Warn only when recovery stays incomplete across consecutive attempts.
const PENDING_RECOVERY_WARNING_ATTEMPTS = 2
function notifyPendingRecovery(instanceId: string, cause: PendingRecoveryCause): void {
  const instance = instances().get(instanceId)
  log.warn("Pending request recovery is incomplete", { instanceId, cause })
  // Name the sessions that made these directories required: active or holding a request.
  const sessionTitlesIn = (directories: readonly string[]) => {
    const wanted = new Set(directories.map(normalizeWorkspacePath))
    return Array.from(sessions().get(instanceId)?.values() ?? []).filter((session) => session.location?.directory
      && wanted.has(normalizeWorkspacePath(session.location.directory))
      && (session.status !== "idle" || session.pendingPermission || session.pendingForm))
      .map((session) => session.title || session.id)
  }
  const { title, message } = describePendingRecovery(cause, instance ? getInstanceLabel(instance) : instanceId, sessionTitlesIn, tGlobal)
  if (!claimPendingRecoveryNotice(pendingRecoveryNoticeKey(pendingRecoveryProject(instanceId), cause, message))) return
  // A project diagnostic, not a request itself: it keeps its bubble and History entry.
  showToastNotification({ category: "projects", title, message, variant: "warning" })
}

function pendingRecoveryProject(instanceId: string): string {
  const instance = instances().get(instanceId)
  return instance?.folder ? workspaceIdentity(instance.folder, instance.backendId) : instanceId
}

// A cause marks an attempt that counts toward the warning; without one, the state only changes.
function markPendingRecovery(instanceId: string, incomplete: boolean, cause?: PendingRecoveryCause): void {
  setIncompletePendingRecovery((previous) => {
    if (previous.has(instanceId) === incomplete) return previous
    const next = new Set(previous)
    if (incomplete) next.add(instanceId)
    else next.delete(instanceId)
    return next
  })
  if (!incomplete) {
    notifiedPendingRecovery.delete(instanceId)
    failedPendingRecoveries.delete(instanceId)
    return
  }
  if (!cause) return
  const failures = (failedPendingRecoveries.get(instanceId) ?? 0) + 1
  failedPendingRecoveries.set(instanceId, failures)
  if (failures >= PENDING_RECOVERY_WARNING_ATTEMPTS && !notifiedPendingRecovery.has(instanceId)) {
    notifiedPendingRecovery.add(instanceId)
    notifyPendingRecovery(instanceId, cause)
  }
}
const pendingRequestSyncSuperseded = new Error("Pending request sync was superseded")
const pendingDiscoveryDeferred = new Error("Pending discovery deferred during compaction")
type PendingCompaction = {
  client: NonNullable<Instance["client"]>; active: boolean; created: number; sequence?: number; signal: AbortSignal
}
const pendingCompactions = new Map<string, Map<string, PendingCompaction>>()
const deferredPendingDiscovery = new Map<string, ReturnType<typeof captureInstanceOperation>>()
let pendingDiscoveryResume: Promise<void> | undefined
let nextPendingRequestSyncGeneration = 0

function isPendingDiscoveryCompacting(): boolean {
  // ponytail: one daemon per backend; only observed compactions are known here.
  for (const instance of instances().values()) {
    const tracked = pendingCompactions.get(instance.id)
    if (Array.from(tracked?.values() ?? []).some((entry) => entry.active && !entry.signal.aborted)) return true
    if (!instance.client || instance.status !== "ready") continue
    if (Array.from(sessions().get(instance.id)?.values() ?? []).some((session) => session.status === "compacting" && !tracked?.has(session.id))) return true
  }
  return false
}

function deferPendingDiscovery(instanceId: string): boolean {
  if (!isPendingDiscoveryCompacting()) return false
  markPendingRecovery(instanceId, true)
  deferredPendingDiscovery.set(instanceId, captureInstanceOperation(instanceId))
  return true
}

function resumePendingDiscovery(): void {
  if (pendingDiscoveryResume || !deferredPendingDiscovery.size || isPendingDiscoveryCompacting()) return
  const owners = new Map(deferredPendingDiscovery)
  const resume = Promise.resolve().then(async () => {
    while (deferredPendingDiscovery.size && !isPendingDiscoveryCompacting()) {
      const id = deferredPendingDiscovery.keys().next().value!
      const operation = owners.get(id)
      if (!operation || deferredPendingDiscovery.get(id) !== operation) break
      if (!operation.current()) { deferredPendingDiscovery.delete(id); continue }
      await pendingRequestSyncs.get(id)?.promise.catch(() => {})
      if (!operation.current()) continue
      if (isPendingDiscoveryCompacting()) break
      if (deferredPendingDiscovery.get(id) !== operation) break
      if (!deferredPendingDiscovery.delete(id)) continue
      const instance = instances().get(id)
      if (instance?.client && instance.status === "ready") await syncPendingRequests(id, undefined, undefined, operation.signal).catch((error) => {
        log.warn("Failed to resume pending discovery after compaction", { instanceId: id, error })
      })
    }
  }).finally(() => {
    if (pendingDiscoveryResume === resume) pendingDiscoveryResume = undefined
    resumePendingDiscovery()
  })
  pendingDiscoveryResume = resume
}

function observePendingCompaction(instanceId: string, event: Parameters<NonNullable<typeof sseManager.onInvalidation>>[1]): void {
  const starting = event.type === "session.compaction.started" || event.type === "session.compaction.delta"
  if (!starting && event.type !== "session.compaction.ended" && event.type !== "session.compaction.failed") return
  const client = instances().get(instanceId)?.client
  if (!client || !("sessionID" in event.data)) return
  const id = event.data.sessionID
  const entries = pendingCompactions.get(instanceId) ?? new Map<string, PendingCompaction>()
  const captured = entries.get(id)
  const previous = captured && !captured.signal.aborted ? captured : undefined
  if (!starting && previous && (!previous.active || previous.client !== client)) return
  const sequence = "durable" in event ? event.durable.seq : undefined
  if (previous?.client === client && (sequence === undefined ? event.created <= previous.created
    : previous.sequence !== undefined && sequence <= previous.sequence)) return
  entries.set(id, { client, active: starting, created: Math.max(event.created, previous?.created ?? 0), sequence: sequence ?? previous?.sequence,
    signal: serverEvents.signalForInstance(instanceId) })
  pendingCompactions.set(instanceId, entries)
  if (starting) {
    for (const [id, sync] of pendingRequestSyncs) if (!sync.targeted) deferredPendingDiscovery.set(id, captureInstanceOperation(id))
  } else resumePendingDiscovery()
}

async function withPendingRequestTimeout<T>(instanceId: string, run: (signal: AbortSignal) => Promise<T>, background = true, timeoutMs = 10_000): Promise<T> {
  const operation = captureInstanceOperation(instanceId)
  operation.signal.throwIfAborted()
  const controller = new AbortController()
  const signal = AbortSignal.any([operation.signal, controller.signal])
  const controllers = pendingRequestControllers.get(instanceId) ?? new Set<AbortController>()
  controllers.add(controller)
  pendingRequestControllers.set(instanceId, controllers)
  try {
    const timed = async () => {
      signal.throwIfAborted()
      if (!operation.current()) throw pendingRequestSyncSuperseded
      // Check after background queue admission, immediately before dispatch.
      if (background && deferPendingDiscovery(instanceId)) throw pendingDiscoveryDeferred
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try { return await run(signal) }
      finally { clearTimeout(timeout) }
    }
    return await (background ? backgroundReads.run(signal, timed) : timed())
  } finally {
    controllers.delete(controller)
    if (!controllers.size && pendingRequestControllers.get(instanceId) === controllers) {
      pendingRequestControllers.delete(instanceId)
    }
  }
}

function abortPendingRequestWork(instanceId: string): void {
  for (const controller of pendingRequestControllers.get(instanceId) ?? []) controller.abort()
}

async function allSettledBounded<T, R>(
  items: readonly T[],
  isCurrent: () => boolean,
  run: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R> | undefined>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (isCurrent() && next < items.length) {
      const index = next++
      try {
        results[index] = { status: "fulfilled", value: await run(items[index]) }
      } catch (reason) {
        results[index] = { status: "rejected", reason }
      }
    }
  }))
  return results.filter((result): result is PromiseSettledResult<R> => result !== undefined)
}

function bumpEpoch(epochs: Map<string, number>, instanceId: string): void {
  epochs.set(instanceId, (epochs.get(instanceId) ?? 0) + 1)
}

function invalidatePendingRequestSync(instanceId: string): void {
  if (instances().has(instanceId)) markPendingRecovery(instanceId, true)
  bumpEpoch(pendingRequestSyncEpochs, instanceId)
  bumpEpoch(pendingPermissionMutationEpochs, instanceId)
  bumpEpoch(pendingFormMutationEpochs, instanceId)
}
type RestoreWorkspaceDescriptor = WorkspaceDescriptor & { reused?: boolean; receipt?: WorkspaceOperationReceipt }
const workspaceListReconciliationFence = new BackendWorkspaceListReconciliationFence()
const restoreCreationReceipts = new Map<string, WorkspaceOperationReceipt>()

function observeRestoreWorkspace(workspace: WorkspaceDescriptor): RestoreWorkspaceDescriptor | undefined {
  const backendId = parseInstanceKey(workspace.id).backendId
  const requestKey = workspace.requestId && workspaceRequestKey(backendId, workspace.requestId, serverEvents.signal(backendId))
  if (requestKey && restoreCreatedWorkspaceCleanup.shouldIgnoreObservation(workspace.id, requestKey, (workspace as RestoreWorkspaceDescriptor).reused)) return undefined
  const tracked = restoreCreatedWorkspaceCleanup.get(workspace.id, true)
  const receipt = requestKey
    ? restoreCreationReceipts.get(requestKey)
    : tracked?.receipt
  // An observation may enrich a claim only on its original attachment.
  return receipt?.attached() ? { ...workspace, requestId: workspace.requestId ?? receipt.requestId,
    ...(tracked?.reused ? { reused: true } : {}), receipt: Object.freeze({ ...receipt,
    rawId: parseInstanceKey(workspace.id).workspaceId, instanceId: workspace.id,
  }) } : workspace
}

const restoreCreatedWorkspaceCleanup = new AbortCreatedWorkspaceCleanup<RestoreWorkspaceDescriptor>({
  requestKey: workspace => workspace.receipt?.requestKey,
  isCurrent: workspace => workspace.receipt?.attached() === true,
  isCurrentKey: (id, key) => {
    const backendId = parseInstanceKey(id).backendId
    const [, requestId] = JSON.parse(key) as [string, string]
    return key === workspaceRequestKey(backendId, requestId, serverEvents.signal(backendId))
  },
  onSettled: workspace => {
    if (workspace.receipt) restoreCreationReceipts.delete(workspace.receipt.requestKey)
  },
  discardWorkspace: (workspace) => {
    if (!workspace.requestId) return Promise.reject(new Error(`Restore workspace ${workspace.id} has no creation request`))
    if (!workspace.receipt) return Promise.reject(new Error("Workspace creation owner unavailable"))
    return workspace.receipt.api.cancelWorkspaceCreation(workspace.requestId)
  },
  restoreWorkspace: (workspace) => {
    if (!workspace.receipt?.attached()) return false
    workspaceListReconciliationFence.markMutation(workspace.id)
    upsertWorkspace(workspace, undefined, workspace.receipt.backendId)
  },
  onPermanentFailure: (workspace, error) => {
    log.error("Failed to settle restore workspace ownership", {
      workspaceId: workspace.id,
      error,
    })
  },
})
let restoreCreationRequestSequence = 0
const restoreCreationCommitGates = new RestoreWorkspaceCommitGates<RestoreWorkspaceDescriptor>()

const connectionResyncs = new TrailingResyncCoordinator(
  async (instanceId, signal) => {
    await waitForSettledPrerequisite(initialHydrations.get(instanceId))
    signal.throwIfAborted()
    const instance = instances().get(instanceId)
    if (!instance?.client || instance.status !== "ready") return
    const current = () => !signal.aborted && instances().get(instanceId)?.client === instance.client
    let sessionError: unknown
    try {
      await fetchSessions(instanceId, { reset: true, signal })
    } catch (error) {
      sessionError = error
    }
    signal.throwIfAborted()
    if (!current()) return
    await Promise.all([
      reloadWorktrees(instanceId, false, signal),
      syncPendingRequests(instanceId, undefined, undefined, signal),
      refreshVolatileInstanceState(instanceId, undefined, signal),
      syncLoadedSessionInboxes(instanceId, signal),
    ])
    signal.throwIfAborted()
    if (!current()) return
    if (sessionError) throw sessionError
    const loadedMessages = messagesLoaded().get(instanceId) ?? new Set<string>()
    for (const sessionId of loadedMessages) {
      signal.throwIfAborted()
      if (!current()) return
      invalidateSessionMessageLoad(instanceId, sessionId)
    }
    const activeId = activeSessionId().get(instanceId)
    signal.throwIfAborted()
    if (!current()) return
    if (activeId && loadedMessages.has(activeId)) await loadMessages(instanceId, activeId, { force: true, signal })
    signal.throwIfAborted()
    if (!current()) return
    reconcilePendingSessionIndicators(instanceId)
  },
  (instanceId, error) => {
    log.warn("Failed to resync sessions after instance connection", { instanceId, error })
  },
)
const connectionResyncGate = new ConnectionResyncGate()

function resyncConnectedInstance(instanceId: string): void {
  void connectionResyncs.request(instanceId, serverEvents.signalForInstance(instanceId))
}

async function syncLoadedSessionInboxes(instanceId: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  const instance = instances().get(instanceId)
  if (!instance?.client || instance.status !== "ready") return
  const loaded = messagesLoaded().get(instanceId) ?? new Set<string>()
  await Promise.all(Array.from(loaded, async (sessionId) => {
    if (signal?.aborted) return
    const directory = sessions().get(instanceId)?.get(sessionId)?.location.directory ?? instance.folder
    try {
      await syncOpenCodeSessionInbox(instanceId, sessionId, directory, signal)
    } catch (error) {
      log.warn("Failed to resync session inbox after connection", { instanceId, sessionId, error })
    }
  }))
}

const allInstanceRefreshTargets: readonly InstanceRefreshTarget[] = ["agents", "providers", "commands", "metadata", "filesystem"]
const volatileInstanceRefreshes = new Map<string, { promise: Promise<void>; pending: Set<InstanceRefreshTarget>; signal?: AbortSignal; client: Instance["client"] }>()

function refreshVolatileInstanceState(
  instanceId: string,
  targets: readonly InstanceRefreshTarget[] = allInstanceRefreshTargets,
  signal = serverEvents.signalForInstance(instanceId),
): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  const existing = volatileInstanceRefreshes.get(instanceId)
  if (existing && !existing.signal?.aborted && existing.client === instances().get(instanceId)?.client) {
    for (const target of targets) existing.pending.add(target)
    return existing.promise
  }
  const instance = instances().get(instanceId)
  if (!instance?.client || instance.status !== "ready") return Promise.resolve()
  const client = instance.client

  const state = { promise: Promise.resolve(), pending: new Set(targets), signal, client }
  state.promise = (async () => {
    do {
      if (signal?.aborted || instances().get(instanceId)?.client !== client) return
      const current = new Set(state.pending)
      state.pending.clear()
      if (current.has("filesystem")) invalidateFilesystemCaches(instanceId)
      if (signal?.aborted) return
      const requests: Promise<unknown>[] = []
      const location = getActiveCatalogLocation(instanceId)
      if (current.has("agents")) requests.push(fetchAgents(instanceId, location, true))
      if (current.has("providers")) requests.push(fetchProviders(instanceId, location, true))
      if (current.has("commands")) requests.push(fetchCommands(instanceId, client, location))
      if (current.has("metadata")) {
        requests.push(loadInstanceMetadata(instance, { force: true, location }))
      }
      await Promise.all(requests)
      if (signal?.aborted || instances().get(instanceId)?.client !== client) return
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

function workspaceDescriptorToInstance(descriptor: WorkspaceDescriptor, projectName?: string, backendId: BackendId = LOCAL_BACKEND_ID): Instance {
  const existing = instances().get(descriptor.id)
  const environment = preferencesForBackend(backendId).serverSettings().environmentVariables
  return {
    id: descriptor.id,
    ...(backendId !== LOCAL_BACKEND_ID ? { backendId } : {}),
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
    environmentVariables: backendId === LOCAL_BACKEND_ID ? existing?.environmentVariables ?? environment ?? {} : environment,
    ...(descriptor.temporary ? { temporary: true } : {}),
  }
}

/** `descriptor.id` is the instance key of a workspace of `backendId`. */
function upsertWorkspace(descriptor: WorkspaceDescriptor, projectName?: string, backendId: BackendId = LOCAL_BACKEND_ID) {
  // A workspace (re)created after a stop event keeps its instance.
  pendingWorkspaceStops.delete(descriptor.id)
  const mapped = workspaceDescriptorToInstance(descriptor, projectName, backendId)
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
  const signal = serverEvents.signalForInstance(descriptor.id)
  if (signal.aborted) return
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
    backendOf(descriptor.id).sdk.destroyClientsForInstance(descriptor.id)
    destroyOpenCodeData(descriptor.id)
    cancelTranscriptProjections(descriptor.id)
  }

  const client = backendOf(descriptor.id).sdk.createClient(descriptor.id, nextProxyPath, () => activeInstanceId() === descriptor.id)
  updateInstance(descriptor.id, {
    client,
    port: nextPort ?? 0,
    proxyPath: nextProxyPath,
    status: "ready",
  })
  sseManager.seedStatusIfMissing(descriptor.id, "connecting")
  const sessionHydration = startInstanceSessionHydration(descriptor.id, false, signal)
  initialSessionHydrations.set(descriptor.id, sessionHydration.sessions)
  initialWorkspaceMetadataHydrations.set(descriptor.id, sessionHydration.workspaceMetadata)
  const recovered = successfulPendingRecoveries.get(descriptor.id)
  const hydration = hydrateInstanceData(descriptor.id, {
    propagateErrors: true,
    sessionHydration: sessionHydration.sessions,
    workspaceMetadataHydration: sessionHydration.workspaceMetadata,
    signal,
  })
  initialHydrations.set(descriptor.id, hydration)
  void hydration.catch((error) => {
    log.error("Failed to hydrate instance data", error)
    if (!signal.aborted && initialHydrations.get(descriptor.id) === hydration
      && instances().get(descriptor.id)?.client === client
      && successfulPendingRecoveries.get(descriptor.id) === recovered) markPendingRecovery(descriptor.id, true, hydrationCause(error))
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
    backends.get(parseInstanceKey(instanceId).backendId)?.sdk.destroyClientsForInstance(instanceId)
  }
  destroyOpenCodeData(instanceId)
  cancelTranscriptProjections(instanceId)
  sseManager.seedStatus(instanceId, "disconnected")
}

function getPendingRequestLocations(instanceId: string, rootDirectory?: string, includeHistorical = true, includeInventory = true) {
  const instanceSessions = sessions().get(instanceId)
  return buildV2RequestLocations(rootDirectory, [
    getActiveCatalogLocation(instanceId),
    ...getPendingWorktreeLocations(instanceId),
    ...(includeInventory ? getWorktrees(instanceId).filter(worktree => !worktree.nestedFolderMissing) : []),
    ...Array.from(instanceSessions?.values() ?? [])
      .filter((session) => includeHistorical || session.status !== "idle" || session.pendingPermission || session.pendingForm)
      .map((session) => session.location),
    ...getPermissionQueue(instanceId).flatMap((permission) => {
      const location = rememberedRequestLocation(permissionRequestLocations, instanceId, permission.id)
        ?? instanceSessions?.get(getPermissionSessionId(permission) ?? "")?.location
      return location ? [location] : []
    }),
    ...getFormQueue(instanceId).flatMap((form) => {
      const location = rememberedRequestLocation(formRequestLocations, instanceId, form.id) ?? form.location
        ?? instanceSessions?.get(form.sessionID)?.location
      return location ? [location] : []
    }),
  ])
}

function pendingSnapshotResults<T>(
  snapshot: Extract<RecoverySnapshot, { supported: true }>,
  select: (entry: { permissions: PermissionRequest[]; forms: FormWithLocation[] }) => T[],
): PromiseSettledResult<{ location: { directory: string }; response: { location: { directory: string }; data: T[]; complete: boolean } }>[] {
  return snapshot.directories.flatMap<PromiseSettledResult<{ location: { directory: string }; response: { location: { directory: string }; data: T[]; complete: boolean } }>>((entry) => {
    // Only broker-validated native placement keys are authority, never UI aliases.
    const locations = entry.locations ?? []
    return [
      ...locations.map((location) => ({ status: "fulfilled" as const, value: {
        location: location.location, response: { location: location.location, data: select(location), complete: entry.status === "ok" },
      } })),
      ...(entry.status === "error" ? [{ status: "rejected" as const, reason: new PendingRecoveryError({ kind: "directories",
        directories: [{ directory: entry.directory, issue: entry.reason ?? "unavailable", detail: entry.detail }] }) }] : []),
    ]
  })
}

async function readPendingRequestSnapshot(instanceId: string, isCurrent: () => boolean, reconcileInventory = true, retryDirectories?: string[]): Promise<RecoverySnapshot> {
  const requiredDirectories = () => new Set(getPendingRequestLocations(instanceId, instances().get(instanceId)?.folder, false)
    .flatMap((location) => location.directory ? [normalizeWorkspacePath(location.directory)] : []))
  const required = requiredDirectories()
  const liveRequired = new Set(getPendingRequestLocations(instanceId, instances().get(instanceId)?.folder, false, false)
    .flatMap((location) => location.directory ? [normalizeWorkspacePath(location.directory)] : []))
  const directories = retryDirectories ?? [...new Set(getPendingRequestLocations(instanceId, instances().get(instanceId)?.folder)
    .flatMap((location) => location.directory ? [location.directory] : []))]
  const snapshot: Extract<RecoverySnapshot, { supported: true }> = { supported: true, directories: [] }
  for (let offset = 0; offset < directories.length;) {
    if (!isCurrent()) throw pendingRequestSyncSuperseded
    if (deferPendingDiscovery(instanceId)) throw pendingDiscoveryDeferred
    let end = offset, queryBytes = 0
    // ponytail: eight directories bound Git-heavy batches; tune only with native recovery proof.
    while (end < directories.length && end - offset < 8) {
      const directory = directories[end]
      const params = new URLSearchParams({ directories: directory })
      if (!required.has(normalizeWorkspacePath(directory))) params.append("optionalDirectories", directory)
      queryBytes += params.toString().length + 1
      if (end > offset && queryBytes > 7000) break
      end++
    }
    // Leave room for the route prefix/headers; an unsplittable oversized path
    // still fails closed rather than reporting its pending queue as empty.
    const batch = directories.slice(offset, end)
    const optional = batch.filter((directory) => !required.has(normalizeWorkspacePath(directory)))
    offset = end
    const addBatch = (entries: readonly RecoveryDirectory[]) => {
      const currentRequired = requiredDirectories()
      const reported = new Set(entries.map((entry) => normalizeWorkspacePath(entry.directory)))
      for (const directory of batch) if (!reported.has(normalizeWorkspacePath(directory))) {
        snapshot.directories.push({ directory, status: "error", reason: "unavailable" })
      }
      for (const entry of entries) {
        if (entry.status !== "excluded") snapshot.directories.push(entry)
        else if (!optional.includes(entry.directory) || currentRequired.has(normalizeWorkspacePath(entry.directory))) {
          snapshot.directories.push({ directory: entry.directory, status: "error", reason: "excluded" })
        }
        // Excluded historical hints never authorize clearing a known queue.
      }
    }
    try {
      // Directory/Git authorization has a longer broker budget than native queue
      // reads. Let it finish, with a small transport margin, before aborting.
      const next = await withPendingRequestTimeout(instanceId, (signal) => backendOf(instanceId).api.getPendingRequests(instanceId, batch, signal, optional), true, PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS + 5_000)
      if (!isCurrent()) throw pendingRequestSyncSuperseded
      if (next.supported === false) return next
      if (next.supported !== true) throw new Error("Invalid pending request snapshot")
      addBatch(next.directories)
    } catch (error) {
      if (error === pendingDiscoveryDeferred) throw error
      if (!isCurrent()) throw pendingRequestSyncSuperseded
      // The backend also defers for compactions this UI never observed (unloaded or
      // other projects' sessions). Like a local deferral, wait for the next pass.
      if (error instanceof HttpResponseError && error.status === 503 && error.code === "deferred") throw pendingDiscoveryDeferred
      // A refused batch still reports each directory's own status and reason.
      const refused = refusedDirectories(error)
      if (refused) addBatch(refused)
      else {
        const { issue, detail } = batchIssue(error)
        snapshot.directories.push(...batch.map((directory) => ({ directory, status: "error" as const, reason: issue, detail })))
      }
    }
  }
  // A display descriptor can outlive an external Git worktree removal (or its
  // inventory-change event). Reconcile only inventory-only failures, once. This
  // does not prove queue absence: the new optional hint still needs the broker's
  // filesystem/ownership proof. Selected, active and known-request paths stay required.
  const staleInventory = snapshot.directories.filter(entry => entry.status === "error"
    && (entry.reason === "missing" || entry.reason === "not-owned")
    && required.has(normalizeWorkspacePath(entry.directory)) && !liveRequired.has(normalizeWorkspacePath(entry.directory)))
  if (reconcileInventory && staleInventory.length) {
    if (!isCurrent()) throw pendingRequestSyncSuperseded
    if (deferPendingDiscovery(instanceId)) throw pendingDiscoveryDeferred
    try { await reloadWorktrees(instanceId, true) }
    catch (error) { log.warn("Failed to reconcile pending recovery worktrees", { instanceId, error }) }
    if (!isCurrent()) throw pendingRequestSyncSuperseded
    const currentRequired = requiredDirectories()
    const retryDirectories = staleInventory.filter(entry => !currentRequired.has(normalizeWorkspacePath(entry.directory))).map(entry => entry.directory)
    if (retryDirectories.length) {
      const retry = await readPendingRequestSnapshot(instanceId, isCurrent, false, retryDirectories)
      if (retry.supported) snapshot.directories = [...snapshot.directories.filter(entry => !retryDirectories.includes(entry.directory)), ...retry.directories]
    }
  }
  return snapshot
}

async function syncPendingPermissions(
  instanceId: string,
  propagateErrors = false,
  isCurrent: () => boolean = () => true,
  snapshot?: Promise<RecoverySnapshot>,
  targetLocations?: RequestLocation[],
): Promise<void> {
  const operation = captureInstanceOperation(instanceId)
  const owns = isCurrent
  isCurrent = () => operation.current() && owns()
  if (!isCurrent()) return
  const instance = instances().get(instanceId)
  if (!instance?.client) return
  const mutationEpoch = pendingPermissionMutationEpochs.get(instanceId) ?? 0

  try {
    const remote: Array<{ request: PermissionRequest; location: RequestAuthorityLocation; key: string }> = []
    const scannedLocations = new Set<string>()
    const pending = await snapshot
    if (!isCurrent()) throw pendingRequestSyncSuperseded
    if (!pending?.supported && !targetLocations) throw new PendingRecoveryError({ kind: "unsupported" })
    if (!targetLocations && deferPendingDiscovery(instanceId)) throw pendingDiscoveryDeferred
    const locations = targetLocations ?? []
    const results = pending?.supported ? pendingSnapshotResults(pending, (entry) => entry.permissions) : await allSettledBounded(locations, () => isCurrent() && (Boolean(targetLocations) || !deferPendingDiscovery(instanceId)), async (location) => {
      const response = await withPendingRequestTimeout(instanceId, (signal) => (
        instance.client!.permission.request.list({ location: toRequestLocation(location) }, {
          ...requestLocationOptions(location), signal,
          ...(targetLocations ? { headers: { ...requestLocationOptions(location)?.headers, [PENDING_RECONCILIATION_HEADER]: "1" } } : {}),
        })
      ), !targetLocations)
      return { location, response }
    })
    const failures: unknown[] = []
    if (!pending?.supported && results.length < locations.length && !targetLocations) failures.push(pendingDiscoveryDeferred)
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason)
        continue
      }
      const { location, response } = result.value
      log.info(pending?.supported ? "location.pending permissions" : "permission.request.list", { instanceId, location, resolvedLocation: response.location })
      const authority = {
        directory: response.location.directory || location.directory,
        workspaceID: locationWorkspaceID(response.location),
      }
      const key = requestLocationKey(authority)
      if (!key) continue
      if (!("complete" in response) || response.complete !== false) scannedLocations.add(key)
      remote.push(...response.data.map((request) => ({ request, location: authority, key })))
    }

    if (!isCurrent() || (pendingPermissionMutationEpochs.get(instanceId) ?? 0) !== mutationEpoch) {
      if (propagateErrors) throw pendingRequestSyncSuperseded
      return
    }
    // ponytail: retain tombstones until instance removal; location-scoped settlement
    // provenance is needed before bounded coverage can safely retire them.

    const pendingRemote = remote.filter(({ request }) => !hasRepliedPermission(instanceId, request.id))
    const remoteIds = new Set(pendingRemote.map(({ request }) => request.id))
    const local = getPermissionQueue(instanceId)

    // Remove any stale local permissions missing from server.
    for (const entry of local) {
      const key = permissionRequestLocations.get(instanceId)?.get(entry.id)?.key
        ?? requestLocationKey(sessions().get(instanceId)?.get(getPermissionSessionId(entry) ?? "")?.location)
      if (!remoteIds.has(entry.id) && key && scannedLocations.has(key)) {
        removePermissionFromQueue(instanceId, entry.id)
        removePermissionV2(instanceId, entry.id)
      }
    }

    // Upsert all server-side pending permissions.
    for (const { request, location } of pendingRemote) {
      const queuedPermission = addPermissionToQueue(instanceId, request, location) ?? request
      upsertPermissionV2(instanceId, queuedPermission)
    }
    reconcilePendingSessionIndicators(instanceId)
    if (failures.length) {
      if (failures.some((error) => error !== pendingDiscoveryDeferred)) log.warn("Pending permission scan was partial", { instanceId, failedLocations: failures.length })
      if (propagateErrors) throw combinePendingFailures(failures)
    }
  } catch (error) {
    if (error !== pendingDiscoveryDeferred) log.warn("Failed to sync pending permissions", { instanceId, error })
    if (propagateErrors) throw error
  }
}

async function syncPendingForms(
  instanceId: string,
  propagateErrors = false,
  isCurrent: () => boolean = () => true,
  snapshot?: Promise<RecoverySnapshot>,
  targetLocations?: RequestLocation[],
): Promise<void> {
  const operation = captureInstanceOperation(instanceId)
  const owns = isCurrent
  isCurrent = () => operation.current() && owns()
  if (!isCurrent()) return
  const instance = instances().get(instanceId)
  if (!instance?.client) return
  const mutationEpoch = pendingFormMutationEpochs.get(instanceId) ?? 0

  try {
    const remote: Array<{ form: FormWithLocation; location: RequestAuthorityLocation; key: string }> = []
    const scannedLocations = new Set<string>()
    const pending = await snapshot
    if (!isCurrent()) throw pendingRequestSyncSuperseded
    if (!pending?.supported && !targetLocations) throw new PendingRecoveryError({ kind: "unsupported" })
    if (!targetLocations && deferPendingDiscovery(instanceId)) throw pendingDiscoveryDeferred
    const locations = targetLocations ?? []
    const results = pending?.supported ? pendingSnapshotResults(pending, (entry) => entry.forms) : await allSettledBounded(locations, () => isCurrent() && (Boolean(targetLocations) || !deferPendingDiscovery(instanceId)), async (location) => {
      const response = await withPendingRequestTimeout(instanceId, (signal) => (
        instance.client!.form.list({ location: toRequestLocation(location) }, {
          ...requestLocationOptions(location), signal,
          ...(targetLocations ? { headers: { ...requestLocationOptions(location)?.headers, [PENDING_RECONCILIATION_HEADER]: "1" } } : {}),
        })
      ), !targetLocations)
      return { location, response }
    })
    const failures: unknown[] = []
    if (!pending?.supported && results.length < locations.length && !targetLocations) failures.push(pendingDiscoveryDeferred)
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason)
        continue
      }
      const { location, response } = result.value
      const authority = {
        directory: response.location.directory || location.directory,
        workspaceID: locationWorkspaceID(response.location),
      }
      const key = requestLocationKey(authority)
      if (!key) continue
      if (!("complete" in response) || response.complete !== false) scannedLocations.add(key)
      remote.push(...response.data.map((form) => ({
        form: form.sessionID === "global" ? { ...form, location: response.location } : form,
        location: authority,
        key,
      })))
    }
    if (!isCurrent() || (pendingFormMutationEpochs.get(instanceId) ?? 0) !== mutationEpoch) {
      if (propagateErrors) throw pendingRequestSyncSuperseded
      return
    }
    const pendingRemote = remote.filter(({ form }) => !hasSettledForm(instanceId, form.id))
    const remoteIds = new Set(pendingRemote.map(({ form }) => form.id))
    for (const form of getFormQueue(instanceId)) {
      const key = formRequestLocations.get(instanceId)?.get(form.id)?.key
        ?? requestLocationKey(form.location)
        ?? requestLocationKey(sessions().get(instanceId)?.get(form.sessionID)?.location)
      if (!remoteIds.has(form.id) && key && scannedLocations.has(key)) removePendingForm(instanceId, form.id)
    }
    for (const { form, location } of pendingRemote) addPendingForm(instanceId, form, location)
    reconcilePendingSessionIndicators(instanceId)
    if (failures.length) {
      if (failures.some((error) => error !== pendingDiscoveryDeferred)) log.warn("Pending form scan was partial", { instanceId, failedLocations: failures.length })
      if (propagateErrors) throw combinePendingFailures(failures)
    }
  } catch (error) {
    if (error !== pendingDiscoveryDeferred) log.warn("Failed to sync pending forms", { instanceId, error })
    if (propagateErrors) throw error
  }
}

async function runPendingRequestSync(
  instanceId: string,
  generation: number,
  token: { cancelled: boolean },
  targetLocations?: RequestLocation[],
  current: () => boolean = captureInstanceOperation(instanceId).current,
): Promise<void> {
  const startingClient = instances().get(instanceId)?.client
  for (let attempt = 0; attempt < 3 && !token.cancelled && current(); attempt += 1) {
    if (!targetLocations && deferPendingDiscovery(instanceId)) return
    const epoch = (pendingRequestSyncEpochs.get(instanceId) ?? 0) + 1
    pendingRequestSyncEpochs.set(instanceId, epoch)
    const client = instances().get(instanceId)?.client
    if (!client) return
    const isCurrent = () => !token.cancelled && current()
      && instances().get(instanceId)?.client === client
      && pendingRequestSyncEpochs.get(instanceId) === epoch
      && pendingRequestSyncGenerations.get(instanceId) === generation
    try {
      // Unavailable loaded-only recovery is non-authoritative, never permission
      // to construct every historical/worktree Location. Only settlement targets
      // use ordinary lists; SSE and later snapshots still recover global Forms.
      const snapshot = targetLocations ? undefined : readPendingRequestSnapshot(instanceId, isCurrent)
      const results = await Promise.allSettled([
        syncPendingPermissions(instanceId, true, isCurrent, snapshot, targetLocations),
        syncPendingForms(instanceId, true, isCurrent, snapshot, targetLocations),
      ])
      for (const result of results) if (result.status === "rejected") throw result.reason
      if (!targetLocations && isCurrent()) {
        successfulPendingRecoveries.set(instanceId, (successfulPendingRecoveries.get(instanceId) ?? 0) + 1)
        releasePendingRecoveryNotices(pendingRecoveryProject(instanceId))
        markPendingRecovery(instanceId, false)
      }
      return
    } catch (error) {
      if (isCurrent()) markPendingRecovery(instanceId, true, error !== pendingDiscoveryDeferred && error !== pendingRequestSyncSuperseded
        ? recoveryCauseOf(error) : undefined)
      if (error === pendingDiscoveryDeferred) { resumePendingDiscovery(); return }
      if (error !== pendingRequestSyncSuperseded) throw error
    }
  }
  if (current() && !token.cancelled && pendingRequestSyncGenerations.get(instanceId) === generation) {
    if (instances().get(instanceId)?.client === startingClient) {
      markPendingRecovery(instanceId, true, { kind: "unstable" })
    }
    throw new Error("Pending request sync did not stabilize")
  }
}

function syncPendingRequests(
  instanceId: string,
  registerInvalidation?: (invalidate: () => void) => void,
  targetLocations?: RequestLocation[],
  signal?: AbortSignal,
): Promise<void> {
  const operation = captureInstanceOperation(instanceId, signal)
  signal = operation.signal
  if (signal?.aborted) return Promise.resolve()
  const owned = (promise: Promise<void>, invalidate: () => void) => {
    registerInvalidation?.(invalidate)
    if (!signal) return promise
    signal?.addEventListener("abort", invalidate, { once: true })
    if (signal?.aborted) invalidate()
    void promise.then(() => signal?.removeEventListener("abort", invalidate), () => signal?.removeEventListener("abort", invalidate))
    return promise
  }
  const generation = pendingRequestSyncGenerations.get(instanceId)
  if (generation === undefined) return Promise.resolve()
  if (!targetLocations && deferPendingDiscovery(instanceId)) return Promise.resolve()
  const existing = pendingRequestSyncs.get(instanceId)
  if (existing?.generation === generation && pendingOperationOwners.get(existing.promise)?.()) {
    if (!targetLocations && existing.targeted) { deferredPendingDiscovery.set(instanceId, operation); resumePendingDiscovery() }
    return owned(existing.promise, () => {
      if (pendingRequestSyncs.get(instanceId)?.token !== existing.token) return
      existing.token.cancelled = true
      abortPendingRequestWork(instanceId)
      invalidatePendingRequestSync(instanceId)
      pendingRequestSyncs.delete(instanceId)
    })
  }
  const token = { cancelled: false }
  if (!targetLocations) deferredPendingDiscovery.delete(instanceId)
  const promise = runPendingRequestSync(instanceId, generation, token, targetLocations, operation.current).finally(() => {
    if (pendingRequestSyncs.get(instanceId)?.promise === promise) pendingRequestSyncs.delete(instanceId)
  })
  pendingRequestSyncs.set(instanceId, { generation, targeted: Boolean(targetLocations), token, promise })
  pendingOperationOwners.set(promise, operation.current)
  return owned(promise, () => {
    if (pendingRequestSyncs.get(instanceId)?.token !== token) return
    token.cancelled = true
    abortPendingRequestWork(instanceId)
    invalidatePendingRequestSync(instanceId)
    pendingRequestSyncs.delete(instanceId)
  })
}

function schedulePendingRequestReconciliation(instanceId: string, location?: RequestLocation): void {
  const current = pendingRequestSyncs.get(instanceId)
  if (current) current.token.cancelled = true
  abortPendingRequestWork(instanceId)
  pendingRequestSyncs.delete(instanceId)
  invalidatePendingRequestSync(instanceId)
  const targets = location ? [location] : undefined
  void syncPendingRequests(instanceId, undefined, targets).catch((error) => {
    log.warn("Failed to reconcile pending requests after an ambiguous mutation", { instanceId, error })
  })
}

async function runPendingRequestLiveness(instanceId: string, operation = captureInstanceOperation(instanceId)): Promise<void> {
  if (!operation.current()) return
  const instanceSessions = sessions().get(instanceId)
  const hasRunningSession = Array.from(instanceSessions?.values() ?? []).some((session) => session.status === "working" || session.status === "compacting")
  let sessionError: unknown
  const compactions = new Map(pendingCompactions.get(instanceId) ?? [])
  const client = instances().get(instanceId)?.client
  if (hasRunningSession || Array.from(compactions.values()).some((entry) => entry.active && !entry.signal.aborted) || getPermissionQueue(instanceId).length || getFormQueue(instanceId).length) {
    try {
      const active = await withPendingRequestTimeout(instanceId, (signal) => refreshSessionRuntimeStatus(instanceId, signal), false)
      if (active && operation.current() && instances().get(instanceId)?.client === client) {
        for (const [id, baseline] of compactions) {
          if (baseline.active && !baseline.signal.aborted && pendingCompactions.get(instanceId)?.get(id) === baseline && !Object.prototype.hasOwnProperty.call(active, id)) {
            pendingCompactions.get(instanceId)!.set(id, { ...baseline, active: false })
          }
        }
        resumePendingDiscovery()
      }
    } catch (error) {
      sessionError = error
    }
  }
  if (!operation.current()) return
  await syncPendingRequests(instanceId, undefined, undefined, operation.signal)
  if (!operation.current()) return
  reconcilePendingSessionIndicators(instanceId)
  if (sessionError) throw sessionError
}

function reconcilePendingRequestLiveness(instanceId: string): Promise<void> {
  const operation = captureInstanceOperation(instanceId)
  if (!operation.current()) return Promise.resolve()
  const existing = pendingRequestLiveness.get(instanceId)
  if (existing && pendingOperationOwners.get(existing)?.()) return existing
  const promise = runPendingRequestLiveness(instanceId, operation).finally(() => {
    if (pendingRequestLiveness.get(instanceId) === promise) pendingRequestLiveness.delete(instanceId)
  })
  pendingRequestLiveness.set(instanceId, promise)
  pendingOperationOwners.set(promise, operation.current)
  return promise
}

function startInstanceSessionHydration(instanceId: string, force = false, signal = serverEvents.signalForInstance(instanceId)): {
  sessions: Promise<void>
  workspaceMetadata: Promise<void>
} {
  const client = instances().get(instanceId)?.client
  const current = () => !signal.aborted && instances().get(instanceId)?.client === client
  if (!current()) return { sessions: Promise.resolve(), workspaceMetadata: Promise.resolve() }
  const worktreeHydration = force
    ? reloadWorktrees(instanceId, false, signal)
    : ensureWorktreesLoaded(instanceId, signal)
  const projectMetadata = Promise.resolve().then(async () => {
    if (!current()) return
    const instance = instances().get(instanceId)
    if (instance?.client) await loadInstanceProjectMetadata(instance, { force, signal }).catch((error) => {
      log.warn("Failed to load project metadata before session hydration", { instanceId, error })
    })
  })
  const workspaceMetadata = Promise.all([worktreeHydration, projectMetadata]).then(() => {})
  // Session hydration can outlive a failed forced worktree read. Observe the
  // rejection immediately while retaining it for metadata-dependent callers.
  void workspaceMetadata.catch((error) => log.warn("Failed to hydrate workspace metadata", { instanceId, error }))
  // Publish the root directory page without waiting for project/checkout metadata.
  // Full family reconciliation still awaits that inventory in session-api.
  const sessions = Promise.resolve().then(async () => {
    if (!current()) return
    // fetchSessions reconciles the index after publication. Clearing it here
    // hides restored rows while the first network request is still pending.
    await fetchSessions(instanceId, { projectMetadata, signal }).catch((error) => {
      log.error("Failed to hydrate sessions", { instanceId, error })
    })
  })
  void sessions.then(async () => {
    if (!current()) return
    const instance = instances().get(instanceId)
    if (instance?.client) {
      await loadInstanceMetadata(instance, { force, location: getActiveCatalogLocation(instanceId), signal })
    }
  }).catch((error) => log.warn("Failed to load supplemental instance metadata", { instanceId, error }))
  return { sessions, workspaceMetadata }
}

async function hydrateInstanceData(instanceId: string, options?: {
  force?: boolean
  propagateErrors?: boolean
  sessionHydration?: Promise<void>
  workspaceMetadataHydration?: Promise<void>
  signal?: AbortSignal
}) {
  const signal = options?.signal ?? serverEvents.signalForInstance(instanceId)
  const client = instances().get(instanceId)?.client
  const current = () => !signal.aborted && instances().get(instanceId)?.client === client
  if (!current()) return
  try {
    const hydration = options?.sessionHydration
      ? {
          sessions: options.sessionHydration,
          workspaceMetadata: options.workspaceMetadataHydration ?? Promise.resolve(),
        }
      : startInstanceSessionHydration(instanceId, options?.force, signal)
    // Composer catalogues must not wait for the complete historical inventory.
    await Promise.all([
      hydration.sessions,
      hydration.workspaceMetadata,
      refreshSessionCatalog(instanceId, options?.force),
    ])
    if (!current()) return
    await ensureInstanceConfigLoaded(instanceId)
    if (!current()) return
    await syncPendingRequests(instanceId, undefined, undefined, signal)
  } catch (error) {
    log.error("Failed to fetch initial data", error)
    if (options?.propagateErrors) throw error
  }
}

function clearReloadableInstanceState(instanceId: string): void {
  clearCacheForInstance(instanceId)
  clearCommands(instanceId)
  clearInstanceMetadata(instanceId)
  // Recovery can be unavailable; only authoritative coverage or settlement
  // removes known interruptions, not a catalogue/location rehydration.
  markPendingRecovery(instanceId, true)
}

/** Reconciles one backend; false means this read had no current publication authority. */
async function refreshWorkspaceList(
  backendId: BackendId = LOCAL_BACKEND_ID,
  api: Pick<typeof serverApi, "fetchWorkspaces"> = serverApi,
  signal = serverEvents.signal(backendId),
): Promise<boolean> {
  if (signal?.aborted) return false
  // Preferences imports shared controls, but does not own workspace/session
  // hydration. Its provider editor receives an explicit location from the host.
  if (!usesClientState()) return false
  if (backendId !== LOCAL_BACKEND_ID && api === serverApi) throw new Error("A non-local workspace list needs its backend API")
  const requestFence = workspaceListReconciliationFence.begin(backendId)
  const removalCandidates = new Set([...instances().values()]
    .filter((instance) => backendIdOf(instance) === backendId).map(({ id }) => id))
  try {
    const listed = await api.fetchWorkspaces(signal)
    if (signal?.aborted || !workspaceListReconciliationFence.isCurrent(requestFence)) return false
    // Workspaces are keyed by instance key: the workspace id itself for the local backend.
    const workspaces = listed.map((workspace) => {
      const id = instanceKey(backendId, workspace.id)
      return id === workspace.id ? workspace : { ...workspace, id }
    })
    const remoteIds = new Set(workspaces.map(({ id }) => id))
    for (const descriptor of workspaces) {
      const workspace = observeRestoreWorkspace(descriptor)
      if (!workspace) continue
      if (signal?.aborted) return false
      if (!workspaceListReconciliationFence.allows(requestFence, workspace.id)) continue
      restoreCreatedWorkspaceCleanup.trackPendingRequest(workspace)
      if (restoreCreationCommitGates.deferRefreshWorkspace(workspace)) continue
      if (restoreCreatedWorkspaceCleanup.owns(workspace.id)) {
        restoreCreatedWorkspaceCleanup.track(workspace)
        continue
      }
      upsertWorkspace(workspace, undefined, backendId)
    }
    const unchangedCandidates = [...removalCandidates]
      .filter((id) => workspaceListReconciliationFence.allows(requestFence, id))
    for (const instanceId of getUnavailableWorkspaceIds(
      unchangedCandidates, remoteIds, (id) => restoreCreatedWorkspaceCleanup.owns(id),
    )) {
      if (signal?.aborted) return false
      releaseInstanceResources(instanceId)
      removeInstance(instanceId, { authoritative: false })
    }
    return !signal?.aborted && workspaceListReconciliationFence.isCurrent(requestFence)
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

serverEvents.onOpen((backendId) => {
  const backend = backends.get(backendId)
  if (!backend) return
  publishLatestWorkspaceLoad(refreshWorkspaceList(backendId, backend.api).then(
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

function handleWorkspaceEvent(event: BackendEventPayload) {
  if (!usesClientState()) return
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
    const workspace = observeRestoreWorkspace(event.workspace)
    if (!workspace) return
    restoreCreatedWorkspaceCleanup.trackPendingRequest(workspace)
    if (restoreCreationCommitGates.deferWorkspace(workspace)) return
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
      upsertWorkspace(event.workspace, undefined, event.backendId)
      break
    case "workspace.started":
      upsertWorkspace(event.workspace, undefined, event.backendId)
      break
    case "workspace.error":
      upsertWorkspace(event.workspace, undefined, event.backendId)
      showWorkspaceLaunchError(event.workspace)
      clearPermissionAutoAcceptForInstance(event.workspace.id)
      clearSyncedYoloSessionsForInstance(event.workspace.id)
      break
    case "workspace.stopped": {
      const instance = instances().get(event.workspaceId)
      const locallyClosed = locallyRequestedWorkspaceCloses.delete(event.workspaceId)
      if (event.reason === "deleted" && instance && openInstanceTabIds().has(event.workspaceId)
        && !locallyClosed) {
        showToastNotification({ category: "projects",
          message: tGlobal("app.closeInstance.toast.otherWindow", { project: getInstanceLabel(instance) }),
          variant: "info",
        })
      }
      requestInstanceTabClose(event.workspaceId)
      const tracked = restoreCreatedWorkspaceCleanup.get(event.workspaceId, true)
      if (tracked?.receipt?.attached()) restoreCreatedWorkspaceCleanup.release(event.workspaceId, tracked.receipt.requestKey)
      // Clear the instance after this event batch has unmounted its tab: clearing
      // a visible shell's state in the same update remounted views inside the
      // dying subtree and broke the whole window. Skip a re-created workspace.
      const stop = Symbol(event.workspaceId)
      const operation = captureInstanceOperation(event.workspaceId)
      pendingWorkspaceStops.set(event.workspaceId, stop)
      queueMicrotask(() => {
        if (pendingWorkspaceStops.get(event.workspaceId) !== stop) return
        pendingWorkspaceStops.delete(event.workspaceId)
        if (!operation.current()) return
        releaseInstanceResources(event.workspaceId)
        removeInstance(event.workspaceId, { authoritative: event.reason === "deleted" })
      })
      break
    }
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
    .filter((existing) => isSameProject(existing, instance))
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
    ...(instance.backendId ? { backendId: instance.backendId } : {}),
  })
  syncHasInstancesFlag()
}

function updateInstance(id: string, updates: Partial<Instance>) {
  const existing = instances().get(id)
  if (updates.client !== undefined && existing?.client && updates.client !== existing.client) {
    deferredPendingDiscovery.delete(id)
    clearSessionListRequestState(id)
    clearSessionCatalogState(id)
    clearCommands(id)
    clearInstanceMetadata(id)
    destroyOpenCodeData(id)
    cancelTranscriptProjections(id)
    volatileInstanceRefreshes.delete(id)
    for (const sessionId of sessions().get(id)?.keys() ?? []) invalidateSessionMessageLoad(id, sessionId)
  }
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
  locallyRequestedWorkspaceCloses.delete(id)
  deferredPendingDiscovery.delete(id)
  pendingCompactions.delete(id)
  clearPendingWorktreeMoves(id)
  const removedInstance = instances().get(id)
  const removedOccurrence = removedInstance
    ? Array.from(instances().values())
        .filter((instance) => isSameProject(instance, removedInstance))
        .findIndex((instance) => instance.id === id)
    : -1
  if (removedInstance && removedOccurrence >= 0 && options.authoritative === false) {
    publishInstanceLifecycleAuthority({
      type: "unavailable",
      instanceId: id,
      folder: removedInstance.folder,
      occurrence: removedOccurrence,
      ...(removedInstance.backendId ? { backendId: removedInstance.backendId } : {}),
    })
  }
  detachInstanceTabMembership(id)
  connectionResyncGate.clear(id)
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
  clearSettledForms(id)
  clearPendingFormQueue(id)
  clearInstanceMetadata(id)
  destroyOpenCodeData(id)
  cancelTranscriptProjections(id)
  clearPermissionAutoAcceptForInstance(id)
  clearSyncedYoloSessionsForInstance(id)
  initialHydrations.delete(id)
  initialSessionHydrations.delete(id)
  initialWorkspaceMetadataHydrations.delete(id)
  invalidatePendingRequestSync(id)
  abortPendingRequestWork(id)
  pendingRequestLiveness.delete(id)
  pendingRequestSyncGenerations.delete(id)
  successfulPendingRecoveries.delete(id)
  markPendingRecovery(id, false)
  resumePendingDiscovery()
  settleInstanceReadyWaiters(id, new Error(`Workspace ${id} was removed before it became ready`))

  if (activeInstanceId() === id) {
    setActiveInstanceId(nextActiveId)
  }

  // Clean up session indexes and drafts for removed instance
  clearCacheForInstance(id)
  messageStoreBus.unregisterInstance(id)
  clearInstanceDraftPrompts(id)
  clearInstanceSeenInterruptions(id)
  clearSessionListRequestState(id)
  forgetSessionListRestoration(id)
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
      ...(removedInstance.backendId ? { backendId: removedInstance.backendId } : {}),
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
  if (workspace.reused !== true && workspace.receipt?.attached()
    && !restoreCreatedWorkspaceCleanup.isReleased(workspace.id, workspace.receipt.requestKey)) removeRestoreCreatedInstanceFromUi(workspace.id)
  return restoreCreatedWorkspaceCleanup.discardCreated(workspace, { retainTombstone: workspace.reused !== true })
}

function disposeRestoreCreatedInstance(instanceId: string): Promise<void> {
  const workspace = restoreCreatedWorkspaceCleanup.get(instanceId)
  if (!workspace) return Promise.resolve()
  if (workspace.reused !== true && workspace.receipt?.attached()) removeRestoreCreatedInstanceFromUi(instanceId)
  return restoreCreatedWorkspaceCleanup.discardTracked(instanceId, { retainTombstone: workspace.reused !== true })
}

async function releaseRestoreCreatedInstance(instanceId: string, requestId: string): Promise<void> {
  // ponytail: linear in outstanding claims; index requests if very large restores make this measurable.
  const receipts = [...restoreCreationReceipts.values()].filter(receipt => receipt.instanceId === instanceId && receipt.requestId === requestId)
  if (receipts.length > 1) throw new Error("Workspace creation owner ambiguous")
  const receipt = receipts[0]
  if (!receipt) return
  if (receipt.requestId !== requestId) throw new Error("Workspace creation owner unavailable")
  await restoreCreatedWorkspaceCleanup.releaseAfter(instanceId, (workspace) => {
    if (!workspace.receipt || workspace.requestId !== requestId) return Promise.reject(new Error("Workspace creation owner unavailable"))
    return retryWithBackoff(() => workspace.receipt!.api.releaseWorkspaceCreation(instanceId, requestId), {
      maxAttempts: 4,
      initialDelayMs: 250,
      maxDelayMs: 2_000,
      backoffMultiplier: 4,
    })
  }, receipt.requestKey)
}

async function cancelRestoreCreationRequest(receipt: WorkspaceOperationReceipt): Promise<void> {
  await cancelRestoreCreation(receipt.requestId!, receipt.api)
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
    if (workspace.receipt) restoreCreatedWorkspaceCleanup.release(workspace.id, workspace.receipt.requestKey)
    if (workspace.receipt?.attached()) removeRestoreCreatedInstanceFromUi(workspace.id)
    return
  }
  await disposeRestoreWorkspaceResponse(workspace)
}

async function createInstance(
  folder: string,
  projectName?: string,
  options?: {
    backend?: BackendClient
    signal?: AbortSignal
    shouldCreateCommit?: (instanceId: string) => boolean
    onBeforeCreateCommit?: (instanceId: string) => void
    onCreateCommit?: (instanceId: string) => void
    waitForCreateCommit?: () => Promise<void>
  },
): Promise<{ instanceId: string; reused: boolean; requestId?: string }> {
  const restoreRequestId = options?.signal ? createRestoreCreationRequestId() : undefined
  const receipt = captureWorkspaceOperation(folder, options?.backend, restoreRequestId, options?.signal)
  const userOpeningOrder = !options?.signal ? restoreCreatedWorkspaceCleanup.captureOperationOrder() : undefined
  const signal = receipt.signal
  if (restoreRequestId) {
    restoreCreationReceipts.set(receipt.requestKey, receipt)
    restoreCreatedWorkspaceCleanup.beginRequest(receipt.requestKey)
  }
  const commitGate: RestoreWorkspaceCommitGate<RestoreWorkspaceDescriptor> | undefined = restoreRequestId && options?.waitForCreateCommit
    ? restoreCreationCommitGates.begin(restoreRequestId, options.waitForCreateCommit(), folder, receipt.backendId, receipt.attached)
    : undefined
  let cancellationRequest: Promise<boolean> | null = null
  let requestResolved = false
  let terminalHandled = false
  const cancelPendingCreation = () => {
    if (!restoreRequestId) return
    const trackedCleanup = restoreCreatedWorkspaceCleanup.quarantineRequest(receipt.requestKey)
    cancellationRequest ??= trackedCleanup
      ? trackedCleanup.then(() => true)
      : cancelRestoreCreationRequest(receipt)
          .then(() => {
            restoreCreationReceipts.delete(receipt.requestKey)
            restoreCreatedWorkspaceCleanup.settleRequest(receipt.requestKey)
            return true
          }, (error) => {
            log.warn("Failed to cancel restore workspace creation", { requestId: restoreRequestId, error })
            return false
          })
  }
  signal.addEventListener("abort", cancelPendingCreation, { once: true })

  try {
    signal.throwIfAborted()
    if (!receipt.current()) throw new Error("Workspace creation owner unavailable")
    const response = await receipt.api.createWorkspace({
      path: folder,
      name: projectName,
      requestId: restoreRequestId,
    }, { signal })
    const id = instanceKey(receipt.backendId, response.id)
    const responseReceipt = Object.freeze({ ...receipt, rawId: response.id, instanceId: id })
    if (restoreRequestId && !restoreCreatedWorkspaceCleanup.isRequestSettled(receipt.requestKey)) restoreCreationReceipts.set(receipt.requestKey, responseReceipt)
    const workspace: RestoreWorkspaceDescriptor = { ...response, id, receipt: responseReceipt }
    requestResolved = true
    if (restoreRequestId && !workspace.requestId) {
      restoreCreationReceipts.delete(receipt.requestKey)
      restoreCreatedWorkspaceCleanup.settleRequest(receipt.requestKey)
    }
    const reused = workspace.reused === true
    if (restoreRequestId) restoreCreationCommitGates.bindResponse(restoreRequestId, workspace.id, receipt.attached)
    if (!receipt.current()) {
      if (workspace.requestId) await disposeRestoreWorkspaceResponse(workspace)
      throw getAbortReason(signal)
    }
    if (options?.signal && workspace.requestId) {
      const observed = restoreRequestId
        ? restoreCreationCommitGates.resolve(restoreRequestId, workspace, receipt.backendId, receipt.attached).workspace
        : workspace
      restoreCreatedWorkspaceCleanup.track({
        ...observed,
        requestId: observed.requestId ?? workspace.requestId,
        ...(reused ? { reused: true as const } : {}),
      })
    }
    else if (!options?.signal) restoreCreatedWorkspaceCleanup.releaseTombstoneForUserCreate(workspace.id, userOpeningOrder)
    if (commitGate) await commitGate.wait
    if (!receipt.current()) {
      if (workspace.requestId) await disposeRestoreWorkspaceResponse(workspace)
      throw getAbortReason(signal)
    }
    const resolution = restoreRequestId
      ? restoreCreationCommitGates.resolve(restoreRequestId, workspace, receipt.backendId, receipt.attached)
      : { workspace }
    const committedWorkspace: RestoreWorkspaceDescriptor = {
      ...resolution.workspace,
      receipt: responseReceipt,
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
      || options?.shouldCreateCommit?.(workspace.id) === false
    if (!discarded) {
      if (!receipt.current()) throw getAbortReason(signal)
      workspaceListReconciliationFence.markMutation(workspace.id)
      options?.onBeforeCreateCommit?.(workspace.id)
      if (!receipt.current()) throw getAbortReason(signal)
      upsertWorkspace(committedWorkspace, reused ? undefined : projectName, receipt.backendId)
      if (!receipt.current()) throw getAbortReason(signal)
      options?.onCreateCommit?.(workspace.id)
      if (!receipt.current()) throw getAbortReason(signal)
    }
    if (discarded) {
      if (workspace.requestId) await disposeRestoreWorkspaceResponse(workspace)
      throw new Error(`Restore-created workspace ${workspace.id} was closed before startup completed`)
    }
    return { instanceId: workspace.id, reused, requestId: workspace.requestId }
  } catch (error) {
    // The create route's explicit rejection is definitive; transport/abort/5xx failures remain unknown.
    if (restoreRequestId && !requestResolved && error instanceof HttpResponseError
      && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 499) {
      restoreCreationReceipts.delete(receipt.requestKey)
      restoreCreatedWorkspaceCleanup.settleRequest(receipt.requestKey)
    }
    if (!terminalHandled && commitGate?.terminal && commitGate.workspace) {
      terminalHandled = true
      await settleRestoreWorkspaceTerminal(commitGate.workspace, commitGate.terminal)
    }
    if (!signal.aborted) log.error("Failed to create workspace", error)
    throw error
  } finally {
    signal.removeEventListener("abort", cancelPendingCreation)
    if (restoreRequestId) {
      restoreCreationCommitGates.end(restoreRequestId, receipt.backendId, receipt.attached)
      const pendingCancellation = cancellationRequest as Promise<boolean> | null
      if (requestResolved && !signal.aborted || !pendingCancellation) {
        restoreCreatedWorkspaceCleanup.finishRequest(receipt.requestKey)
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

/** One project is one folder of one backend. */
function isSameProject(a: Pick<Instance, "folder" | "backendId">, b: Pick<Instance, "folder" | "backendId">): boolean {
  return backendIdOf(a) === backendIdOf(b) && normalizeInstanceFolderPath(a.folder) === normalizeInstanceFolderPath(b.folder)
}

function getExistingInstanceForFolder(folder: string, backendId: BackendId = LOCAL_BACKEND_ID): Instance | null {
  if (!folder) return null
  const matches = Array.from(instances().values()).filter((instance) => {
    if (instance.status === "stopped") return false
    return isSameProject(instance, { folder, backendId })
  })

  if (matches.length === 0) return null

  const activeId = activeInstanceId()
  return matches.find((instance) => instance.id === activeId) ?? matches.find((instance) => instance.status === "ready") ?? matches[0] ?? null
}

function updateProjectNameForFolder(folder: string, projectName: string, backendId: BackendId = LOCAL_BACKEND_ID): void {
  const name = projectName.trim()
  if (!folder || !name) return
  for (const instance of instances().values()) {
    if (instance.status === "stopped") continue
    if (isSameProject(instance, { folder, backendId })) {
      updateInstance(instance.id, { projectName: name })
    }
  }
}

const workspaceCloseRequests = new Map<string, Promise<void>>()
const locallyRequestedWorkspaceCloses = new Set<string>()

/** Origin outlives the HTTP request: cleanup and its stop event may arrive later. */
function trackWorkspaceClose(id: string, operation: () => Promise<void>): Promise<void> {
  const pending = workspaceCloseRequests.get(id)
  if (pending) return pending
  const hadOrigin = locallyRequestedWorkspaceCloses.has(id)
  locallyRequestedWorkspaceCloses.add(id)
  const request = Promise.resolve().then(operation).catch((error) => {
    if (!hadOrigin && error instanceof HttpResponseError && error.status >= 400 && error.status < 500) {
      locallyRequestedWorkspaceCloses.delete(id)
    }
    throw error
  }).finally(() => workspaceCloseRequests.delete(id))
  workspaceCloseRequests.set(id, request)
  return request
}

function closeWorkspace(id: string): Promise<void> {
  const instance = instances().get(id)
  if (!instance) return Promise.resolve()
  const pending = workspaceCloseRequests.get(id)
  if (pending) return pending

  let receipt: WorkspaceOperationReceipt | undefined
  let captureError: unknown
  try { receipt = captureWorkspaceOperation(instance.folder, backendOf(id)) }
  catch (error) { captureError = error }
  return trackWorkspaceClose(id, () => {
    if (!receipt) return Promise.reject(captureError)
    if (!receipt.current()) return Promise.reject(new Error("Workspace close owner unavailable"))
    return receipt.api.deleteWorkspace(id)
  })
    .catch((error) => {
      log.error("Failed to close workspace", error)
      try {
        showToastNotification({ category: "projects",
          message: tGlobal("app.closeInstance.toast.error"),
          variant: "error",
        })
      } finally {
        throw error
      }
    })
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

/** The directory a queued request runs in: its admitted location, else its own or its session's. */
function getPendingRequestDirectory(instanceId: string, request: { kind: "permission"; payload: PermissionRequest } | { kind: "form"; payload: FormWithLocation }): string | undefined {
  const remembered = rememberedRequestLocation(request.kind === "permission" ? permissionRequestLocations : formRequestLocations,
    instanceId, request.payload.id)
  const sessionId = request.kind === "permission" ? getPermissionSessionId(request.payload) : request.payload.sessionID
  return (remembered ?? (request.kind === "form" ? request.payload.location : undefined)
    ?? sessions().get(instanceId)?.get(sessionId ?? "")?.location)?.directory
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

function addPermissionToQueue(instanceId: string, permission: PermissionRequest, location?: RequestAuthorityLocation | string): PermissionRequest | undefined {
  bumpEpoch(pendingPermissionMutationEpochs, instanceId)
  rememberRequestLocation(permissionRequestLocations, instanceId, permission.id, location)
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
  forgetRequestLocation(permissionRequestLocations, instanceId, permissionId)
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
  const operation = captureInstanceOperation(instanceId)
  if (!operation.current()) return
  const key = `${instanceId}:${sessionId}`
  yoloOperations.set(key, operation)
  const current = () => operation.current() && yoloOperations.get(key) === operation
  const wasEnabled = isPermissionAutoAcceptEnabled(instanceId, sessionId)
  togglePermissionAutoAccept(instanceId, sessionId)
  void backendOf(instanceId).api
    .toggleYolo(instanceId, sessionId)
    .then((state) => {
      if (!current()) return
      setPermissionAutoAcceptEnabled(instanceId, sessionId, state.enabled)
    })
    .catch((error) => {
      if (!current()) return
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
const yoloOperations = new Map<string, ReturnType<typeof captureInstanceOperation>>()

export function ensureYoloStateSynced(instanceId: string, sessionId: string): void {
  if (!instanceId || !sessionId || sessionId === "info") return
  const operation = captureInstanceOperation(instanceId)
  if (!operation.current()) return
  const key = `${instanceId}:${sessionId}`
  if (syncedYoloSessions.has(key) && yoloOperations.get(key)?.current()) return
  syncedYoloSessions.add(key)
  yoloOperations.set(key, operation)
  const current = () => operation.current() && yoloOperations.get(key) === operation
  void backendOf(instanceId).api
    .getYoloState(instanceId, sessionId)
    .then((state) => {
      if (!current()) return
      setPermissionAutoAcceptEnabled(instanceId, sessionId, state.enabled)
    })
    .catch((error) => {
      if (!current()) return
      // allow retry on next activation (e.g. instance not ready yet)
      syncedYoloSessions.delete(key)
      log.warn("Failed to sync Yolo state", { instanceId, sessionId, error })
    })
}

serverEvents.onOpen((backendId) => {
  for (const key of new Set([...syncedYoloSessions, ...yoloOperations.keys()])) {
    if (parseInstanceKey(key).backendId === backendId) {
      syncedYoloSessions.delete(key)
      yoloOperations.delete(key)
    }
  }
})

function clearSyncedYoloSessionsForInstance(instanceId: string): void {
  const prefix = `${instanceId}:`
  for (const key of new Set([...syncedYoloSessions, ...yoloOperations.keys()])) {
    if (key.startsWith(prefix)) {
      syncedYoloSessions.delete(key)
      yoloOperations.delete(key)
    }
  }
}

function clearPermissionQueue(instanceId: string): void {
  bumpEpoch(pendingPermissionMutationEpochs, instanceId)
  permissionRequestLocations.delete(instanceId)
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
  const operation = captureInstanceOperation(instanceId)
  operation.signal.throwIfAborted()
  if (!operation.current()) throw pendingRequestSyncSuperseded
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  const permission = getPermissionQueue(instanceId).find((entry) => entry.id === requestId)
  try {
    if (!permission) throw new Error(`Permission request not found: ${requestId}`)
    await getRootClient(instanceId).permission.reply({
      sessionID: permission.sessionID,
      requestID: requestId,
      decision: reply,
      ...(message ? { message } : {}),
    })

    if (!operation.current()) return
    markPermissionReplied(instanceId, requestId)
    // Remove from both local queues after successful response; the SSE replied event
    // is still accepted, but the UI no longer depends on receiving it.
    removePermissionFromQueue(instanceId, requestId)
    removePermissionV2(instanceId, requestId)
  } catch (error) {
    log.error("Failed to send permission response", error)
    if (operation.current()) schedulePendingRequestReconciliation(instanceId, rememberedRequestLocation(permissionRequestLocations, instanceId, requestId)
      ?? sessions().get(instanceId)?.get(permission?.sessionID ?? "")?.location)
    throw error
  }
}

async function sendFormReply(instanceId: string, formId: string, answer: FormAnswer, interaction?: FormAnswerInteraction): Promise<void> {
  const operation = captureInstanceOperation(instanceId)
  operation.signal.throwIfAborted()
  if (!operation.current()) throw pendingRequestSyncSuperseded
  const form = getFormQueue(instanceId).find((item) => item.id === formId)
  if (!form) throw new Error(`Form request not found: ${formId}`)
  const humanSubmit = form.metadata?.kind === "question" && consumeFormAnswerInteraction(interaction, form, answer)
  const options = formRequestOptions(form)
  bumpEpoch(pendingFormMutationEpochs, instanceId)
  try {
    await getRootClient(instanceId).session.form.reply(
      { sessionID: form.sessionID, formID: form.id, answer },
      humanSubmit ? { ...options, headers: { ...options?.headers, "x-codenomad-human-answer": "1" } } : options,
    )
    if (!operation.current()) return
    markFormSettled(instanceId, form.id)
    removePendingForm(instanceId, form.id)
  } catch (error) {
    if (operation.current()) schedulePendingRequestReconciliation(instanceId, rememberedRequestLocation(formRequestLocations, instanceId, form.id) ?? form.location)
    throw error
  }
}

let pendingFormAddedHandler: ((instanceId: string, form: FormWithLocation) => void) | undefined

function setPendingFormAddedHandler(handler: (instanceId: string, form: FormWithLocation) => void): void {
  pendingFormAddedHandler = handler
}

function addPendingForm(instanceId: string, form: FormWithLocation, location?: RequestAuthorityLocation | string): FormWithLocation | undefined {
  bumpEpoch(pendingFormMutationEpochs, instanceId)
  rememberRequestLocation(formRequestLocations, instanceId, form.id, location ?? form.location)
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
  forgetRequestLocation(formRequestLocations, instanceId, formId)
  const form = getFormQueue(instanceId).find((item) => item.id === formId)
  removeFormFromQueue(instanceId, formId)
  formRegistry.remove(instanceId, formId)
  if (form) {
    const remaining = formRegistry.decrement(instanceId, form.sessionID)
    setSessionPendingForm(instanceId, form.sessionID, remaining > 0)
  }
  recomputeActiveInterruption(instanceId)
}

function clearPendingFormQueue(instanceId: string): void {
  bumpEpoch(pendingFormMutationEpochs, instanceId)
  formRequestLocations.delete(instanceId)
  formRegistry.clear(instanceId, getFormQueue(instanceId), (sessionId) => {
    setSessionPendingForm(instanceId, sessionId, false)
  })
  clearStoredFormQueue(instanceId)
  recomputeActiveInterruption(instanceId)
}

async function sendFormCancel(instanceId: string, formId: string): Promise<void> {
  const operation = captureInstanceOperation(instanceId)
  operation.signal.throwIfAborted()
  if (!operation.current()) throw pendingRequestSyncSuperseded
  const form = getFormQueue(instanceId).find((item) => item.id === formId)
  if (!form) throw new Error(`Form request not found: ${formId}`)
  bumpEpoch(pendingFormMutationEpochs, instanceId)
  try {
    await getRootClient(instanceId).session.form.cancel(
      { sessionID: form.sessionID, formID: form.id },
      formRequestOptions(form),
    )
    if (!operation.current()) return
    markFormSettled(instanceId, form.id)
    removePendingForm(instanceId, form.id)
  } catch (error) {
    if (operation.current()) schedulePendingRequestReconciliation(instanceId, rememberedRequestLocation(formRequestLocations, instanceId, form.id) ?? form.location)
    throw error
  }
}

// Events after which assistant message cost/token totals may have changed.
const USAGE_EVENT_TYPES = new Set<string>([
  "session.step.ended",
  "session.step.failed",
])

// These events publish their page in the same task. Destructive events pair
// with direct store surgery a delayed projection would only repeat, and an
// execution settlement is the stable point interactive reads (part deletion,
// copy) synchronize on: its final status must never lag a frame behind. A
// replayed chunk carrying one publishes the same way, before the drained
// reducer retires and the page it holds is lost to a later frame.
const SYNCHRONOUS_PROJECTION_EVENTS = new Set<string>([
  "session.deleted",
  "session.inbox.cancelled",
  "session.revert.committed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

const isSettlementEvent = (type: string) => SYNCHRONOUS_PROJECTION_EVENTS.has(type)

/** Publishes a page in this task, subsuming the pending frame: the dropped
 * entry's obligations (usage updates) transfer to this publication. */
const publishSynchronousPage = (
  instanceId: string,
  sessionId: string,
  data: ReturnType<typeof applyOpenCodeDataEvent>,
  options: { preserveOmitted?: boolean; confirmPending: boolean; updateUsage: boolean },
) => {
  const dropped = takeTranscriptProjection(instanceId, sessionId)
  projectOpenCodeMessages(instanceId, sessionId, data, options.preserveOmitted ?? true, options.confirmPending)
  if (options.updateUsage || Boolean(dropped?.updateUsage)) updateSessionInfo(instanceId, sessionId)
}

// One stable, explicitly chunk-safe publication identity for ordinary replay.
// Destructive event-specific effects below retain per-event callback barriers.
const publishTranscriptChunk: NonNullable<OpenCodeDataEventAdmission["publication"]> = ({ instanceId, sessionId, data, events }) => {
  const sessionEvents = events.filter((event) => event.type.startsWith("session."))
  if (!sessionEvents.length) return
  // A visible child transcript (its task renderer is mounted) watches this
  // page exactly like the active session; only unseen sessions fall back to
  // invalidate-on-stream so their next activation reads authoritatively.
  if (activeSessionId().get(instanceId) !== sessionId && !isSessionTranscriptVisible(instanceId, sessionId)) {
    if (messagesLoaded().get(instanceId)?.has(sessionId)) invalidateSessionMessageLoad(instanceId, sessionId)
    return
  }
  if (!isLatestWindow(messageStoreBus.getOrCreate(instanceId).getMessageWindow(sessionId))) return
  const options = {
    confirmPending: sessionEvents.at(-1)?.type !== "session.inbox.enqueued",
    updateUsage: sessionEvents.some((event) => USAGE_EVENT_TYPES.has(event.type) || event.type === "session.compaction.delta"),
  }
  if (sessionEvents.some((event) => isSettlementEvent(event.type))) {
    publishSynchronousPage(instanceId, sessionId, data, options)
    return
  }
  scheduleTranscriptProjection(instanceId, sessionId, data, options)
}

function handleInstanceInvalidation(instanceId: string, event: Parameters<NonNullable<typeof sseManager.onInvalidation>>[1]): void {
  const instance = instances().get(instanceId)
  if (!instance?.client) return
  observePendingCompaction(instanceId, event)
  const sessionId = "sessionID" in event.data && typeof event.data.sessionID === "string"
    ? event.data.sessionID
    : event.type === "form.created"
      ? event.data.form.sessionID
      : undefined
  const isCompactionDelta = event.type === "session.compaction.delta"
  const invalidateInactiveMessages = () => {
    if (sessionId && event.type.startsWith("session.")
      && activeSessionId().get(instanceId) !== sessionId
      && !isSessionTranscriptVisible(instanceId, sessionId)
      && messagesLoaded().get(instanceId)?.has(sessionId)) {
      invalidateSessionMessageLoad(instanceId, sessionId)
    }
  }
  const projectMessages = (data: ReturnType<typeof applyOpenCodeDataEvent>, preserveOmitted = true, force = false) => {
    invalidateInactiveMessages()
    if (isCompactionDelta && !force) {
      return
    }
    if (sessionId && (force || event.type.startsWith("session.")) && (
      (activeSessionId().get(instanceId) === sessionId || isSessionTranscriptVisible(instanceId, sessionId))
      && isLatestWindow(messageStoreBus.getOrCreate(instanceId).getMessageWindow(sessionId))
    )) {
      if (force || isSettlementEvent(event.type)) {
        publishSynchronousPage(instanceId, sessionId, data, {
          preserveOmitted,
          confirmPending: force || event.type !== "session.inbox.enqueued",
          updateUsage: force || USAGE_EVENT_TYPES.has(event.type),
        })
        return
      }
      scheduleTranscriptProjection(instanceId, sessionId, data, {
        confirmPending: event.type !== "session.inbox.enqueued",
        updateUsage: USAGE_EVENT_TYPES.has(event.type),
      })
    }
  }
  const project = (data: ReturnType<typeof applyOpenCodeDataEvent>, preserveOmitted = true) => {
    projectMessages(data, preserveOmitted)
    if (sessionId && event.type === "session.inbox.cancelled") {
      removeMessageV2(instanceId, event.data.inboxID, sessionId)
    }
    if (sessionId && event.type === "session.revert.committed") {
      for (const messageId of messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId)) {
        if (messageId >= event.data.to) removeMessageV2(instanceId, messageId, sessionId)
      }
    }
  }
  const hasEventSideEffects = event.type === "session.inbox.cancelled" || event.type === "session.revert.committed"
  const admission: OpenCodeDataEventAdmission = {
    deferred: false,
    publication: hasEventSideEffects ? undefined : publishTranscriptChunk,
  }
  const data = applyOpenCodeDataEvent(instanceId, instance.folder, event, hasEventSideEffects ? (next) => project(next) : undefined, (next) => {
    projectMessages(next, false, true)
    schedulePendingRequestReconciliation(instanceId)
  }, Boolean(sessionId && activeSessionId().get(instanceId) !== sessionId
    && !messageStoreBus.getInstance(instanceId)?.getSessionMessageIds(sessionId).length), admission)
  if (admission.deferred) invalidateInactiveMessages()
  else project(data)
  if (sessionId && (event.type === "permission.asked" || event.type === "permission.replied")) {
    const current = data.session.permission.list(sessionId) ?? []
    const remote = (event.type === "permission.asked"
      ? [event.data, ...current.filter((permission) => permission.id !== event.data.id)]
      : current).filter((permission) => !hasRepliedPermission(instanceId, permission.id))
    const location = event.location ?? sessions().get(instanceId)?.get(sessionId)?.location
    for (const permission of remote) {
      const queued = addPermissionToQueue(instanceId, permission, location) ?? permission
      upsertPermissionV2(instanceId, queued)
    }
    if (event.type === "permission.replied") {
      removePermissionFromQueue(instanceId, event.data.requestID)
      removePermissionV2(instanceId, event.data.requestID)
    }
  }
  if (sessionId && event.type.startsWith("form.")) {
    const current = data.session.form.list(sessionId, sessionId === "global" ? event.location : undefined) ?? []
    const remote = event.type === "form.created"
      ? [event.data.form, ...current.filter((form) => form.id !== event.data.form.id)]
      : current
    const location = event.location ?? sessions().get(instanceId)?.get(sessionId)?.location
    for (const form of remote) {
      // Like recovery, keep a global Form's location: its reply and cancellation are addressed there.
      const queued = sessionId === "global" && event.location ? { ...form, location: event.location } : form
      if (!hasSettledForm(instanceId, form.id)) addPendingForm(instanceId, queued, location)
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      markFormSettled(instanceId, event.data.id)
      removePendingForm(instanceId, event.data.id)
    }
  }
  finishOpenCodeDataEvent(instanceId, event)
  const targets = getInstanceRefreshTargets(event.type)
  if (event.type === "filesystem.changed") queueFilesystemInvalidation(instanceId)
  else if (targets.length) void refreshVolatileInstanceState(instanceId, targets)
}

sseManager.onInvalidation = handleInstanceInvalidation

// The frame coalescer re-checks the gates a projection was admitted under when
// its frame runs; a selection change flushes pending pages first (session-state).
setTranscriptProjectionGates({
  // Watched transcripts: the active session's own view plus any child session
  // whose task renderer is mounted (visible) — both admit frame projections.
  isActiveSession: (instanceId, sessionId) =>
    activeSessionId().get(instanceId) === sessionId || isSessionTranscriptVisible(instanceId, sessionId),
  isLatestMessageWindow: (instanceId, sessionId) =>
    isLatestWindow(messageStoreBus.getOrCreate(instanceId).getMessageWindow(sessionId)),
  invalidateInactiveLoadedSession: (instanceId, sessionId) => {
    if (messagesLoaded().get(instanceId)?.has(sessionId)) invalidateSessionMessageLoad(instanceId, sessionId)
  },
  onProjectedUsage: updateSessionInfo,
  // Frame publications always keep omitted history; only their confirmation
  // flag varies (projectOpenCodeMessages takes preserveOmitted first).
  projectPage: (instanceId, sessionId, data, confirmPending) =>
    projectOpenCodeMessages(instanceId, sessionId, data, true, confirmPending),
})

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
  refreshWorkspaceList,
  updateProjectNameForFolder,
  closeWorkspace,
  trackWorkspaceClose,
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
  getPendingRequestDirectory,
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
  reconcilePendingSessionIndicators,
  reconcilePendingRequestLiveness,
  syncPendingRequests,
  invalidatePendingRequestSync,
  refreshVolatileInstanceState,
  syncLoadedSessionInboxes,
  handleInstanceInvalidation,
  clearReloadableInstanceState,
}
