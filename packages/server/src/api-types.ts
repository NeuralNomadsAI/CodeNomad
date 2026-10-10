import type {
  AgentModelSelection,
  AgentModelSelections,
  ModelPreference,
  OpenCodeBinary,
  Preferences,
  RecentFolder,
} from "./config/schema"
import type { FormInfo, OpenCodeEvent, PermissionRequest } from "@opencode/client"
export type { PanelExtensionManifest, PanelExtensionSummary, PanelExtensionContext, PanelExtensionCatalog, PanelExtensionCatalogEntry } from "./panel-extensions/contract"
export type { GitHistoryCommit, GitHistoryPage, GitCommitFile, GitCommitDetails, GitCommitDiff } from "./git-history-types"
export type { MissionRecurrenceReadPage } from "./missions/recurrence-reader-contract"

export type {
  MissionActor,
  MissionActorActivity,
  MissionActorActivityState,
  MissionActorRuntimeStatus,
  MissionActivityProjection,
  MissionListAvailableResponse,
  MissionListResponse,
  MissionListUnavailableResponse,
  MissionMap,
  MissionBriefing,
  MissionBriefingItem,
  MissionReport,
  MissionReportOutcome,
  MissionSnapshot,
  MissionStatus,
  MissionTask,
  MissionTaskStatus,
  MissionTemplateId,
} from "./missions/model"

/** Deliberately excludes private config, authority receipts and native Job metadata. */
export interface MissionRecurrenceSnapshot {
  version: 1
  projectID: string
  schedules: Array<{
    id: string
    revision: number
    title: string
    state: "running" | "paused" | "interrupted" | "stopped"
    clock: { time: string; zone: string }
    nextDueAt: number | null
    interruptionReason?: "service-restart" | "error"
    /** Non-blocking display warning: the latest wake failed and is being retried. */
    lastError?: { code: "wake-failed" | "admission-failed" | "settlement-failed"; at: number }
    pending: { passageID: string; status: "starting" | "running" | "settling" | "uncertain";
      trigger?: "daily" | "manual"; reason?: "not-observed" | "admission-failing"
      missionID?: string; conversationID?: string } | null
    actions: Array<"play" | "pause" | "stop" | "resume" | "run-now" | "check">
    controls: import("./missions/recurrence-control-contract").RecurrenceControlStatus[]
    latestResult: MissionRecurrenceReceipt | null
    history: MissionRecurrenceReceipt[]
  }>
}

export interface MissionRecurrenceCurrent {
  version: 1
  projectID: string
  scheduleID: string
  passageID: string | null
  mission?: import("./missions/model").MissionMap
  activity?: import("./missions/model").MissionActivityProjection
}
export type MissionRecurrenceCurrentContent = ReturnType<typeof import("./missions/recurrence-current").currentRecurrenceContent>

/** Bounded native reference receipts only; never the standing instructions, native transcript or authority. */
export interface MissionRecurrenceReceipt {
  passageID: string
  dueAt: number
  settledAt: number
  outcome: "completed" | "failed" | "ended-without-report"
  /** `interrupted`: a service restart cut the passage and nothing resumed it.
   * `not-started`: its start message was never admitted and cannot be. */
  reason?: "interrupted" | "not-started"
  /** Daily schedule or an explicit Run now. */
  trigger?: "daily" | "manual"
  missionID?: string
  conversationID?: string
}

/**
 * Canonical HTTP/SSE contract for the CLI server.
 * These types are consumed by both the CLI implementation and any UI clients.
 */

export const PROMPT_INLINE_FILE_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxFiles: 10,
  maxTotalBytes: 20 * 1024 * 1024,
  // Covers the aggregate raw-byte budget after base64 expansion plus JSON metadata.
  maxRequestBodyBytes: 32 * 1024 * 1024,
} as const

export type WorkspaceStatus = "starting" | "ready" | "stopped" | "error"

