import { z } from "zod"
import type { ProviderUsageResponse, ProviderUsageWindow } from "../api-types"
import { locationRequestOptions } from "../opencode/compatibility/location"
import type { ServiceConnection } from "../workspaces/opencode-service"

export const PLUGIN_USAGE_RPC_PREFIX = "provider-usage."
export const PLUGIN_USAGE_RPC_METHOD = "read"
export const PLUGIN_USAGE_MAX_WINDOWS = 16
export const PLUGIN_USAGE_MAX_RESPONSE_BYTES = 256 * 1024

const RPC_PROVIDER_ID = /^[A-Za-z0-9._-]{1,100}$/
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/
const FORBIDDEN_KEYS = new Set([
  "__proto__", "prototype", ...Object.getOwnPropertyNames(Object.prototype),
])

function isForbiddenWindowKey(label: string): boolean {
  if (FORBIDDEN_KEYS.has(label)) return true
  const scope = label.indexOf(":")
  return scope > 0 && FORBIDDEN_KEYS.has(label.slice(0, scope))
}

function isCanonicalWindowKey(value: string): boolean {
  if (value !== value.trim() || CONTROL_CHARS.test(value) || isForbiddenWindowKey(value)) return false
  const scope = value.indexOf(":")
  if (scope < 0) return true
  const base = value.slice(0, scope)
  const detail = value.slice(scope + 1)
  return base.length > 0 && detail.length > 0 && base === base.trim() && detail === detail.trim()
}

const displayText = (max: number) =>
  z.string().refine(value => !CONTROL_CHARS.test(value)).transform(value => value.trim()).pipe(z.string().min(1).max(max))

const canonicalWindowKey = z.string().min(1).max(64).refine(isCanonicalWindowKey)

const finite = z.number().refine(Number.isFinite)
const MAX_EPOCH_MS = 8_640_000_000_000_000
const epochMs = finite.refine(value => value > 0 && value <= MAX_EPOCH_MS)
// Parse JS's shortest decimal string directly so neither binary scaling (`1.005 * 100`)
// nor intermediate rounding (`99.9949999`) alters hundredths or complement cutoffs.
function toHundredths(value: number): number {
  if (value === 0) return 0
  const [mantissa, expPart] = value.toExponential().split("e")
  const digits = mantissa!.replace(".", "")
  const point = Number(expPart) + 3
  if (point <= 0) return point === 0 && digits[0]! >= "5" ? 1 : 0
  const padded = digits.padEnd(point, "0")
  const whole = Number(padded.slice(0, point))
  return (padded[point] ?? "0") >= "5" ? whole + 1 : whole
}
const roundPercent = (value: number) => toHundredths(value) / 100
const percent = finite.refine(value => value >= 0 && value <= 100).transform(roundPercent)

const pluginWindowSchema = z.object({
  usedPercent: percent.nullable().optional(),
  remainingPercent: percent.nullable().optional(),
  windowSeconds: finite.refine(value => value >= 0).nullable().optional(),
  resetAt: epochMs.nullable().optional(),
  valueLabel: displayText(128).optional(),
  balanceUSD: z.object({ remaining: finite, total: finite.refine(value => value >= 0).optional() }).strict().optional(),
  limitUSD: finite.refine(value => value >= 0).optional(),
  consumption: z.union([
    z.object({ used: finite.refine(value => value >= 0), limit: finite.refine(value => value >= 0).optional() }).strict(),
    z.object({ creditsUsed: finite.refine(value => value >= 0) }).strict(),
    z.object({ unlimited: z.literal(true) }).strict(),
  ]).optional(),
}).strict().refine(item =>
  item.usedPercent == null || item.remainingPercent == null
    || Math.abs(toHundredths(item.usedPercent) + toHundredths(item.remainingPercent) - 10_000) <= 5,
).refine(item =>
  !(item.consumption && "unlimited" in item.consumption) || (item.usedPercent == null && item.remainingPercent == null),
// The panel shows one value per window: consumption, limitUSD or balanceUSD.
).refine(item => [item.consumption, item.limitUSD, item.balanceUSD].filter(value => value !== undefined).length <= 1)

const absentRpcErrorSchema = z.object({
  _tag: z.literal("RpcError"),
  type: z.enum(["rpc.unavailable", "rpc.method_not_found"]),
  message: z.string().min(1).max(4096),
}).strict()

// OpenCode reserves `rpc.`; plugin failures are its other system codes or custom unprefixed types.
const PLUGIN_SYSTEM_RPC_ERRORS = new Set(["rpc.invalid_input", "rpc.invalid_output", "rpc.internal"])
const registeredRpcErrorSchema = z.object({
  _tag: z.literal("RpcError"),
  type: z.string().refine(type => !type.startsWith("rpc.") || PLUGIN_SYSTEM_RPC_ERRORS.has(type)),
  message: z.string(),
  data: z.unknown().optional(),
}).strict()

