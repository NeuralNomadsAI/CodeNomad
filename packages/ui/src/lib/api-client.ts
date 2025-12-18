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
    ? window.__CODENOMAD_API_BASE__ ?? (IS_DEV ? FALLBACK_API_BASE : RUNTIME_BASE ?? FALLBACK_API_BASE)
    : FALLBACK_API_BASE
const DEFAULT_EVENTS_PATH = typeof window !== "undefined" ? window.__CODENOMAD_EVENTS_URL__ ?? "/api/events" : "/api/events"
const API_BASE = import.meta.env.VITE_CODENOMAD_API_BASE ?? DEFAULT_BASE
const EVENTS_URL = buildEventsUrl(API_BASE, DEFAULT_EVENTS_PATH)

export const CODENOMAD_API_BASE = API_BASE

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
    "Content-Type": "application/json",
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
  listFileSystem(path?: string, options?: { includeFiles?: boolean }): Promise<FileSystemListResponse> {
    const params = new URLSearchParams()
    if (path && path !== ".") {
      params.set("path", path)
    }
    if (options?.includeFiles !== undefined) {
      params.set("includeFiles", String(options.includeFiles))
    }
    const query = params.toString()
    return request<FileSystemListResponse>(query ? `/api/filesystem?${query}` : "/api/filesystem")
  },
  readInstanceData(id: string): Promise<InstanceData> {
    return request<InstanceData>(`/api/storage/instances/${encodeURIComponent(id)}`)
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
}

export type { WorkspaceDescriptor, WorkspaceLogEntry, WorkspaceEventPayload, WorkspaceEventType }