export interface WorkspaceDescriptor {
  id: string
  /** Correlates creation events with the client request that initiated them. */
  requestId?: string
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
  /** The folder is a CodeNomad-managed temporary folder that discarding deletes. */
  temporary?: boolean
}

export interface WorkspaceCreateRequest {
  path: string
  name?: string
  requestId?: string
}

export interface WorkspaceCloneRequest {
  repositoryUrl: string
  destinationPath: string
  cleanup?: boolean
}

export interface WorkspaceCloneResponse {
  path: string
}

export type WorkspaceCreateResponse = WorkspaceDescriptor & {
  /** True when this request did not own creation of the returned workspace. */
  reused?: true
}
export type WorkspaceListResponse = WorkspaceDescriptor[]
export type WorkspaceDetailResponse = WorkspaceDescriptor

/** Only successful exact-directory coverage may remove local interruptions. */
export interface WorkspacePendingRequestLocation {
  location: { directory: string }
  permissions: PermissionRequest[]
  forms: FormInfo[]
}

export type WorkspacePendingRequestsResponse = { supported: false } | {
  supported: true
  directories: Array<{
    directory: string
    status: "ok"
    locations: WorkspacePendingRequestLocation[]
  } | { directory: string; status: "error"; locations?: WorkspacePendingRequestLocation[] }
    // An optional historical hint is outside current ownership; never empty queue authority.
    | { directory: string; status: "excluded"; locations?: never }>
}

export interface WorkspaceDeleteResponse {
  id: string
  status: WorkspaceStatus
}

export interface ProviderAccountsSnapshot {
  supported: boolean
  enabled: boolean
  logins: Record<string, string>
}

export interface ProviderUsageWindow {
  usedPercent: number | null
  remainingPercent: number | null
  windowSeconds: number | null
  resetAt: number | null
  valueLabel?: string
}

export interface ProviderUsageResponse {
  requestedProviderId: string
  providerId: string | null
  providerName: string
  modelId?: string
  supported: boolean
  configured: boolean
  ok: boolean
  windows: Record<string, ProviderUsageWindow>
  fetchedAt: number
  unavailableReason?: "native-credential-api-unavailable"
}

export type WorktreeKind = "root" | "worktree"

export interface WorktreeDescriptor {
  /** Stable identifier used by CodeNomad + clients ("root" for the selected workspace folder). */
  slug: string
  /** Presentation only; the worktree identifier does not change with its branch. */
  label?: string
  /** Absolute directory path on the server host. */
  directory: string
  /** Equivalent path in the OpenCode service namespace (notably WSL). */
  serviceDirectory?: string
  /** Native checkout root (before mirroring a nested workspace folder). */
  serviceRoot?: string
  /** Exact path registered in Git's worktree inventory. */
  registeredDirectory?: string
  /** Degraded mode: only this exact physical directory authorizes sessions. */
  directoryOnly?: boolean
  kind: WorktreeKind
  /** False for the opened folder and Git's main checkout. */
  removable?: boolean
  /** Optional VCS branch name when available. */
  branch?: string
  /** Commit recorded by the Git worktree inventory. */
  head?: string
}

export interface WorktreeListResponse {
  /** False means directory-only degraded mode; repository membership is unknown. */
  gitAvailable?: boolean
  worktrees: WorktreeDescriptor[]
  /** Default creation parent in the OpenCode service namespace. */
  defaultDirectory?: string
  /** True when the workspace folder resolves to a Git repository. */
  isGitRepo?: boolean
}

export interface WorktreeCreateRequest {
  slug: string
  fromSlug?: string
  /** Optional branch name (defaults to slug). */
  branch?: string
}

export interface WorktreeSessionMoveRequest {
  worktreeSlug: string
}

export interface WorktreeSessionMoveResponse {
  rootSessionId: string
  sessionIds: string[]
  worktreeSlug: string
}

export type GitChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unmerged"

