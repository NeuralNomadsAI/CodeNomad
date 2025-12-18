import { createContext, createMemo, createRoot, createSignal, onMount, useContext } from "solid-js"
import type { Accessor, ParentComponent } from "solid-js"
import { storage, type ConfigData } from "../lib/storage"
import {
  ensureInstanceConfigLoaded,
  getInstanceConfig,
  updateInstanceConfig as updateInstanceData,
} from "./instance-config"
import { getLogger } from "../lib/logger"

const log = getLogger("actions")

type DeepReadonly<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends Array<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

export interface ModelPreference {
  providerId: string
  modelId: string
}

export interface AgentModelSelections {
  [instanceId: string]: Record<string, ModelPreference>
}

export type DiffViewMode = "split" | "unified"
export type ExpansionPreference = "expanded" | "collapsed"

export type ListeningMode = "local" | "all"

export type McpLocalServerConfig = {
  type: "local"
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export type McpRemoteServerConfig = {
  type: "remote"
  url: string
  headers?: Record<string, string>
  oauth?: boolean | Record<string, unknown>
  enabled?: boolean
  timeout?: number
}

export type McpServerConfig = McpLocalServerConfig | McpRemoteServerConfig

export interface Preferences {
  showThinkingBlocks: boolean
  thinkingBlocksExpansion: ExpansionPreference
  showTimelineTools: boolean
  lastUsedBinary?: string
  environmentVariables: Record<string, string>
  modelRecents: ModelPreference[]
  diffViewMode: DiffViewMode
  toolOutputExpansion: ExpansionPreference
  diagnosticsExpansion: ExpansionPreference
  showUsageMetrics: boolean
  autoCleanupBlankSessions: boolean
  listeningMode: ListeningMode

  modelDefaultsByAgent: Record<string, ModelPreference>

  mcpRegistry: Record<string, McpServerConfig>
  mcpDesiredState: Record<string, boolean>
  mcpAutoApply: boolean
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

export type ThemePreference = NonNullable<ConfigData["theme"]>

const MAX_RECENT_FOLDERS = 20
const MAX_RECENT_MODELS = 5

const defaultPreferences: Preferences = {
  showThinkingBlocks: false,
  thinkingBlocksExpansion: "expanded",
  showTimelineTools: true,
  environmentVariables: {},
  modelRecents: [],
  diffViewMode: "split",
  toolOutputExpansion: "expanded",
  diagnosticsExpansion: "expanded",
  showUsageMetrics: true,
  autoCleanupBlankSessions: true,
  listeningMode: "local",

  modelDefaultsByAgent: {},

  mcpRegistry: {},
  mcpDesiredState: {},
  mcpAutoApply: true,
}


function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch (error) {
      log.warn("Failed to compare preference values", error)
    }
  }
  return false
}

function normalizePreferences(pref?: Partial<Preferences> & { agentModelSelections?: unknown }): Preferences {
  const sanitized = pref ?? {}
  const environmentVariables = {
    ...defaultPreferences.environmentVariables,
    ...(sanitized.environmentVariables ?? {}),
  }

  const sourceModelRecents = sanitized.modelRecents ?? defaultPreferences.modelRecents
  const modelRecents = sourceModelRecents.map((item) => ({ ...item }))

  const modelDefaultsByAgent = { ...(sanitized.modelDefaultsByAgent ?? defaultPreferences.modelDefaultsByAgent) }

  const mcpRegistry = { ...(sanitized.mcpRegistry ?? defaultPreferences.mcpRegistry) }
  const mcpDesiredState = { ...(sanitized.mcpDesiredState ?? defaultPreferences.mcpDesiredState) }

  return {
    showThinkingBlocks: sanitized.showThinkingBlocks ?? defaultPreferences.showThinkingBlocks,
    thinkingBlocksExpansion: sanitized.thinkingBlocksExpansion ?? defaultPreferences.thinkingBlocksExpansion,
    showTimelineTools: sanitized.showTimelineTools ?? defaultPreferences.showTimelineTools,
    lastUsedBinary: sanitized.lastUsedBinary ?? defaultPreferences.lastUsedBinary,
    environmentVariables,
    modelRecents,
    diffViewMode: sanitized.diffViewMode ?? defaultPreferences.diffViewMode,
    toolOutputExpansion: sanitized.toolOutputExpansion ?? defaultPreferences.toolOutputExpansion,
    diagnosticsExpansion: sanitized.diagnosticsExpansion ?? defaultPreferences.diagnosticsExpansion,
    showUsageMetrics: sanitized.showUsageMetrics ?? defaultPreferences.showUsageMetrics,
    autoCleanupBlankSessions: sanitized.autoCleanupBlankSessions ?? defaultPreferences.autoCleanupBlankSessions,
    listeningMode: sanitized.listeningMode ?? defaultPreferences.listeningMode,

    modelDefaultsByAgent,

    mcpRegistry,
    mcpDesiredState,
    mcpAutoApply: sanitized.mcpAutoApply ?? defaultPreferences.mcpAutoApply,
  }
}

