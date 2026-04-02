import { createContext, createEffect, createMemo, createSignal, onMount, useContext } from "solid-js"
import type { Accessor, ParentComponent } from "solid-js"
import { storage, type OwnerBucket } from "../lib/storage"
import {
  ensureInstanceConfigLoaded,
  getInstanceConfig,
  updateInstanceConfig as updateInstanceData,
} from "./instance-config"
import { getLogger } from "../lib/logger"
import { loadSpeechCapabilities, resetSpeechCapabilities } from "./speech"

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

export type DiffViewMode = "split" | "unified"
export type ExpansionPreference = "expanded" | "collapsed"
export type ToolInputsVisibilityPreference = "hidden" | "collapsed" | "expanded"
export type ListeningMode = "local" | "all"
export type ServerLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"
export type SpeechProviderPreference = "openai-compatible"
export type SpeechPlaybackMode = "streaming" | "buffered"
export type SpeechTtsFormat = "mp3" | "wav" | "opus" | "aac"

export interface SpeechSettings {
  provider: SpeechProviderPreference
  apiKey?: string
  hasApiKey: boolean
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  playbackMode: SpeechPlaybackMode
  ttsFormat: SpeechTtsFormat
}

export type SpeechSettingsUpdate = Partial<Omit<SpeechSettings, "apiKey">> & {
  apiKey?: string | null
}

export interface UiSettings {
  showThinkingBlocks: boolean
  showKeyboardShortcutHints: boolean
  thinkingBlocksExpansion: ExpansionPreference
  showTimelineTools: boolean
  promptSubmitOnEnter: boolean
  showPromptVoiceInput: boolean
  locale?: string
  diffViewMode: DiffViewMode
  toolOutputExpansion: ExpansionPreference
  diagnosticsExpansion: ExpansionPreference
  toolInputsVisibility: ToolInputsVisibilityPreference
  showUsageMetrics: boolean
  autoCleanupBlankSessions: boolean

  // OS notifications
  osNotificationsEnabled: boolean
  osNotificationsAllowWhenVisible: boolean
  notifyOnNeedsInput: boolean
  notifyOnIdle: boolean

  // UI font settings
  fontFamilySans?: string
  fontFamilyMono?: string
}

// Backwards-compatible alias for older imports.
export type Preferences = UiSettings

export interface OpenCodeBinary {
  path: string
  version?: string
  lastUsed: number
  label?: string
}

export interface RecentFolder {
  path: string
  lastAccessed: number
}

export type ThemePreference = "light" | "dark" | "system"

interface UiConfigBucket {
  theme?: ThemePreference
  settings?: Partial<UiSettings>
}

interface ServerConfigBucket {
  listeningMode?: ListeningMode
  logLevel?: ServerLogLevel
  environmentVariables?: Record<string, string>
  opencodeBinary?: string
  speech?: Partial<SpeechSettings>
}

interface UiStateBucket {
  recentFolders?: RecentFolder[]
  opencodeBinaries?: OpenCodeBinary[]
  models?: {
    recents?: ModelPreference[]
    favorites?: ModelPreference[]
    thinkingSelections?: Record<string, string>
  }
}

interface NormalizedUiState {
  recentFolders: RecentFolder[]
  opencodeBinaries: OpenCodeBinary[]
  models: {
    recents: ModelPreference[]
    favorites: ModelPreference[]
    thinkingSelections: Record<string, string>
  }
}

const MAX_RECENT_FOLDERS = 20
const MAX_RECENT_MODELS = 5
const MAX_FAVORITE_MODELS = 50

const defaultUiSettings: UiSettings = {
  showThinkingBlocks: false,
  showKeyboardShortcutHints: true,
  thinkingBlocksExpansion: "expanded",
  showTimelineTools: true,
  promptSubmitOnEnter: false,
  showPromptVoiceInput: true,
  diffViewMode: "split",
  toolOutputExpansion: "expanded",
  diagnosticsExpansion: "expanded",
  toolInputsVisibility: "collapsed",
  showUsageMetrics: true,
  autoCleanupBlankSessions: true,

  osNotificationsEnabled: false,
  osNotificationsAllowWhenVisible: false,
  notifyOnNeedsInput: true,
  notifyOnIdle: true,

  // Font settings
  fontFamilySans: undefined,
  fontFamilyMono: undefined,
}

