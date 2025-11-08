import { createSignal } from "solid-js"
import type { Instance, LogEntry } from "../types/instance"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import {
  fetchSessions,
  fetchAgents,
  fetchProviders,
  removeSessionIndexes,
  clearInstanceDraftPrompts,
} from "./sessions"
import { preferences, updateLastUsedBinary } from "./preferences"

const [instances, setInstances] = createSignal<Map<string, Instance>>(new Map())
const [activeInstanceId, setActiveInstanceId] = createSignal<string | null>(null)
const [instanceLogs, setInstanceLogs] = createSignal<Map<string, LogEntry[]>>(new Map())

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

function removeLogContainer(id: string) {
  setInstanceLogs((prev) => {
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

function addInstance(instance: Instance) {
  setInstances((prev) => {
    const next = new Map(prev)
    next.set(instance.id, instance)
    return next
  })
  ensureLogContainer(instance.id)
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
  setInstances((prev) => {
    const next = new Map(prev)
    next.delete(id)
    return next
  })
  removeLogContainer(id)

  if (activeInstanceId() === id) {
    setActiveInstanceId(null)
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
    environmentVariables: preferences().environmentVariables,
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

function getActiveInstance(): Instance | null {
  const id = activeInstanceId()
  return id ? instances().get(id) || null : null
}

function addLog(id: string, entry: LogEntry) {
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
}
