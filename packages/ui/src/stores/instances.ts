import { createSignal } from "solid-js"
import type { Instance, LogEntry } from "../types/instance"
import type { LspStatus } from "@opencode-ai/sdk/v2"
import type { PermissionReply, PermissionRequestLike } from "../types/permission"
import { getPermissionCreatedAt, getPermissionSessionId } from "../types/permission"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { getQuestionSessionId } from "../types/question"
import { requestData } from "../lib/opencode-api"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import type { WorkspaceDescriptor, WorkspaceEventPayload, WorkspaceLogEntry } from "../../../server/src/api-types"
import { ensureInstanceConfigLoaded } from "./instance-config"
import {
  fetchSessions,
  fetchAgents,
  fetchProviders,
  clearInstanceDraftPrompts,
} from "./sessions"
import { ensureWorktreesLoaded, ensureWorktreeMapLoaded } from "./worktrees"
import { fetchCommands, clearCommands } from "./commands"
import { preferences } from "./preferences"
import { setSessionPendingPermission, setSessionPendingQuestion } from "./session-state"
import { setHasInstances } from "./ui"
import { messageStoreBus } from "./message-v2/bus"
import { upsertPermissionV2, removePermissionV2, upsertQuestionV2, removeQuestionV2 } from "./message-v2/bridge"
import { clearCacheForInstance } from "../lib/global-cache"
import { getLogger } from "../lib/logger"
import { mergeInstanceMetadata, clearInstanceMetadata } from "./instance-metadata"

const log = getLogger("api")

const [instances, setInstances] = createSignal<Map<string, Instance>>(new Map())

const [activeInstanceId, setActiveInstanceId] = createSignal<string | null>(null)
const [instanceLogs, setInstanceLogs] = createSignal<Map<string, LogEntry[]>>(new Map())
const [logStreamingState, setLogStreamingState] = createSignal<Map<string, boolean>>(new Map())

// Interruption queues (permissions + questions) per instance
const [permissionQueues, setPermissionQueues] = createSignal<Map<string, PermissionRequestLike[]>>(new Map())
const [activePermissionId, setActivePermissionId] = createSignal<Map<string, string | null>>(new Map())
const permissionSessionCounts = new Map<string, Map<string, number>>()

const [questionQueues, setQuestionQueues] = createSignal<Map<string, QuestionRequest[]>>(new Map())
const [activeQuestionId, setActiveQuestionId] = createSignal<Map<string, string | null>>(new Map())
const questionSessionCounts = new Map<string, Map<string, number>>()
const questionEnqueuedAt = new Map<string, number>()

function ensureQuestionEnqueuedAt(request: QuestionRequest): number {
  const existing = questionEnqueuedAt.get(request.id)
  if (existing) return existing
  const now = Date.now()
  questionEnqueuedAt.set(request.id, now)
  return now
}

type InterruptionKind = "permission" | "question"

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

function workspaceDescriptorToInstance(descriptor: WorkspaceDescriptor): Instance {
  const existing = instances().get(descriptor.id)
  return {
    id: descriptor.id,
    folder: descriptor.path,
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
    environmentVariables: existing?.environmentVariables ?? preferences().environmentVariables ?? {},
  }
}