const defaultSpeechSettings: SpeechSettings = {
  provider: "openai-compatible",
  hasApiKey: false,
  sttModel: "gpt-4o-mini-transcribe",
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "alloy",
  playbackMode: "streaming",
  ttsFormat: "mp3",
}

function normalizeUiSettings(input?: Partial<UiSettings> | null): UiSettings {
  const sanitized = input ?? {}
  return {
    showThinkingBlocks: sanitized.showThinkingBlocks ?? defaultUiSettings.showThinkingBlocks,
    showKeyboardShortcutHints:
      sanitized.showKeyboardShortcutHints ?? defaultUiSettings.showKeyboardShortcutHints,
    thinkingBlocksExpansion: sanitized.thinkingBlocksExpansion ?? defaultUiSettings.thinkingBlocksExpansion,
    showTimelineTools: sanitized.showTimelineTools ?? defaultUiSettings.showTimelineTools,
    promptSubmitOnEnter: sanitized.promptSubmitOnEnter ?? defaultUiSettings.promptSubmitOnEnter,
    showPromptVoiceInput: sanitized.showPromptVoiceInput ?? defaultUiSettings.showPromptVoiceInput,
    locale: sanitized.locale ?? defaultUiSettings.locale,
    diffViewMode: sanitized.diffViewMode ?? defaultUiSettings.diffViewMode,
    toolOutputExpansion: sanitized.toolOutputExpansion ?? defaultUiSettings.toolOutputExpansion,
    diagnosticsExpansion: sanitized.diagnosticsExpansion ?? defaultUiSettings.diagnosticsExpansion,
    toolInputsVisibility:
      sanitized.toolInputsVisibility === "hidden" || sanitized.toolInputsVisibility === "collapsed" || sanitized.toolInputsVisibility === "expanded"
        ? sanitized.toolInputsVisibility
        : defaultUiSettings.toolInputsVisibility,
    showUsageMetrics: sanitized.showUsageMetrics ?? defaultUiSettings.showUsageMetrics,
    autoCleanupBlankSessions: sanitized.autoCleanupBlankSessions ?? defaultUiSettings.autoCleanupBlankSessions,
    osNotificationsEnabled: sanitized.osNotificationsEnabled ?? defaultUiSettings.osNotificationsEnabled,
    osNotificationsAllowWhenVisible:
      sanitized.osNotificationsAllowWhenVisible ?? defaultUiSettings.osNotificationsAllowWhenVisible,
    notifyOnNeedsInput: sanitized.notifyOnNeedsInput ?? defaultUiSettings.notifyOnNeedsInput,
    notifyOnIdle: sanitized.notifyOnIdle ?? defaultUiSettings.notifyOnIdle,
    fontFamilySans: normalizeFontFamily(sanitized.fontFamilySans),
    fontFamilyMono: normalizeFontFamily(sanitized.fontFamilyMono),
  }
}

/**
 * 標準化字體設定字符串
 * 確保字符串經過 trim 並且不為空，否則返回 undefined
 * 
 * @param value - 輸入的字符串值
 * @returns 標準化後的字體字符串，如果無效則返回 undefined
 */
function normalizeFontFamily(value: unknown): string | undefined {
  // 檢查是否為字符串類型
  if (typeof value !== "string") return undefined
  
  // 去除首尾空白
  const trimmed = value.trim()
  
  // 檢查是否為空字符串
  if (trimmed.length === 0) return undefined
  
  return trimmed
}

function normalizeRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

