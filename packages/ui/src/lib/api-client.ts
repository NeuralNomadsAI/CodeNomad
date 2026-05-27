import type {
  BackgroundProcess,
  BackgroundProcessListResponse,
  BackgroundProcessOutputResponse,
  BinaryValidationResult,
  ConfigFileContentRequest,
  ConfigFileContentResponse,
  ConfigFileListResponse,
  FileSystemEntry,
  FileSystemCreateFolderResponse,
  FileSystemFileContentResponse,
  FileSystemListResponse,
  InstanceData,
  SpeechCapabilitiesResponse,
  SpeechSynthesisResponse,
  SpeechTranscriptionResponse,
  SideCar,
  PreviewSession,
  ServerMeta,
  RemoteProxySessionCreateRequest,
  RemoteProxySessionCreateResponse,
  RemoteServerProbeRequest,
  RemoteServerProbeResponse,
  VoiceModeStateResponse,
  WorkspaceCloneRequest,
  WorkspaceCloneResponse,
  WorktreeGitCommitRequest,
  WorktreeGitCommitResponse,
  WorktreeGitDiffRequest,
  WorktreeGitMutationResponse,
  WorktreeGitPathsRequest,
  WorkspaceCreateRequest,
  WorkspaceDescriptor,
  WorkspaceFileResponse,
  WorkspaceFileSearchResponse,

  WorkspaceLogEntry,
  WorkspaceEventPayload,
  WorkspaceEventType,
  WorktreeListResponse,
  WorktreeMap,
  WorktreeCreateRequest,
  WorktreeGitDiffResponse,
  WorktreeGitStatusResponse,
} from "../../../server/src/api-types"
import { getClientIdentity } from "./client-identity"
import { getLogger } from "./logger"
import { attachEventSourceHandlers } from "./event-source-handlers"

const RUNTIME_BASE = typeof window !== "undefined" ? window.location?.origin : undefined
const DEFAULT_BASE = typeof window !== "undefined" ? window.__CODENOMAD_API_BASE__ ?? RUNTIME_BASE : undefined
const DEFAULT_EVENTS_PATH = typeof window !== "undefined" ? window.__CODENOMAD_EVENTS_URL__ ?? "/api/events" : "/api/events"
const API_BASE = import.meta.env.VITE_CODENOMAD_API_BASE ?? DEFAULT_BASE
const EVENTS_URL = buildEventsUrl(API_BASE, DEFAULT_EVENTS_PATH)

export const CODENOMAD_API_BASE = API_BASE

export function buildBackgroundProcessStreamUrl(instanceId: string, processId: string): string {
  const encodedInstanceId = encodeURIComponent(instanceId)
  const encodedProcessId = encodeURIComponent(processId)
  return buildAbsoluteUrl(`/workspaces/${encodedInstanceId}/plugin/background-processes/${encodedProcessId}/stream`)
}

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

function buildAbsoluteUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path
  }
  if (!API_BASE) {
    return path
  }
  const normalized = path.startsWith("/") ? path : `/${path}`
  return `${API_BASE}${normalized}`
}

const httpLogger = getLogger("api")
const sseLogger = getLogger("sse")

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {}
  if (!headers) return output

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      output[key] = value
    })
    return output
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      output[key] = value
    }
    return output
  }

  return { ...headers }
}

