import { createContext, createMemo, createSignal, onMount, useContext } from "solid-js"
import type { Accessor, ParentComponent } from "solid-js"
import { storage, type OwnerBucket } from "../lib/storage"
import type {
  ConnectionProfile,
  ExecutionProfile,
  RemoteServerConnectionProfile,
  RemoteServerProfile,
  SshConnectionProfile,
} from "../../../server/src/api-types"
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
  holdLongAssistantReplies: boolean
  promptSubmitOnEnter: boolean
  showPromptVoiceInput: boolean
  locale?: string
  diffViewMode: DiffViewMode
  toolOutputExpansion: ExpansionPreference
  diagnosticsExpansion: ExpansionPreference
  toolInputsVisibility: ToolInputsVisibilityPreference
  showUsageMetrics: boolean
  autoCleanupBlankSessions: boolean
  keepUnseenSubagentIdleStatus: boolean

  // OS notifications
  osNotificationsEnabled: boolean
  osNotificationsAllowWhenVisible: boolean
  notifyOnNeedsInput: boolean
  notifyOnIdle: boolean
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
  executionProfiles?: ExecutionProfile[]
  defaultExecutionProfileId?: string
  speech?: Partial<SpeechSettings>
}

interface UiStateBucket {
  recentFolders?: RecentFolder[]
  opencodeBinaries?: OpenCodeBinary[]
  remoteServers?: RemoteServerProfile[]
  connectionProfiles?: ConnectionProfile[]
  lastSelectedExecutionProfileId?: string
  models?: {
    recents?: ModelPreference[]
    favorites?: ModelPreference[]
    thinkingSelections?: Record<string, string>
  }
}

interface NormalizedUiState {
  recentFolders: RecentFolder[]
  opencodeBinaries: OpenCodeBinary[]
  remoteServers: RemoteServerProfile[]
  connectionProfiles: ConnectionProfile[]
  lastSelectedExecutionProfileId?: string
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
  holdLongAssistantReplies: true,
  promptSubmitOnEnter: false,
  showPromptVoiceInput: true,
  diffViewMode: "split",
  toolOutputExpansion: "expanded",
  diagnosticsExpansion: "expanded",
  toolInputsVisibility: "collapsed",
  showUsageMetrics: true,
  autoCleanupBlankSessions: true,
  keepUnseenSubagentIdleStatus: false,

  osNotificationsEnabled: false,
  osNotificationsAllowWhenVisible: false,
  notifyOnNeedsInput: true,
  notifyOnIdle: true,
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
    holdLongAssistantReplies: sanitized.holdLongAssistantReplies ?? defaultUiSettings.holdLongAssistantReplies,
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
    keepUnseenSubagentIdleStatus:
      sanitized.keepUnseenSubagentIdleStatus ?? defaultUiSettings.keepUnseenSubagentIdleStatus,
    osNotificationsEnabled: sanitized.osNotificationsEnabled ?? defaultUiSettings.osNotificationsEnabled,
    osNotificationsAllowWhenVisible:
      sanitized.osNotificationsAllowWhenVisible ?? defaultUiSettings.osNotificationsAllowWhenVisible,
    notifyOnNeedsInput: sanitized.notifyOnNeedsInput ?? defaultUiSettings.notifyOnNeedsInput,
    notifyOnIdle: sanitized.notifyOnIdle ?? defaultUiSettings.notifyOnIdle,
  }
}

function normalizeRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0)
  return out.length > 0 ? out : undefined
}