function normalizeSpeechSettings(input?: Partial<SpeechSettings> | null): SpeechSettings {
  const sanitized = input ?? {}
  return {
    provider: sanitized.provider === "openai-compatible" ? sanitized.provider : defaultSpeechSettings.provider,
    apiKey: typeof sanitized.apiKey === "string" && sanitized.apiKey.trim() ? sanitized.apiKey.trim() : undefined,
    hasApiKey: sanitized.hasApiKey === true || (typeof sanitized.apiKey === "string" && sanitized.apiKey.trim().length > 0),
    baseUrl: typeof sanitized.baseUrl === "string" && sanitized.baseUrl.trim() ? sanitized.baseUrl.trim() : undefined,
    sttModel:
      typeof sanitized.sttModel === "string" && sanitized.sttModel.trim()
        ? sanitized.sttModel.trim()
        : defaultSpeechSettings.sttModel,
    ttsModel:
      typeof sanitized.ttsModel === "string" && sanitized.ttsModel.trim()
        ? sanitized.ttsModel.trim()
        : defaultSpeechSettings.ttsModel,
    ttsVoice:
      typeof sanitized.ttsVoice === "string" && sanitized.ttsVoice.trim()
        ? sanitized.ttsVoice.trim()
        : defaultSpeechSettings.ttsVoice,
    playbackMode:
      sanitized.playbackMode === "buffered" || sanitized.playbackMode === "streaming"
        ? sanitized.playbackMode
        : defaultSpeechSettings.playbackMode,
    ttsFormat:
      sanitized.ttsFormat === "wav" || sanitized.ttsFormat === "opus" || sanitized.ttsFormat === "aac" || sanitized.ttsFormat === "mp3"
        ? sanitized.ttsFormat
        : defaultSpeechSettings.ttsFormat,
  }
}

function cloneArray<T>(value: unknown, mapper: (item: any) => T | null): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    const mapped = mapper(item)
    if (mapped) out.push(mapped)
  }
  return out
}

function normalizeUiState(input?: UiStateBucket | null): NormalizedUiState {
  const source = input ?? {}
  return {
    recentFolders: cloneArray<RecentFolder>(source.recentFolders, (f) => {
      if (!f || typeof f !== "object") return null
      const p = (f as any).path
      const lastAccessed = (f as any).lastAccessed
      if (typeof p !== "string") return null
      const ts = typeof lastAccessed === "number" ? lastAccessed : Date.now()
      return { path: p, lastAccessed: ts }
    }),
    opencodeBinaries: cloneArray<OpenCodeBinary>(source.opencodeBinaries, (b) => {
      if (!b || typeof b !== "object") return null
      const p = (b as any).path
      if (typeof p !== "string") return null
      const lastUsed = typeof (b as any).lastUsed === "number" ? (b as any).lastUsed : Date.now()
      const version = typeof (b as any).version === "string" ? (b as any).version : undefined
      const label = typeof (b as any).label === "string" ? (b as any).label : undefined
      return { path: p, version, label, lastUsed }
    }),
    models: {
      recents: cloneArray<ModelPreference>((source.models as any)?.recents, (m) => {
        if (!m || typeof m !== "object") return null
        const providerId = (m as any).providerId
        const modelId = (m as any).modelId
        if (typeof providerId !== "string" || typeof modelId !== "string") return null
        return { providerId, modelId }
      }),
      favorites: cloneArray<ModelPreference>((source.models as any)?.favorites, (m) => {
        if (!m || typeof m !== "object") return null
        const providerId = (m as any).providerId
        const modelId = (m as any).modelId
        if (typeof providerId !== "string" || typeof modelId !== "string") return null
        return { providerId, modelId }
      }),
      thinkingSelections: normalizeRecord((source.models as any)?.thinkingSelections),
    },
  }
}

function normalizeServerConfig(
  input?: ServerConfigBucket | null,
): Required<Pick<ServerConfigBucket, "listeningMode" | "logLevel" | "environmentVariables" | "opencodeBinary">> & { speech: SpeechSettings } {
  const source = input ?? {}
  const listeningMode = source.listeningMode === "all" ? "all" : "local"
  const logLevel =
    source.logLevel === "INFO" || source.logLevel === "WARN" || source.logLevel === "ERROR" || source.logLevel === "DEBUG"
      ? source.logLevel
      : "DEBUG"
  const opencodeBinary = typeof source.opencodeBinary === "string" && source.opencodeBinary.trim() ? source.opencodeBinary : "opencode"
  const environmentVariables = normalizeRecord(source.environmentVariables)
  const speech = normalizeSpeechSettings(source.speech)
  return { listeningMode, logLevel, opencodeBinary, environmentVariables, speech }
}

