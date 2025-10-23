import { createSignal } from "solid-js"
import type { Instance, LogEntry } from "../types/instance"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import { fetchSessions, fetchAgents, fetchProviders } from "./sessions"
import { showSessionPicker } from "./ui"

const [instances, setInstances] = createSignal<Map<string, Instance>>(new Map())
const [activeInstanceId, setActiveInstanceId] = createSignal<string | null>(null)

const MAX_LOG_ENTRIES = 1000

function addInstance(instance: Instance) {
  setInstances((prev) => {
    const next = new Map(prev)
    next.set(instance.id, instance)
    return next
  })
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

  if (activeInstanceId() === id) {
    setActiveInstanceId(null)
  }
}

async function createInstance(folder: string): Promise<string> {
  const id = `instance-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  const instance: Instance = {
    id,
    folder,
    port: 0,
    pid: 0,
    status: "starting",
    client: null,
    logs: [],
  }

  addInstance(instance)

  try {
    const { id: returnedId, port, pid } = await window.electronAPI.createInstance(id, folder)

    const client = sdkManager.createClient(port)

    updateInstance(id, {
      port,
      pid,
      client,
      status: "ready",
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

    showSessionPicker(id)

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
  setInstances((prev) => {
    const next = new Map(prev)
    const instance = next.get(id)
    if (instance) {
      const logs = [...instance.logs, entry]
      if (logs.length > MAX_LOG_ENTRIES) {
        logs.shift()
      }
      next.set(id, { ...instance, logs })
    }
    return next
  })
}

function clearLogs(id: string) {
  setInstances((prev) => {
    const next = new Map(prev)
    const instance = next.get(id)
    if (instance) {
      next.set(id, { ...instance, logs: [] })
    }
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
}
