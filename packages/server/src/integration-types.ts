// Shared types of OpenCode integrations (dev-docs/OPENCODE_INTEGRATIONS.md), kept out of api-types.ts.
import type { PluginControlLocation, PluginControlScope } from "./api-types"
import type { IntegrationCatalogEntry, IntegrationFamily, IntegrationStatus } from "./opencode/integrations/contract"
import type { IntegrationCatalogState } from "./opencode/integrations/catalog"
import type { IntegrationRuntimeState } from "./opencode/integrations/status"

export type {
  IntegrationCatalog,
  IntegrationCatalogEntry,
  IntegrationFamily,
  IntegrationHostOffer,
  IntegrationMarker,
  IntegrationRpcDefinition,
  IntegrationRpcOutputName,
  IntegrationRpcOutputRead,
  IntegrationRpcValue,
  IntegrationStatus,
} from "./opencode/integrations/contract"
export type { IntegrationCatalogState } from "./opencode/integrations/catalog"
export type { IntegrationRuntimeState } from "./opencode/integrations/status"

/** One catalog integration in a Location, without the catalog's internal `plugin`, `rpc` and `sources`. */
export interface IntegrationView {
  id: string
  displayName: string
  family: IntegrationFamily
  summary: IntegrationCatalogEntry["summary"]
  app: IntegrationCatalogEntry["app"]
  docs: string
  catalogStatus: IntegrationCatalogEntry["status"]
  /** Recognised in the effective configuration, enabled or not. */
  configured: boolean
  /** Writable scopes that declare it or a rule for its plugin. */
  scopes: PluginControlScope[]
  /** Installed package version, when the runtime loaded it. */
  version?: string
  outdated?: true
  state: IntegrationRuntimeState
  /** Projection of a conforming `status` answer (`state: "ok"` only). */
  status?: {
    version: string
    host?: NonNullable<IntegrationStatus["host"]>
    connection?: NonNullable<IntegrationStatus["connection"]>
    notices?: string[]
  }
}

/** `GET /api/workspaces/:id/integrations?directory=` */
export interface IntegrationsResponse {
  location: PluginControlLocation
  catalog: { state: IntegrationCatalogState; fetchedAt?: string }
  integrations: IntegrationView[]
}