function getModelKey(model: { providerId: string; modelId: string }): string {
  return `${model.providerId}/${model.modelId}`
}

function buildRecentFolderList(folderPath: string, source: RecentFolder[]): RecentFolder[] {
  const folders = source.filter((f) => f.path !== folderPath)
  folders.unshift({ path: folderPath, lastAccessed: Date.now() })
  return folders.slice(0, MAX_RECENT_FOLDERS)
}

function buildBinaryList(binaryPath: string, version: string | undefined, source: OpenCodeBinary[]): OpenCodeBinary[] {
  const timestamp = Date.now()
  const existing = source.find((b) => b.path === binaryPath)
  if (existing) {
    const updatedEntry: OpenCodeBinary = { ...existing, lastUsed: timestamp, version: version ?? existing.version }
    const remaining = source.filter((b) => b.path !== binaryPath)
    return [updatedEntry, ...remaining]
  }
  const nextEntry: OpenCodeBinary = version
    ? { path: binaryPath, version, lastUsed: timestamp }
    : { path: binaryPath, lastUsed: timestamp }
  return [nextEntry, ...source].slice(0, 10)
}

const [uiConfigBucket, setUiConfigBucket] = createSignal<UiConfigBucket>({})
const [serverConfigBucket, setServerConfigBucket] = createSignal<ServerConfigBucket>({})
const [uiStateBucket, setUiStateBucket] = createSignal<UiStateBucket>({})
const [isLoaded, setIsLoaded] = createSignal(false)

const uiSettings = createMemo<UiSettings>(() => normalizeUiSettings(uiConfigBucket().settings))
const themePreference = createMemo<ThemePreference>(() => uiConfigBucket().theme ?? "system")
const serverSettings = createMemo(() => normalizeServerConfig(serverConfigBucket()))
const uiState = createMemo(() => normalizeUiState(uiStateBucket()))

const preferences = uiSettings
const recentFolders = createMemo<RecentFolder[]>(() => uiState().recentFolders)
const opencodeBinaries = createMemo<OpenCodeBinary[]>(() => uiState().opencodeBinaries)

let loadPromise: Promise<void> | null = null

async function ensureLoaded(): Promise<void> {
  if (isLoaded()) return
  if (!loadPromise) {
    loadPromise = Promise.all([
      storage.loadConfigOwner("ui"),
      storage.loadConfigOwner("server"),
      storage.loadStateOwner("ui"),
    ])
      .then(([uiCfg, srvCfg, uiSt]) => {
        setUiConfigBucket(uiCfg as any)
        setServerConfigBucket(srvCfg as any)
        setUiStateBucket(uiSt as any)
        setIsLoaded(true)
      })
      .catch((error) => {
        log.error("Failed to load settings", error)
        setUiConfigBucket({})
        setServerConfigBucket({})
        setUiStateBucket({})
        setIsLoaded(true)
      })
      .finally(() => {
        loadPromise = null
      })
  }
  await loadPromise
}

async function patchConfigOwner(owner: string, patch: unknown) {
  await ensureLoaded()
  const updated = await storage.patchConfigOwner(owner, patch)
  if (owner === "ui") setUiConfigBucket(updated as any)
  if (owner === "server") setServerConfigBucket(updated as any)
}

async function patchStateOwner(owner: string, patch: unknown) {
  await ensureLoaded()
  const updated = await storage.patchStateOwner(owner, patch)
  if (owner === "ui") setUiStateBucket(updated as any)
}

function updateUiSettings(updates: Partial<UiSettings>) {
  const current = uiConfigBucket()
  const nextSettings = normalizeUiSettings({ ...(current.settings ?? {}), ...updates })
  const patch = { settings: nextSettings }
  void patchConfigOwner("ui", patch).catch((error) => log.error("Failed to patch ui settings", error))
}

function updatePreferences(updates: Partial<UiSettings>): void {
  updateUiSettings(updates)
}