export interface WorktreeGitStatusEntry {
  path: string
  originalPath?: string | null
  stagedStatus: GitChangeKind | null
  stagedAdditions: number
  stagedDeletions: number
  unstagedStatus: GitChangeKind | null
  unstagedAdditions: number
  unstagedDeletions: number
}

export type WorktreeGitStatusResponse = WorktreeGitStatusEntry[]

export type WorktreeGitDiffScope = "staged" | "unstaged"

export interface WorktreeGitPathsRequest {
  paths: string[]
}

export interface WorktreeGitMutationResponse {
  ok: true
}

export interface WorktreeGitCommitRequest {
  message: string
}

export interface WorktreeGitCommitResponse {
  ok: true
  commitSha?: string
}

export interface WorktreeGitDiffResponse {
  path: string
  originalPath?: string | null
  scope: WorktreeGitDiffScope
  before: string
  after: string
  isBinary?: boolean
  image?: import("./git-history-types").GitImageDiff
}

export interface WorktreeGitDiffRequest {
  path: string
  originalPath?: string | null
  scope: WorktreeGitDiffScope
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
  /**
   * Path identifier for the entry. Relative to the server root in restricted
   * single-root listings ("." represents the root itself); absolute in
   * unrestricted, drives, and multi-root top-level listings.
   */
  path: string
  /** Absolute path when available (unrestricted and multi-root listings). */
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
  /**
   * Canonical identifier of the current view:
   * - "." for restricted single-root listings
   * - WINDOWS_DRIVES_ROOT for the Windows drives pseudo-root
   * - absolute path otherwise
   */
  currentPath: string
  /** Optional parent path if navigation upward is allowed. */
  parentPath?: string
  /** Absolute path representing the root or origin point for this listing. */
  rootPath: string
  /** Absolute home directory of the CLI host (useful defaults for unrestricted mode). */
  homePath: string
  /** Human-friendly label for the current path. */
  displayPath: string
  /** Indicates whether entry paths are relative, absolute, or represent the drive pseudo-view. */
  pathKind: FileSystemPathKind
}

export interface FileSystemListResponse {
  entries: FileSystemEntry[]
  metadata: FileSystemListingMetadata
}

export interface FileSystemCreateFolderRequest {
  /**
   * Path identifier for the currently browsed directory.
   * Matches the `path` parameter used for `/api/filesystem`.
   */
  parentPath?: string
  /** Single folder name (no separators). */
  name: string
}

export interface FileSystemCreateFolderResponse {
  /**
   * Path identifier that can be passed back to `/api/filesystem` to browse the new folder.
   * Relative for restricted listings and absolute for unrestricted listings.
   */
  path: string
  /** Absolute folder path on the server host. */
  absolutePath: string
}

export interface FileSystemFileContentResponse {
  path: string
  contents: string
  encoding: "utf-8" | "base64"
}

export interface ConfigFileDescriptor {
  id: string
  label: string
  path: string
  language: string
}

export type ConfigFileListResponse = ConfigFileDescriptor[]

export interface ConfigFileContentResponse {
  id: string
  path: string
  contents: string
  exists: boolean
}

export interface ConfigFileContentRequest {
  contents: string
}

export type PluginControlScope = "global" | "project"
export type WebSearchSelection = string | false | null
export interface WebSearchSettingsSnapshot {
  location: PluginControlLocation
  effective: WebSearchSelection
  scopes: Array<{ scope: PluginControlScope; path: string; selection: WebSearchSelection }>
}
export interface WebSearchSettingsMutation {
  location: PluginControlLocation
  scope: PluginControlScope
  provider: WebSearchSelection
}
export type PluginConfigScope = PluginControlScope | "other" | "virtual"

export interface PluginControlLocation {
  directory: string
  workspaceID?: string
}

export interface SubagentDepthCapability { minimum: number; maximum?: number; default?: number }
export interface SubagentDepthSnapshot {
  location: PluginControlLocation
  capability: SubagentDepthCapability | null
  effectiveDepth: number | null
  project: { path: string; depth: number | null; expectation: string } | null
}

