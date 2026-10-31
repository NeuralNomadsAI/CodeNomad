import { z } from "zod"

// OpenCode integrations, spec draft 0.1 (NeuralNomadsAI/opencode-integrations, spec/; dev-docs/OPENCODE_INTEGRATIONS.md).
// Each schema accepts exactly what its JSON Schema in `vendor/` accepts (parity test). Rules JSON Schema cannot
// express, such as catalog uniqueness, are separate refinements named below.
export const INTEGRATION_SPEC_DRAFT = "0.1"
export const INTEGRATION_SPEC_VERSION = 0
export const INTEGRATION_CONTRACT_VERSION = 1
/** Key of the static marker in an integration package's `package.json`. */
export const INTEGRATION_MARKER_KEY = "opencodeIntegration"
export const INTEGRATION_CATALOG_MAX_BYTES = 256 * 1024
export const INTEGRATION_CATALOG_MAX_ENTRIES = 64
export const INTEGRATION_MAX_OFFERS = 16

export const INTEGRATION_FAMILIES = ["native", "vendor-mcp", "api"] as const
export type IntegrationFamily = (typeof INTEGRATION_FAMILIES)[number]
/** Methods every family registers, then the native-only ones (spec/rpc-contract.md, RPC-1). */
export const INTEGRATION_STATUS_METHODS = ["status"] as const
export const INTEGRATION_NATIVE_METHODS = ["status", "installHost", "hosts", "attachHost", "detachHost", "advertise", "withdraw"] as const
export const INTEGRATION_EVENTS = ["status_changed", "hosts_changed"] as const

// JSON Schema `pattern` is a Unicode ECMAScript expression and `minLength`/`maxLength` count code points,
// where zod's `.max()` counts UTF-16 units: lengths are checked on code points so astral characters agree.
const pattern = (source: string) => new RegExp(source, "u")
const codePoints = (value: string) => [...value].length
function text(source: string | null, bounds: { min?: number; max?: number } = {}) {
  const expression = source === null ? null : pattern(source)
  return z.string().refine(value => (expression === null || expression.test(value))
    && codePoints(value) >= (bounds.min ?? 0) && (bounds.max === undefined || codePoints(value) <= bounds.max))
}

const INTEGRATION_ID = "^[a-z][a-z0-9-]{0,31}$"
const NEURALNOMADS_ID = "^neuralnomads\\.[a-z][a-z0-9-]{0,31}$"
const RANGE = "^[0-9xX*^~<>=|. -]+$"
const SEMVER = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$"
// Display text: no path separator and no control character.
const DISPLAY = "^[^/\\\\\\p{Cc}]+$"
const HANDLE = "^[^\\p{Cc}]+$"
const OFFER_ID = "^[A-Za-z0-9_-]{8,64}$"
const SESSION_ID = "^[A-Za-z0-9_-]{1,128}$"
const OFFER_KEY = "^[A-Za-z0-9._:-]{1,64}$"
const TOKEN = "^[0-9a-f]{64}$"

const integrationId = () => text(INTEGRATION_ID)
const neuralnomadsId = () => text(NEURALNOMADS_ID)
const range = () => text(RANGE, { min: 1, max: 64 })
const displayName = () => text("^OpenCode for \\S.*$", { max: 60 })
const family = () => z.enum(INTEGRATION_FAMILIES)
const integer = (min: number, max?: number) => {
  const value = z.number().int().min(min)
  return max === undefined ? value : value.max(max)
}
const vendor = () => z.object({
  server: text(null, { min: 1, max: 80 }),
  minAppVersion: text("^[0-9]+(\\.[0-9]+){0,2}$").optional(),
}).strict()

// marker.schema.json and catalog.schema.json `allOf`: native requires `host` and only native has it;
// only vendor-mcp may have `vendor`.
function familyFields(value: { family: IntegrationFamily; host?: unknown; vendor?: unknown }, context: z.RefinementCtx) {
  if ((value.family === "native") !== (value.host !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["host"],
    message: value.family === "native" ? "A native integration declares its host" : "Only a native integration declares a host" })
  if (value.family !== "vendor-mcp" && value.vendor !== undefined)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["vendor"], message: "Only a vendor-mcp integration declares a vendor server" })
}

/** marker.schema.json: the `opencodeIntegration` object of an integration package. */
export const integrationMarkerSchema = z.object({
  spec: z.literal(INTEGRATION_SPEC_VERSION),
  id: integrationId(),
  displayName: displayName(),
  family: family(),
  plugin: neuralnomadsId(),
  rpc: neuralnomadsId(),
  host: z.object({
    app: integrationId(),
    protocol: integer(1),
    range: range(),
    appVersions: range(),
    payload: text("^host/[a-z][a-z0-9-]*/[A-Za-z0-9._-]+$", { max: 200 }),
    sha256: text("^[0-9a-f]{64}$"),
  }).strict().optional(),
  vendor: vendor().optional(),
}).strict().superRefine(familyFields)
export type IntegrationMarker = z.infer<typeof integrationMarkerSchema>

