import { createContext, createMemo, createSignal, onCleanup, type Accessor, type ParentComponent, useContext } from "solid-js"
import type { InstanceData } from "../../../server/src/api-types"
import { storage } from "../lib/storage"
import { getLogger } from "../lib/logger"
import { sessionActionSuperseded } from "./session-action-queue"

const log = getLogger("api")

const DEFAULT_INSTANCE_DATA: InstanceData = { messageHistory: [], agentModelSelections: {} }

const [instanceDataMap, setInstanceDataMap] = createSignal<Map<string, InstanceData>>(new Map())
const loadPromises = new Map<string, { promise: Promise<void>; current: () => boolean }>()
const instanceSubscriptions = new Map<string, { unsubscribe?: () => void }>()

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
  const owner: { unsubscribe?: () => void } = {}
  instanceSubscriptions.set(instanceId, owner)
  owner.unsubscribe = storage.onInstanceDataChanged(instanceId, (data) => {
    if (instanceSubscriptions.get(instanceId) === owner) setInstanceData(instanceId, data)
  })
}

function detachSubscription(instanceId: string) {
  const owner = instanceSubscriptions.get(instanceId)
  if (!owner) return
  instanceSubscriptions.delete(instanceId)
  owner.unsubscribe?.()
}

function setInstanceData(instanceId: string, data: InstanceData) {
  setInstanceDataMap((prev) => {
    const next = new Map(prev)
    next.set(instanceId, cloneInstanceData(data))
    return next
  })
}

async function ensureInstanceConfig(instanceId: string, isCurrent: () => boolean = () => true): Promise<void> {
  if (!instanceId) return
  if (instanceDataMap().has(instanceId)) return
  let existing = loadPromises.get(instanceId)
  const replacingLoad = Boolean(existing)
  for (let joined = 0; existing?.current(); joined++) {
    if (joined === 3) {
      const { tGlobal } = await import("../lib/i18n")
      throw sessionActionSuperseded(tGlobal("session.actions.superseded"))
    }
    await existing.promise
    if (!isCurrent() || instanceDataMap().has(instanceId)) return
    // The initiating caller may have retired while this reader stayed current.
    // Join a current replacement, or start one read under this reader's authority.
    existing = loadPromises.get(instanceId)
  }
  if (!isCurrent()) return
  const state = { promise: Promise.resolve(), current: isCurrent }
  const current = () => isCurrent() && loadPromises.get(instanceId) === state
  const promise = storage
    .loadInstanceData(instanceId, current)
    .then((data) => {
      if (!current()) return
      attachSubscription(instanceId)
    })
    .catch((error) => {
      if (!current()) return
      log.warn("Failed to load instance data", error)
      if (replacingLoad) throw error
      setInstanceData(instanceId, DEFAULT_INSTANCE_DATA)
      attachSubscription(instanceId)
    })
    .finally(() => {
      if (loadPromises.get(instanceId) === state) loadPromises.delete(instanceId)
    })
  state.promise = promise
  loadPromises.set(instanceId, state)
  await promise
}

async function updateInstanceConfig(instanceId: string, mutator: (draft: InstanceData) => void, isCurrent: () => boolean = () => true): Promise<void> {
  if (!instanceId) return
  await ensureInstanceConfig(instanceId, isCurrent)
  if (!isCurrent()) return
  const current = instanceDataMap().get(instanceId) ?? DEFAULT_INSTANCE_DATA
  const draft = cloneInstanceData(current)
  mutator(draft)
  try {
    await storage.saveInstanceData(instanceId, draft, isCurrent)
  } catch (error) {
    log.warn("Failed to persist instance data", error)
  }
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
  loadPromises.delete(instanceId)
  storage.forgetInstanceData(instanceId)
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
    for (const owner of instanceSubscriptions.values()) {
      owner.unsubscribe?.()
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