export type PluginRuntimeSource =
  | { type: "builtin" }
  | { type: "package"; target: string; version?: string; outdated?: true; updating?: true }
  | { type: "local"; path: string }
  | { type: "sdk" }

export interface PluginRuntimeInventoryEntry {
  key: string
  id?: string
  source: PluginRuntimeSource
  features: { server?: true; tui?: true; rpc?: true }
  state: { status: "active" } | { status: "failed"; error: string; ref?: string }
}

export interface PluginConfiguredRule {
  selector: string
  enabled: boolean
  scope: PluginConfigScope
  path?: string
  order: number
  entryIndex: number
}

export interface PluginConfiguredSource {
  target: string
  scope: PluginConfigScope
  path?: string
  entryIndex: number
  hasOptions: boolean
}

export type PluginScopeRuleState = "default" | "enabled" | "disabled"

export interface PluginActivationControl {
  id: string
  runtime?: PluginRuntimeInventoryEntry
  /** True for OpenCode-owned plugins, including disabled builtins absent from runtime inventory. */
  builtin: boolean
  effective: PluginScopeRuleState
  global: PluginScopeRuleState
  project: PluginScopeRuleState
  controllingRule?: PluginConfiguredRule
}

export interface PluginControlTarget {
  scope: PluginControlScope
  path: string
  exists: boolean
}

export interface PluginControlsSnapshot {
  location: PluginControlLocation
  runtime: PluginRuntimeInventoryEntry[]
  configured: {
    rules: PluginConfiguredRule[]
    sources: PluginConfiguredSource[]
  }
  controls: PluginActivationControl[]
  targets: PluginControlTarget[]
}

export interface PluginActivationMutationRequest {
  location: PluginControlLocation
  pluginId: string
  scope: PluginControlScope
  enabled: boolean
}

export interface PluginActivationMutationResponse {
  snapshot: PluginControlsSnapshot
  rule: string
  target: PluginControlTarget
  changed: boolean
  reloadPending: boolean
}

export const WINDOWS_DRIVES_ROOT = "__drives__"

export interface WorkspaceFileResponse {
  workspaceId: string
  relativePath: string
  /** UTF-8 file contents; binary files should be base64 encoded by the caller. */
  contents: string
  encoding?: "utf-8" | "base64"
}

export type WorkspaceFileSearchResponse = FileSystemEntry[]

export interface InstanceData {
  messageHistory: string[]
  agentModelSelections: AgentModelSelection
}

export type InstanceStreamStatus = "connecting" | "connected" | "error" | "disconnected"

export type InstanceStreamEvent = OpenCodeEvent

export type SideCarKind = "port"

export type SideCarPrefixMode = "strip" | "preserve"

export type SideCarStatus = "running" | "stopped"

export interface SideCar {
  id: string
  kind: SideCarKind
  name: string
  port: number
  insecure: boolean
  prefixMode: SideCarPrefixMode
  status: SideCarStatus
  createdAt: string
  updatedAt: string
}