function normalizeExecutionProfiles(value: unknown): ExecutionProfile[] {
  if (!Array.isArray(value)) return []

  const profiles: ExecutionProfile[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue

    const id = typeof (entry as any).id === "string" ? (entry as any).id.trim() : ""
    const name = typeof (entry as any).name === "string" ? (entry as any).name.trim() : ""
    const kind = typeof (entry as any).kind === "string" ? (entry as any).kind.trim() : ""
    if (!id || !name) continue

    if (kind === "local") {
      const binaryPath = typeof (entry as any).binaryPath === "string" ? (entry as any).binaryPath.trim() : ""
      if (!binaryPath) continue
      profiles.push({ id, name, kind, binaryPath })
      continue
    }

    if (kind === "wsl") {
      const distro = typeof (entry as any).distro === "string" ? (entry as any).distro.trim() : ""
      const binaryPath = typeof (entry as any).binaryPath === "string" ? (entry as any).binaryPath.trim() : ""
      if (!distro || !binaryPath) continue
      profiles.push({ id, name, kind, distro, binaryPath })
      continue
    }

    if (kind === "docker") {
      const image = typeof (entry as any).image === "string" ? (entry as any).image.trim() : ""
      const workspaceMountPath = typeof (entry as any).workspaceMountPath === "string" ? (entry as any).workspaceMountPath.trim() : ""
      const configMountPath = typeof (entry as any).configMountPath === "string" ? (entry as any).configMountPath.trim() : ""
      if (!image || !workspaceMountPath || !configMountPath) continue
      profiles.push({
        id,
        name,
        kind,
        image,
        workspaceMountPath,
        configMountPath,
        command: normalizeStringList((entry as any).command),
        extraDockerArgs: normalizeStringList((entry as any).extraDockerArgs),
      })
      continue
    }

    if (kind === "command") {
      const executable = typeof (entry as any).executable === "string" ? (entry as any).executable.trim() : ""
      const cwdMode = (entry as any).cwdMode === "inherit" ? "inherit" : (entry as any).cwdMode === "workspace" ? "workspace" : undefined
      if (!executable) continue
      profiles.push({
        id,
        name,
        kind,
        executable,
        args: normalizeStringList((entry as any).args),
        cwdMode,
      })
    }
  }

  return profiles
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

function sortByRecentActivity<T extends { lastConnectedAt?: string; updatedAt: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const left = a.lastConnectedAt ?? a.updatedAt
    const right = b.lastConnectedAt ?? b.updatedAt
    return right.localeCompare(left)
  })
}

function normalizeRemoteServerProfile(value: unknown): RemoteServerProfile | null {
  if (!value || typeof value !== "object") return null
  const id = typeof (value as any).id === "string" ? (value as any).id.trim() : ""
  const name = typeof (value as any).name === "string" ? (value as any).name.trim() : ""
  const baseUrl = typeof (value as any).baseUrl === "string" ? (value as any).baseUrl.trim() : ""
  if (!id || !name || !baseUrl) return null
  const createdAt = typeof (value as any).createdAt === "string" ? (value as any).createdAt : new Date().toISOString()
  const updatedAt = typeof (value as any).updatedAt === "string" ? (value as any).updatedAt : createdAt
  const lastConnectedAt = typeof (value as any).lastConnectedAt === "string" ? (value as any).lastConnectedAt : undefined
  return {
    id,
    name,
    baseUrl,
    skipTlsVerify: Boolean((value as any).skipTlsVerify),
    createdAt,
    updatedAt,
    lastConnectedAt,
  }
}

function remoteServerToConnectionProfile(server: RemoteServerProfile): RemoteServerConnectionProfile {
  return {
    id: server.id,
    name: server.name,
    kind: "remote-server",
    baseUrl: server.baseUrl,
    skipTlsVerify: server.skipTlsVerify,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    lastConnectedAt: server.lastConnectedAt,
  }
}

function connectionProfileToRemoteServer(profile: ConnectionProfile): RemoteServerProfile | null {
  if (profile.kind !== "remote-server") return null
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    skipTlsVerify: profile.skipTlsVerify,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    lastConnectedAt: profile.lastConnectedAt,
  }
}