function setThemePreference(preference: ThemePreference): void {
  if (themePreference() === preference) return
  void patchConfigOwner("ui", { theme: preference }).catch((error) => log.error("Failed to set theme", error))
}

 async function setListeningMode(mode: ListeningMode): Promise<void> {
   if (serverSettings().listeningMode === mode) return
   await patchConfigOwner("server", { listeningMode: mode })
 }

function updateEnvironmentVariables(envVars: Record<string, string>): void {
  void patchConfigOwner("server", { environmentVariables: envVars }).catch((error) =>
    log.error("Failed to update environment variables", error),
  )
}

function addEnvironmentVariable(key: string, value: string): void {
  const current = serverSettings().environmentVariables
  updateEnvironmentVariables({ ...current, [key]: value })
}

function removeEnvironmentVariable(key: string): void {
  const current = serverSettings().environmentVariables
  const { [key]: removed, ...rest } = current
  updateEnvironmentVariables(rest)
}

function updateLastUsedBinary(path: string): void {
  const target = path && path.trim().length > 0 ? path : "opencode"
  void patchConfigOwner("server", { opencodeBinary: target }).catch((error) => log.error("Failed to set default binary", error))

  // also bump lastUsed in state ui.opencodeBinaries
  const nextList = buildBinaryList(target, undefined, opencodeBinaries())
  void patchStateOwner("ui", { opencodeBinaries: nextList }).catch((error) => log.error("Failed to update binary list", error))
}

function updateLogLevel(level: ServerLogLevel): void {
  const target = level ?? "DEBUG"
  void patchConfigOwner("server", { logLevel: target }).catch((error) => log.error("Failed to set log level", error))
}

async function updateSpeechSettings(updates: SpeechSettingsUpdate): Promise<void> {
  const apiKeyPatch = updates.apiKey
  const { apiKey: _apiKey, ...restUpdates } = updates
  const next = normalizeSpeechSettings({
    ...serverSettings().speech,
    ...restUpdates,
    ...(apiKeyPatch === null ? {} : { apiKey: apiKeyPatch }),
  })
  const { hasApiKey: _hasApiKey, ...persistedSpeech } = next
  const patch = {
    ...persistedSpeech,
    ...(apiKeyPatch === null ? { apiKey: null } : {}),
  }
  try {
    await patchConfigOwner("server", { speech: patch })
  } catch (error) {
    log.error("Failed to update speech settings", error)
    throw error
  }
}

function addOpenCodeBinary(path: string, version?: string): void {
  const nextList = buildBinaryList(path, version, opencodeBinaries())
  void patchStateOwner("ui", { opencodeBinaries: nextList }).catch((error) => log.error("Failed to add binary", error))
}

function removeOpenCodeBinary(path: string): void {
  const nextList = opencodeBinaries().filter((b) => b.path !== path)
  void patchStateOwner("ui", { opencodeBinaries: nextList }).catch((error) => log.error("Failed to remove binary", error))

  if (serverSettings().opencodeBinary === path) {
    void patchConfigOwner("server", { opencodeBinary: "opencode" }).catch((error) =>
      log.error("Failed to reset default binary", error),
    )
  }
}

function addRecentFolder(folderPath: string): void {
  const next = buildRecentFolderList(folderPath, recentFolders())
  void patchStateOwner("ui", { recentFolders: next }).catch((error) => log.error("Failed to add recent folder", error))
}

function removeRecentFolder(folderPath: string): void {
  const next = recentFolders().filter((f) => f.path !== folderPath)
  void patchStateOwner("ui", { recentFolders: next }).catch((error) => log.error("Failed to remove recent folder", error))
}

function recordWorkspaceLaunch(folderPath: string, binaryPath?: string): void {
  const targetBinary = binaryPath && binaryPath.trim().length > 0 ? binaryPath : serverSettings().opencodeBinary
  const nextFolders = buildRecentFolderList(folderPath, recentFolders())
  const nextBinaries = buildBinaryList(targetBinary, undefined, opencodeBinaries())

  void patchStateOwner("ui", { recentFolders: nextFolders, opencodeBinaries: nextBinaries }).catch((error) =>
    log.error("Failed to update ui state on launch", error),
  )
  void patchConfigOwner("server", { opencodeBinary: targetBinary }).catch((error) =>
    log.error("Failed to persist selected binary", error),
  )
}

