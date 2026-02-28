import { createContext, createMemo, createSignal, onCleanup, type Accessor, type ParentComponent, useContext } from "solid-js"
import type { InstanceData } from "../../../server/src/api-types"
import { storage } from "../lib/storage"
import { getLogger } from "../lib/logger"

const log = getLogger("api")

const DEFAULT_INSTANCE_DATA: InstanceData = { messageHistory: [], agentModelSelections: {}, mcpDefaults: {}, sessionMcpSettings: {} }

const [instanceDataMap, setInstanceDataMap] = createSignal<Map<string, InstanceData>>(new Map())
const loadPromises = new Map<string, Promise<void>>()
const instanceSubscriptions = new Map<string, () => void>()

function cloneInstanceData(data?: InstanceData | null): InstanceData {
  const source = data ?? DEFAULT_INSTANCE_DATA
  const clonedSessionMcp: Record<string, Record<string, boolean>> = {}
  for (const [k, v] of Object.entries(source.sessionMcpSettings ?? {})) {
    clonedSessionMcp[k] = { ...v }
  }
  return {
    messageHistory: Array.isArray(source.messageHistory) ? [...source.messageHistory] : [],
    agentModelSelections: { ...(source.agentModelSelections ?? {}) },
    mcpDefaults: { ...(source.mcpDefaults ?? {}) },
    sessionMcpSettings: clonedSessionMcp,
    sessionMcpModes: { ...(source.sessionMcpModes ?? {}) },
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
      log.warn("Failed to load instance data", error)
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
    log.warn("Failed to persist instance data", error)
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

async function clearSessionMcpSettings(instanceId: string, sessionId: string): Promise<void> {
  if (!instanceId || !sessionId) return
  await ensureInstanceConfig(instanceId)
  const current = instanceDataMap().get(instanceId) ?? DEFAULT_INSTANCE_DATA
  const sessionSettings = current.sessionMcpSettings ?? {}
  if (!sessionSettings[sessionId]) return
  const draft = cloneInstanceData(current)
  delete draft.sessionMcpSettings?.[sessionId]
  try {
    await storage.saveInstanceData(instanceId, draft)
  } catch (error) {
    log.warn("Failed to clear session MCP settings", error)
  }
  setInstanceData(instanceId, draft)
}

function getSessionMcpMode(instanceId: string, sessionId: string | null): "global" | "local" {
  if (!sessionId) return "global"
  const config = getInstanceConfig(instanceId)
  return config.sessionMcpModes?.[sessionId] ?? "global"
}

async function setSessionMcpMode(instanceId: string, sessionId: string, mode: "global" | "local"): Promise<void> {
  await ensureInstanceConfig(instanceId)
  await updateInstanceConfig(instanceId, (draft) => {
    draft.sessionMcpModes = draft.sessionMcpModes ?? {}
    draft.sessionMcpModes[sessionId] = mode
  })
}

function getMcpSettingsForSession(instanceId: string, sessionId: string | null): Record<string, boolean> {
  const config = getInstanceConfig(instanceId)
  const defaults = config.mcpDefaults ?? {}
  if (!sessionId) return defaults

  const mode = getSessionMcpMode(instanceId, sessionId)

  if (mode === "global") {
    // In global mode, completely ignore session overrides and strictly use defaults
    return defaults
  }

  // In local mode, we merge local settings on top of defaults.
  // This ensures that servers implicitly "on" in the workspace stay on,
  // until explicitly toggled off in the local session.
  if (config.sessionMcpSettings?.[sessionId]) {
    return { ...defaults, ...config.sessionMcpSettings[sessionId] }
  }

  return defaults
}

async function saveMcpSettingForSession(instanceId: string, sessionId: string | null, serverName: string, enabled: boolean): Promise<void> {
  await ensureInstanceConfig(instanceId)
  await updateInstanceConfig(instanceId, (draft) => {
    if (sessionId) {
      const mode = draft.sessionMcpModes?.[sessionId] ?? "global"

      draft.sessionMcpSettings = draft.sessionMcpSettings ?? {}

      if (mode === "global") {
        // Toggling a switch while in Global mode completely OVERWRITES previous local settings
        // We take a snapshot of the current workspace defaults, apply the toggle, and save it as the new Local state.
        const currentDefaults = draft.mcpDefaults ?? {}
        draft.sessionMcpSettings[sessionId] = { ...currentDefaults, [serverName]: enabled }

        // Auto-switch to local mode
        draft.sessionMcpModes = draft.sessionMcpModes ?? {}
        draft.sessionMcpModes[sessionId] = "local"
      } else {
        // Already in local mode: just update the specific toggle, appending it to the existing local config
        draft.sessionMcpSettings[sessionId] = draft.sessionMcpSettings[sessionId] ?? {}
        draft.sessionMcpSettings[sessionId][serverName] = enabled
      }
    } else {
      draft.mcpDefaults = draft.mcpDefaults ?? {}
      draft.mcpDefaults[serverName] = enabled
    }
  })
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
  clearSessionMcpSettings,
  getMcpSettingsForSession,
  saveMcpSettingForSession,
  getSessionMcpMode,
  setSessionMcpMode,
}
