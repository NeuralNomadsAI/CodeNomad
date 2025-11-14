import { createContext, createSignal, onMount, useContext } from "solid-js"
import type { Accessor, ParentComponent } from "solid-js"
import { storage, type ConfigData } from "../lib/storage"

export interface ModelPreference {
  providerId: string
  modelId: string
}

export interface AgentModelSelections {
  [instanceId: string]: Record<string, ModelPreference>
}

export type DiffViewMode = "split" | "unified"

export interface Preferences {
  showThinkingBlocks: boolean
  lastUsedBinary?: string
  environmentVariables?: Record<string, string>
  modelRecents?: ModelPreference[]
  agentModelSelections?: AgentModelSelections
  diffViewMode?: DiffViewMode
}

export interface OpenCodeBinary {
  path: string
  version?: string
  lastUsed: number
}

export interface RecentFolder {
  path: string
  lastAccessed: number
}

const MAX_RECENT_FOLDERS = 20
const MAX_RECENT_MODELS = 5

const defaultPreferences: Preferences = {
  showThinkingBlocks: false,
  modelRecents: [],
  agentModelSelections: {},
  diffViewMode: "split",
}

const [preferences, setPreferences] = createSignal<Preferences>(defaultPreferences)
const [recentFolders, setRecentFolders] = createSignal<RecentFolder[]>([])
const [opencodeBinaries, setOpenCodeBinaries] = createSignal<OpenCodeBinary[]>([])
const [isConfigLoaded, setIsConfigLoaded] = createSignal(false)
let cachedConfig: ConfigData = {
  preferences: defaultPreferences,
  recentFolders: [],
  opencodeBinaries: [],
}
let loadPromise: Promise<void> | null = null

async function loadConfig(): Promise<void> {
  try {
    const config = await storage.loadConfig()
    cachedConfig = {
      ...config,
      preferences: { ...defaultPreferences, ...config.preferences },
      recentFolders: config.recentFolders || [],
      opencodeBinaries: config.opencodeBinaries || [],
    }
  } catch (error) {
    console.error("Failed to load config:", error)
    cachedConfig = {
      ...cachedConfig,
      preferences: { ...defaultPreferences },
      recentFolders: [],
      opencodeBinaries: [],
    }
  }

  setPreferences(cachedConfig.preferences)
  setRecentFolders(cachedConfig.recentFolders)
  setOpenCodeBinaries(cachedConfig.opencodeBinaries)
  setIsConfigLoaded(true)
}

async function saveConfig(): Promise<void> {
  try {
    await ensureConfigLoaded()
    const config: ConfigData = {
      ...cachedConfig,
      preferences: preferences(),
      recentFolders: recentFolders(),
      opencodeBinaries: opencodeBinaries(),
    }
    cachedConfig = config
    await storage.saveConfig(config)
  } catch (error) {
    console.error("Failed to save config:", error)
  }
}

async function ensureConfigLoaded(): Promise<void> {
  if (isConfigLoaded()) return
  if (!loadPromise) {
    loadPromise = loadConfig().finally(() => {
      loadPromise = null
    })
  }
  await loadPromise
}


function updatePreferences(updates: Partial<Preferences>): void {
  const updated = { ...preferences(), ...updates }
  setPreferences(updated)
  saveConfig().catch(console.error)
}

function setDiffViewMode(mode: DiffViewMode): void {
  if (preferences().diffViewMode === mode) return
  updatePreferences({ diffViewMode: mode })
}

function toggleShowThinkingBlocks(): void {
  updatePreferences({ showThinkingBlocks: !preferences().showThinkingBlocks })
}

function addRecentFolder(path: string): void {
  const folders = recentFolders().filter((f) => f.path !== path)
  folders.unshift({ path, lastAccessed: Date.now() })

  const trimmed = folders.slice(0, MAX_RECENT_FOLDERS)
  setRecentFolders(trimmed)
  saveConfig().catch(console.error)
}

function removeRecentFolder(path: string): void {
  const folders = recentFolders().filter((f) => f.path !== path)
  setRecentFolders(folders)
  saveConfig().catch(console.error)
}

function addOpenCodeBinary(path: string, version?: string): void {
  const binaries = opencodeBinaries().filter((b) => b.path !== path)
  const lastUsed = Date.now()
  const binaryEntry: OpenCodeBinary = version ? { path, version, lastUsed } : { path, lastUsed }
  binaries.unshift(binaryEntry)

  const trimmed = binaries.slice(0, 10) // Keep max 10 binaries
  setOpenCodeBinaries(trimmed)
  saveConfig().catch(console.error)
}

function removeOpenCodeBinary(path: string): void {
  const binaries = opencodeBinaries().filter((b) => b.path !== path)
  setOpenCodeBinaries(binaries)
  saveConfig().catch(console.error)
}

