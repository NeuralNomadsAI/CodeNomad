import type {
  AgentModelSelection,
  AgentModelSelections,
  ConfigFile,
  ModelPreference,
  OpenCodeBinary,
  Preferences,
  RecentFolder,
} from "./config/schema"

/**
 * Canonical HTTP/SSE contract for the CLI server.
 * These types are consumed by both the CLI implementation and any UI clients.
 */

export type WorkspaceStatus = "starting" | "ready" | "stopped" | "error"

export interface WorkspaceDescriptor {
  id: string
  /** Absolute path on the server host. */
  path: string
  name?: string
  status: WorkspaceStatus
  /** PID/port are populated when the workspace is running. */
  pid?: number
  port?: number
  /** Canonical proxy path the CLI exposes for this instance. */
  proxyPath: string
  /** Identifier of the binary resolved from config. */
  binaryId: string
  binaryLabel: string
  /** Version of the binary when this workspace was started. */
  binaryVersion?: string
  /** Currently installed version of the binary (for comparison). */
  installedBinaryVersion?: string
  /** True if the workspace is running an older version than what's installed. */
  isVersionOutdated?: boolean
  createdAt: string
  updatedAt: string
  /** Present when `status` is "error". */
  error?: string
}

export interface WorkspaceCreateRequest {
  path: string
  name?: string
}

export type WorkspaceCreateResponse = WorkspaceDescriptor
export type WorkspaceListResponse = WorkspaceDescriptor[]
export type WorkspaceDetailResponse = WorkspaceDescriptor

export interface WorkspaceDeleteResponse {
  id: string
  status: WorkspaceStatus
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface WorkspaceLogEntry {
  workspaceId: string
  timestamp: string
  level: LogLevel
  message: string
}

export interface FileSystemEntry {
  name: string
  /** Path relative to the CLI server root ("." represents the root itself). */
  path: string
  /** Absolute path when available (unrestricted listings). */
  absolutePath?: string
  type: "file" | "directory"
  size?: number
  /** ISO timestamp of last modification when available. */
  modifiedAt?: string
}

export type FileSystemScope = "restricted" | "unrestricted"
export type FileSystemPathKind = "relative" | "absolute" | "drives"

export interface FileSystemListingMetadata {
  scope: FileSystemScope
  /** Canonical identifier of the current view ("." for restricted roots, absolute paths otherwise). */
  currentPath: string
  /** Optional parent path if navigation upward is allowed. */
  parentPath?: string
  /** Absolute path representing the root or origin point for this listing. */
  rootPath: string
  /** Absolute home directory of the CLI host (useful defaults for unrestricted mode). */
  homePath: string
  /** Human-friendly label for the current path. */
  displayPath: string
  /** Indicates whether entry paths are relative, absolute, or represent drive roots. */
  pathKind: FileSystemPathKind
}

export interface FileSystemListResponse {
  entries: FileSystemEntry[]
  metadata: FileSystemListingMetadata
}

export const WINDOWS_DRIVES_ROOT = "__drives__"

export interface WorkspaceFileResponse {
  workspaceId: string
  relativePath: string
  /** UTF-8 file contents; binary files should be base64 encoded by the caller. */
  contents: string
}

export type WorkspaceFileSearchResponse = FileSystemEntry[]

export type PermissionOverride = "inherit" | "enabled" | "disabled"

export interface InstanceData {
  messageHistory: string[]
  agentModelSelections: AgentModelSelection
  permissionOverride?: PermissionOverride
}

export type InstanceStreamStatus = "connecting" | "connected" | "error" | "disconnected"

export interface InstanceStreamEvent {
  type: string
  properties?: Record<string, unknown>
  [key: string]: unknown
}

export interface BinaryRecord {
  id: string
  path: string
  label: string
  version?: string

  /** Indicates that this binary will be picked when workspaces omit an explicit choice. */
  isDefault: boolean
  lastValidatedAt?: string
  validationError?: string

