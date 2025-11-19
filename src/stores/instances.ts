import { createSignal } from "solid-js"
import type { Instance, LogEntry } from "../types/instance"
import type { LspStatus, Permission } from "@opencode-ai/sdk"
import type { ClientPart, Message } from "../types/message"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import {
  fetchSessions,
  fetchAgents,
  fetchProviders,
  removeSessionIndexes,
  clearInstanceDraftPrompts,
} from "./sessions"
import { fetchCommands, clearCommands } from "./commands"
import { preferences, updateLastUsedBinary } from "./preferences"
import { computeDisplayParts } from "./session-messages"
import { withSession, setSessionPendingPermission } from "./session-state"
import { setHasInstances } from "./ui"

const [instances, setInstances] = createSignal<Map<string, Instance>>(new Map())
const [activeInstanceId, setActiveInstanceId] = createSignal<string | null>(null)
const [instanceLogs, setInstanceLogs] = createSignal<Map<string, LogEntry[]>>(new Map())
const [logStreamingState, setLogStreamingState] = createSignal<Map<string, boolean>>(new Map())

// Permission queue management per instance
const [permissionQueues, setPermissionQueues] = createSignal<Map<string, Permission[]>>(new Map())
const [activePermissionId, setActivePermissionId] = createSignal<Map<string, string | null>>(new Map())
const permissionSessionCounts = new Map<string, Map<string, number>>()
interface DisconnectedInstanceInfo {
  id: string
  folder: string
  reason: string
}
const [disconnectedInstance, setDisconnectedInstance] = createSignal<DisconnectedInstanceInfo | null>(null)

const MAX_LOG_ENTRIES = 1000

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

  if (activeInstanceId() === id) {
    setActiveInstanceId(nextActiveId)
  }

  // Clean up session indexes and drafts for removed instance
  removeSessionIndexes(id)
  clearInstanceDraftPrompts(id)
}