export interface PreviewSession {
  token: string
  sessionId: string
  targetUrl: string
  proxyUrl: string
  createdAt: string
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

export type SettingsOwner = string
export type SettingsBucket = Record<string, unknown>
export type SettingsDoc = Record<string, unknown>

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

export const OPENCODE_V2_REQUIRED_ERROR_CODE = "opencode_v2_required" as const
export const SESSION_ENVIRONMENT_FAILED_ERROR_CODE = "session_environment_failed" as const
export const PENDING_RECONCILIATION_HEADER = "x-codenomad-pending-reconciliation" as const
export const PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS = 30_000

export interface BinaryValidationResult {
  valid: boolean
  version?: string
  error?: string
  errorCode?: typeof OPENCODE_V2_REQUIRED_ERROR_CODE
}

export interface OpenCodeUpdateStatus {
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean | null
  canUpgrade: boolean
  checkError?: "update_check_failed"
  minimumVersion: string
  recommendedVersion: string
  versionAssessment: "tested" | "untested" | "incompatible"
  incompatibilityReason?: "step_timestamp" | "canonical_api" | "session_environment"
  state: "missing" | "update_required" | "ready" | "error"
  binaryPath: string
  installationSource?: "path" | "user"
  needsSharedInstallation?: boolean
  daemonVersion?: string
  serviceState?: "stopped" | "ready" | "restart_required" | "restart_available" | "incompatible" | "error"
  canReload?: boolean
  serviceError?: string
  target: "host" | "wsl"
  canRestart: boolean
}

export interface OpenCodeUpdateResponse {
  success: boolean
  version: string
}

export interface SpeechSegment {
  startMs: number
  endMs: number
  text: string
}

export interface SpeechCapabilitiesResponse {
  available: boolean
  configured: boolean
  provider: string
  supportsStt: boolean
  supportsTts: boolean
  supportsStreamingTts: boolean
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  ttsFormats: string[]
  streamingTtsFormats: string[]
  separateProviders?: boolean
  sttConfigured?: boolean
  ttsConfigured?: boolean
  sttBaseUrl?: string
  ttsBaseUrl?: string
}

export interface SpeechTranscriptionResponse {
  text: string
  language?: string
  durationMs?: number
  segments?: SpeechSegment[]
}

export interface SpeechSynthesisResponse {
  audioBase64: string
  mimeType: string
}

export interface YoloStateResponse {
  enabled: boolean
}

export interface RemoteServerProfile {
  id: string
  name: string
  baseUrl: string
  skipTlsVerify: boolean
  createdAt: string
  updatedAt: string
  lastConnectedAt?: string
}

export interface RemoteServerProbeRequest {
  baseUrl: string
  skipTlsVerify?: boolean
}

export interface RemoteServerProbeResponse {
  ok: boolean
  reachable: boolean
  normalizedUrl: string
  skipTlsVerify: boolean
  requiresAuth: boolean
  authenticated: boolean
  error?: string
  errorCode?: string
}

export interface RemoteProxySessionCreateRequest {
  baseUrl: string
  skipTlsVerify?: boolean
}

export interface RemoteProxySessionCreateResponse {
  sessionId: string
  windowUrl: string
}

export interface RemoteControlStatus {
  /** False for requests arriving through Remote Control: only the host manages it. */
  manageable: boolean
  enabled: boolean
  state: "stopped" | "connecting" | "connected" | "reconnecting" | "error"
  /** Public HTTPS origin while the tunnel is connected. */
  remoteUrl?: string
  pairedDevices: number
  lastConnectedAt?: string
  error?: string
}

export interface RemoteControlPairing {
  url: string
  expiresAt: string
}

export interface RemoteControlDevice {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string
}

export interface RemoteControlStartResponse {
  status: RemoteControlStatus
  pairing: RemoteControlPairing
}

export type WorkspaceEventType =
  | "workspace.created"
  | "workspace.started"
  | "workspace.error"
  | "workspace.stopped"
  | "workspace.log"
  | "workspace.worktreesChanged"
  | "workspace.temporaryChanged"
  | "sidecar.updated"
  | "sidecar.removed"
  | "storage.configChanged"
  | "storage.stateChanged"
  | "instance.dataChanged"
  | "instance.event"
  | "instance.eventStatus"
  | "yolo.stateChanged"
  | "yolo.autoAccepted"
  | "permission.receiptsChanged"

export interface PermissionReceipt {
  requestId: string
  sessionId: string
  action?: string
  resources: string[]
  requestMessage?: string
  source?: { messageId: string; callId: string }
  decision: "once" | "always" | "reject"
  reason?: string
  origin: "codenomad" | "yolo" | "native"
  resolvedAt: number
}

export interface PermissionReceiptPage {
  receipts: PermissionReceipt[]
  next?: string
}

export type WorkspaceEventPayload =
  | { type: "workspace.created"; workspace: WorkspaceDescriptor }
  | { type: "workspace.started"; workspace: WorkspaceDescriptor }
  | { type: "workspace.error"; workspace: WorkspaceDescriptor }
  | { type: "workspace.stopped"; workspaceId: string; reason?: "deleted" | "stopped" }
  | { type: "workspace.log"; entry: WorkspaceLogEntry }
  | { type: "workspace.worktreesChanged"; workspaceId: string }
  /** Every folder still registered as temporary, after a create, keep or discard. */
  | { type: "workspace.temporaryChanged"; folders: string[] }
  | { type: "sidecar.updated"; sidecar: SideCar }
  | { type: "sidecar.removed"; sidecarId: string }
  | { type: "storage.configChanged"; owner: SettingsOwner; value: SettingsBucket }
  | { type: "storage.stateChanged"; owner: SettingsOwner; value: SettingsBucket }
  | { type: "instance.dataChanged"; instanceId: string; data: InstanceData }
  | { type: "instance.event"; instanceId: string; event: InstanceStreamEvent }
  | { type: "instance.eventStatus"; instanceId: string; status: InstanceStreamStatus; generation: number; reason?: string }
  | { type: "yolo.stateChanged"; instanceId: string; sessionId: string; enabled: boolean }
  | { type: "yolo.autoAccepted"; instanceId: string; sessionId: string; permissionId: string }
  | { type: "permission.receiptsChanged"; instanceId: string; sessionId: string; messageId?: string }

export interface NetworkAddress {
  ip: string
  family: "ipv4" | "ipv6"
  scope: "external" | "internal" | "loopback"
  /** Remote URL using the server's remote protocol/port for this IP. */
  remoteUrl: string
}

export interface LatestReleaseInfo {
  version: string
  tag: string
  url: string
  channel: "stable" | "preview"
  publishedAt?: string
  notes?: string
}

/** Which releases are offered; never selects desktop data or OpenCode state. */
export type UpdateFeed = "stable" | "preview"

export interface UiMeta {
  version?: string
  source: "bundled" | "downloaded" | "previous" | "override" | "dev-proxy" | "missing"
}

export interface SupportMeta {
  supported: boolean
  message?: string
  minServerVersion?: string
  latestServerVersion?: string
  latestServerUrl?: string
}

export interface ServerMeta {
  /** URL desktop apps should use to connect (prefers loopback HTTP when enabled). */
  localUrl: string
  /** URL direct remote clients should use (prefers HTTPS when enabled). */
  remoteUrl?: string
  /** SSE endpoint advertised to clients (`/api/events` by default). */
  eventsUrl: string
  /** Host the server is bound to (e.g., 127.0.0.1 or 0.0.0.0). */
  host: string
  /** Listening mode derived from host binding. */
  listeningMode: "local" | "all"
  /** Actual local port in use after binding. */
  localPort: number
  /** Actual direct remote port in use after binding (when remoteUrl is set). */
  remotePort?: number
  /** Display label for the host (e.g., hostname or friendly name). */
  hostLabel: string
  /** Absolute path of the filesystem root exposed to clients. */
  workspaceRoot: string
  /** Reachable direct-access addresses for this server, external first. */
  addresses: NetworkAddress[]
  serverVersion?: string
  /** CodeNomad backend OS and Node runtime architecture, never the UI or OpenCode host. */
  system?: { platform: string; arch: string }
  ui?: UiMeta
  support?: SupportMeta
  /** Effective update feed (saved `server.updateFeed`, else derived from the installed build label). */
  updateFeed?: UpdateFeed
  /** Newest release offered by the preview feed; stable updates use `support`. */
  update?: LatestReleaseInfo | null
  /** Explicit desktop data profile of the launching host; omitted for the default profile. */
  desktopProfile?: string
}

export type {
  Preferences,
  ModelPreference,
  AgentModelSelections,
  RecentFolder,
  OpenCodeBinary,
}
export type { PruneRequest, PruneResult } from "./opencode/session-pruning/contract"