const registeredRpcInternalErrorSchema = z.object({
  _tag: z.literal("RpcInternalError"),
  type: z.enum(["rpc.internal", "rpc.invalid_output"]),
  message: z.string(),
  data: z.unknown().optional(),
}).strict()

const pluginUsageOutputSchema = z.object({
  providerName: displayText(128).optional(),
  configured: z.boolean(),
  ok: z.boolean(),
  fetchedAt: epochMs.optional(),
  windows: z.record(canonicalWindowKey, pluginWindowSchema)
    .refine(record => Object.keys(record).length <= PLUGIN_USAGE_MAX_WINDOWS),
})

export function pluginUsageRpcId(providerId: string): string | null {
  const id = providerId.trim()
  if (!RPC_PROVIDER_ID.test(id) || id.includes("..")) return null
  return `${PLUGIN_USAGE_RPC_PREFIX}${id}`
}

export function parsePluginUsageOutput(
  raw: unknown,
  context: { requestedProviderId: string; providerId: string; modelId?: string; now?: () => number },
): ProviderUsageResponse | null {
  const rawWindows = raw && typeof raw === "object" && "windows" in raw
    ? (raw as { windows?: unknown }).windows
    : undefined
  if (rawWindows && typeof rawWindows === "object" && !Array.isArray(rawWindows)
    && Object.keys(rawWindows).some(isForbiddenWindowKey)) {
    return null
  }
  const parsed = pluginUsageOutputSchema.safeParse(raw)
  if (!parsed.success) return null
  const data = parsed.data
  // An unconfigured provider has no quota to show, whatever `ok` claims.
  const ok = data.ok && data.configured
  const windows: Record<string, ProviderUsageWindow> = {}
  if (ok) {
    for (const [label, item] of Object.entries(data.windows)) {
      const usedHundredths = item.usedPercent != null
        ? toHundredths(item.usedPercent)
        : item.remainingPercent != null
          ? 10_000 - toHundredths(item.remainingPercent)
          : null
      const usedPercent = usedHundredths != null ? usedHundredths / 100 : null
      const remainingPercent = usedHundredths != null ? (10_000 - usedHundredths) / 100 : null
      windows[label] = {
        usedPercent,
        remainingPercent,
        windowSeconds: item.windowSeconds ?? null,
        resetAt: item.resetAt ?? null,
        ...(item.valueLabel !== undefined ? { valueLabel: item.valueLabel } : {}),
        ...(item.balanceUSD !== undefined ? { balanceUSD: item.balanceUSD } : {}),
        ...(item.limitUSD !== undefined ? { limitUSD: item.limitUSD } : {}),
        ...(item.consumption !== undefined ? { consumption: item.consumption } : {}),
      }
    }
  }
  return {
    requestedProviderId: context.requestedProviderId,
    providerId: context.providerId,
    providerName: data.providerName ?? context.providerId,
    modelId: context.modelId,
    supported: true,
    configured: data.configured,
    ok,
    windows,
    fetchedAt: data.fetchedAt ?? (context.now ?? Date.now)(),
  }
}

export function unavailable(providerId: string, modelId?: string): ProviderUsageResponse {
  return {
    requestedProviderId: providerId,
    providerId,
    providerName: providerId,
    modelId,
    supported: true,
    configured: true,
    ok: false,
    windows: {},
    fetchedAt: Date.now(),
  }
}

async function awaitBounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException("Plugin usage timed out", "AbortError"))
    signal.addEventListener("abort", abort, { once: true })
  })
  try { return await Promise.race([operation, aborted]) }
  finally { signal.removeEventListener("abort", abort) }
}

function isJsonResponse(response: Response): boolean {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  return type === "application/json" || type.endsWith("+json")
}

