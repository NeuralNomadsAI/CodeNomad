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

const capability = z.string().regex(/^[a-f0-9]{32,64}$/)
const scope = z.enum(["global", "project"])
const integration = bundlesHostsInputSchema.shape.integration
const mounted = { owner: capability, mountID: capability }
export const bundlesMountInputSchema = z.object({ owner: capability, instanceId: z.string().min(1).max(256),
  digest: z.string().regex(/^[a-f0-9]{64}$/), sessionID: bundlesSessionSchema }).strict()
export const bundlesManageInputSchema = z.discriminatedUnion("method", [
  z.object({ ...mounted, method: z.literal("request"), input: z.object({ action: z.enum(["install", "update", "remove"]), integration, scope }).strict() }).strict(),
  z.object({ ...mounted, method: z.literal("setActive"), input: z.object({ integration, scope, enabled: z.boolean() }).strict() }).strict(),
  z.object({ ...mounted, method: z.literal("installHost"), input: z.object({ integration }).strict() }).strict(),
  z.object({ ...mounted, method: z.literal("attach"), input: z.object({ integration, offerID: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict() }).strict(),
  z.object({ ...mounted, method: z.literal("detach"), input: z.object({ integration }).strict() }).strict(),
])
export const bundlesControlInputSchema = z.discriminatedUnion("command", [
  z.object({ ...mounted, command: z.literal("start"), requestID: capability }).strict(),
  z.object({ ...mounted, command: z.literal("displayed"), planID: capability }).strict(),
  z.object({ ...mounted, command: z.literal("confirm"), planID: capability }).strict(),
  z.object({ ...mounted, command: z.literal("cancel"), planID: capability }).strict(),
  z.object({ ...mounted, command: z.literal("dispose") }).strict(),
  z.object({ ...mounted, command: z.literal("userRemount") }).strict(),
])
export type BundlesMountInput = z.infer<typeof bundlesMountInputSchema>
export type BundlesManageInput = z.infer<typeof bundlesManageInputSchema>
export type BundlesControlInput = z.infer<typeof bundlesControlInputSchema>

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
