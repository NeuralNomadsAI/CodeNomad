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

/** One catalog integration in a Location, without the catalog's plugin ID, `rpc`, `sources` and `package`. */
export interface IntegrationView {
  id: string
  displayName: string
  family: IntegrationFamily
  summary: IntegrationCatalogEntry["summary"]
  app: IntegrationCatalogEntry["app"]
  /** The catalog's documentation link, only when it is the integration's reviewed GitHub page. */
  docs?: string
  catalogStatus: IntegrationCatalogEntry["status"]
  /** Recognised in the effective configuration, enabled or not. */
  configured: boolean
  /**
   * `declared`: at least one recognised source declaration (Global, Project or inherited); `runtime`: the native
   * inventory loaded it or it failed to load, absent otherwise. Activation rules alone set neither.
   */
  plugin: { declared: boolean; runtime?: "loaded" | "failed" }
  /**
   * A source designates another integration too or loaded under another plugin ID, a failure is shared by several
   * sources, or two runtime candidates exist: those sources and the runtime entry are attributed to none.
   */
  ambiguous?: true
  /** Writable scopes that declare it or a rule for its plugin. */
  scopes: PluginControlScope[]
  /** Safe correlation to writable plugin-source rows; paths, targets and plugin IDs stay server-side. */
  configuredSources: Array<{ scope: PluginControlScope; entryIndex: number }>
  /** Safe correlation to writable activation rules of its plugin ID (none when ambiguous). */
  configuredRules: Array<{ scope: PluginControlScope; entryIndex: number }>
  /** Installed package version, when the runtime loaded it. */
  version?: string
  outdated?: true
  state: IntegrationRuntimeState
  /** Projection of a conforming `status` answer (`state: "ok"` only). */
  status?: {
    version: string
    host?: NonNullable<IntegrationStatus["host"]>
    connection?: IntegrationConnectionView
    notices?: string[]
  }
}

/**
 * `connection` without any aggregate binding fact: a native integration's offer count, or another family's
 * connection state. Bindings are read per displayed conversation only.
 */
export type IntegrationConnectionView = { offers?: number; state?: Exclude<NonNullable<IntegrationStatus["connection"]>["state"], "attached" | "available"> }

/** `GET /api/workspaces/:id/integrations?directory=` */
export interface IntegrationsResponse {
  location: PluginControlLocation
  catalog: { state: IntegrationCatalogState; fetchedAt?: string }
  integrations: IntegrationView[]
}

export type IntegrationHostsResponse = import("./opencode/integrations/contract").IntegrationRpcValue<"hosts.output">
/** Display-only projection of the exact native session's authoritative binding read. */
export type IntegrationBindingResponse = { state: "attached"; label: string } | { state: "none" } | { state: "unknown" }
export type IntegrationAttachRequest = import("./opencode/integrations/contract").IntegrationRpcValue<"attachHost.input">
export type IntegrationAttachResponse = import("./opencode/integrations/contract").IntegrationRpcValue<"attachHost.output">
export type IntegrationDetachRequest = import("./opencode/integrations/contract").IntegrationRpcValue<"detachHost.input">
export type IntegrationDetachResponse = import("./opencode/integrations/contract").IntegrationRpcValue<"detachHost.output">
export type IntegrationInstallHostResponse = Pick<import("./opencode/integrations/contract").IntegrationRpcValue<"installHost.output">, "outcome">
/** Persisted reattach hint only; the integration owns current bindings. */
export interface IntegrationAttachmentHint { integration: string; label: string; attachedAt: number }
export const INTEGRATION_ATTACHMENT_METADATA_KEY = "codenomad.integrationAttachment"
