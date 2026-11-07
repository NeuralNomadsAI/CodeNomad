import type { IntegrationsResponse, IntegrationHostsResponse, IntegrationAttachResponse, IntegrationDetachResponse, IntegrationInstallHostResponse, IntegrationBindingResponse } from "../../../server/src/integration-types"
import type { PluginControlScope } from "../../../server/src/api-types"
import type { PluginSourceMutationResponse } from "../../../server/src/plugin-source-types"
import type { IntegrationBindingTarget } from "../stores/integration-bindings-store"
import { backendOf } from "./backend-client"
import { parseInstanceKey } from "./backend-identity"
import { captureBackendOperation } from "./backend-operation"
import type { BackendHttp } from "./backend-transport"
import { backgroundReads } from "./background-read-queue"
import { HttpResponseError } from "./retryable-file-search"

/** An explicit transport is useful for isolated route qualification. Production resolves the instance owner. */
type BackendHttpClient = Pick<BackendHttp, "url" | "fetch">

/** The catalog integrations of one Location (`GET /api/workspaces/:id/integrations`), in the shared background budget. */
export async function fetchIntegrations(instanceId: string, directory: string, signal: AbortSignal, http?: BackendHttpClient): Promise<IntegrationsResponse> {
  signal = captureBackendOperation(instanceId, signal).signal
  http ??= backendOf(instanceId)
  const path = `/api/workspaces/${encodeURIComponent(parseInstanceKey(instanceId).workspaceId)}/integrations?${new URLSearchParams({ directory })}`
  return backgroundReads.run(signal, async () => {
    signal.throwIfAborted()
    const response = await http.fetch(http.url(path), { signal, credentials: "include" })
    signal.throwIfAborted()
    if (!response.ok) throw new HttpResponseError(`Request failed with ${response.status}`, response.status, response.headers.get("Retry-After"))
    const value = await response.json()
    signal.throwIfAborted()
    if (!value || !Array.isArray(value.integrations) || !value.catalog || !["fresh", "stale", "unavailable"].includes(value.catalog.state)) {
      throw new Error("Invalid integration response")
    }
    return value as IntegrationsResponse
  }, "visible")
}

/** Projected per-session binding only; transport failures revoke authority without exposing native diagnostics. */
export async function fetchIntegrationBinding(target: IntegrationBindingTarget, signal: AbortSignal, http?: BackendHttpClient): Promise<IntegrationBindingResponse> {
  signal = captureBackendOperation(target.instanceId, signal).signal
  return backgroundReads.run(signal, async () => {
    const path = `/api/workspaces/${encodeURIComponent(parseInstanceKey(target.instanceId).workspaceId)}/integrations/${encodeURIComponent(target.integrationId)}/binding?${new URLSearchParams({ directory: target.directory, sessionID: target.sessionID })}`
    try {
      signal.throwIfAborted()
      http ??= backendOf(target.instanceId)
      const response = await http.fetch(http.url(path), { signal, credentials: "include", cache: "no-store" })
      signal.throwIfAborted()
      if (!response.ok) return { state: "unknown" }
      const value = await response.json()
      signal.throwIfAborted()
      if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unknown" }
      const keys = Object.keys(value)
      if (keys.length === 1 && (value.state === "none" || value.state === "unknown")) return { state: value.state }
      if (keys.length === 2 && keys.includes("label") && value.state === "attached" && typeof value.label === "string"
        && [...value.label].length > 0 && [...value.label].length <= 120 && !/[/\\\p{Cc}]/u.test(value.label)) return { state: "attached", label: value.label }
    } catch { /* A failed authority read is unknown; never retain a previous attachment. */ }
    return { state: "unknown" }
  }, "visible")
}

/**
 * Installs a catalog integration by ID (`POST …/integrations/:id/install`): the server builds the spec from its
 * catalog. Sent once; a lost or refused answer is an uncertain outcome the caller reconciles by a new read.
 */
export async function installIntegration(instanceId: string, directory: string, integrationId: string, scope: PluginControlScope,
  signal?: AbortSignal, http?: BackendHttpClient): Promise<PluginSourceMutationResponse> {
  signal = captureBackendOperation(instanceId, signal).signal
  http ??= backendOf(instanceId)
  signal.throwIfAborted()
  const path = `/api/workspaces/${encodeURIComponent(parseInstanceKey(instanceId).workspaceId)}/integrations/${encodeURIComponent(integrationId)}/install?${new URLSearchParams({ directory })}`
  const response = await http.fetch(http.url(path), {
    signal, credentials: "include", cache: "no-store", method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope }),
  })
  signal.throwIfAborted()
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    signal.throwIfAborted()
    throw new HttpResponseError("Integration install failed", response.status, null, typeof error?.code === "string" ? error.code : undefined)
  }
  const value = await response.json()
  signal.throwIfAborted()
  if (!value || typeof value !== "object" || Object.keys(value).length !== 3 || value.scope !== scope
    || typeof value.spec !== "string" || !value.spec || value.reloadPending !== true) throw new Error("Invalid integration install response")
  return { scope, spec: value.spec, reloadPending: true }
}

/** Fixed CodeNomad routes only; the server owns RPC identity and placement checks. Never replay mutations. */
export async function integrationAttachmentRequest<T extends IntegrationHostsResponse | IntegrationAttachResponse | IntegrationDetachResponse | IntegrationInstallHostResponse>(
  instanceId: string, directory: string, integrationId: string, action: "hosts" | "attach" | "detach" | "install-host",
  signal: AbortSignal, body?: { sessionID: string; offerID?: string } | Record<string, never>, http?: BackendHttpClient,
): Promise<T> {
  signal = captureBackendOperation(instanceId, signal).signal
  http ??= backendOf(instanceId)
  signal.throwIfAborted()
  const path = `/api/workspaces/${encodeURIComponent(parseInstanceKey(instanceId).workspaceId)}/integrations/${encodeURIComponent(integrationId)}/${action}?${new URLSearchParams({ directory })}`
  const response = await http.fetch(http.url(path), {
    signal, credentials: "include", cache: "no-store", method: action === "hosts" ? "GET" : "POST",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  })
  signal.throwIfAborted()
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    signal.throwIfAborted()
    throw new HttpResponseError("Integration action failed", response.status, null, typeof error.code === "string" ? error.code : undefined)
  }
  const value = await response.json() as T
  signal.throwIfAborted()
  return value
}
