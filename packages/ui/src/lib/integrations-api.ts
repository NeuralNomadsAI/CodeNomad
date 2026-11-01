import type { IntegrationsResponse, IntegrationHostsResponse, IntegrationAttachResponse, IntegrationDetachResponse, IntegrationInstallHostResponse, IntegrationBindingResponse } from "../../../server/src/integration-types"
import type { IntegrationBindingTarget } from "../stores/integration-bindings-store"
import { CODENOMAD_API_BASE as API_BASE } from "./api-base"
import { authenticatedFetch } from "./auth-recovery"
import { backgroundReads } from "./background-read-queue"
import { HttpResponseError } from "./retryable-file-search"

/** The catalog integrations of one Location (`GET /api/workspaces/:id/integrations`), in the shared background budget. */
export function fetchIntegrations(instanceId: string, directory: string, signal: AbortSignal): Promise<IntegrationsResponse> {
  const path = `/api/workspaces/${encodeURIComponent(instanceId)}/integrations?${new URLSearchParams({ directory })}`
  return backgroundReads.run(signal, async () => {
    const response = await authenticatedFetch(API_BASE ? new URL(path, API_BASE).toString() : path, { signal, credentials: "include" })
    if (!response.ok) throw new HttpResponseError(`Request failed with ${response.status}`, response.status, response.headers.get("Retry-After"))
    const value = await response.json()
    if (!value || !Array.isArray(value.integrations) || !value.catalog || !["fresh", "stale", "unavailable"].includes(value.catalog.state)) {
      throw new Error("Invalid integration response")
    }
    return value as IntegrationsResponse
  }, "visible")
}

/** Projected per-session binding only; transport failures revoke authority without exposing native diagnostics. */
export function fetchIntegrationBinding(target: IntegrationBindingTarget, signal: AbortSignal): Promise<IntegrationBindingResponse> {
  return backgroundReads.run(signal, async () => {
    const path = `/api/workspaces/${encodeURIComponent(target.instanceId)}/integrations/${encodeURIComponent(target.integrationId)}/binding?${new URLSearchParams({ directory: target.directory, sessionID: target.sessionID })}`
    try {
      const response = await authenticatedFetch(API_BASE ? new URL(path, API_BASE).toString() : path, { signal, credentials: "include", cache: "no-store" })
      if (!response.ok) return { state: "unknown" }
      const value = await response.json()
      if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unknown" }
      const keys = Object.keys(value)
      if (keys.length === 1 && (value.state === "none" || value.state === "unknown")) return { state: value.state }
      if (keys.length === 2 && keys.includes("label") && value.state === "attached" && typeof value.label === "string"
        && [...value.label].length > 0 && [...value.label].length <= 120 && !/[/\\\p{Cc}]/u.test(value.label)) return { state: "attached", label: value.label }
    } catch { /* A failed authority read is unknown; never retain a previous attachment. */ }
    return { state: "unknown" }
  }, "visible")
}

/** Fixed CodeNomad routes only; the server owns RPC identity and placement checks. Never replay mutations. */
export async function integrationAttachmentRequest<T extends IntegrationHostsResponse | IntegrationAttachResponse | IntegrationDetachResponse | IntegrationInstallHostResponse>(
  instanceId: string, directory: string, integrationId: string, action: "hosts" | "attach" | "detach" | "install-host",
  signal: AbortSignal, body?: { sessionID: string; offerID?: string } | Record<string, never>,
): Promise<T> {
  const path = `/api/workspaces/${encodeURIComponent(instanceId)}/integrations/${encodeURIComponent(integrationId)}/${action}?${new URLSearchParams({ directory })}`
  const response = await authenticatedFetch(API_BASE ? new URL(path, API_BASE).toString() : path, {
    signal, credentials: "include", cache: "no-store", method: action === "hosts" ? "GET" : "POST",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new HttpResponseError("Integration action failed", response.status, null, typeof error.code === "string" ? error.code : undefined)
  }
  return await response.json() as T
}