function addRecentModelPreference(model: ModelPreference): void {
  if (!model.providerId || !model.modelId) return
  const recents = uiState().models.recents
  const filtered = recents.filter((item) => item.providerId !== model.providerId || item.modelId !== model.modelId)
  const updated = [model, ...filtered].slice(0, MAX_RECENT_MODELS)
  void patchStateOwner("ui", { models: { recents: updated } }).catch((error) => log.error("Failed to update model recents", error))
}

function isFavoriteModelPreference(model: ModelPreference): boolean {
  if (!model.providerId || !model.modelId) return false
  return uiState().models.favorites.some((item) => item.providerId === model.providerId && item.modelId === model.modelId)
}

function toggleFavoriteModelPreference(model: ModelPreference): void {
  if (!model.providerId || !model.modelId) return
  const favorites = uiState().models.favorites
  const exists = favorites.some((item) => item.providerId === model.providerId && item.modelId === model.modelId)

  const updated = exists
    ? favorites.filter((item) => item.providerId !== model.providerId || item.modelId !== model.modelId)
    : [model, ...favorites.filter((item) => item.providerId !== model.providerId || item.modelId !== model.modelId)].slice(
        0,
        MAX_FAVORITE_MODELS,
      )

  void patchStateOwner("ui", { models: { favorites: updated } }).catch((error) => log.error("Failed to update model favorites", error))
}

function getModelThinkingSelection(model: { providerId: string; modelId: string }): string | undefined {
  if (!model.providerId || !model.modelId) return undefined
  return uiState().models.thinkingSelections[getModelKey(model)]
}

function setModelThinkingSelection(model: { providerId: string; modelId: string }, value: string | undefined): void {
  if (!model.providerId || !model.modelId) return
  const key = getModelKey(model)
  const current = uiState().models.thinkingSelections[key]
  if (current === value) return

  const selections = { ...uiState().models.thinkingSelections }
  if (!value) {
    delete selections[key]
  } else {
    selections[key] = value
  }
  void patchStateOwner("ui", { models: { thinkingSelections: selections } }).catch((error) =>
    log.error("Failed to update thinking selection", error),
  )
}

function setDiffViewMode(mode: DiffViewMode): void {
  if (preferences().diffViewMode === mode) return
  updateUiSettings({ diffViewMode: mode })
}

function setToolOutputExpansion(mode: ExpansionPreference): void {
  if (preferences().toolOutputExpansion === mode) return
  updateUiSettings({ toolOutputExpansion: mode })
}

function setDiagnosticsExpansion(mode: ExpansionPreference): void {
  if (preferences().diagnosticsExpansion === mode) return
  updateUiSettings({ diagnosticsExpansion: mode })
}

function setToolInputsVisibility(mode: ToolInputsVisibilityPreference): void {
  if (preferences().toolInputsVisibility === mode) return
  updateUiSettings({ toolInputsVisibility: mode })
}

function setThinkingBlocksExpansion(mode: ExpansionPreference): void {
  if (preferences().thinkingBlocksExpansion === mode) return
  updateUiSettings({ thinkingBlocksExpansion: mode })
}

function setFontFamilySans(fontFamily: string | undefined): void {
  const normalized = normalizeFontFamily(fontFamily)
  updateUiSettings({ fontFamilySans: normalized })
}

function setFontFamilyMono(fontFamily: string | undefined): void {
  const normalized = normalizeFontFamily(fontFamily)
  updateUiSettings({ fontFamilyMono: normalized })
}

function toggleShowThinkingBlocks(): void {
  updateUiSettings({ showThinkingBlocks: !preferences().showThinkingBlocks })
}

function toggleKeyboardShortcutHints(): void {
  updatePreferences({ showKeyboardShortcutHints: !preferences().showKeyboardShortcutHints })
}

function toggleShowTimelineTools(): void {
  updateUiSettings({ showTimelineTools: !preferences().showTimelineTools })
}

