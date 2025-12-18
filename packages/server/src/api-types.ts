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
  binaryVersion?: string
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

export interface InstanceData {
  messageHistory: string[]
  agentModelSelections: AgentModelSelection
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
