import { createContext, createMemo, createSignal, onCleanup, type Accessor, type ParentComponent, useContext } from "solid-js"
import type { InstanceData } from "../../../server/src/api-types"
import { storage } from "../lib/storage"

const DEFAULT_INSTANCE_DATA: InstanceData = { messageHistory: [], agentModelSelections: {} }

const [instanceDataMap, setInstanceDataMap] = createSignal<Map<string, InstanceData>>(new Map())
const loadPromises = new Map<string, Promise<void>>()
const instanceSubscriptions = new Map<string, () => void>()

function cloneInstanceData(data?: InstanceData | null): InstanceData {
  const source = data ?? DEFAULT_INSTANCE_DATA
  return {
    ...source,
    messageHistory: Array.isArray(source.messageHistory) ? [...source.messageHistory] : [],
    agentModelSelections: { ...(source.agentModelSelections ?? {}) },
  }
}

function attachSubscription(instanceId: string) {
  if (instanceSubscriptions.has(instanceId)) return
  const unsubscribe = storage.onInstanceDataChanged(instanceId, (data) => {
    setInstanceData(instanceId, data)
  })
  instanceSubscriptions.set(instanceId, unsubscribe)
}

function detachSubscription(instanceId: string) {
  const unsubscribe = instanceSubscriptions.get(instanceId)
  if (!unsubscribe) return
  unsubscribe()
  instanceSubscriptions.delete(instanceId)
}

function setInstanceData(instanceId: string, data: InstanceData) {
  setInstanceDataMap((prev) => {
    const next = new Map(prev)
    next.set(instanceId, cloneInstanceData(data))
    return next
  })
}

async function ensureInstanceConfig(instanceId: string): Promise<void> {
  if (!instanceId) return
  if (instanceDataMap().has(instanceId)) return
  if (loadPromises.has(instanceId)) {
    await loadPromises.get(instanceId)
    return
  }
  const promise = storage
    .loadInstanceData(instanceId)
    .then((data) => {
      setInstanceData(instanceId, data)
      attachSubscription(instanceId)
    })
    .catch((error) => {
      console.warn("Failed to load instance data:", error)
      setInstanceData(instanceId, DEFAULT_INSTANCE_DATA)
      attachSubscription(instanceId)
    })
    .finally(() => {
      loadPromises.delete(instanceId)
    })
  loadPromises.set(instanceId, promise)
  await promise
}

async function updateInstanceConfig(instanceId: string, mutator: (draft: InstanceData) => void): Promise<void> {
  if (!instanceId) return
  await ensureInstanceConfig(instanceId)
  const current = instanceDataMap().get(instanceId) ?? DEFAULT_INSTANCE_DATA
  const draft = cloneInstanceData(current)
  mutator(draft)
  try {
    await storage.saveInstanceData(instanceId, draft)
  } catch (error) {
    console.warn("Failed to persist instance data:", error)
  }
  setInstanceData(instanceId, draft)
}

function getInstanceConfig(instanceId: string): InstanceData {
  return instanceDataMap().get(instanceId) ?? DEFAULT_INSTANCE_DATA
}

function useInstanceConfig(instanceId: string): Accessor<InstanceData> {
  const context = useContext(InstanceConfigContext)
  if (!context) {
    throw new Error("useInstanceConfig must be used within InstanceConfigProvider")
  }
  return createMemo(() => instanceDataMap().get(instanceId) ?? DEFAULT_INSTANCE_DATA)
}

function clearInstanceConfig(instanceId: string): void {
  setInstanceDataMap((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  detachSubscription(instanceId)
}

interface InstanceConfigContextValue {
  getInstanceConfig: typeof getInstanceConfig
  ensureInstanceConfig: typeof ensureInstanceConfig
  updateInstanceConfig: typeof updateInstanceConfig
  clearInstanceConfig: typeof clearInstanceConfig
}

const InstanceConfigContext = createContext<InstanceConfigContextValue>()

const contextValue: InstanceConfigContextValue = {
  getInstanceConfig,
  ensureInstanceConfig,
  updateInstanceConfig,
  clearInstanceConfig,
}

const InstanceConfigProvider: ParentComponent = (props) => {
  onCleanup(() => {
    for (const unsubscribe of instanceSubscriptions.values()) {
      unsubscribe()
    }
    instanceSubscriptions.clear()
  })

  return <InstanceConfigContext.Provider value={contextValue}>{props.children}</InstanceConfigContext.Provider>
}

export {
  InstanceConfigProvider,
  useInstanceConfig,
  ensureInstanceConfig as ensureInstanceConfigLoaded,
  getInstanceConfig,
  updateInstanceConfig,
  clearInstanceConfig,
}