function toggleUsageMetrics(): void {
  updateUiSettings({ showUsageMetrics: !preferences().showUsageMetrics })
}

function togglePromptSubmitOnEnter(): void {
  updateUiSettings({ promptSubmitOnEnter: !preferences().promptSubmitOnEnter })
}

function toggleShowPromptVoiceInput(): void {
  updateUiSettings({ showPromptVoiceInput: !preferences().showPromptVoiceInput })
}

function toggleAutoCleanupBlankSessions(): void {
  const nextValue = !preferences().autoCleanupBlankSessions
  log.info("toggle auto cleanup", { value: nextValue })
  updateUiSettings({ autoCleanupBlankSessions: nextValue })
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

void ensureLoaded().catch((error: unknown) => {
  log.error("Failed to initialize settings", error)
})

interface ConfigContextValue {
  isLoaded: Accessor<boolean>
  preferences: typeof preferences
  updatePreferences: typeof updatePreferences
  themePreference: typeof themePreference
  setThemePreference: typeof setThemePreference

  // server-owned stable config
  serverSettings: typeof serverSettings
  setListeningMode: typeof setListeningMode
  updateEnvironmentVariables: typeof updateEnvironmentVariables
  addEnvironmentVariable: typeof addEnvironmentVariable
  removeEnvironmentVariable: typeof removeEnvironmentVariable
    updateLastUsedBinary: typeof updateLastUsedBinary
    updateLogLevel: typeof updateLogLevel
    updateSpeechSettings: typeof updateSpeechSettings

  // ui-owned state
  recentFolders: typeof recentFolders
  opencodeBinaries: typeof opencodeBinaries
  uiState: typeof uiState
  addRecentFolder: typeof addRecentFolder
  removeRecentFolder: typeof removeRecentFolder
  addOpenCodeBinary: typeof addOpenCodeBinary
  removeOpenCodeBinary: typeof removeOpenCodeBinary
  recordWorkspaceLaunch: typeof recordWorkspaceLaunch
  addRecentModelPreference: typeof addRecentModelPreference
  isFavoriteModelPreference: typeof isFavoriteModelPreference
  toggleFavoriteModelPreference: typeof toggleFavoriteModelPreference
  getModelThinkingSelection: typeof getModelThinkingSelection
  setModelThinkingSelection: typeof setModelThinkingSelection

  // ui settings helpers
  toggleShowThinkingBlocks: typeof toggleShowThinkingBlocks
  toggleKeyboardShortcutHints: typeof toggleKeyboardShortcutHints
  toggleShowTimelineTools: typeof toggleShowTimelineTools
  toggleUsageMetrics: typeof toggleUsageMetrics
  toggleAutoCleanupBlankSessions: typeof toggleAutoCleanupBlankSessions
  togglePromptSubmitOnEnter: typeof togglePromptSubmitOnEnter
  toggleShowPromptVoiceInput: typeof toggleShowPromptVoiceInput
  setDiffViewMode: typeof setDiffViewMode
  setToolOutputExpansion: typeof setToolOutputExpansion
  setDiagnosticsExpansion: typeof setDiagnosticsExpansion
  setThinkingBlocksExpansion: typeof setThinkingBlocksExpansion
  setToolInputsVisibility: typeof setToolInputsVisibility

  // font settings
  setFontFamilySans: typeof setFontFamilySans
  setFontFamilyMono: typeof setFontFamilyMono

  // instance scoped
  setAgentModelPreference: typeof setAgentModelPreference
  getAgentModelPreference: typeof getAgentModelPreference
}

const ConfigContext = createContext<ConfigContextValue>()

const configContextValue: ConfigContextValue = {
  isLoaded,
  preferences,
  updatePreferences,
  themePreference,
  setThemePreference,
  serverSettings,
  setListeningMode,
  updateEnvironmentVariables,
  addEnvironmentVariable,
  removeEnvironmentVariable,
  updateLastUsedBinary,
  updateLogLevel,
  updateSpeechSettings,
  recentFolders,
  opencodeBinaries,
  uiState,
  addRecentFolder,
  removeRecentFolder,
  addOpenCodeBinary,
  removeOpenCodeBinary,
  recordWorkspaceLaunch,
  addRecentModelPreference,
  isFavoriteModelPreference,
  toggleFavoriteModelPreference,
  getModelThinkingSelection,
  setModelThinkingSelection,
  toggleShowThinkingBlocks,
  toggleKeyboardShortcutHints,
  toggleShowTimelineTools,
  toggleUsageMetrics,
  toggleAutoCleanupBlankSessions,
  togglePromptSubmitOnEnter,
  toggleShowPromptVoiceInput,
  setDiffViewMode,
  setToolOutputExpansion,
  setDiagnosticsExpansion,
  setThinkingBlocksExpansion,
  setToolInputsVisibility,
  setFontFamilySans,
  setFontFamilyMono,
  setAgentModelPreference,
  getAgentModelPreference,
}

export const ConfigProvider: ParentComponent = (props) => {
  onMount(() => {
    ensureLoaded().catch((error: unknown) => {
      log.error("Failed to initialize settings", error)
    })

    const unsubUi = storage.onConfigOwnerChanged("ui", (bucket) => {
      setUiConfigBucket(bucket as any)
      setIsLoaded(true)
    })
    const unsubServer = storage.onConfigOwnerChanged("server", (bucket) => {
      setServerConfigBucket(bucket as any)
      setIsLoaded(true)
      resetSpeechCapabilities()
      void loadSpeechCapabilities(true)
    })
    const unsubStateUi = storage.onStateOwnerChanged("ui", (bucket) => {
      setUiStateBucket(bucket as any)
      setIsLoaded(true)
    })

    return () => {
      unsubUi()
      unsubServer()
      unsubStateUi()
    }
  })

  // Update CSS variables when font settings change
  createEffect(() => {
    const sansFont = preferences().fontFamilySans
    const monoFont = preferences().fontFamilyMono
    
    const root = document.documentElement
    
    // Update sans-serif font variable
    if (sansFont) {
      // Use the user-specified font as the primary font
      // 已经通过 normalizeFontFamily 标准化，确保是有效的非空字符串
      root.style.setProperty('--font-family-sans-user', `"${sansFont}"`)
    } else {
      // Reset to default
      root.style.setProperty('--font-family-sans-user', '-apple-system')
    }
    
    // Update monospace font variable
    if (monoFont) {
      // Use the user-specified font as the primary font
      // 已经通过 normalizeFontFamily 标准化，确保是有效的非空字符串
      root.style.setProperty('--font-family-mono-user', `"${monoFont}"`)
    } else {
      // Reset to default
      root.style.setProperty('--font-family-mono-user', 'ui-monospace')
    }
  })

  return <ConfigContext.Provider value={configContextValue}>{props.children}</ConfigContext.Provider>
}

export function useConfig(): ConfigContextValue {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error("useConfig must be used within ConfigProvider")
  }
  return context
}

export {
  preferences,
  uiState,
  serverSettings,
  recentFolders,
  opencodeBinaries,
  themePreference,
  setThemePreference,
  updatePreferences,
  setListeningMode,
  updateEnvironmentVariables,
  addEnvironmentVariable,
  removeEnvironmentVariable,
  updateLastUsedBinary,
  updateLogLevel,
  updateSpeechSettings,
  addRecentFolder,
  removeRecentFolder,
  addOpenCodeBinary,
  removeOpenCodeBinary,
  recordWorkspaceLaunch,
  addRecentModelPreference,
  isFavoriteModelPreference,
  toggleFavoriteModelPreference,
  getModelThinkingSelection,
  setModelThinkingSelection,
  toggleShowThinkingBlocks,
  toggleKeyboardShortcutHints,
  toggleShowTimelineTools,
  toggleUsageMetrics,
  toggleAutoCleanupBlankSessions,
  togglePromptSubmitOnEnter,
  toggleShowPromptVoiceInput,
  setDiffViewMode,
  setToolOutputExpansion,
  setDiagnosticsExpansion,
  setThinkingBlocksExpansion,
  setFontFamilySans,
  setFontFamilyMono,
  setAgentModelPreference,
  getAgentModelPreference,
}
