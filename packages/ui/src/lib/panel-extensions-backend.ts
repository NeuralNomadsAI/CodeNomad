import { backendOf } from "./backend-client"
import { captureBackendOperation } from "./backend-operation"
import { createPanelExtensionsApi } from "./panel-extensions-api"
import { LOCAL_BACKEND_ID } from "./backend-identity"
import { resolveBackendUrl } from "./backend-transport"

/** Inventory and package administration belong to this project's captured backend. */
export function panelExtensionsFor(instanceId: string, parent?: AbortSignal) {
  const backend = backendOf(instanceId)
  const operation = captureBackendOperation(instanceId, parent)
  return createPanelExtensionsApi({ fetch: backend.fetch,
    url: path => backend.id === LOCAL_BACKEND_ID ? resolveBackendUrl(backend.baseUrl, path, "append") : backend.url(path),
  }, operation)
}