// Wrap module-level signals in createRoot to avoid "computations created outside a createRoot" warning
let internalConfig: () => ConfigData
let setInternalConfig: (v: ConfigData | ((prev: ConfigData) => ConfigData)) => void
let config: () => DeepReadonly<ConfigData>
let isConfigLoaded: () => boolean
let setIsConfigLoaded: (v: boolean) => void
let preferences: () => Preferences
let recentFolders: () => RecentFolder[]
let opencodeBinaries: () => OpenCodeBinary[]
let themePreference: () => ThemePreference
let loadPromise: Promise<void> | null = null

createRoot(() => {
  const [_internalConfig, _setInternalConfig] = createSignal<ConfigData>(buildFallbackConfig())
  internalConfig = _internalConfig
  setInternalConfig = _setInternalConfig

  config = createMemo<DeepReadonly<ConfigData>>(() => _internalConfig())
  const [_isConfigLoaded, _setIsConfigLoaded] = createSignal(false)
  isConfigLoaded = _isConfigLoaded
  setIsConfigLoaded = _setIsConfigLoaded

  preferences = createMemo<Preferences>(() => _internalConfig().preferences)
  recentFolders = createMemo<RecentFolder[]>(() => _internalConfig().recentFolders ?? [])
  opencodeBinaries = createMemo<OpenCodeBinary[]>(() => _internalConfig().opencodeBinaries ?? [])
  themePreference = createMemo<ThemePreference>(() => _internalConfig().theme ?? "dark")
})

function normalizeConfig(config?: ConfigData | null): ConfigData {
  return {
    preferences: normalizePreferences(config?.preferences),
    recentFolders: (config?.recentFolders ?? []).map((folder) => ({ ...folder })),
    opencodeBinaries: (config?.opencodeBinaries ?? []).map((binary) => ({ ...binary })),
    theme: config?.theme ?? "dark",
  }
}

function buildFallbackConfig(): ConfigData {
  return normalizeConfig()
}

function removeLegacyAgentSelections(config?: ConfigData | null): { cleaned: ConfigData; migrated: boolean } {
  const migrated = Boolean((config?.preferences as { agentModelSelections?: unknown } | undefined)?.agentModelSelections)
  const cleanedConfig = normalizeConfig(config)
  return { cleaned: cleanedConfig, migrated }
}

async function syncConfig(source?: ConfigData): Promise<void> {
  try {
    const loaded = source ?? (await storage.loadConfig())
    const { cleaned, migrated } = removeLegacyAgentSelections(loaded)
    applyConfig(cleaned)
    if (migrated) {
      void storage.updateConfig(cleaned).catch((error: unknown) => {
        log.error("Failed to persist legacy config cleanup", error)
      })
    }
  } catch (error) {
    log.error("Failed to load config", error)
    applyConfig(buildFallbackConfig())
  }
}

function applyConfig(next: ConfigData) {
  setInternalConfig(normalizeConfig(next))
  setIsConfigLoaded(true)
}

function cloneConfigForUpdate(): ConfigData {
  return normalizeConfig(internalConfig())
}

function logConfigDiff(previous: ConfigData, next: ConfigData) {
  if (deepEqual(previous, next)) {
    return
  }
  const changes = diffObjects(previous, next)
  if (changes.length > 0) {
    log.info("[Config] Changes", changes)
  }
}

function diffObjects(previous: unknown, next: unknown, path: string[] = []): string[] {
  if (previous === next) {
    return []
  }

  if (typeof previous !== "object" || previous === null || typeof next !== "object" || next === null) {
    return [path.join(".")]
  }

  const prevKeys = Object.keys(previous as Record<string, unknown>)
  const nextKeys = Object.keys(next as Record<string, unknown>)
  const allKeys = new Set([...prevKeys, ...nextKeys])
  const changes: string[] = []

  for (const key of allKeys) {
    const childPath = [...path, key]
    const prevValue = (previous as Record<string, unknown>)[key]
    const nextValue = (next as Record<string, unknown>)[key]
    changes.push(...diffObjects(prevValue, nextValue, childPath))
  }

  return changes
}

