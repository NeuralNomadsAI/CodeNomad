import type { PluginControlLocation, PluginControlScope } from "../../api-types"
import type { IntegrationConnectionView, IntegrationsResponse, IntegrationView } from "../../integration-types"
import type { IntegrationFamily, IntegrationStatus } from "./contract"
import type { WorkspaceManager } from "../../workspaces/manager"
import { locationRequestOptions } from "../compatibility/location"
import { PluginControlsError, type PluginControls } from "../plugin-controls"
import type { IntegrationCatalogSource } from "./catalog"
import { isIntegrationDocsUrl } from "./docs-url"
import { recognizeIntegrations } from "./recognition"
import { readIntegrationStatuses, type IntegrationStatusRead } from "./status"

export interface IntegrationsReaderDeps {
  controls: Pick<PluginControls, "read">
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation" | "requireWorkspaceCapability">
  catalog: Pick<IntegrationCatalogSource, "read">
  timeoutMs?: number
}

/**
 * The catalog integrations of one owned Location: recognition from the authoritative plugin snapshot, then the
 * fixed `status` RPC of each loaded one under the RPC ID the catalog names (never the client's). Ownership and the
 * connection are checked again after the calls, so an answer never outlives the Location it was read for.
 */
export class IntegrationsReader {
  constructor(private readonly deps: IntegrationsReaderDeps) {}

  async read(workspaceId: string, location: PluginControlLocation, signal?: AbortSignal): Promise<IntegrationsResponse> {
    // prototype-1236: a read of the plugin inventory and the integrations' own status RPC, explicit servers included.
    try { this.deps.workspaceManager.requireWorkspaceCapability(workspaceId, "plugins") }
    catch (error) {
      if (error instanceof Error && "statusCode" in error && error.statusCode === 404) throw new PluginControlsError("Workspace not found", "not-found")
      throw error
    }
    const connection = await this.deps.workspaceManager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode service is unavailable", "unavailable")
    const [snapshot, catalog] = await Promise.all([this.deps.controls.read(workspaceId, location, signal), this.deps.catalog.read()])
    signal?.throwIfAborted()
    const owned = snapshot.location
    const recognitions = recognizeIntegrations(catalog.catalog, snapshot)
    const statuses = await readIntegrationStatuses(recognitions, (rpcID, method, callSignal) =>
      connection.client.rpc.call({ rpcID, method, input: {}, location: { directory: owned.directory } },
        { ...locationRequestOptions(owned), signal: callSignal }).then(response => response.output),
    { signal, timeoutMs: this.deps.timeoutMs })
    signal?.throwIfAborted()
    if (!await this.deps.workspaceManager.ownsLocation(workspaceId, owned, connection.client)) {
      throw new PluginControlsError("Location is not owned by this workspace", "forbidden")
    }
    try {
      connection.assertCurrent()
    } catch (error) {
      throw new PluginControlsError("OpenCode service connection changed", "unavailable", { cause: error })
    }
    const writable = (source: { scope: string; path?: string }): source is { scope: PluginControlScope; path?: string } =>
      (source.scope === "global" || source.scope === "project") && snapshot.targets.some(target => target.scope === source.scope && target.path === source.path)
    const ambiguousSources = new Map<string, { scope: PluginControlScope; entryIndex: number }>()
    for (const source of recognitions.flatMap(recognition => recognition.candidates)) {
      if (writable(source)) ambiguousSources.set(`${source.scope}:${source.entryIndex}`, { scope: source.scope, entryIndex: source.entryIndex })
    }
    return {
      location: owned,
      catalog: { state: catalog.state, ...(catalog.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}) },
      ambiguousSources: [...ambiguousSources.values()],
      integrations: recognitions.map((recognition, index): IntegrationView => {
        const { entry } = recognition
        const read: IntegrationStatusRead = statuses[index]!
        const source = recognition.runtime?.source
        const scopes = recognition.scopes.filter((scope): scope is PluginControlScope => scope === "global" || scope === "project")
        return {
          id: entry.id,
          displayName: entry.displayName,
          family: entry.family,
          summary: entry.summary,
          app: entry.app,
          ...(isIntegrationDocsUrl(entry.docs, entry.id) ? { docs: entry.docs } : {}),
          catalogStatus: entry.status,
          configured: recognition.ways.length > 0,
          // A retained `id`/`-id` rule alone is neither a declaration nor a loaded plugin.
          plugin: {
            declared: recognition.sources.length > 0,
            ...(recognition.runtime ? { runtime: recognition.runtime.state.status === "failed" ? "failed" as const : "loaded" as const } : {}),
          },
          ...(recognition.ambiguous ? { ambiguous: true as const } : {}),
          scopes,
          configuredSources: recognition.sources.flatMap(source =>
            (source.scope === "global" || source.scope === "project")
              && snapshot.targets.some(target => target.scope === source.scope && target.path === source.path)
              ? [{ scope: source.scope, entryIndex: source.entryIndex,
                expectedRevision: snapshot.targets.find(target => target.scope === source.scope && target.path === source.path)?.expectedRevision }] : []),
          configuredRules: recognition.ambiguous ? [] : snapshot.configured.rules.flatMap(rule =>
            rule.selector === entry.plugin && (rule.scope === "global" || rule.scope === "project")
              && snapshot.targets.some(target => target.scope === rule.scope && target.path === rule.path)
              ? [{ scope: rule.scope, entryIndex: rule.entryIndex,
                expectedRevision: snapshot.targets.find(target => target.scope === rule.scope && target.path === rule.path)?.expectedRevision }] : []),
          ...(source?.type === "package" && source.version ? { version: source.version } : {}),
          ...(source?.type === "package" && source.outdated ? { outdated: true as const } : {}),
          state: read.state,
          ...(read.state === "ok" ? {
            status: {
              version: read.status.integration.version,
              ...(read.status.host ? { host: read.status.host } : {}),
              ...(read.status.connection ? { connection: projectConnection(entry.family, read.status.connection) } : {}),
              ...(read.status.notices ? { notices: read.status.notices } : {}),
            },
          } : {}),
        }
      }),
    }
  }
}

/**
 * Integration surfaces never receive an aggregate binding state or count: a native integration keeps only its
 * offer count, the other families only their connection state.
 */
function projectConnection(family: IntegrationFamily, connection: NonNullable<IntegrationStatus["connection"]>): IntegrationConnectionView {
  if (family === "native") return connection.offers === undefined ? {} : { offers: connection.offers }
  return connection.state === "attached" || connection.state === "available" ? {} : { state: connection.state }
}
