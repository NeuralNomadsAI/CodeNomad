import type {
  AppConfig,
  BinaryCreateRequest,
  BinaryListResponse,
  BinaryUpdateRequest,
  BinaryValidationResult,
  FileSystemEntry,
  FileSystemListResponse,
  InstanceData,
  ServerMeta,
  UpdateCheckResult,
  WorkspaceCreateRequest,
  WorkspaceDescriptor,
  WorkspaceFileResponse,
  WorkspaceFileSearchResponse,

  WorkspaceLogEntry,
  WorkspaceEventPayload,
  WorkspaceEventType,
} from "../../../server/src/api-types"
import { getLogger } from "./logger"

const FALLBACK_API_BASE = "http://127.0.0.1:9898"
const RUNTIME_BASE = typeof window !== "undefined" ? window.location?.origin : undefined
const IS_DEV = import.meta.env.DEV
const DEFAULT_BASE =
  typeof window !== "undefined"
    ? window.__ERA_CODE_API_BASE__ ?? (IS_DEV ? FALLBACK_API_BASE : RUNTIME_BASE ?? FALLBACK_API_BASE)
    : FALLBACK_API_BASE
const DEFAULT_EVENTS_PATH = typeof window !== "undefined" ? window.__ERA_CODE_EVENTS_URL__ ?? "/api/events" : "/api/events"
const API_BASE = import.meta.env.VITE_ERA_CODE_API_BASE ?? DEFAULT_BASE
const EVENTS_URL = buildEventsUrl(API_BASE, DEFAULT_EVENTS_PATH)

export const ERA_CODE_API_BASE = API_BASE

function buildEventsUrl(base: string | undefined, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path
  }
  if (base) {
    const normalized = path.startsWith("/") ? path : `/${path}`
    return `${base}${normalized}`
  }
  return path
}

const httpLogger = getLogger("api")
const sseLogger = getLogger("sse")

function logHttp(message: string, context?: Record<string, unknown>) {
  if (context) {
    httpLogger.info(message, context)
    return
  }
  httpLogger.info(message)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = API_BASE ? new URL(path, API_BASE).toString() : path
  const headers: HeadersInit = {
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers ?? {}),
  }

  const method = (init?.method ?? "GET").toUpperCase()
  const startedAt = Date.now()
  logHttp(`${method} ${path}`)

  try {
    const response = await fetch(url, { ...init, headers })
    if (!response.ok) {
      const message = await response.text()
      logHttp(`${method} ${path} -> ${response.status}`, { durationMs: Date.now() - startedAt, error: message })
      throw new Error(message || `Request failed with ${response.status}`)
    }
    const duration = Date.now() - startedAt
    logHttp(`${method} ${path} -> ${response.status}`, { durationMs: duration })
    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  } catch (error) {
    logHttp(`${method} ${path} failed`, { durationMs: Date.now() - startedAt, error })
    throw error
  }
}


