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

export type BinaryPreferenceSource = "user" | "auto"

/** Extended thinking mode (Anthropic-style) */
export type ThinkingModeExtended = "auto" | "enabled" | "disabled"
/** Budget-based reasoning mode (OpenAI-style) */
export type ThinkingModeBudget = "low" | "medium" | "high"
/** Simple boolean reasoning mode (generic) */
export type ThinkingModeBoolean = "on" | "off"
/** Union of all thinking mode values */
export type ThinkingMode = ThinkingModeExtended | ThinkingModeBudget | ThinkingModeBoolean
/** Reasoning flavor determines which option set to show */
export type ReasoningFlavor = "extended" | "budget" | "boolean"

/** Per-model thinking mode selections */
export type ModelThinkingSelections = Record<string, ThinkingMode>

export interface Preferences {
  showThinkingBlocks: boolean
  thinkingBlocksExpansion: ExpansionPreference
  showTimelineTools: boolean
  lastUsedBinary?: string
  // Tracks whether lastUsedBinary was explicitly set by user or auto-detected
  binaryPreferenceSource: BinaryPreferenceSource
  environmentVariables: Record<string, string>
  modelRecents: ModelPreference[]
  diffViewMode: DiffViewMode
  toolOutputExpansion: ExpansionPreference
  diagnosticsExpansion: ExpansionPreference
  showUsageMetrics: boolean
  autoCleanupBlankSessions: boolean
  stopInstanceOnLastSessionDelete: boolean
  idleInstanceTimeoutMinutes: number
  autoStopOnDisconnect: boolean
  listeningMode: ListeningMode

  // Permissions
  autoApprovePermissions: boolean

  // Chat window settings
  defaultToolCallsCollapsed: boolean
  showVerboseOutput: boolean

  modelDefaultsByAgent: Record<string, ModelPreference>

  mcpRegistry: Record<string, McpServerConfig>
  mcpDesiredState: Record<string, boolean>
  mcpAutoApply: boolean

  /** Per-model thinking mode selections */
  modelThinkingSelections: ModelThinkingSelections

  /** Favorite model identifiers (e.g., "providerId/modelId") */
  modelFavorites: string[]

  // GitHub
  defaultClonePath?: string

  // Update checking preferences (synced from server)
  lastUpdateCheckTime?: number
  autoCheckForUpdates: boolean

  // Sub-agent configuration
  maxSubagentIterations: number
  agentAutonomy: "conservative" | "balanced" | "aggressive"

  // Tool routing configuration
  toolRouting: {
    globalDeny: string[]
    profiles: Record<string, {
      addCategories?: string[]
      removeCategories?: string[]
      addTools?: string[]
      denyTools?: string[]
    } | undefined>
  }
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
  binaryPreferenceSource: "auto",
  environmentVariables: {},
  modelRecents: [],
  diffViewMode: "split",
  toolOutputExpansion: "expanded",
  diagnosticsExpansion: "expanded",
  showUsageMetrics: true,
  autoCleanupBlankSessions: true,
  stopInstanceOnLastSessionDelete: false,
  idleInstanceTimeoutMinutes: 0,
  autoStopOnDisconnect: true, // Auto-stop disconnected instances to prevent orphans
  listeningMode: "local",

  // Permissions - default to auto-approve (skip permission prompts)
  autoApprovePermissions: true,

  // Chat window settings - default to collapsed tool calls, show verbose output
  defaultToolCallsCollapsed: true,
  showVerboseOutput: true,

  modelDefaultsByAgent: {},

  mcpRegistry: {},
  mcpDesiredState: {},
  mcpAutoApply: true,

  modelThinkingSelections: {},
  modelFavorites: [],

  // Update checking
  autoCheckForUpdates: true,

  // Sub-agent configuration
  maxSubagentIterations: 3,
  agentAutonomy: "balanced",

  // Tool routing
  toolRouting: { globalDeny: [], profiles: {} },
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
  const modelThinkingSelections = { ...(sanitized.modelThinkingSelections ?? defaultPreferences.modelThinkingSelections) }
  const modelFavorites = [...(sanitized.modelFavorites ?? defaultPreferences.modelFavorites)]