function logHttp(message: string, context?: Record<string, unknown>) {
  if (context) {
    httpLogger.info(message, context)
    return
  }
  httpLogger.info(message)
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  if (!text) return `Request failed with ${response.status}`

  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    if (typeof parsed?.error === "string" && parsed.error.trim()) {
      return parsed.error
    }
    if (typeof parsed?.message === "string" && parsed.message.trim()) {
      return parsed.message
    }
  } catch {
    // Keep the original body for plain-text responses.
  }

  return text
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = API_BASE ? new URL(path, API_BASE).toString() : path
  const headers = normalizeHeaders(init?.headers)
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

  const method = (init?.method ?? "GET").toUpperCase()
  const startedAt = Date.now()
  logHttp(`${method} ${path}`)

  try {
    const response = await fetch(url, { ...init, headers, credentials: init?.credentials ?? "include" })
    if (!response.ok) {
      const message = await readErrorMessage(response)
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

async function requestRaw(path: string, init?: RequestInit): Promise<Response> {
  const url = API_BASE ? new URL(path, API_BASE).toString() : path
  const headers = normalizeHeaders(init?.headers)
  if (init?.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json"
  }

  const method = (init?.method ?? "GET").toUpperCase()
  const startedAt = Date.now()
  logHttp(`${method} ${path}`)

  const response = await fetch(url, { ...init, headers, credentials: init?.credentials ?? "include" })
  if (!response.ok) {
    const message = await readErrorMessage(response)
    logHttp(`${method} ${path} -> ${response.status}`, { durationMs: Date.now() - startedAt, error: message })
    throw new Error(message || `Request failed with ${response.status}`)
  }

  logHttp(`${method} ${path} -> ${response.status}`, { durationMs: Date.now() - startedAt })
  return response
}


export const serverApi = {
  fetchWorkspaces(): Promise<WorkspaceDescriptor[]> {
    return request<WorkspaceDescriptor[]>("/api/workspaces")
  },

  fetchWorktrees(id: string): Promise<WorktreeListResponse> {
    return request<WorktreeListResponse>(`/api/workspaces/${encodeURIComponent(id)}/worktrees`)
  },

  createWorktree(id: string, payload: WorktreeCreateRequest): Promise<{ slug: string; directory: string; branch?: string }> {
    return request<{ slug: string; directory: string; branch?: string }>(`/api/workspaces/${encodeURIComponent(id)}/worktrees`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },

  deleteWorktree(id: string, slug: string, options?: { force?: boolean }): Promise<void> {
    const params = new URLSearchParams()
    if (options?.force) {
      params.set("force", "true")
    }
    const suffix = params.toString() ? `?${params.toString()}` : ""
    return request(`/api/workspaces/${encodeURIComponent(id)}/worktrees/${encodeURIComponent(slug)}${suffix}`, {
      method: "DELETE",
    })
  },

  readWorktreeMap(id: string): Promise<WorktreeMap> {
    return request<WorktreeMap>(`/api/workspaces/${encodeURIComponent(id)}/worktrees/map`)
  },

  writeWorktreeMap(id: string, map: WorktreeMap): Promise<void> {
    return request(`/api/workspaces/${encodeURIComponent(id)}/worktrees/map`, {
      method: "PUT",
      body: JSON.stringify(map),
    })
  },
  createWorkspace(payload: WorkspaceCreateRequest): Promise<WorkspaceDescriptor> {
    return request<WorkspaceDescriptor>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },
  fetchSidecars(): Promise<{ sidecars: SideCar[] }> {
    return request<{ sidecars: SideCar[] }>("/api/sidecars")
  },
  createSidecar(payload: {
    kind: "port"
    name: string
    port: number
    insecure: boolean
    prefixMode: "strip" | "preserve"
  }): Promise<SideCar> {
    return request<SideCar>("/api/sidecars", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },
  updateSidecar(
    id: string,
    payload: Partial<{ name: string; port: number; insecure: boolean; prefixMode: "strip" | "preserve" }>,
  ): Promise<SideCar> {
    return request<SideCar>(`/api/sidecars/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    })
  },
  deleteSidecar(id: string): Promise<void> {
    return request(`/api/sidecars/${encodeURIComponent(id)}`, { method: "DELETE" })
  },
  createPreview(payload: { sessionId: string; url: string }): Promise<PreviewSession> {
    return request<PreviewSession>("/api/previews", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },
  deletePreview(token: string): Promise<void> {
    return request(`/api/previews/${encodeURIComponent(token)}`, { method: "DELETE" })
  },
  fetchServerMeta(): Promise<ServerMeta> {
    return request<ServerMeta>("/api/meta")
  },
  probeRemoteServer(payload: RemoteServerProbeRequest): Promise<RemoteServerProbeResponse> {
    return request<RemoteServerProbeResponse>("/api/remote-servers/probe", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },
  createRemoteProxySession(payload: RemoteProxySessionCreateRequest): Promise<RemoteProxySessionCreateResponse> {
    return request<RemoteProxySessionCreateResponse>("/api/remote-proxy/sessions", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },
  deleteRemoteProxySession(id: string): Promise<void> {
    return request(`/api/remote-proxy/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })
  },
  fetchAuthStatus(): Promise<{ authenticated: boolean; username?: string; passwordUserProvided?: boolean }> {
    return request<{ authenticated: boolean; username?: string; passwordUserProvided?: boolean }>("/api/auth/status")
  },
  listConfigFiles(): Promise<ConfigFileListResponse> {
    return request<ConfigFileListResponse>("/api/config-files")
  },
  readConfigFile(id: string): Promise<ConfigFileContentResponse> {
    return request<ConfigFileContentResponse>(`/api/config-files/${encodeURIComponent(id)}/content`)
  },
  writeConfigFile(id: string, contents: string): Promise<void> {
    const body: ConfigFileContentRequest = { contents }
    return request(`/api/config-files/${encodeURIComponent(id)}/content`, {
      method: "PUT",
      body: JSON.stringify(body),
    })
  },
  setServerPassword(password: string): Promise<{ ok: boolean; username: string; passwordUserProvided: boolean }> {
    return request<{ ok: boolean; username: string; passwordUserProvided: boolean }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ password }),
    })
  },
  deleteWorkspace(id: string): Promise<void> {
    return request(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" })
  },
  cloneWorkspaceRepository(payload: WorkspaceCloneRequest): Promise<WorkspaceCloneResponse> {
    return request<WorkspaceCloneResponse>("/api/workspaces/clone", {
      method: "POST",
      body: JSON.stringify(payload),
    })
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
  readWorkspaceFile(id: string, relativePath: string, options?: { encoding?: "utf-8" | "base64" }): Promise<WorkspaceFileResponse> {
    const params = new URLSearchParams({ path: relativePath })
    if (options?.encoding) {
      params.set("encoding", options.encoding)
    }
    return request<WorkspaceFileResponse>(
      `/api/workspaces/${encodeURIComponent(id)}/files/content?${params.toString()}`,
    )
  },
  writeWorkspaceFile(id: string, relativePath: string, contents: string): Promise<void> {
    const params = new URLSearchParams({ path: relativePath })
    return request(
      `/api/workspaces/${encodeURIComponent(id)}/files/content?${params.toString()}`,
      {
        method: "PUT",
        body: JSON.stringify({ contents }),
      },
    )
  },
  fetchWorktreeGitStatus(id: string, slug: string): Promise<WorktreeGitStatusResponse> {
    return request<WorktreeGitStatusResponse>(
      `/api/workspaces/${encodeURIComponent(id)}/worktrees/${encodeURIComponent(slug)}/git-status`,
    )
  },
  fetchWorktreeGitDiff(id: string, slug: string, requestPayload: WorktreeGitDiffRequest): Promise<WorktreeGitDiffResponse> {
    const params = new URLSearchParams({ path: requestPayload.path, scope: requestPayload.scope })
    if (requestPayload.originalPath) {
      params.set("originalPath", requestPayload.originalPath)
    }
    return request<WorktreeGitDiffResponse>(
      `/api/workspaces/${encodeURIComponent(id)}/worktrees/${encodeURIComponent(slug)}/git-diff?${params.toString()}`,
    )
  },
  stageWorktreeGitPaths(id: string, slug: string, payload: WorktreeGitPathsRequest): Promise<WorktreeGitMutationResponse> {
    return request<WorktreeGitMutationResponse>(
      `/api/workspaces/${encodeURIComponent(id)}/worktrees/${encodeURIComponent(slug)}/git-stage`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    )
  },
  unstageWorktreeGitPaths(id: string, slug: string, payload: WorktreeGitPathsRequest): Promise<WorktreeGitMutationResponse> {
    return request<WorktreeGitMutationResponse>(
      `/api/workspaces/${encodeURIComponent(id)}/worktrees/${encodeURIComponent(slug)}/git-unstage`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    )
  },
  commitWorktreeGitChanges(id: string, slug: string, payload: WorktreeGitCommitRequest): Promise<WorktreeGitCommitResponse> {
    return request<WorktreeGitCommitResponse>(
      `/api/workspaces/${encodeURIComponent(id)}/worktrees/${encodeURIComponent(slug)}/git-commit`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    )
  },

  fetchConfigOwner<T extends Record<string, any> = Record<string, any>>(owner: string): Promise<T> {
    return request<T>(`/api/storage/config/${encodeURIComponent(owner)}`)
  },
  patchConfigOwner<T extends Record<string, any> = Record<string, any>>(owner: string, patch: unknown): Promise<T> {
    return request<T>(`/api/storage/config/${encodeURIComponent(owner)}`, {
      method: "PATCH",
      body: JSON.stringify(patch ?? {}),
    })
  },
  fetchStateOwner<T extends Record<string, any> = Record<string, any>>(owner: string): Promise<T> {
    return request<T>(`/api/storage/state/${encodeURIComponent(owner)}`)
  },
  patchStateOwner<T extends Record<string, any> = Record<string, any>>(owner: string, patch: unknown): Promise<T> {
    return request<T>(`/api/storage/state/${encodeURIComponent(owner)}`, {
      method: "PATCH",
      body: JSON.stringify(patch ?? {}),
    })
  },

  validateBinary(path: string): Promise<BinaryValidationResult> {
    return request<BinaryValidationResult>("/api/storage/binaries/validate", {
      method: "POST",
      body: JSON.stringify({ path }),
    })
  },
  fetchSpeechCapabilities(): Promise<SpeechCapabilitiesResponse> {
    return request<SpeechCapabilitiesResponse>("/api/speech/capabilities")
  },
  transcribeAudio(payload: {
    audioBase64: string
    mimeType: string
    filename?: string
    language?: string
    prompt?: string
  }): Promise<SpeechTranscriptionResponse> {
    return request<SpeechTranscriptionResponse>("/api/speech/transcribe", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },
  synthesizeSpeech(payload: { text: string; format?: "mp3" | "wav" | "opus" | "aac" }): Promise<SpeechSynthesisResponse> {
    return request<SpeechSynthesisResponse>("/api/speech/synthesize", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },
  synthesizeSpeechStream(
    payload: { text: string; format?: "mp3" | "wav" | "opus" | "aac" },
    signal?: AbortSignal,
  ): Promise<Response> {
    return requestRaw("/api/speech/synthesize/stream", {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
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

  createFileSystemFolder(parentPath: string | undefined, name: string): Promise<FileSystemCreateFolderResponse> {
    return request<FileSystemCreateFolderResponse>("/api/filesystem/folders", {
      method: "POST",
      body: JSON.stringify({ parentPath, name }),
    })
  },
  readFileSystemFile(path: string, options?: { encoding?: "utf-8" | "base64" }): Promise<FileSystemFileContentResponse> {
    const params = new URLSearchParams({ path })
    if (options?.encoding) {
      params.set("encoding", options.encoding)
    }
    return request<FileSystemFileContentResponse>(`/api/filesystem/files/content?${params.toString()}`)
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
  listBackgroundProcesses(instanceId: string): Promise<BackgroundProcessListResponse> {
    return request<BackgroundProcessListResponse>(
      `/workspaces/${encodeURIComponent(instanceId)}/plugin/background-processes`,
    )
  },
  stopBackgroundProcess(instanceId: string, processId: string): Promise<BackgroundProcess> {
    return request<BackgroundProcess>(
      `/workspaces/${encodeURIComponent(instanceId)}/plugin/background-processes/${encodeURIComponent(processId)}/stop`,
      { method: "POST" },
    )
  },
  terminateBackgroundProcess(instanceId: string, processId: string): Promise<void> {
    return request(
      `/workspaces/${encodeURIComponent(instanceId)}/plugin/background-processes/${encodeURIComponent(processId)}/terminate`,
      { method: "POST" },
    )
  },
  updateVoiceMode(instanceId: string, enabled: boolean): Promise<VoiceModeStateResponse> {
    const identity = getClientIdentity()
    return request<VoiceModeStateResponse>(`/workspaces/${encodeURIComponent(instanceId)}/plugin/voice-mode`, {
      method: "POST",
      body: JSON.stringify({ ...identity, enabled }),
    })
  },
  sendClientConnectionPong(payload: { clientId: string; connectionId: string; pingTs?: number }): Promise<void> {
    return request<void>("/api/client-connections/pong", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  },
  fetchBackgroundProcessOutput(
    instanceId: string,
    processId: string,
    options?: { method?: "full" | "tail" | "head" | "grep"; pattern?: string; lines?: number; maxBytes?: number },
  ): Promise<BackgroundProcessOutputResponse> {
    const params = new URLSearchParams()
    if (options?.method) {
      params.set("method", options.method)
    }
    if (options?.pattern) {
      params.set("pattern", options.pattern)
    }
    if (options?.lines) {
      params.set("lines", String(options.lines))
    }
    if (options?.maxBytes !== undefined) {
      params.set("maxBytes", String(options.maxBytes))
    }
    const query = params.toString()
    const suffix = query ? `?${query}` : ""
    return request<BackgroundProcessOutputResponse>(
      `/workspaces/${encodeURIComponent(instanceId)}/plugin/background-processes/${encodeURIComponent(processId)}/output${suffix}`,
    )
  },
  connectEvents(
    onEvent: (event: WorkspaceEventPayload) => void,
    onError?: () => void,
    onPing?: (payload: { ts?: number }) => void,
  ) {
    const identity = getClientIdentity()
    const url = buildClientEventsUrl(identity)
    sseLogger.info(`Connecting to ${url}`)
    const source = new EventSource(url, { withCredentials: true } as any)
    attachEventSourceHandlers(source, { onEvent, onError, onPing, logger: sseLogger })
    return source
  },
}

function buildClientEventsUrl(identity: { clientId: string; connectionId: string }): string {
  const url = new URL(EVENTS_URL, typeof window !== "undefined" ? window.location.origin : "http://localhost")
  url.searchParams.set("clientId", identity.clientId)
  url.searchParams.set("connectionId", identity.connectionId)
  if (EVENTS_URL.startsWith("http://") || EVENTS_URL.startsWith("https://")) {
    return url.toString()
  }
  return `${url.pathname}${url.search}`
}

export type { WorkspaceDescriptor, WorkspaceLogEntry, WorkspaceEventPayload, WorkspaceEventType, SideCar }
