import type { MemoryContext, MemoryOperation, MemorySettings, MemoryUIListResult, MemoryErrorCode } from "../../../server/src/api-types"
import { localHttp } from "./auth-recovery"
import { backends } from "./backend-client"
import { parseInstanceKey } from "./backend-identity"
import { captureBackendOperation } from "./backend-operation"

export class AgentMemoryError extends Error {
  constructor(readonly code: MemoryErrorCode | "unavailable", readonly titles?: readonly string[]) { super(code) }
}

async function request<T>(path: string, init?: RequestInit, http: Pick<typeof localHttp, "fetch" | "url"> = localHttp, signal = AbortSignal.timeout(30_000)): Promise<T> {
  const response = await http.fetch(http.url(path),
    { ...init, credentials: "include", headers: { "Content-Type": "application/json" }, signal })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const codes = ["disabled", "full", "conflict", "invalid", "unreadable", "git_unavailable", "malformed"]
    throw new AgentMemoryError(codes.includes(error.code) ? error.code : "unavailable",
      Array.isArray(error.titles) && error.titles.every((title: unknown) => typeof title === "string") ? error.titles : undefined)
  }
  return response.json()
}

export const agentMemoryApi = {
  settings: () => request<MemorySettings>("/api/memory/settings"),
  setEnabled: (enabled: boolean) => request<MemorySettings>("/api/memory/settings", { method: "PUT", body: JSON.stringify({ enabled }) }),
  operation: <T>(operation: MemoryOperation, context?: MemoryContext) => request<T>("/api/memory", {
    method: "POST", body: JSON.stringify({ operation, ...(context ? { context } : {}) }),
  }),
  list: (scope: "global" | "project", context?: MemoryContext) => agentMemoryApi.operation<MemoryUIListResult>({ action: "list", scope }, context),
}

/** A qualified project keeps every memory scope and enablement check on its owner. */
export function agentMemoryFor(instanceId?: string): typeof agentMemoryApi {
  if (!instanceId || parseInstanceKey(instanceId).backendId === "local") return agentMemoryApi
  const backend = backends.get(parseInstanceKey(instanceId).backendId), operation = captureBackendOperation(instanceId)
  const send = async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (!backend) throw new AgentMemoryError("unavailable")
    operation.signal.throwIfAborted()
    const result = await request<T>(path, init, backend, AbortSignal.any([operation.signal, AbortSignal.timeout(30_000)]))
    operation.signal.throwIfAborted()
    return result
  }
  const api: typeof agentMemoryApi = {
    settings: () => send("/api/memory/settings"),
    setEnabled: enabled => send("/api/memory/settings", { method: "PUT", body: JSON.stringify({ enabled }) }),
    operation: (operation, context) => context && context.workspaceId !== instanceId ? Promise.reject(new AgentMemoryError("unavailable"))
      : send("/api/memory", { method: "POST", body: JSON.stringify({
        operation, ...(context ? { context: { ...context, workspaceId: parseInstanceKey(context.workspaceId).workspaceId } } : {}),
      }) }),
    list: (scope, context) => api.operation({ action: "list", scope }, context),
  }
  return api
}