function updateLastUsedBinary(path: string): void {
  updatePreferences({ lastUsedBinary: path })

  const binaries = opencodeBinaries()
  let binary = binaries.find((b) => b.path === path)

  // If binary not found in list, add it (for system PATH "opencode")
  if (!binary) {
    addOpenCodeBinary(path)
    binary = { path, lastUsed: Date.now() }
  } else {
    binary.lastUsed = Date.now()
    // Move to front
    const sorted = [binary, ...binaries.filter((b) => b.path !== path)]
    setOpenCodeBinaries(sorted)
    saveConfig().catch(console.error)
  }
}

function updateEnvironmentVariables(envVars: Record<string, string>): void {
  updatePreferences({ environmentVariables: envVars })
}

function addEnvironmentVariable(key: string, value: string): void {
  const current = preferences().environmentVariables || {}
  const updated = { ...current, [key]: value }
  updateEnvironmentVariables(updated)
}

function removeEnvironmentVariable(key: string): void {
  const current = preferences().environmentVariables || {}
  const { [key]: removed, ...rest } = current
  updateEnvironmentVariables(rest)
}

function addRecentModelPreference(model: ModelPreference): void {
  if (!model.providerId || !model.modelId) return
  const recents = preferences().modelRecents ?? []
  const filtered = recents.filter((item) => item.providerId !== model.providerId || item.modelId !== model.modelId)
  const updated = [model, ...filtered].slice(0, MAX_RECENT_MODELS)
  updatePreferences({ modelRecents: updated })
}

function setAgentModelPreference(instanceId: string, agent: string, model: ModelPreference): void {
  if (!instanceId || !agent || !model.providerId || !model.modelId) return
  const selections = preferences().agentModelSelections ?? {}
  const instanceSelections = selections[instanceId] ?? {}
  const existing = instanceSelections[agent]
  if (existing && existing.providerId === model.providerId && existing.modelId === model.modelId) {
    return
  }
  updatePreferences({
    agentModelSelections: {
      ...selections,
      [instanceId]: {
        ...instanceSelections,
        [agent]: model,
      },
    },
  })
}

function getAgentModelPreference(instanceId: string, agent: string): ModelPreference | undefined {
  return preferences().agentModelSelections?.[instanceId]?.[agent]
}

void ensureConfigLoaded().catch((error) => {
  console.error("Failed to initialize config:", error)
})

interface ConfigContextValue {
  isLoaded: Accessor<boolean>
  preferences: typeof preferences
  recentFolders: typeof recentFolders
  opencodeBinaries: typeof opencodeBinaries
  toggleShowThinkingBlocks: typeof toggleShowThinkingBlocks
  setDiffViewMode: typeof setDiffViewMode
  addRecentFolder: typeof addRecentFolder
  removeRecentFolder: typeof removeRecentFolder
  addOpenCodeBinary: typeof addOpenCodeBinary
  removeOpenCodeBinary: typeof removeOpenCodeBinary
  updateLastUsedBinary: typeof updateLastUsedBinary
  updatePreferences: typeof updatePreferences
  updateEnvironmentVariables: typeof updateEnvironmentVariables
  addEnvironmentVariable: typeof addEnvironmentVariable
  removeEnvironmentVariable: typeof removeEnvironmentVariable
  addRecentModelPreference: typeof addRecentModelPreference
  setAgentModelPreference: typeof setAgentModelPreference
  getAgentModelPreference: typeof getAgentModelPreference
}

const ConfigContext = createContext<ConfigContextValue>()

const configContextValue: ConfigContextValue = {
  isLoaded: isConfigLoaded,
  preferences,
  recentFolders,
  opencodeBinaries,
  toggleShowThinkingBlocks,
  setDiffViewMode,
  addRecentFolder,
  removeRecentFolder,
  addOpenCodeBinary,
  removeOpenCodeBinary,
  updateLastUsedBinary,
  updatePreferences,
  updateEnvironmentVariables,
  addEnvironmentVariable,
  removeEnvironmentVariable,
  addRecentModelPreference,
  setAgentModelPreference,
  getAgentModelPreference,
}

const ConfigProvider: ParentComponent = (props) => {
  onMount(() => {
    ensureConfigLoaded().catch((error) => {
      console.error("Failed to initialize config:", error)
    })

    const unsubscribe = storage.onConfigChanged(() => {
      loadConfig().catch((error) => {
        console.error("Failed to refresh config:", error)
      })
    })

    return () => {
      unsubscribe()
    }
  })

  return <ConfigContext.Provider value={configContextValue}>{props.children}</ConfigContext.Provider>
}

function useConfig(): ConfigContextValue {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error("useConfig must be used within ConfigProvider")
  }
  return context
}

export {
  ConfigProvider,
  useConfig,
  preferences,
  updatePreferences,
  toggleShowThinkingBlocks,
  recentFolders,
  addRecentFolder,
  removeRecentFolder,
  opencodeBinaries,
  addOpenCodeBinary,
  removeOpenCodeBinary,
  updateLastUsedBinary,
  updateEnvironmentVariables,
  addEnvironmentVariable,
  removeEnvironmentVariable,
  addRecentModelPreference,
  setAgentModelPreference,
  getAgentModelPreference,
  setDiffViewMode,
}
