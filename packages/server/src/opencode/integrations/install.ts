import type { PluginControlLocation, PluginControlScope } from "../../api-types"
import type { PluginSourceMutationResponse } from "../../plugin-source-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { PluginControlsError, type PluginControls } from "../plugin-controls"
import { PluginSourcesError, type PluginSources } from "../plugin-sources"
import type { IntegrationCatalogSource } from "./catalog"
import { recognizeIntegrations } from "./recognition"

export type IntegrationInstallErrorCode =
  | "invalid" | "not-found" | "forbidden" | "global-only" | "refused" | "duplicate" | "ambiguous" | "stale" | "unavailable" | "timeout"
  | "uncertain"

/** Fixed, content-free refusals: neither the spec nor a path crosses the HTTP boundary or reaches a log. */
export class IntegrationInstallError extends Error {
  constructor(readonly code: IntegrationInstallErrorCode) { super(`Integration install ${code}`) }
}

export interface IntegrationInstallerDeps {
  controls: Pick<PluginControls, "read">
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation" | "requireWorkspaceCapability">
  catalog: Pick<IntegrationCatalogSource, "read">
  sources: Pick<PluginSources, "add">
}

/**
 * Installs a catalog integration by its ID: the spec `<package>@<range>` comes from the current catalog (a valid
 * `stale` one included), never from the client, and is written by `PluginSources.add` and its serialized queue.
 */
export class IntegrationInstaller {
  constructor(private readonly deps: IntegrationInstallerDeps) {}

  async install(workspaceId: string, integrationId: string, location: PluginControlLocation, scope: PluginControlScope,
    signal?: AbortSignal): Promise<PluginSourceMutationResponse> {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(integrationId) || (scope !== "global" && scope !== "project")
      || location.workspaceID !== undefined || !location.directory) throw new IntegrationInstallError("invalid")
    try {
      this.requireHostControls(workspaceId)
      const connection = await this.deps.workspaceManager.getSharedServiceConnection(workspaceId)
      if (!connection) throw new IntegrationInstallError("unavailable")
      // The snapshot read checks Location ownership before any catalog-derived answer.
      const [snapshot, catalog] = await Promise.all([this.deps.controls.read(workspaceId, location, signal), this.deps.catalog.read()])
      // An unavailable catalog lists nothing: it answers 503 before any ID lookup.
      if (catalog.state === "unavailable") throw new IntegrationInstallError("unavailable")
      const entry = catalog.catalog.integrations.find(candidate => candidate.id === integrationId)
      if (!entry) throw new IntegrationInstallError("not-found")
      if (entry.family === "native" && scope !== "global") throw new IntegrationInstallError("global-only")
      const recognition = recognizeIntegrations(catalog.catalog, snapshot).find(item => item.entry.id === entry.id)!
      if (recognition.ambiguous) throw new IntegrationInstallError("ambiguous")
      // Declared or loaded blocks; retained `id`/`-id` rules of an earlier removal never do.
      if (recognition.sources.length || recognition.runtime) throw new IntegrationInstallError("duplicate")
      const owned = snapshot.location
      await this.authorize(workspaceId, owned, connection, signal)
      const result = await this.deps.sources.add(workspaceId, { location: owned, scope, spec: `${entry.package}@${entry.range}` })
      // The write happened: a refusal now is an uncertain outcome, never a "nothing written" code.
      await this.authorize(workspaceId, owned, connection).catch(() => { throw new IntegrationInstallError("uncertain") })
      return { scope: result.scope, spec: result.spec, reloadPending: result.reloadPending }
    } catch (error) {
      throw installError(error)
    }
  }

  private async authorize(workspaceId: string, location: PluginControlLocation, connection: ServiceConnection, signal?: AbortSignal) {
    this.requireHostControls(workspaceId)
    signal?.throwIfAborted()
    connection.assertCurrent()
    if (!await this.deps.workspaceManager.ownsLocation(workspaceId, location, connection.client, signal)) {
      throw new IntegrationInstallError("forbidden")
    }
    signal?.throwIfAborted()
    connection.assertCurrent()
  }

  private requireHostControls(workspaceId: string) {
    try { this.deps.workspaceManager.requireWorkspaceCapability(workspaceId, "executionSettings") }
    catch { throw new IntegrationInstallError("forbidden") }
  }
}

function installError(error: unknown): IntegrationInstallError {
  if (error instanceof IntegrationInstallError) return error
  if (error instanceof PluginSourcesError) {
    if (error.code === "duplicate" || error.code === "global-only" || error.code === "stale" || error.code === "timeout") return new IntegrationInstallError(error.code)
    return new IntegrationInstallError(error.kind === "conflict" ? "duplicate" : error.kind === "invalid" ? "refused" : "unavailable")
  }
  if (error instanceof PluginControlsError) {
    if (error.kind === "forbidden" || error.kind === "not-found") return new IntegrationInstallError(error.kind === "forbidden" ? "forbidden" : "not-found")
    if (error.kind === "conflict") return new IntegrationInstallError("stale")
    if (error.kind === "invalid") return new IntegrationInstallError("refused")
  }
  return new IntegrationInstallError("unavailable")
}