function updateConfig(mutator: (draft: ConfigData) => void): void {
  const previous = internalConfig()
  const draft = cloneConfigForUpdate()
  mutator(draft)
  logConfigDiff(previous, draft)
  applyConfig(draft)
  void persistFullConfig(draft)
}

async function persistFullConfig(next: ConfigData): Promise<void> {
  try {
    await ensureConfigLoaded()
    await storage.updateConfig(next)
  } catch (error) {
    log.error("Failed to save config", error)
    void syncConfig().catch((syncError: unknown) => {
      log.error("Failed to refresh config", syncError)
    })
  }
}

function setThemePreference(preference: ThemePreference): void {
  if (themePreference() === preference) {
    return
  }
  updateConfig((draft) => {
    draft.theme = preference
  })
}

async function ensureConfigLoaded(): Promise<void> {
  if (isConfigLoaded()) return
  if (!loadPromise) {
    loadPromise = syncConfig().finally(() => {
      loadPromise = null
    })
  }
  await loadPromise
}

function buildRecentFolderList(path: string, source: RecentFolder[]): RecentFolder[] {
  const folders = source.filter((f) => f.path !== path)
  folders.unshift({ path, lastAccessed: Date.now() })
  return folders.slice(0, MAX_RECENT_FOLDERS)
}

function buildBinaryList(path: string, version: string | undefined, source: OpenCodeBinary[]): OpenCodeBinary[] {
  const timestamp = Date.now()
  const existing = source.find((b) => b.path === path)
  if (existing) {
    const updatedEntry: OpenCodeBinary = { ...existing, lastUsed: timestamp }
    const remaining = source.filter((b) => b.path !== path)
    return [updatedEntry, ...remaining]
  }
  const nextEntry: OpenCodeBinary = version ? { path, version, lastUsed: timestamp } : { path, lastUsed: timestamp }
  return [nextEntry, ...source].slice(0, 10)
}

function updatePreferences(updates: Partial<Preferences>): void {
  const current = internalConfig().preferences
  const merged = normalizePreferences({ ...current, ...updates })
  if (deepEqual(current, merged)) {
    return
  }
  updateConfig((draft) => {
    draft.preferences = merged
  })
}

function setListeningMode(mode: ListeningMode): void {
  if (preferences().listeningMode === mode) return
  updatePreferences({ listeningMode: mode })
}

function setDiffViewMode(mode: DiffViewMode): void {
  if (preferences().diffViewMode === mode) return
  updatePreferences({ diffViewMode: mode })
}

function setToolOutputExpansion(mode: ExpansionPreference): void {
  if (preferences().toolOutputExpansion === mode) return
  updatePreferences({ toolOutputExpansion: mode })
}

function setDiagnosticsExpansion(mode: ExpansionPreference): void {
  if (preferences().diagnosticsExpansion === mode) return
  updatePreferences({ diagnosticsExpansion: mode })
}

function setThinkingBlocksExpansion(mode: ExpansionPreference): void {
  if (preferences().thinkingBlocksExpansion === mode) return
  updatePreferences({ thinkingBlocksExpansion: mode })
}

function toggleShowThinkingBlocks(): void {
  updatePreferences({ showThinkingBlocks: !preferences().showThinkingBlocks })
}

function toggleShowTimelineTools(): void {
  updatePreferences({ showTimelineTools: !preferences().showTimelineTools })
}

function toggleUsageMetrics(): void {
  updatePreferences({ showUsageMetrics: !preferences().showUsageMetrics })
}

function toggleAutoCleanupBlankSessions(): void {
  const nextValue = !preferences().autoCleanupBlankSessions
  log.info("toggle auto cleanup", { value: nextValue })
  updatePreferences({ autoCleanupBlankSessions: nextValue })
}

function addRecentFolder(path: string): void {
  updateConfig((draft) => {
    draft.recentFolders = buildRecentFolderList(path, draft.recentFolders)
  })
}

function removeRecentFolder(path: string): void {
  updateConfig((draft) => {
    draft.recentFolders = draft.recentFolders.filter((f) => f.path !== path)
  })
}

function addOpenCodeBinary(path: string, version?: string): void {
  updateConfig((draft) => {
    draft.opencodeBinaries = buildBinaryList(path, version, draft.opencodeBinaries)
  })
}

function removeOpenCodeBinary(path: string): void {
  updateConfig((draft) => {
    draft.opencodeBinaries = draft.opencodeBinaries.filter((b) => b.path !== path)
  })
}