  /** Source of the binary: auto-detected, configured, or fallback */
  source?: "auto-detected" | "configured" | "fallback"
}

export type AppConfig = ConfigFile
export type AppConfigResponse = AppConfig
export type AppConfigUpdateRequest = Partial<AppConfig>

export interface BinaryListResponse {
  binaries: BinaryRecord[]
}

export interface BinaryCreateRequest {
  path: string
  label?: string
  makeDefault?: boolean
}

export interface BinaryUpdateRequest {
  label?: string
  makeDefault?: boolean
}

export interface BinaryValidationResult {
  valid: boolean
  version?: string
  error?: string
}

export type WorkspaceEventType =
  | "workspace.created"
  | "workspace.started"
  | "workspace.error"
  | "workspace.stopped"
  | "workspace.log"
  | "config.appChanged"
  | "config.binariesChanged"
  | "instance.dataChanged"
  | "instance.event"
  | "instance.eventStatus"
  | "app.releaseAvailable"
  | "app.updateAvailable"
  | "file.changed"
  | "file.conflict"
  | "file.conflict.resolved"

// ============================================================
// File Conflict Types
// ============================================================

export type FileConflictType = "concurrent-write" | "external-change" | "merge-conflict"

export interface FileSessionInfo {
  sessionId: string
  instanceId: string
  hash: string
  timestamp: number
}

export interface FileConflictRegion {
  startLine: number
  endLine: number
  base: string
  ours: string
  theirs: string
}

export interface FileChangedEvent {
  type: "file.changed"
  filePath: string
  absolutePath: string
  changeType: "add" | "change" | "unlink"
  sessionId: string
  instanceId: string
  hash: string
  previousHash?: string
  timestamp: number
  affectedSessions: string[]
}

export interface FileConflictEvent {
  type: "file.conflict"
  conflictId: string
  filePath: string
  absolutePath: string
  conflictType: FileConflictType
  involvedSessions: FileSessionInfo[]
  mergeResult: {
    canAutoMerge: boolean
    mergedContent?: string
    conflicts?: FileConflictRegion[]
  }
  timestamp: number
}

export interface FileConflictResolvedEvent {
  type: "file.conflict.resolved"
  conflictId: string
  filePath: string
  resolution: "auto-merged" | "keep-ours" | "keep-theirs" | "manual"
  resolvedBy: string
  newHash: string
  timestamp: number
}

export type WorkspaceEventPayload =
  | { type: "workspace.created"; workspace: WorkspaceDescriptor }
  | { type: "workspace.started"; workspace: WorkspaceDescriptor }
  | { type: "workspace.error"; workspace: WorkspaceDescriptor }
  | { type: "workspace.stopped"; workspaceId: string }
  | { type: "workspace.log"; entry: WorkspaceLogEntry }
  | { type: "config.appChanged"; config: AppConfig }
  | { type: "config.binariesChanged"; binaries: BinaryRecord[] }
  | { type: "instance.dataChanged"; instanceId: string; data: InstanceData }
  | { type: "instance.event"; instanceId: string; event: InstanceStreamEvent }
  | { type: "instance.eventStatus"; instanceId: string; status: InstanceStreamStatus; reason?: string }
  | { type: "app.releaseAvailable"; release: LatestReleaseInfo }
  | { type: "app.updateAvailable"; updates: UpdateCheckResult }
  | FileChangedEvent
  | FileConflictEvent
  | FileConflictResolvedEvent

export interface NetworkAddress {
  ip: string
  family: "ipv4" | "ipv6"
  scope: "external" | "internal" | "loopback"
  url: string
}

export interface LatestReleaseInfo {
  version: string
  tag: string
  url: string
  channel: "stable" | "dev"
  publishedAt?: string
  notes?: string
}

export interface ServerMeta {
  /** Base URL clients should target for REST calls (useful for Electron embedding). */
  httpBaseUrl: string
  /** SSE endpoint advertised to clients (`/api/events` by default). */
  eventsUrl: string
  /** Host the server is bound to (e.g., 127.0.0.1 or 0.0.0.0). */
  host: string
  /** Listening mode derived from host binding. */
  listeningMode: "local" | "all"
  /** Actual port in use after binding. */
  port: number
  /** Display label for the host (e.g., hostname or friendly name). */
  hostLabel: string
  /** Absolute path of the filesystem root exposed to clients. */
  workspaceRoot: string
  /** True when the server allows browsing the full filesystem. */
  unrestrictedRoot?: boolean
  /** Reachable addresses for this server, external first. */
  addresses: NetworkAddress[]
  /** Optional metadata about the most recent public release. */
  latestRelease?: LatestReleaseInfo
}

export type {
  Preferences,
  ModelPreference,
  AgentModelSelections,
  RecentFolder,
  OpenCodeBinary,
}

// ============================================================
// Era Code Integration Types
// ============================================================

/**
 * Era Code installation and project status
 */
export interface EraStatusResponse {
  /** Whether era-code binary is installed */
  installed: boolean
  /** Version of era-code if installed */
  version: string | null
  /** Path to era-code binary */
  binaryPath: string | null
  /** Whether the project has Era initialized (.era directory) */
  projectInitialized: boolean
  /** Whether era assets are available */
  assetsAvailable: boolean
  /** Count of available assets by type */
  assets?: {
    agents: number
    commands: number
    skills: number
    plugins: number
  }
  /** Project-specific era status */
  project?: {
    hasConstitution: boolean
    hasDirectives: boolean
  }
  /** Version of the project's era manifest */
  manifestVersion?: string
  /** Latest available era-code version */
  latestVersion?: string
  /** Whether the project manifest is outdated compared to installed era-code */
  isManifestOutdated?: boolean
}

/**
 * Era upgrade check response
 */
export interface EraUpgradeCheckResponse {
  /** Whether an upgrade is available */
  available: boolean
  /** Current installed version */
  currentVersion: string | null
  /** Target version available for upgrade */
  targetVersion: string | null
  /** Error message if check failed */
  error?: string
}

/**
 * Era upgrade result
 */
export interface EraUpgradeResult {
  /** Whether upgrade succeeded */
  success: boolean
  /** New version after upgrade */
  version?: string
  /** Error message if upgrade failed */
  error?: string
}

/**
 * Era governance rule
 */
export interface EraGovernanceRule {
  id: string
  pattern: string
  action: "allow" | "deny"
  reason: string
  suggestion?: string
  overridable: boolean
  source: "hardcoded" | "default" | "project" | "user"
}

// ============================================================
// Update Checker Types
// ============================================================

/**
 * Information about OpenCode binary update availability
 */
export interface OpenCodeUpdateInfo {
  available: boolean
  currentVersion: string | null
  latestVersion: string | null
}

/**
 * Combined result of checking for updates (Era Code + OpenCode)
 */
export interface UpdateCheckResult {
  eraCode: {
    available: boolean
    currentVersion?: string
    targetVersion?: string
  } | null
  openCode: OpenCodeUpdateInfo | null
  lastChecked: number
}

// ============================================================
// Project Init Types
// ============================================================

export interface ProjectInitRequest {
  name: string
  location: string
  template: "blank" | "typescript-node" | "python" | "react-vite"
  gitInit: boolean
  createReadme: boolean
}

export interface ProjectInitResponse {
  success: boolean
  path: string
  filesCreated: string[]
  gitInitialized: boolean
  error?: string
}
