import { z } from "zod"
import { INTEGRATION_CATALOG_MAX_ENTRIES, INTEGRATION_MAX_OFFERS, integrationCatalogEntrySchema, integrationStatusSchema } from "../opencode/integrations/contract"
import { looksLikePath } from "../opencode/integrations/status"

// Draft API 4 projection contract. Native RPC authority stays inside the backend.
const entry = integrationCatalogEntrySchema.innerType().shape
const catalogState = z.object({ state: z.enum(["fresh", "stale", "unavailable"]), fetchedAt: z.string().datetime().optional() }).strict()
const display = (max: number) => z.string().refine(value => [...value].length >= 1 && [...value].length <= max
  && !/\p{Cc}/u.test(value) && !looksLikePath(value))
const label = display(120)
const version = integrationStatusSchema.shape.integration.shape.version
const rule = z.enum(["default", "enabled", "disabled"])
export const bundlesEmptyInputSchema = z.object({}).strict()
export const bundlesHostsInputSchema = z.object({ integration: entry.id }).strict()
export const bundlesSessionSchema = z.string().regex(/^ses[A-Za-z0-9_-]{0,125}$/)

export const bundlesCatalogResultSchema = catalogState.extend({ integrations: z.array(z.object({
  id: entry.id, displayName: entry.displayName, family: entry.family, summary: entry.summary,
  app: entry.app, docs: entry.docs, catalogStatus: entry.status,
}).strict()).max(INTEGRATION_CATALOG_MAX_ENTRIES) }).strict()

const host = integrationStatusSchema.shape.host.unwrap().extend({ appVersion: display(64).optional() }).strict()
const commonStatus = { version, notices: z.array(z.literal("legacy_install")).max(1).optional() }
const commonState = {
  id: entry.id, configured: z.boolean(), scopes: z.array(z.enum(["global", "project"])).max(2),
  activation: z.object({ global: rule, project: rule, effective: rule }).strict(),
  version: version.optional(), outdated: z.literal(true).optional(),
  state: z.enum(["absent", "inactive", "failed", "unsupported", "non-conforming", "unknown", "ok"]),
}
const attachment = z.discriminatedUnion("state", [
  z.object({ state: z.literal("attached"), label }).strict(),
  z.object({ state: z.literal("none") }).strict(), z.object({ state: z.literal("unknown") }).strict(),
])
const nativeState = z.object({ ...commonState, family: z.literal("native"), attachment,
  status: z.object({ ...commonStatus, host: host.optional(),
    connection: z.object({ offers: z.number().int().min(0).max(INTEGRATION_MAX_OFFERS).optional() }).strict().optional(),
  }).strict().optional(),
}).strict()
const otherState = z.object({ ...commonState, family: z.enum(["vendor-mcp", "api"]),
  status: z.object({ ...commonStatus,
    connection: z.object({ state: integrationStatusSchema.shape.connection.unwrap().shape.state }).strict().optional(),
  }).strict().optional(),
}).strict()
export const bundlesStateResultSchema = z.object({ catalog: catalogState,
  integrations: z.array(z.union([nativeState, otherState])).max(INTEGRATION_CATALOG_MAX_ENTRIES),
}).strict()
export const bundlesHostsResultSchema = z.object({ offers: z.array(z.object({
  offerID: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), label, document: label.optional(),
  appVersion: display(64).optional(), protocol: z.enum(["ok", "incompatible"]),
}).strict()).max(INTEGRATION_MAX_OFFERS) }).strict()

/** State invalidations coalesce; request results keep each identity and outcome for the management slice. */
export const bundlesChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state") }).strict(),
  z.object({ kind: z.literal("request"), requestID: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    outcome: z.enum(["confirmed", "cancelled", "expired", "failed"]) }).strict(),
])
export type BundlesCatalogResult = z.infer<typeof bundlesCatalogResultSchema>
export type BundlesStateResult = z.infer<typeof bundlesStateResultSchema>
export type BundlesHostsResult = z.infer<typeof bundlesHostsResultSchema>
export type BundlesChange = z.infer<typeof bundlesChangeSchema>
