import { z } from "zod"
import type { ProviderUsageResponse, ProviderUsageWindow } from "../api-types"
import { locationRequestOptions } from "../opencode/compatibility/location"
import type { ServiceConnection } from "../workspaces/opencode-service"

export const PLUGIN_USAGE_RPC_PREFIX = "provider-usage."
export const PLUGIN_USAGE_RPC_METHOD = "read"
export const PLUGIN_USAGE_MAX_WINDOWS = 16

const RPC_PROVIDER_ID = /^[A-Za-z0-9._-]{1,128}$/
const CONTROL_CHARS = /[\x00-\x1f\x7f]/
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

const displayText = (max: number) =>
  z.string().trim().min(1).max(max).refine(value => !CONTROL_CHARS.test(value))

const canonicalWindowKey = z.string().min(1).max(64).refine(value =>
  value === value.trim() && !CONTROL_CHARS.test(value) && !FORBIDDEN_KEYS.has(value),
)

const finite = z.number().refine(Number.isFinite)
const roundPercent = (value: number) => Math.round(value * 100) / 100
const percent = finite.refine(value => value >= 0 && value <= 100).transform(roundPercent)

const pluginWindowSchema = z.object({
  usedPercent: percent.nullable().optional(),
  remainingPercent: percent.nullable().optional(),
  windowSeconds: finite.refine(value => value >= 0).nullable().optional(),
  resetAt: finite.refine(value => value > 0).nullable().optional(),
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
    || Math.abs(item.usedPercent + item.remainingPercent - 100) <= 0.05,
)

const pluginUsageOutputSchema = z.object({
  providerName: displayText(128).optional(),
  configured: z.boolean(),
  ok: z.boolean(),
  fetchedAt: finite.refine(value => value > 0).optional(),
  windows: z.record(canonicalWindowKey, pluginWindowSchema)
    .refine(record => Object.keys(record).length <= PLUGIN_USAGE_MAX_WINDOWS),
})

export function pluginUsageRpcId(providerId: string): string | null {
  const id = providerId.trim()
  if (!RPC_PROVIDER_ID.test(id) || id.includes("..")) return null
  return `${PLUGIN_USAGE_RPC_PREFIX}${id}`
}

export type PluginUsageErrorKind = "absent" | "registered" | "failure"

export function classifyPluginUsageError(error: unknown): PluginUsageErrorKind {
  if (!error || typeof error !== "object") return "failure"
  const record = error as { _tag?: unknown; type?: unknown; name?: unknown; reason?: unknown; error?: unknown }
  if (record._tag === "RpcError") {
    if (record.type === "rpc.unavailable" || record.type === "rpc.method_not_found") return "absent"
    return typeof record.type === "string" && record.type.length > 0 ? "registered" : "failure"
  }
  if (record._tag === "RpcInternalError") return "registered"
  if (record._tag !== undefined) return "failure"
  if (record.name === "ClientError") {
    return record.reason === "UnsupportedContentType" ? "absent" : "failure"
  }
  if (error instanceof Error && record.name === "Error") {
    const ownKeys = Object.keys(record)
    if (ownKeys.length === 0 && error.message === "") return "absent"
    const type = typeof record.type === "string" ? record.type.toLowerCase() : undefined
    const detail = [error.message, typeof record.error === "string" ? record.error : ""]
      .join(" ").trim().toLowerCase()
    if (type === "not_found" || detail.includes("not found") || detail === "404") return "absent"
  }
  return "failure"
}

export function parsePluginUsageOutput(
  raw: unknown,
  context: { requestedProviderId: string; providerId: string; modelId?: string; now?: () => number },
): ProviderUsageResponse | null {
  const rawWindows = raw && typeof raw === "object" && "windows" in raw
    ? (raw as { windows?: unknown }).windows
    : undefined
  if (rawWindows && typeof rawWindows === "object" && !Array.isArray(rawWindows)
    && Object.keys(rawWindows).some(key => FORBIDDEN_KEYS.has(key))) {
    return null
  }
  const parsed = pluginUsageOutputSchema.safeParse(raw)
  if (!parsed.success) return null
  const data = parsed.data
  const windows: Record<string, ProviderUsageWindow> = {}
  if (data.ok) {
    for (const [label, item] of Object.entries(data.windows)) {
      const usedPercent = item.usedPercent ?? (item.remainingPercent != null ? roundPercent(100 - item.remainingPercent) : null)
      const remainingPercent = usedPercent != null ? roundPercent(100 - usedPercent) : null
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
    ok: data.ok,
    windows,
    fetchedAt: data.fetchedAt ?? (context.now ?? Date.now)(),
  }
}

function unavailable(providerId: string, modelId?: string): ProviderUsageResponse {
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

export async function readPluginProviderUsage(
  connection: Pick<ServiceConnection, "client">,
  target: { providerId: string; location: { directory: string; workspaceID?: string }; modelId?: string },
  signal: AbortSignal,
  quotaSignal: AbortSignal = signal,
): Promise<ProviderUsageResponse | null> {
  const rpcID = pluginUsageRpcId(target.providerId)
  if (!rpcID) return null
  const providerId = target.providerId.trim()
  try {
    quotaSignal.throwIfAborted()
    const pending = connection.client.rpc.call(
      {
        rpcID,
        method: PLUGIN_USAGE_RPC_METHOD,
        input: target.modelId ? { modelId: target.modelId } : {},
        location: { directory: target.location.directory },
      },
      { ...locationRequestOptions(target.location), signal: quotaSignal },
    )
    pending.catch(() => {})
    const response = await awaitBounded(pending, quotaSignal)
    signal.throwIfAborted()
    if (quotaSignal.aborted) return unavailable(target.providerId, target.modelId)
    return parsePluginUsageOutput(response.output, {
      requestedProviderId: target.providerId,
      providerId,
      modelId: target.modelId,
    }) ?? unavailable(target.providerId, target.modelId)
  } catch (error) {
    signal.throwIfAborted()
    if (quotaSignal.aborted) return unavailable(target.providerId, target.modelId)
    const kind = classifyPluginUsageError(error)
    if (kind === "registered") return unavailable(target.providerId, target.modelId)
    if (kind === "absent") return null
    throw error
  }
}
