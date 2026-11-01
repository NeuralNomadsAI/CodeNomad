import type { IntegrationsResponse } from "../../../server/src/integration-types"
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
    return (await response.json()) as IntegrationsResponse
  }, "visible")
}