type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "non-json" | "overflow" | "malformed" }

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<BoundedJsonResult> {
  if (!isJsonResponse(response)) {
    void response.body?.cancel().catch(() => {})
    return { ok: false, reason: "non-json" }
  }
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > PLUGIN_USAGE_MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {})
    return { ok: false, reason: "overflow" }
  }
  if (!response.body) {
    const pending = response.text()
    pending.catch(() => {})
    const text = await awaitBounded(pending, signal)
    if (Buffer.byteLength(text, "utf8") > PLUGIN_USAGE_MAX_RESPONSE_BYTES) return { ok: false, reason: "overflow" }
    try { return { ok: true, value: JSON.parse(text) } }
    catch { return { ok: false, reason: "malformed" } }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const read = reader.read()
      read.catch(() => {})
      const { done, value } = await awaitBounded(read, signal)
      if (done) break
      total += value.byteLength
      if (total > PLUGIN_USAGE_MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {})
        return { ok: false, reason: "overflow" }
      }
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  try { return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))) } }
  catch { return { ok: false, reason: "malformed" } }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export async function readPluginProviderUsage(
  connection: Pick<ServiceConnection, "endpoint" | "fetch">,
  target: { providerId: string; location: { directory: string; workspaceID?: string }; modelId?: string },
  signal: AbortSignal,
  quotaDeadline: AbortSignal = signal,
): Promise<ProviderUsageResponse | null> {
  // The quota deadline never outlives the caller's own signal.
  const quotaSignal = AbortSignal.any([signal, quotaDeadline])
  const rpcID = pluginUsageRpcId(target.providerId)
  if (!rpcID) return null
  if (target.location.workspaceID !== undefined) throw new Error("Unsupported workspace selector")
  const providerId = target.providerId.trim()
  try {
    quotaSignal.throwIfAborted()
    const url = new URL(`/api/rpc/${encodeURIComponent(rpcID)}/${PLUGIN_USAGE_RPC_METHOD}`, connection.endpoint.url)
    url.searchParams.set("location[directory]", target.location.directory)
    const headers = new Headers(locationRequestOptions(target.location)?.headers)
    headers.set("content-type", "application/json")
    let abandoned = false
    const pending = connection.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: target.modelId ? { modelId: target.modelId } : {} }),
      signal: quotaSignal,
      redirect: "error",
    })
    void pending.then(
      response => { if (abandoned || signal.aborted || quotaSignal.aborted) void response.body?.cancel().catch(() => {}) },
      () => {},
    )
    let response: Response
    try {
      response = await awaitBounded(pending, quotaSignal)
    } catch (error) {
      abandoned = true
      throw error
    }
    if (signal.aborted || quotaSignal.aborted) {
      void response.body?.cancel().catch(() => {})
      signal.throwIfAborted()
      return unavailable(target.providerId, target.modelId)
    }

    if (response.status === 200) {
      const json = await readBoundedJson(response, quotaSignal)
      signal.throwIfAborted()
      if (quotaSignal.aborted) return unavailable(target.providerId, target.modelId)
      const body = json.ok ? asRecord(json.value) : null
      if (!body || !("output" in body)) return unavailable(target.providerId, target.modelId)
      return parsePluginUsageOutput(body.output, {
        requestedProviderId: target.providerId,
        providerId,
        modelId: target.modelId,
      }) ?? unavailable(target.providerId, target.modelId)
    }

    if (response.status === 400) {
      const json = await readBoundedJson(response, quotaSignal)
      signal.throwIfAborted()
      // Past the quota deadline no fallback read may start.
      if (quotaSignal.aborted) return unavailable(target.providerId, target.modelId)
      const body = json.ok ? asRecord(json.value) : null
      if (absentRpcErrorSchema.safeParse(body).success) return null
      if (registeredRpcErrorSchema.safeParse(body).success) return unavailable(target.providerId, target.modelId)
      throw new Error("Plugin usage RPC rejected request")
    }

    if (response.status === 404) {
      const json = await readBoundedJson(response, quotaSignal)
      signal.throwIfAborted()
      if (quotaSignal.aborted) return unavailable(target.providerId, target.modelId)
      if (!json.ok) {
        if (json.reason === "non-json") return null
        throw new Error("Plugin usage 404 body unreadable")
      }
      const body = asRecord(json.value)
      if (body?._tag === "LocationNotFoundError" || body?._tag === "SessionNotFoundError") {
        throw new Error("Plugin usage location not found")
      }
      // RPC envelopes never travel as 404: only generic missing-route bodies mean "absent".
      if (body?._tag === "RpcError" || body?._tag === "RpcInternalError") throw new Error("Plugin usage RPC status mismatch")
      return null
    }

    if (response.status === 500) {
      const json = await readBoundedJson(response, quotaSignal)
      signal.throwIfAborted()
      const body = json.ok ? asRecord(json.value) : null
      if (registeredRpcInternalErrorSchema.safeParse(body).success) return unavailable(target.providerId, target.modelId)
      throw new Error("Plugin usage daemon error")
    }

    void response.body?.cancel().catch(() => {})
    throw new Error("Plugin usage unexpected status")
  } catch (error) {
    signal.throwIfAborted()
    if (quotaSignal.aborted) return unavailable(target.providerId, target.modelId)
    throw error
  }
}