  return {
    showThinkingBlocks: sanitized.showThinkingBlocks ?? defaultPreferences.showThinkingBlocks,
    thinkingBlocksExpansion: sanitized.thinkingBlocksExpansion ?? defaultPreferences.thinkingBlocksExpansion,
    showTimelineTools: sanitized.showTimelineTools ?? defaultPreferences.showTimelineTools,
    lastUsedBinary: sanitized.lastUsedBinary ?? defaultPreferences.lastUsedBinary,
    binaryPreferenceSource: sanitized.binaryPreferenceSource ?? defaultPreferences.binaryPreferenceSource,
    environmentVariables,
    modelRecents,
    diffViewMode: sanitized.diffViewMode ?? defaultPreferences.diffViewMode,
    toolOutputExpansion: sanitized.toolOutputExpansion ?? defaultPreferences.toolOutputExpansion,
    diagnosticsExpansion: sanitized.diagnosticsExpansion ?? defaultPreferences.diagnosticsExpansion,
    showUsageMetrics: sanitized.showUsageMetrics ?? defaultPreferences.showUsageMetrics,
    autoCleanupBlankSessions: sanitized.autoCleanupBlankSessions ?? defaultPreferences.autoCleanupBlankSessions,
    stopInstanceOnLastSessionDelete: sanitized.stopInstanceOnLastSessionDelete ?? defaultPreferences.stopInstanceOnLastSessionDelete,
    idleInstanceTimeoutMinutes: sanitized.idleInstanceTimeoutMinutes ?? defaultPreferences.idleInstanceTimeoutMinutes,
    autoStopOnDisconnect: sanitized.autoStopOnDisconnect ?? defaultPreferences.autoStopOnDisconnect,
    listeningMode: sanitized.listeningMode ?? defaultPreferences.listeningMode,

    // Permissions
    autoApprovePermissions: sanitized.autoApprovePermissions ?? defaultPreferences.autoApprovePermissions,

    // Chat window settings
    defaultToolCallsCollapsed: sanitized.defaultToolCallsCollapsed ?? defaultPreferences.defaultToolCallsCollapsed,
    showVerboseOutput: sanitized.showVerboseOutput ?? defaultPreferences.showVerboseOutput,

    modelDefaultsByAgent,

    mcpRegistry,
    mcpDesiredState,
    mcpAutoApply: sanitized.mcpAutoApply ?? defaultPreferences.mcpAutoApply,

    modelThinkingSelections,
    modelFavorites,

    // GitHub
    defaultClonePath: sanitized.defaultClonePath,

    // Update checking
    lastUpdateCheckTime: sanitized.lastUpdateCheckTime,
    autoCheckForUpdates: sanitized.autoCheckForUpdates ?? defaultPreferences.autoCheckForUpdates,

    // Sub-agent configuration
    maxSubagentIterations: Math.min(10, Math.max(1, sanitized.maxSubagentIterations ?? defaultPreferences.maxSubagentIterations)),
    agentAutonomy: (["conservative", "balanced", "aggressive"].includes(sanitized.agentAutonomy as string)
      ? sanitized.agentAutonomy
      : defaultPreferences.agentAutonomy) as "conservative" | "balanced" | "aggressive",

    // Tool routing
    toolRouting: sanitized.toolRouting ?? defaultPreferences.toolRouting,
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

function toggleStopInstanceOnLastSessionDelete(): void {
  const nextValue = !preferences().stopInstanceOnLastSessionDelete
  log.info("toggle stop instance on last session delete", { value: nextValue })
  updatePreferences({ stopInstanceOnLastSessionDelete: nextValue })
}

function toggleDefaultToolCallsCollapsed(): void {
  const nextValue = !preferences().defaultToolCallsCollapsed
  log.info("toggle default tool calls collapsed", { value: nextValue })
  updatePreferences({ defaultToolCallsCollapsed: nextValue })
}

function toggleShowVerboseOutput(): void {
  const nextValue = !preferences().showVerboseOutput
  log.info("toggle show verbose output", { value: nextValue })
  updatePreferences({ showVerboseOutput: nextValue })
}

function toggleAutoApprovePermissions(): void {
  const nextValue = !preferences().autoApprovePermissions
  log.info("toggle auto-approve permissions", { value: nextValue })
  updatePreferences({ autoApprovePermissions: nextValue })
}

function setMaxSubagentIterations(value: number): void {
  const clamped = Math.min(10, Math.max(1, Math.round(value)))
  if (preferences().maxSubagentIterations === clamped) return
  updatePreferences({ maxSubagentIterations: clamped })
}

function setAgentAutonomy(value: "conservative" | "balanced" | "aggressive"): void {
  if (preferences().agentAutonomy === value) return
  updatePreferences({ agentAutonomy: value })
}

function setDefaultClonePath(path: string): void {
  updatePreferences({ defaultClonePath: path || undefined })
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
    draft.preferences = normalizePreferences({ ...draft.preferences, lastUsedBinary: target, binaryPreferenceSource: "user" })
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

function setDefaultModels(models: Record<string, ModelPreference>): void {
  log.info("Setting default models by agent", { models })
  updatePreferences({ modelDefaultsByAgent: models })
}

/**
 * Determine the reasoning flavor for a given provider.
 * - Anthropic / Bedrock / Vertex → extended (auto/enabled/disabled)
 * - OpenAI / Azure → budget (low/medium/high)
 * - Everything else → boolean (on/off)
 */
function getReasoningFlavor(providerId: string): ReasoningFlavor {
  const id = providerId.toLowerCase()
  if (id.includes("anthropic") || id.includes("bedrock") || id.includes("vertex")) {
    return "extended"
  }
  if (id.includes("openai") || id.includes("azure")) {
    return "budget"
  }
  return "boolean"
}

/**
 * Get the default thinking mode for a given flavor.
 */
function getDefaultThinkingMode(flavor: ReasoningFlavor): ThinkingMode {
  switch (flavor) {
    case "extended":
      return "auto"
    case "budget":
      return "medium"
    case "boolean":
      return "off"
  }
}

const EXTENDED_MODES: ThinkingMode[] = ["auto", "enabled", "disabled"]
const BUDGET_MODES: ThinkingMode[] = ["low", "medium", "high"]
const BOOLEAN_MODES: ThinkingMode[] = ["on", "off"]

/**
 * Get the valid modes for a flavor.
 */
function getModesForFlavor(flavor: ReasoningFlavor): ThinkingMode[] {
  switch (flavor) {
    case "extended":
      return EXTENDED_MODES
    case "budget":
      return BUDGET_MODES
    case "boolean":
      return BOOLEAN_MODES
  }
}

/**
 * Get the effective thinking mode for a model, falling back to the flavor default
 * if the stored mode doesn't match the current flavor.
 */
function getEffectiveThinkingMode(modelKey: string, providerId: string): ThinkingMode {
  if (!modelKey) return "auto"
  const stored = preferences().modelThinkingSelections?.[modelKey]
  const flavor = getReasoningFlavor(providerId)
  const validModes = getModesForFlavor(flavor)
  if (stored && validModes.includes(stored)) {
    return stored
  }
  return getDefaultThinkingMode(flavor)
}

/**
 * Set the thinking mode for a specific model.
 * @param modelKey - The model identifier (e.g., "claude-sonnet-4" or "providerId/modelId")
 * @param mode - The thinking mode to set
 */
function setModelThinkingMode(modelKey: string, mode: ThinkingMode): void {
  if (!modelKey) return
  const current = preferences().modelThinkingSelections ?? {}
  if (current[modelKey] === mode) return
  updatePreferences({ modelThinkingSelections: { ...current, [modelKey]: mode } })
}

/**
 * Get the thinking mode for a specific model.
 * @param modelKey - The model identifier
 * @returns The thinking mode, defaults to "auto"
 */
function getModelThinkingMode(modelKey: string): ThinkingMode {
  if (!modelKey) return "auto"
  return preferences().modelThinkingSelections?.[modelKey] ?? "auto"
}

/**
 * Add a model to favorites.
 * @param modelKey - The model identifier (e.g., "providerId/modelId")
 */
function addModelFavorite(modelKey: string): void {
  if (!modelKey) return
  const current = preferences().modelFavorites ?? []
  if (current.includes(modelKey)) return
  updatePreferences({ modelFavorites: [...current, modelKey] })
}

/**
 * Remove a model from favorites.
 * @param modelKey - The model identifier
 */
function removeModelFavorite(modelKey: string): void {
  if (!modelKey) return
  const current = preferences().modelFavorites ?? []
  if (!current.includes(modelKey)) return
  updatePreferences({ modelFavorites: current.filter(key => key !== modelKey) })
}

/**
 * Toggle a model's favorite status.
 * @param modelKey - The model identifier
 */
function toggleModelFavorite(modelKey: string): void {
  if (!modelKey) return
  const current = preferences().modelFavorites ?? []
  if (current.includes(modelKey)) {
    removeModelFavorite(modelKey)
  } else {
    addModelFavorite(modelKey)
  }
}

/**
 * Check if a model is a favorite.
 * @param modelKey - The model identifier
 * @returns Whether the model is favorited
 */
function isModelFavorite(modelKey: string): boolean {
  if (!modelKey) return false
  return (preferences().modelFavorites ?? []).includes(modelKey)
}

/**
 * Get the list of favorite model keys.
 * @returns Array of favorite model identifiers
 */
function getModelFavorites(): string[] {
  return preferences().modelFavorites ?? []
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
  toggleStopInstanceOnLastSessionDelete: typeof toggleStopInstanceOnLastSessionDelete
  toggleDefaultToolCallsCollapsed: typeof toggleDefaultToolCallsCollapsed
  toggleShowVerboseOutput: typeof toggleShowVerboseOutput
  toggleAutoApprovePermissions: typeof toggleAutoApprovePermissions

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
  setMaxSubagentIterations: typeof setMaxSubagentIterations
  setAgentAutonomy: typeof setAgentAutonomy
  setDefaultClonePath: typeof setDefaultClonePath
  setDefaultModels: typeof setDefaultModels
  setModelThinkingMode: typeof setModelThinkingMode
  getModelThinkingMode: typeof getModelThinkingMode
  getReasoningFlavor: typeof getReasoningFlavor
  getDefaultThinkingMode: typeof getDefaultThinkingMode
  getEffectiveThinkingMode: typeof getEffectiveThinkingMode
  getModesForFlavor: typeof getModesForFlavor
  addModelFavorite: typeof addModelFavorite
  removeModelFavorite: typeof removeModelFavorite
  toggleModelFavorite: typeof toggleModelFavorite
  isModelFavorite: typeof isModelFavorite
  getModelFavorites: typeof getModelFavorites
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
  toggleStopInstanceOnLastSessionDelete,
  toggleDefaultToolCallsCollapsed,
  toggleShowVerboseOutput,
  toggleAutoApprovePermissions,
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
  setMaxSubagentIterations,
  setAgentAutonomy,
  setDefaultClonePath,
  setDefaultModels,
  setModelThinkingMode,
  getModelThinkingMode,
  getReasoningFlavor,
  getDefaultThinkingMode,
  getEffectiveThinkingMode,
  getModesForFlavor,
  addModelFavorite,
  removeModelFavorite,
  toggleModelFavorite,
  isModelFavorite,
  getModelFavorites,
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
  toggleStopInstanceOnLastSessionDelete,
  toggleDefaultToolCallsCollapsed,
  toggleShowVerboseOutput,
  toggleAutoApprovePermissions,
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
  setMaxSubagentIterations,
  setAgentAutonomy,
  setDefaultClonePath,
  setDefaultModels,
  setModelThinkingMode,
  getModelThinkingMode,
  getReasoningFlavor,
  getDefaultThinkingMode,
  getEffectiveThinkingMode,
  getModesForFlavor,
  addModelFavorite,
  removeModelFavorite,
  toggleModelFavorite,
  isModelFavorite,
  getModelFavorites,
}