export const serverApi = {
  fetchWorkspaces(): Promise<WorkspaceDescriptor[]> {
    return request<WorkspaceDescriptor[]>("/api/workspaces")
  },
  createWorkspace(payload: WorkspaceCreateRequest): Promise<WorkspaceDescriptor> {
    return request<WorkspaceDescriptor>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },
  fetchServerMeta(): Promise<ServerMeta> {
    return request<ServerMeta>("/api/meta")
  },
  deleteWorkspace(id: string): Promise<void> {
    return request(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" })
  },
  listWorkspaceFiles(id: string, relativePath = "."): Promise<FileSystemEntry[]> {
    const params = new URLSearchParams({ path: relativePath })
    return request<FileSystemEntry[]>(`/api/workspaces/${encodeURIComponent(id)}/files?${params.toString()}`)
  },
  searchWorkspaceFiles(
    id: string,
    query: string,
    opts?: { limit?: number; type?: "file" | "directory" | "all" },
  ): Promise<WorkspaceFileSearchResponse> {
    const trimmed = query.trim()
    if (!trimmed) {
      return Promise.resolve([])
    }
    const params = new URLSearchParams({ q: trimmed })
    if (opts?.limit) {
      params.set("limit", String(opts.limit))
    }
    if (opts?.type) {
      params.set("type", opts.type)
    }
    return request<WorkspaceFileSearchResponse>(
      `/api/workspaces/${encodeURIComponent(id)}/files/search?${params.toString()}`,
    )
  },
  readWorkspaceFile(id: string, relativePath: string): Promise<WorkspaceFileResponse> {
    const params = new URLSearchParams({ path: relativePath })
    return request<WorkspaceFileResponse>(
      `/api/workspaces/${encodeURIComponent(id)}/files/content?${params.toString()}`,
    )
  },

  fetchConfig(): Promise<AppConfig> {
    return request<AppConfig>("/api/config/app")
  },
  updateConfig(payload: AppConfig): Promise<AppConfig> {
    return request<AppConfig>("/api/config/app", {
      method: "PUT",
      body: JSON.stringify(payload),
    })
  },
  listBinaries(): Promise<BinaryListResponse> {
    return request<BinaryListResponse>("/api/config/binaries")
  },
  createBinary(payload: BinaryCreateRequest) {
    return request<{ binary: BinaryListResponse["binaries"][number] }>("/api/config/binaries", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },

  updateBinary(id: string, updates: BinaryUpdateRequest) {
    return request<{ binary: BinaryListResponse["binaries"][number] }>(`/api/config/binaries/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    })
  },

  deleteBinary(id: string): Promise<void> {
    return request(`/api/config/binaries/${encodeURIComponent(id)}`, { method: "DELETE" })
  },
  validateBinary(path: string): Promise<BinaryValidationResult> {
    return request<BinaryValidationResult>("/api/config/binaries/validate", {
      method: "POST",
      body: JSON.stringify({ path }),
    })
  },
  listFileSystem(path?: string, options?: { includeFiles?: boolean; includeHidden?: boolean; allowFullNavigation?: boolean }): Promise<FileSystemListResponse> {
    const params = new URLSearchParams()
    if (path && path !== ".") {
      params.set("path", path)
    }
    if (options?.includeFiles !== undefined) {
      params.set("includeFiles", String(options.includeFiles))
    }
    if (options?.includeHidden !== undefined) {
      params.set("includeHidden", String(options.includeHidden))
    }
    if (options?.allowFullNavigation !== undefined) {
      params.set("allowFullNavigation", String(options.allowFullNavigation))
    }
    const query = params.toString()
    return request<FileSystemListResponse>(query ? `/api/filesystem?${query}` : "/api/filesystem")
  },
  readInstanceData(id: string): Promise<InstanceData> {
    return request<InstanceData>(`/api/storage/instances/${encodeURIComponent(id)}`)
  },
  /**
   * Opens a native OS folder picker dialog via the server.
   * Only works when the server is running locally (listeningMode === "local").
   */
  pickFolder(options?: { title?: string; defaultPath?: string }): Promise<{ path: string | null; error?: string }> {
    return request<{ path: string | null; error?: string }>("/api/filesystem/pick-folder", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    })
  },
  writeInstanceData(id: string, data: InstanceData): Promise<void> {
    return request(`/api/storage/instances/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  },
  deleteInstanceData(id: string): Promise<void> {
    return request(`/api/storage/instances/${encodeURIComponent(id)}`, { method: "DELETE" })
  },
  fetchGitStatus(path: string): Promise<{
    available: boolean
    branch?: string
    ahead?: number
    behind?: number
    staged?: string[]
    modified?: string[]
    untracked?: string[]
    error?: string
  }> {
    const params = new URLSearchParams({ path })
    return request(`/api/git/status?${params.toString()}`)
  },
  connectEvents(onEvent: (event: WorkspaceEventPayload) => void, onError?: () => void) {
    sseLogger.info(`Connecting to ${EVENTS_URL}`)
    const source = new EventSource(EVENTS_URL)
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WorkspaceEventPayload
        onEvent(payload)
      } catch (error) {
        sseLogger.error("Failed to parse event", error)
      }
    }
    source.onerror = () => {
      sseLogger.warn("EventSource error, closing stream")
      onError?.()
    }
    return source
  },

  // Session Stats & Cleanup APIs
  fetchSessionStats(): Promise<SessionStatsResponse> {
    return request<SessionStatsResponse>("/api/sessions/stats")
  },
  purgeStaleSession(): Promise<SessionDeleteResponse> {
    return request<SessionDeleteResponse>("/api/sessions/stale", { method: "DELETE" })
  },
  cleanBlankSessions(): Promise<SessionDeleteResponse> {
    return request<SessionDeleteResponse>("/api/sessions/blank", { method: "DELETE" })
  },

  // Process Management APIs
  fetchProcesses(): Promise<ProcessInfo> {
    return request<ProcessInfo>("/api/system/processes")
  },
  fetchPidRegistry(): Promise<Record<string, WorkspacePidEntry>> {
    return request<Record<string, WorkspacePidEntry>>("/api/system/processes/registry")
  },
  cleanupOrphans(): Promise<CleanupResult> {
    return request<CleanupResult>("/api/system/processes/cleanup", { method: "POST" })
  },
  killProcess(pid: number): Promise<{ killed: boolean; pid: number }> {
    return request<{ killed: boolean; pid: number }>(`/api/system/processes/${pid}`, { method: "DELETE" })
  },
  killAllOrphans(): Promise<CleanupResult> {
    return request<CleanupResult>("/api/system/processes/kill-all-orphans", { method: "POST" })
  },

  // Update Check APIs
  checkForUpdates(): Promise<UpdateCheckResult> {
    return request<UpdateCheckResult>("/api/updates/check")
  },
  getUpdateStatus(): Promise<UpdateCheckResult | { lastChecked: null }> {
    return request<UpdateCheckResult | { lastChecked: null }>("/api/updates/status")
  },
}

// Session stats types
export interface SessionStatsResponse {
  total: number
  projectCount: number
  staleCount: number
  blankCount: number
}

export interface SessionDeleteResponse {
  success: boolean
  deleted: number
  errors?: string[]
}

// Process management types
export interface WorkspacePidEntry {
  pid: number
  folder: string
  startedAt: string
}

export interface ProcessInfo {
  registered: Array<{
    workspaceId: string
    entry: WorkspacePidEntry
    running: boolean
  }>
  unregistered: number[]
  summary: {
    totalRegistered: number
    runningRegistered: number
    unregisteredOrphans: number
  }
}

export interface CleanupResult {
  registeredCleanup: {
    cleaned: number
    failed: number
    failedPids: number[]
  }
  unregisteredCleanup: {
    found: number
    killed: number
    pids: number[]
  }
}

export type { WorkspaceDescriptor, WorkspaceLogEntry, WorkspaceEventPayload, WorkspaceEventType }