async function createInstance(folder: string, binaryPath?: string): Promise<string> {
  const id = `instance-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  const instance: Instance = {
    id,
    folder,
    port: 0,
    pid: 0,
    status: "starting",
    client: null,
    environmentVariables: preferences().environmentVariables ?? {},
  }

  addInstance(instance)

  // Update last used binary
  if (binaryPath) {
    updateLastUsedBinary(binaryPath)
  }

  try {
    const {
      id: returnedId,
      port,
      pid,
      binaryPath: actualBinaryPath,
    } = await window.electronAPI.createInstance(id, folder, binaryPath, preferences().environmentVariables)

    const client = sdkManager.createClient(port)

    updateInstance(id, {
      port,
      pid,
      client,
      status: "ready",
      binaryPath: actualBinaryPath,
    })

    setActiveInstanceId(id)
    sseManager.connect(id, port)

    try {
      await fetchSessions(id)
      await fetchAgents(id)
      await fetchProviders(id)
      await fetchCommands(id, client)
    } catch (error) {
      console.error("Failed to fetch initial data:", error)
    }

    return id
  } catch (error) {
    updateInstance(id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function stopInstance(id: string) {
  const instance = instances().get(id)
  if (!instance) return

  sseManager.disconnect(id)

  if (instance.port) {
    sdkManager.destroyClient(instance.port)
  }

  if (instance.pid) {
    await window.electronAPI.stopInstance(instance.pid)
  }

  removeInstance(id)
}

async function fetchLspStatus(instanceId: string): Promise<LspStatus[] | undefined> {
  const instance = instances().get(instanceId)
  if (!instance) {
    console.warn(`[LSP] Skipping fetch; instance ${instanceId} not found`)
    return undefined
  }
  if (!instance.client) {
    console.warn(`[LSP] Skipping fetch; instance ${instanceId} client not ready`)
    return undefined
  }
  const lsp = instance.client.lsp
  if (!lsp?.status) {
    console.warn(`[LSP] Skipping fetch; lsp.status API unavailable for instance ${instanceId}`)
    return undefined
  }
  console.log(`[HTTP] GET /lsp.status for instance ${instanceId}`)
  const response = await lsp.status()
  return response.data ?? []
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
function getPermissionQueue(instanceId: string): Permission[] {
  const queue = permissionQueues().get(instanceId)
  if (!queue) {
    return []
  }
  return queue
}

function getPermissionQueueLength(instanceId: string): number {
  return getPermissionQueue(instanceId).length
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

function addPermissionToQueue(instanceId: string, permission: Permission): void {
  let inserted = false

  setPermissionQueues((prev) => {
    const next = new Map(prev)
    const queue = next.get(instanceId) ?? []

    if (queue.some((p) => p.id === permission.id)) {
      return next
    }

    const updatedQueue = [...queue, permission].sort((a, b) => a.time.created - b.time.created)
    next.set(instanceId, updatedQueue)
    inserted = true
    return next
  })

  if (!inserted) {
    return
  }

  setActivePermissionId((prev) => {
    const next = new Map(prev)
    if (!next.get(instanceId)) {
      next.set(instanceId, permission.id)
    }
    return next
  })

  const sessionId = getPermissionSessionId(permission)
  incrementSessionPendingCount(instanceId, sessionId)
  setSessionPendingPermission(instanceId, sessionId, true)

  const isActive = getActivePermission(instanceId)?.id === permission.id
  attachPermissionToToolPart(instanceId, permission, isActive)
}

function getActivePermission(instanceId: string): Permission | null {
  const activeId = activePermissionId().get(instanceId)
  if (!activeId) return null

  const queue = getPermissionQueue(instanceId)
  return queue.find(p => p.id === activeId) ?? null
}

function removePermissionFromQueue(instanceId: string, permissionId: string): void {
  let removedPermission: Permission | null = null

  setPermissionQueues((prev) => {
    const next = new Map(prev)
    const queue = next.get(instanceId) ?? []
    const filtered: Permission[] = []

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

  setActivePermissionId((prev) => {
    const next = new Map(prev)
    const activeId = next.get(instanceId)
    if (activeId === permissionId) {
      const nextPermission = updatedQueue.length > 0 ? (updatedQueue[0] as Permission) : null
      next.set(instanceId, nextPermission?.id ?? null)
    }
    return next
  })

  const removed = removedPermission
  if (removed) {
    clearPermissionFromToolPart(instanceId, removed)
    const removedSessionId = getPermissionSessionId(removed)
    const remaining = decrementSessionPendingCount(instanceId, removedSessionId)
    setSessionPendingPermission(instanceId, removedSessionId, remaining > 0)
  }

  const nextActivePermission = getActivePermission(instanceId)
  if (nextActivePermission) {
    attachPermissionToToolPart(instanceId, nextActivePermission, true)
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
}

function getPermissionSessionId(permission: Permission): string {
  return (permission as any).sessionID
}

function findToolPartForPermission(message: Message, permission: Permission): ClientPart | null {
  const expectedCallId = permission.callID
  for (const part of message.parts) {
    if (part.type !== "tool") continue
    const toolCallId = (part as any).callID
    if (expectedCallId) {
      if (toolCallId === expectedCallId) {
        return part as ClientPart
      }
      if (!toolCallId && (part.id === expectedCallId || part.messageID === permission.messageID)) {
        return part as ClientPart
      }
      continue
    }

    if ((toolCallId && toolCallId === permission.id) || part.id === permission.id || part.messageID === permission.messageID) {
      return part as ClientPart
    }
  }
  return null
}

function mutateToolPartPermission(
  instanceId: string,
  permission: Permission,
  mutator: (part: ClientPart, message: Message) => boolean,
): void {
  const permissionSessionId = getPermissionSessionId(permission)
  withSession(instanceId, permissionSessionId, (session) => {
    const message = session.messages.find((msg) => msg.id === permission.messageID)
    if (!message) return
    const targetPart = findToolPartForPermission(message, permission)
    if (!targetPart) return

    const changed = mutator(targetPart, message)
    if (!changed) return

    const nextPartVersion = typeof targetPart.version === "number" ? targetPart.version + 1 : 1
    targetPart.version = nextPartVersion
    message.version = (message.version ?? 0) + 1
    message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)
  })
}

function attachPermissionToToolPart(instanceId: string, permission: Permission, active: boolean): void {
  mutateToolPartPermission(instanceId, permission, (part) => {
    const existing = part.pendingPermission
    if (existing && existing.permission.id === permission.id && existing.active === active) {
      return false
    }
    part.pendingPermission = { permission, active }
    return true
  })
}

function clearPermissionFromToolPart(instanceId: string, permission: Permission): void {
  mutateToolPartPermission(instanceId, permission, (part) => {
    if (!part.pendingPermission || part.pendingPermission.permission.id !== permission.id) {
      return false
    }
    delete part.pendingPermission
    return true
  })
}

function refreshPermissionsForSession(instanceId: string, sessionId: string): void {
  const queue = getPermissionQueue(instanceId)
  if (queue.length === 0) {
    setSessionPendingPermission(instanceId, sessionId, false)
    return
  }

  const activeId = activePermissionId().get(instanceId)

  for (const permission of queue) {
    if (getPermissionSessionId(permission) !== sessionId) continue
    const isActive = permission.id === activeId
    attachPermissionToToolPart(instanceId, permission, isActive)
  }

  const pendingCount = permissionSessionCounts.get(instanceId)?.get(sessionId) ?? 0
  setSessionPendingPermission(instanceId, sessionId, pendingCount > 0)
}

async function sendPermissionResponse(
  instanceId: string,
  sessionId: string,
  permissionId: string,
  response: "once" | "always" | "reject"
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    throw new Error("Instance not ready")
  }

  try {
    await instance.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response }
    })
  } catch (error) {
    console.error("Failed to send permission response:", error)
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
  console.log(`[LSP] Received lsp.updated event for instance ${instanceId}`)
  try {
    const lspStatus = await fetchLspStatus(instanceId)
    if (!lspStatus) {
      return
    }
    const instance = instances().get(instanceId)
    if (!instance) {
      console.warn(`[LSP] Instance ${instanceId} disappeared before metadata update`)
      return
    }
    updateInstance(instanceId, {
      metadata: {
        ...(instance.metadata ?? {}),
        lspStatus,
      },
    })
  } catch (error) {
    console.error("Failed to refresh LSP status:", error)
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
    console.error("Failed to stop disconnected instance:", error)
  } finally {
    setDisconnectedInstance(null)
    if (instances().size === 0) {
      setHasInstances(false)
    }
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
  // Permission management
  permissionQueues,
  activePermissionId,
  getPermissionQueue,
  getPermissionQueueLength,
  addPermissionToQueue,
  getActivePermission,
  removePermissionFromQueue,
  clearPermissionQueue,
  refreshPermissionsForSession,
  sendPermissionResponse,
  disconnectedInstance,
  acknowledgeDisconnectedInstance,
  fetchLspStatus,
}
