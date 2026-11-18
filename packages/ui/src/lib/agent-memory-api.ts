import type { MemoryContext, MemoryOperation, MemorySettings, MemoryUIListResult, MemoryErrorCode } from "../../../server/src/api-types"
import { authenticatedFetch } from "./auth-recovery"
import { CODENOMAD_API_BASE } from "./api-base"

export class AgentMemoryError extends Error {
  constructor(readonly code: MemoryErrorCode | "unavailable", readonly titles?: readonly string[]) { super(code) }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(CODENOMAD_API_BASE ? new URL(path, CODENOMAD_API_BASE).toString() : path,
    { ...init, credentials: "include", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000) })
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