function normalizeConnectionProfiles(value: unknown, remoteServers: RemoteServerProfile[]): ConnectionProfile[] {
  const profiles: ConnectionProfile[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue
      const id = typeof (entry as any).id === "string" ? (entry as any).id.trim() : ""
      const name = typeof (entry as any).name === "string" ? (entry as any).name.trim() : ""
      const kind = typeof (entry as any).kind === "string" ? (entry as any).kind.trim() : ""
      if (!id || !name) continue

      const createdAt = typeof (entry as any).createdAt === "string" ? (entry as any).createdAt : new Date().toISOString()
      const updatedAt = typeof (entry as any).updatedAt === "string" ? (entry as any).updatedAt : createdAt
      const lastConnectedAt = typeof (entry as any).lastConnectedAt === "string" ? (entry as any).lastConnectedAt : undefined

      if (kind === "remote-server") {
        const remote = normalizeRemoteServerProfile(entry)
        if (!remote) continue
        profiles.push(remoteServerToConnectionProfile(remote))
        continue
      }

      if (kind === "ssh") {
        const host = typeof (entry as any).host === "string" ? (entry as any).host.trim() : ""
        if (!host) continue
        const profile: SshConnectionProfile = {
          id,
          name,
          kind,
          host,
          createdAt,
          updatedAt,
          lastConnectedAt,
          port: typeof (entry as any).port === "number" ? (entry as any).port : undefined,
          remoteServerPort: typeof (entry as any).remoteServerPort === "number" ? (entry as any).remoteServerPort : undefined,
          username: typeof (entry as any).username === "string" && (entry as any).username.trim() ? (entry as any).username.trim() : undefined,
          remotePath: typeof (entry as any).remotePath === "string" && (entry as any).remotePath.trim() ? (entry as any).remotePath.trim() : undefined,
          bootstrapScript:
            typeof (entry as any).bootstrapScript === "string" && (entry as any).bootstrapScript.trim()
              ? (entry as any).bootstrapScript
              : undefined,
        }
        profiles.push(profile)
      }
    }
  }

  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const))
  for (const server of remoteServers) {
    byId.set(server.id, remoteServerToConnectionProfile(server))
  }

  return sortByRecentActivity(Array.from(byId.values()))
}