function ensureActiveInstanceSelected(): void {
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

function upsertWorkspace(descriptor: WorkspaceDescriptor) {
  const mapped = workspaceDescriptorToInstance(descriptor)
  if (instances().has(descriptor.id)) {
    updateInstance(descriptor.id, mapped)
  } else {
    addInstance(mapped)
  }

  if (descriptor.status === "ready") {
    attachClient(descriptor)
    // If no tab is currently selected (common after UI refresh),
    // auto-select the first ready instance.
    ensureActiveInstanceSelected()
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
  }

  const client = sdkManager.createClient(descriptor.id, nextProxyPath, "root")
  updateInstance(descriptor.id, {
    client,
    port: nextPort ?? 0,
    proxyPath: nextProxyPath,
    status: "ready",
  })
  sseManager.seedStatus(descriptor.id, "connecting")
  void hydrateInstanceData(descriptor.id).catch((error) => {
    log.error("Failed to hydrate instance data", error)
  })
}

function releaseInstanceResources(instanceId: string) {
  const instance = instances().get(instanceId)
  if (!instance) return

  if (instance.client) {
    sdkManager.destroyClientsForInstance(instanceId)
  }
  sseManager.seedStatus(instanceId, "disconnected")
}

async function syncPendingPermissions(instanceId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return

  try {
    const remote = await requestData<PermissionRequestLike[]>(
      instance.client.permission.list(),
      "permission.list",
    )

    const remoteIds = new Set(remote.map((item) => item.id))
    const local = getPermissionQueue(instanceId)

    // Remove any stale local permissions missing from server.
    for (const entry of local) {
      if (!remoteIds.has(entry.id)) {
        removePermissionFromQueue(instanceId, entry.id)
        removePermissionV2(instanceId, entry.id)
      }
    }

    // Upsert all server-side pending permissions.
    for (const permission of remote) {
      addPermissionToQueue(instanceId, permission)
      upsertPermissionV2(instanceId, permission)
    }
  } catch (error) {
    log.warn("Failed to sync pending permissions", { instanceId, error })
  }
}

async function syncPendingQuestions(instanceId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return

  try {
    const remote = await requestData<QuestionRequest[]>(
      instance.client.question.list(),
      "question.list",
    )

    const remoteIds = new Set(remote.map((item) => item.id))
    const local = getQuestionQueue(instanceId)

    // Remove any stale local requests missing from server.
    for (const entry of local) {
      if (!remoteIds.has(entry.id)) {
        removeQuestionFromQueue(instanceId, entry.id)
        removeQuestionV2(instanceId, entry.id)
      }
    }

    // Upsert all server-side pending questions.
    for (const request of remote) {
      ensureQuestionEnqueuedAt(request)
      addQuestionToQueue(instanceId, request)
      upsertQuestionV2(instanceId, request)
    }
  } catch (error) {
    log.warn("Failed to sync pending questions", { instanceId, error })
  }
}

async function hydrateInstanceData(instanceId: string) {
  try {
    await ensureWorktreesLoaded(instanceId)
    await ensureWorktreeMapLoaded(instanceId)
    await fetchSessions(instanceId)
    await fetchAgents(instanceId)
    await fetchProviders(instanceId)
    await ensureInstanceConfigLoaded(instanceId)
    const instance = instances().get(instanceId)
    if (!instance?.client) return
    await fetchCommands(instanceId, instance.client)
    await syncPendingPermissions(instanceId)
    await syncPendingQuestions(instanceId)
  } catch (error) {
    log.error("Failed to fetch initial data", error)
  }
}

  void (async function initializeWorkspaces() {
  try {
    const workspaces = await serverApi.fetchWorkspaces()
    workspaces.forEach((workspace) => upsertWorkspace(workspace))
    // After a UI refresh, we may have instances but no active selection.
    ensureActiveInstanceSelected()
  } catch (error) {
    log.error("Failed to load workspaces", error)
  }
})()


serverEvents.on("*", (event) => handleWorkspaceEvent(event))

function handleWorkspaceEvent(event: WorkspaceEventPayload) {
  switch (event.type) {
    case "workspace.created":
      upsertWorkspace(event.workspace)
      break
    case "workspace.started":
      upsertWorkspace(event.workspace)
      break
    case "workspace.error":
      upsertWorkspace(event.workspace)
      break
    case "workspace.stopped":
      releaseInstanceResources(event.workspaceId)
      removeInstance(event.workspaceId)
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
  setInstances((prev) => {
    const next = new Map(prev)
    next.set(instance.id, instance)
    return next
  })
  ensureLogContainer(instance.id)
  ensureLogStreamingState(instance.id)
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

function removeInstance(id: string) {
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
  clearQuestionQueue(id)
  clearInstanceMetadata(id)

  if (activeInstanceId() === id) {
    setActiveInstanceId(nextActiveId)
  }

  // Clean up session indexes and drafts for removed instance
  clearCacheForInstance(id)
  messageStoreBus.unregisterInstance(id)
  clearInstanceDraftPrompts(id)
  syncHasInstancesFlag()
}

async function createInstance(folder: string, _binaryPath?: string): Promise<string> {
  try {
    const workspace = await serverApi.createWorkspace({ path: folder })
    upsertWorkspace(workspace)
    setActiveInstanceId(workspace.id)
    return workspace.id
  } catch (error) {
    log.error("Failed to create workspace", error)
    throw error
  }
}

async function stopInstance(id: string) {
  const instance = instances().get(id)
  if (!instance) return

  releaseInstanceResources(id)

  try {
    await serverApi.deleteWorkspace(id)
  } catch (error) {
    log.error("Failed to stop workspace", error)
  }

  removeInstance(id)
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
function getPermissionQueue(instanceId: string): PermissionRequestLike[] {
  const queue = permissionQueues().get(instanceId)
  if (!queue) {
    return []
  }
  return queue
}

function getPermissionQueueLength(instanceId: string): number {
  return getPermissionQueue(instanceId).length
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
    return ensureQuestionEnqueuedAt(match)
  }
  return questionEnqueuedAt.get(requestId) ?? Date.now()
}

function computeActiveInterruption(instanceId: string): ActiveInterruption {
  const permissions = getPermissionQueue(instanceId)
  const questions = getQuestionQueue(instanceId)
  const firstPermission = permissions[0]
  const firstQuestion = questions[0]
  if (!firstPermission && !firstQuestion) return null
  if (firstPermission && !firstQuestion) return { kind: "permission", id: firstPermission.id }
  if (firstQuestion && !firstPermission) return { kind: "question", id: firstQuestion.id }

  const permTime = getPermissionCreatedAt(firstPermission)
  const quesTime = firstQuestion ? ensureQuestionEnqueuedAt(firstQuestion) : Number.MAX_SAFE_INTEGER
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

function incrementSessionPendingCount(instanceId: string, sessionId: string): void {
  let sessionCounts = permissionSessionCounts.get(instanceId)
  if (!sessionCounts) {
    sessionCounts = new Map()
    permissionSessionCounts.set(instanceId, sessionCounts)
  }
  const current = sessionCounts.get(sessionId) ?? 0
  sessionCounts.set(sessionId, current + 1)
}

function decrementSessionPendingCount(instanceId: string, sessionId: string): number {
  const sessionCounts = permissionSessionCounts.get(instanceId)
  if (!sessionCounts) return 0
  const current = sessionCounts.get(sessionId) ?? 0
  if (current <= 1) {
    sessionCounts.delete(sessionId)
    if (sessionCounts.size === 0) {
      permissionSessionCounts.delete(instanceId)
    }
    return 0
  }
  const nextValue = current - 1
  sessionCounts.set(sessionId, nextValue)
  return nextValue
}

function clearSessionPendingCounts(instanceId: string): void {
  const sessionCounts = permissionSessionCounts.get(instanceId)
  if (!sessionCounts) return
  for (const sessionId of sessionCounts.keys()) {
    setSessionPendingPermission(instanceId, sessionId, false)
  }
  permissionSessionCounts.delete(instanceId)
}

function incrementQuestionSessionPendingCount(instanceId: string, sessionId: string): void {
  let sessionCounts = questionSessionCounts.get(instanceId)
  if (!sessionCounts) {
    sessionCounts = new Map()
    questionSessionCounts.set(instanceId, sessionCounts)
  }
  const current = sessionCounts.get(sessionId) ?? 0
  sessionCounts.set(sessionId, current + 1)
}

function decrementQuestionSessionPendingCount(instanceId: string, sessionId: string): number {
  const sessionCounts = questionSessionCounts.get(instanceId)
  if (!sessionCounts) return 0
  const current = sessionCounts.get(sessionId) ?? 0
  if (current <= 1) {
    sessionCounts.delete(sessionId)
    if (sessionCounts.size === 0) {
      questionSessionCounts.delete(instanceId)
    }
    return 0
  }
  const nextValue = current - 1
  sessionCounts.set(sessionId, nextValue)
  return nextValue
}

function clearQuestionSessionPendingCounts(instanceId: string): void {
  const sessionCounts = questionSessionCounts.get(instanceId)
  if (!sessionCounts) return
  for (const sessionId of sessionCounts.keys()) {
    setSessionPendingQuestion(instanceId, sessionId, false)
  }
  questionSessionCounts.delete(instanceId)
}

function addPermissionToQueue(instanceId: string, permission: PermissionRequestLike): void {
  let inserted = false

  setPermissionQueues((prev) => {
    const next = new Map(prev)
    const queue = next.get(instanceId) ?? []

    if (queue.some((p) => p.id === permission.id)) {
      return next
    }

    const updatedQueue = [...queue, permission].sort((a, b) => getPermissionCreatedAt(a) - getPermissionCreatedAt(b))
    next.set(instanceId, updatedQueue)
    inserted = true
    return next
  })

  if (!inserted) {
    return
  }

  recomputeActiveInterruption(instanceId)

  const sessionId = getPermissionSessionId(permission)
  if (sessionId) {
    incrementSessionPendingCount(instanceId, sessionId)
    setSessionPendingPermission(instanceId, sessionId, true)
  }
}

function removePermissionFromQueue(instanceId: string, permissionId: string): void {
  let removedPermission: PermissionRequestLike | null = null

  setPermissionQueues((prev) => {
    const next = new Map(prev)
    const queue = next.get(instanceId) ?? []
    const filtered: PermissionRequestLike[] = []

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

  const updatedQueue = getPermissionQueue(instanceId)

  recomputeActiveInterruption(instanceId)

  const removed = removedPermission
  if (removed) {
    const removedSessionId = getPermissionSessionId(removed)
    if (removedSessionId) {
      const remaining = decrementSessionPendingCount(instanceId, removedSessionId)
      setSessionPendingPermission(instanceId, removedSessionId, remaining > 0)
    }
  }
}

function clearPermissionQueue(instanceId: string): void {
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
  clearSessionPendingCounts(instanceId)
  recomputeActiveInterruption(instanceId)
}

function addQuestionToQueue(instanceId: string, request: QuestionRequest): void {
  let inserted = false

  setQuestionQueues((prev) => {
    const next = new Map(prev)
    const queue = next.get(instanceId) ?? ([] as QuestionRequest[])

    if (queue.some((q) => q.id === request.id)) {
      return next
    }

    ensureQuestionEnqueuedAt(request)
    const updatedQueue = [...queue, request].sort((a, b) => {
      return ensureQuestionEnqueuedAt(a) - ensureQuestionEnqueuedAt(b)
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
    incrementQuestionSessionPendingCount(instanceId, sessionId)
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

  questionEnqueuedAt.delete(requestId)
  recomputeActiveInterruption(instanceId)

  if (removedSessionId) {
    const remaining = decrementQuestionSessionPendingCount(instanceId, removedSessionId)
    setSessionPendingQuestion(instanceId, removedSessionId, remaining > 0)
  }
}

function clearQuestionQueue(instanceId: string): void {
  for (const request of getQuestionQueue(instanceId)) {
    questionEnqueuedAt.delete(request.id)
  }

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
  clearQuestionSessionPendingCounts(instanceId)
  recomputeActiveInterruption(instanceId)
}

function setActivePermissionIdForInstance(instanceId: string, permissionId: string): void {
  setActiveInterruptionForInstance(instanceId, { kind: "permission", id: permissionId })
}

function setActiveQuestionIdForInstance(instanceId: string, requestId: string): void {
  setActiveInterruptionForInstance(instanceId, { kind: "question", id: requestId })
}

async function sendQuestionReply(
  instanceId: string,
  _sessionId: string,
  requestId: string,
  answers: string[][],
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  try {
    await requestData(
      instance.client.question.reply({
        requestID: requestId,
        answers,
      }),
      "question.reply",
    )

    removeQuestionFromQueue(instanceId, requestId)
  } catch (error) {
    log.error("Failed to send question reply", error)
    throw error
  }
}

async function sendQuestionReject(instanceId: string, _sessionId: string, requestId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  try {
    await requestData(
      instance.client.question.reject({
        requestID: requestId,
      }),
      "question.reject",
    )

    removeQuestionFromQueue(instanceId, requestId)
  } catch (error) {
    log.error("Failed to send question reject", error)
    throw error
  }
}

async function sendPermissionResponse(
  instanceId: string,
  sessionId: string,
  requestId: string,
  reply: PermissionReply
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  try {
    await requestData(
      instance.client.permission.reply({
        requestID: requestId,
        reply,
      }),
      "permission.reply",
    )

    // Remove from queue after successful response
    removePermissionFromQueue(instanceId, requestId)
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

async function acknowledgeDisconnectedInstance(): Promise<void> {
  const pending = disconnectedInstance()
  if (!pending) {
    return
  }

  try {
    await stopInstance(pending.id)
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
  removeInstance,
  createInstance,
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
  addPermissionToQueue,
  removePermissionFromQueue,
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
  removeQuestionFromQueue,
  clearQuestionQueue,
  sendQuestionReply,
  sendQuestionReject,
  setActiveQuestionIdForInstance,
  disconnectedInstance,
  acknowledgeDisconnectedInstance,
  fetchLspStatus,
}