const summary = z.record(z.string(), text(null, { min: 1, max: 300 })).superRefine((value, context) => {
  const keys = Object.keys(value)
  if (!keys.includes("en")) context.addIssue({ code: z.ZodIssueCode.custom, message: "An English summary is required" })
  if (keys.length > 16) context.addIssue({ code: z.ZodIssueCode.custom, message: "At most 16 summaries" })
  const locale = pattern("^[a-z]{2}(-[A-Z][A-Za-z]{1,3})?$")
  for (const key of keys) if (!locale.test(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Invalid locale" })
})

export const integrationCatalogEntrySchema = z.object({
  id: integrationId(),
  package: text("^@neuralnomads/opencode-[a-z][a-z0-9-]{0,31}$"),
  range: range(),
  displayName: displayName(),
  family: family(),
  plugin: neuralnomadsId(),
  rpc: neuralnomadsId(),
  summary,
  app: z.object({ name: text(null, { min: 1, max: 60 }), versions: range().optional() }).strict(),
  host: z.object({ protocol: integer(1), range: range() }).strict().optional(),
  vendor: vendor().optional(),
  docs: text("^https://github\\.com/NeuralNomadsAI/opencode-integrations/", { max: 300 }),
  status: z.enum(["preview", "stable", "deprecated"]),
  sources: z.object({
    git: z.array(text("^github:NeuralNomadsAI/opencode-integrations#", { max: 200 })).max(8).optional(),
  }).strict().optional(),
}).strict().superRefine(familyFields)
export type IntegrationCatalogEntry = z.infer<typeof integrationCatalogEntrySchema>

/** catalog.schema.json exactly. Readers use `integrationCatalogSchema`, which adds uniqueness. */
export const integrationCatalogDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  integrations: z.array(integrationCatalogEntrySchema).max(INTEGRATION_CATALOG_MAX_ENTRIES),
}).strict()

/** The catalog a reader accepts: the document schema, and no two entries sharing an `id`, `package`, `plugin` or `rpc`. */
export const integrationCatalogSchema = integrationCatalogDocumentSchema.superRefine((catalog, context) => {
  for (const field of ["id", "package", "plugin", "rpc"] as const) {
    const seen = new Set<string>()
    catalog.integrations.forEach((entry, index) => {
      if (seen.has(entry[field])) context.addIssue({ code: z.ZodIssueCode.custom, path: ["integrations", index, field], message: `Duplicate ${field}` })
      seen.add(entry[field])
    })
  }
})
export type IntegrationCatalog = z.infer<typeof integrationCatalogSchema>

// rpc.schema.json. Inputs are strict; outputs are reader schemas that accept and drop unknown fields (RPC-1b).
const empty = () => z.object({}).strict()
const outcome = <const T extends readonly [string, ...string[]]>(values: T) => z.object({ outcome: z.enum(values) })
const display = (max: number) => text(DISPLAY, { min: 1, max })

export const integrationStatusSchema = z.object({
  contract: z.literal(INTEGRATION_CONTRACT_VERSION),
  integration: z.object({
    id: integrationId(),
    version: text(SEMVER, { max: 64 }),
    family: family(),
    spec: z.literal(INTEGRATION_SPEC_VERSION),
  }),
  host: z.object({
    state: z.enum(["absent", "incompatible", "outdated", "ok", "unknown", "unsupported"]),
    partVersion: text(SEMVER, { max: 64 }).optional(),
    expectedRange: range().optional(),
    appVersion: display(64).optional(),
    action: z.enum(["install", "update"]).optional(),
  }).optional(),
  connection: z.object({
    state: z.enum(["none", "available", "attached", "connected", "signed_out", "error"]),
    offers: integer(0, INTEGRATION_MAX_OFFERS).optional(),
    attachedSessions: integer(0, 10_000).optional(),
  }).optional(),
  // Open list: readers ignore notices they do not know.
  notices: z.array(text("^[a-z][a-z0-9_]{0,31}$")).max(8).refine(values => new Set(values).size === values.length).optional(),
})
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>

export const integrationHostOfferSchema = z.object({
  offerID: text(OFFER_ID),
  label: display(120),
  document: display(120).optional(),
  appVersion: display(64).optional(),
  protocol: z.enum(["ok", "incompatible"]),
})
export type IntegrationHostOffer = z.infer<typeof integrationHostOfferSchema>

export const integrationAdvertiseInputSchema = z.object({
  host: z.literal("127.0.0.1"),
  port: integer(1, 65_535),
  token: text(TOKEN),
  script_handle: text(HANDLE, { min: 1, max: 200 }),
  label: display(120),
  protocol: integer(1, 1000),
  offer_key: text(OFFER_KEY),
}).strict()

/** Every definition of rpc.schema.json under its own name (`<method>.input`, `<method>.output`, `<event>.event`). */
export const integrationRpcSchemas = {
  "status.input": empty(),
  "status.output": integrationStatusSchema,
  "installHost.input": z.object({ target: z.literal("default").optional() }).strict(),
  "installHost.output": z.object({
    outcome: z.enum(["installed", "updated", "unchanged", "refused", "failed"]),
    detail: display(300).optional(),
  }),
  "hosts.input": empty(),
  "hosts.output": z.object({ offers: z.array(integrationHostOfferSchema).max(INTEGRATION_MAX_OFFERS) }),
  "attachHost.input": z.object({ offerID: text(OFFER_ID), sessionID: text(SESSION_ID) }).strict(),
  "attachHost.output": outcome(["attached", "busy", "gone", "refused"]),
  "detachHost.input": z.object({ sessionID: text(SESSION_ID) }).strict(),
  "detachHost.output": outcome(["detached", "none"]),
  "advertise.input": integrationAdvertiseInputSchema,
  "advertise.output": outcome(["accepted", "renewed", "refused"]),
  "withdraw.input": z.object({ offer_key: text(OFFER_KEY), token: text(TOKEN) }).strict(),
  "withdraw.output": outcome(["withdrawn", "none"]),
  "status_changed.event": empty(),
  "hosts_changed.event": empty(),
} as const satisfies Record<string, z.ZodTypeAny>
export type IntegrationRpcDefinition = keyof typeof integrationRpcSchemas
export type IntegrationRpcValue<Name extends IntegrationRpcDefinition> = z.infer<(typeof integrationRpcSchemas)[Name]>