function normalizeUiState(input?: UiStateBucket | null): NormalizedUiState {
  const source = input ?? {}
  const remoteServers = sortByRecentActivity(
    cloneArray<RemoteServerProfile>(source.remoteServers, (server) => normalizeRemoteServerProfile(server)),
  )

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
    remoteServers,
    connectionProfiles: normalizeConnectionProfiles(source.connectionProfiles, remoteServers),
    lastSelectedExecutionProfileId:
      typeof source.lastSelectedExecutionProfileId === "string" && source.lastSelectedExecutionProfileId.trim()
        ? source.lastSelectedExecutionProfileId.trim()
        : undefined,
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
): Required<Pick<ServerConfigBucket, "listeningMode" | "logLevel" | "environmentVariables" | "opencodeBinary">> & {
  executionProfiles: ExecutionProfile[]
  defaultExecutionProfileId?: string
  speech: SpeechSettings
} {
  const source = input ?? {}
  const listeningMode = source.listeningMode === "all" ? "all" : "local"
  const logLevel =
    source.logLevel === "INFO" || source.logLevel === "WARN" || source.logLevel === "ERROR" || source.logLevel === "DEBUG"
      ? source.logLevel
      : "DEBUG"
  const opencodeBinary = typeof source.opencodeBinary === "string" && source.opencodeBinary.trim() ? source.opencodeBinary : "opencode"
  const environmentVariables = normalizeRecord(source.environmentVariables)
  const executionProfiles = normalizeExecutionProfiles(source.executionProfiles)
  const defaultExecutionProfileId =
    typeof source.defaultExecutionProfileId === "string" && executionProfiles.some((profile) => profile.id === source.defaultExecutionProfileId)
      ? source.defaultExecutionProfileId
      : undefined
  const speech = normalizeSpeechSettings(source.speech)
  return { listeningMode, logLevel, opencodeBinary, environmentVariables, executionProfiles, defaultExecutionProfileId, speech }
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

interface RemoteServerProfileInput {
  id?: string
  name: string
  baseUrl: string
  skipTlsVerify: boolean
}

function buildRemoteServerProfile(input: RemoteServerProfileInput, source: RemoteServerProfile[]): RemoteServerProfile {
  const existing = input.id ? source.find((entry) => entry.id === input.id) : undefined
  const now = new Date().toISOString()
  return {
    id: existing?.id ?? input.id ?? createRandomId(),
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim(),
    skipTlsVerify: Boolean(input.skipTlsVerify),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastConnectedAt: existing?.lastConnectedAt,
  }
}

function buildRemoteServerList(profile: RemoteServerProfile, source: RemoteServerProfile[]): RemoteServerProfile[] {
  const remaining = source.filter((entry) => entry.id !== profile.id)
  return sortByRecentActivity([profile, ...remaining])
}

function buildExecutionProfileList(profile: ExecutionProfile, source: ExecutionProfile[]): ExecutionProfile[] {
  const remaining = source.filter((entry) => entry.id !== profile.id)
  return [profile, ...remaining]
}

function buildConnectionProfileList(profile: ConnectionProfile, source: ConnectionProfile[]): ConnectionProfile[] {
  const remaining = source.filter((entry) => entry.id !== profile.id)
  return sortByRecentActivity([profile, ...remaining])
}

function createRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `remote-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
const remoteServers = createMemo<RemoteServerProfile[]>(() => uiState().remoteServers)
const connectionProfiles = createMemo<ConnectionProfile[]>(() => uiState().connectionProfiles)
const lastSelectedExecutionProfileId = createMemo<string | undefined>(() => uiState().lastSelectedExecutionProfileId)
const executionProfiles = createMemo<ExecutionProfile[]>(() => serverSettings().executionProfiles)
const defaultExecutionProfileId = createMemo<string | undefined>(() => serverSettings().defaultExecutionProfileId)

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

async function saveRemoteServerProfile(input: RemoteServerProfileInput): Promise<RemoteServerProfile> {
  const profile = buildRemoteServerProfile(input, remoteServers())
  await saveConnectionProfile(remoteServerToConnectionProfile(profile))
  return profile
}

async function markRemoteServerConnected(id: string): Promise<void> {
  const current = connectionProfiles().find((entry) => entry.id === id)
  if (!current) return
  const now = new Date().toISOString()
  const updated: ConnectionProfile = {
    ...current,
    updatedAt: now,
    lastConnectedAt: now,
  }
  await saveConnectionProfile(updated)
}

function removeRemoteServerProfile(id: string): void {
  removeConnectionProfile(id)
}

async function saveConnectionProfile(profile: ConnectionProfile): Promise<ConnectionProfile> {
  const nextProfiles = buildConnectionProfileList(profile, connectionProfiles())
  const nextRemoteServers = sortByRecentActivity(
    nextProfiles
      .map((entry) => connectionProfileToRemoteServer(entry))
      .filter((entry): entry is RemoteServerProfile => Boolean(entry)),
  )

  await patchStateOwner("ui", {
    connectionProfiles: nextProfiles,
    remoteServers: nextRemoteServers,
  })
  return profile
}

function removeConnectionProfile(id: string): void {
  const nextProfiles = connectionProfiles().filter((entry) => entry.id !== id)
  const nextRemoteServers = sortByRecentActivity(
    nextProfiles
      .map((entry) => connectionProfileToRemoteServer(entry))
      .filter((entry): entry is RemoteServerProfile => Boolean(entry)),
  )

  void patchStateOwner("ui", {
    connectionProfiles: nextProfiles,
    remoteServers: nextRemoteServers,
  }).catch((error) => log.error("Failed to remove connection profile", error))
}

function setLastSelectedExecutionProfileId(profileId: string | undefined): void {
  const nextId = profileId?.trim() || undefined
  void patchStateOwner("ui", { lastSelectedExecutionProfileId: nextId }).catch((error) =>
    log.error("Failed to save last selected execution profile", error),
  )
}

async function saveExecutionProfile(profile: ExecutionProfile): Promise<ExecutionProfile> {
  const nextProfiles = buildExecutionProfileList(profile, executionProfiles())
  const nextDefaultExecutionProfileId = defaultExecutionProfileId() ?? profile.id
  await patchConfigOwner("server", {
    executionProfiles: nextProfiles,
    defaultExecutionProfileId: nextDefaultExecutionProfileId,
  })
  return profile
}

async function setDefaultExecutionProfileId(profileId: string | undefined): Promise<void> {
  const trimmed = profileId?.trim()
  const nextDefault = trimmed && executionProfiles().some((profile) => profile.id === trimmed) ? trimmed : undefined
  await patchConfigOwner("server", { defaultExecutionProfileId: nextDefault })
}

function removeExecutionProfile(profileId: string): void {
  const nextProfiles = executionProfiles().filter((profile) => profile.id !== profileId)
  const nextDefault = defaultExecutionProfileId() === profileId ? nextProfiles[0]?.id : defaultExecutionProfileId()
  void patchConfigOwner("server", {
    executionProfiles: nextProfiles,
    defaultExecutionProfileId: nextDefault,
  }).catch((error) => log.error("Failed to remove execution profile", error))
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
  executionProfiles: typeof executionProfiles
  defaultExecutionProfileId: typeof defaultExecutionProfileId
  setListeningMode: typeof setListeningMode
  updateEnvironmentVariables: typeof updateEnvironmentVariables
  addEnvironmentVariable: typeof addEnvironmentVariable
  removeEnvironmentVariable: typeof removeEnvironmentVariable
    updateLastUsedBinary: typeof updateLastUsedBinary
    updateLogLevel: typeof updateLogLevel
    updateSpeechSettings: typeof updateSpeechSettings
    saveExecutionProfile: typeof saveExecutionProfile
    setDefaultExecutionProfileId: typeof setDefaultExecutionProfileId
    removeExecutionProfile: typeof removeExecutionProfile

  // ui-owned state
  recentFolders: typeof recentFolders
  opencodeBinaries: typeof opencodeBinaries
  remoteServers: typeof remoteServers
  connectionProfiles: typeof connectionProfiles
  lastSelectedExecutionProfileId: typeof lastSelectedExecutionProfileId
  uiState: typeof uiState
  addRecentFolder: typeof addRecentFolder
  removeRecentFolder: typeof removeRecentFolder
  addOpenCodeBinary: typeof addOpenCodeBinary
  removeOpenCodeBinary: typeof removeOpenCodeBinary
  saveConnectionProfile: typeof saveConnectionProfile
  removeConnectionProfile: typeof removeConnectionProfile
  setLastSelectedExecutionProfileId: typeof setLastSelectedExecutionProfileId
  saveRemoteServerProfile: typeof saveRemoteServerProfile
  markRemoteServerConnected: typeof markRemoteServerConnected
  removeRemoteServerProfile: typeof removeRemoteServerProfile
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
  executionProfiles,
  defaultExecutionProfileId,
  setListeningMode,
  updateEnvironmentVariables,
  addEnvironmentVariable,
  removeEnvironmentVariable,
  updateLastUsedBinary,
  updateLogLevel,
  updateSpeechSettings,
  saveExecutionProfile,
  setDefaultExecutionProfileId,
  removeExecutionProfile,
  recentFolders,
  opencodeBinaries,
  remoteServers,
  connectionProfiles,
  lastSelectedExecutionProfileId,
  uiState,
  addRecentFolder,
  removeRecentFolder,
  addOpenCodeBinary,
  removeOpenCodeBinary,
  saveConnectionProfile,
  removeConnectionProfile,
  setLastSelectedExecutionProfileId,
  saveRemoteServerProfile,
  markRemoteServerConnected,
  removeRemoteServerProfile,
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
  executionProfiles,
  defaultExecutionProfileId,
  recentFolders,
  opencodeBinaries,
  connectionProfiles,
  lastSelectedExecutionProfileId,
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
  saveExecutionProfile,
  setDefaultExecutionProfileId,
  removeExecutionProfile,
  addRecentFolder,
  removeRecentFolder,
  addOpenCodeBinary,
  removeOpenCodeBinary,
  saveConnectionProfile,
  removeConnectionProfile,
  setLastSelectedExecutionProfileId,
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
  setAgentModelPreference,
  getAgentModelPreference,
}
