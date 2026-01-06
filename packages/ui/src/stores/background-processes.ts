import { createSignal } from "solid-js"
import type { BackgroundProcess } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { sseManager } from "../lib/sse-manager"

const [backgroundProcesses, setBackgroundProcesses] = createSignal<Map<string, BackgroundProcess[]>>(new Map())

function setProcesses(instanceId: string, processes: BackgroundProcess[]) {
  setBackgroundProcesses((prev) => {
    const next = new Map(prev)
    next.set(instanceId, processes)
    return next
  })
}

function updateProcess(instanceId: string, process: BackgroundProcess) {
  setBackgroundProcesses((prev) => {
    const next = new Map(prev)
    const current = next.get(instanceId) ?? []
    const index = current.findIndex((entry) => entry.id === process.id)
    const updated = index >= 0 ? [...current.slice(0, index), process, ...current.slice(index + 1)] : [...current, process]
    next.set(instanceId, updated)
    return next
  })
}

function removeProcess(instanceId: string, processId: string) {
  setBackgroundProcesses((prev) => {
    const next = new Map(prev)
    const current = next.get(instanceId) ?? []
    next.set(
      instanceId,
      current.filter((entry) => entry.id !== processId),
    )
    return next
  })
}

async function loadBackgroundProcesses(instanceId: string) {
  const response = await serverApi.listBackgroundProcesses(instanceId)
  setProcesses(instanceId, response.processes)
}

function getBackgroundProcesses(instanceId: string): BackgroundProcess[] {
  return backgroundProcesses().get(instanceId) ?? []
}

sseManager.onBackgroundProcessUpdated = (instanceId, event) => {
  const process = event.properties?.process
  if (!process) return
  updateProcess(instanceId, process)
}

sseManager.onBackgroundProcessRemoved = (instanceId, event) => {
  const processId = event.properties?.processId
  if (!processId) return
  removeProcess(instanceId, processId)
}

export {
  backgroundProcesses,
  getBackgroundProcesses,
  loadBackgroundProcesses,
  removeProcess as removeBackgroundProcess,
  updateProcess as updateBackgroundProcess,
}
