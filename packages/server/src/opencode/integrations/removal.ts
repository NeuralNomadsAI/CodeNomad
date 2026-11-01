import type { PluginSourceRemoveRequest } from "../../plugin-source-types"
import type { PluginControls } from "../plugin-controls"
import type { IntegrationCatalogSource } from "./catalog"
import type { IntegrationsReader } from "./integrations"
import { integrationsForSpec, recognizeIntegrations } from "./recognition"
import { INTEGRATION_STATUS_TIMEOUT_MS } from "./status"

/**
 * Native RPC contract 1 exposes only an aggregate count. Removal can proceed only with an authoritative zero;
 * never enumerate sessions or infer live bindings from Q8 to manufacture a detach-all operation (AC-C14).
 */
export async function checkIntegrationRemoval(deps: {
  documents: Pick<PluginControls, "read">
  catalog?: Pick<IntegrationCatalogSource, "read">
  integrations?: Pick<IntegrationsReader, "read">
}, workspaceId: string, request: PluginSourceRemoveRequest): Promise<"attached-sessions" | "attachment-unverified" | undefined> {
  if (!deps.catalog) return undefined
  const signal = AbortSignal.timeout(INTEGRATION_STATUS_TIMEOUT_MS)
  try {
    const [view, snapshot] = await Promise.all([deps.catalog.read(), deps.documents.read(workspaceId, request.location, signal)])
    signal.throwIfAborted()
    const bySpec = new Set(integrationsForSpec(view.catalog, request.target).map(entry => entry.id))
    const native = recognizeIntegrations(view.catalog, snapshot).filter(item => item.entry.family === "native"
      && (bySpec.has(item.entry.id) || item.sources.some(source => source.target === request.target)))
    if (native.length === 0) return undefined
    if (native.some(item => item.ambiguous) || !deps.integrations) return "attachment-unverified"
    const states = await deps.integrations.read(workspaceId, request.location, signal)
    signal.throwIfAborted()
    for (const item of native) {
      const state = states.integrations.find(entry => entry.id === item.entry.id)
      if (state?.state !== "ok" || state.status?.connection?.attachedSessions === undefined) return "attachment-unverified"
      if (state.status.connection.attachedSessions > 0) return "attached-sessions"
    }
    return undefined
  } catch { return "attachment-unverified" }
}