function updateLastUsedBinary(path: string): void {
  const target = path || preferences().lastUsedBinary || "opencode"
  updateConfig((draft) => {
    draft.preferences = normalizePreferences({ ...draft.preferences, lastUsedBinary: target })
    draft.opencodeBinaries = buildBinaryList(target, undefined, draft.opencodeBinaries)
  })
}

function recordWorkspaceLaunch(folderPath: string, binaryPath?: string): void {
  updateConfig((draft) => {
    const targetBinary = binaryPath && binaryPath.trim().length > 0 ? binaryPath : draft.preferences.lastUsedBinary || "opencode"
    draft.recentFolders = buildRecentFolderList(folderPath, draft.recentFolders)
    draft.preferences = normalizePreferences({ ...draft.preferences, lastUsedBinary: targetBinary })
    draft.opencodeBinaries = buildBinaryList(targetBinary, undefined, draft.opencodeBinaries)
  })
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

async function setAgentModelPreference(instanceId: string, agent: string, model: ModelPreference): Promise<void> {
  if (!instanceId || !agent || !model.providerId || !model.modelId) return
  await ensureInstanceConfigLoaded(instanceId)
  await updateInstanceData(instanceId, (draft) => {
    const selections = { ...(draft.agentModelSelections ?? {}) }
    const existing = selections[agent]
    if (existing && existing.providerId === model.providerId && existing.modelId === model.modelId) {
      return
    }
    selections[agent] = model
    draft.agentModelSelections = selections
  })
}

async function getAgentModelPreference(instanceId: string, agent: string): Promise<ModelPreference | undefined> {
  if (!instanceId || !agent) return undefined
  await ensureInstanceConfigLoaded(instanceId)
  const selections = getInstanceConfig(instanceId).agentModelSelections ?? {}
  return selections[agent]
}

void ensureConfigLoaded().catch((error: unknown) => {
  log.error("Failed to initialize config", error)
})

interface ConfigContextValue {
  isLoaded: Accessor<boolean>
  config: typeof config
  preferences: typeof preferences
  recentFolders: typeof recentFolders
  opencodeBinaries: typeof opencodeBinaries
  themePreference: typeof themePreference
  setThemePreference: typeof setThemePreference
  updateConfig: typeof updateConfig
  toggleShowThinkingBlocks: typeof toggleShowThinkingBlocks
  toggleShowTimelineTools: typeof toggleShowTimelineTools
  toggleUsageMetrics: typeof toggleUsageMetrics
  toggleAutoCleanupBlankSessions: typeof toggleAutoCleanupBlankSessions

  setDiffViewMode: typeof setDiffViewMode
  setToolOutputExpansion: typeof setToolOutputExpansion
  setDiagnosticsExpansion: typeof setDiagnosticsExpansion
  setThinkingBlocksExpansion: typeof setThinkingBlocksExpansion
  setListeningMode: typeof setListeningMode
  addRecentFolder: typeof addRecentFolder
  removeRecentFolder: typeof removeRecentFolder
  addOpenCodeBinary: typeof addOpenCodeBinary
  removeOpenCodeBinary: typeof removeOpenCodeBinary
  updateLastUsedBinary: typeof updateLastUsedBinary
  recordWorkspaceLaunch: typeof recordWorkspaceLaunch
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
  config,
  preferences,
  recentFolders,
  opencodeBinaries,
  themePreference,
  setThemePreference,
  updateConfig,
  toggleShowThinkingBlocks,
  toggleShowTimelineTools,
  toggleUsageMetrics,
  toggleAutoCleanupBlankSessions,
  setDiffViewMode,
  setToolOutputExpansion,
  setDiagnosticsExpansion,
  setThinkingBlocksExpansion,
  setListeningMode,
  addRecentFolder,
  removeRecentFolder,
  addOpenCodeBinary,
  removeOpenCodeBinary,
  updateLastUsedBinary,
  recordWorkspaceLaunch,
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
    ensureConfigLoaded().catch((error: unknown) => {
      log.error("Failed to initialize config", error)
    })

    const unsubscribe = storage.onConfigChanged((config) => {
      syncConfig(config).catch((error: unknown) => {
        log.error("Failed to refresh config", error)
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
  config,
  preferences,
  updateConfig,
  updatePreferences,
  toggleShowThinkingBlocks,
  toggleShowTimelineTools,
  toggleAutoCleanupBlankSessions,
  toggleUsageMetrics,
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
  setToolOutputExpansion,
  setDiagnosticsExpansion,
  setThinkingBlocksExpansion,
  setListeningMode,
  themePreference,
  setThemePreference,
  recordWorkspaceLaunch,
 }
 


