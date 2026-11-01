import type { IntegrationsResponse, IntegrationHostsResponse, IntegrationAttachResponse, IntegrationDetachResponse, IntegrationInstallHostResponse } from "../../../server/src/integration-types"
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
