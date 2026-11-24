import { z } from "zod"
import type { ProviderUsageResponse, ProviderUsageWindow } from "../api-types"
import { locationRequestOptions } from "../opencode/compatibility/location"
import type { ServiceConnection } from "../workspaces/opencode-service"

export const PLUGIN_USAGE_RPC_PREFIX = "provider-usage."
export const PLUGIN_USAGE_RPC_METHOD = "read"
export const PLUGIN_USAGE_MAX_WINDOWS = 16

const RPC_PROVIDER_ID = /^[A-Za-z0-9._-]{1,128}$/
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

const displayText = (max: number) =>
  z.string().trim().min(1).max(max).refine(value => !CONTROL_CHARS.test(value))

const finite = z.number().refine(Number.isFinite)
const roundPercent = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 100) / 100
const percent = finite.transform(roundPercent)

const pluginWindowSchema = z.object({
  usedPercent: percent.nullable().optional(),
  remainingPercent: percent.nullable().optional(),
  windowSeconds: finite.refine(value => value >= 0).nullable().optional(),
  resetAt: finite.refine(value => value > 0).nullable().optional(),
  valueLabel: displayText(128).optional(),
  balanceUSD: z.object({ remaining: finite, total: finite.optional() }).strict().optional(),
  limitUSD: finite.refine(value => value >= 0).optional(),
  consumption: z.union([
    z.object({ used: finite.refine(value => value >= 0), limit: finite.refine(value => value >= 0).optional() }).strict(),
    z.object({ creditsUsed: finite.refine(value => value >= 0) }).strict(),
    z.object({ unlimited: z.literal(true) }).strict(),
  ]).optional(),
}).strict()

const pluginUsageOutputSchema = z.object({
  providerName: displayText(128).optional(),
  configured: z.boolean(),
  ok: z.boolean(),
  fetchedAt: finite.refine(value => value > 0).optional(),
  windows: z.record(displayText(64), pluginWindowSchema)
    .refine(record => Object.keys(record).length <= PLUGIN_USAGE_MAX_WINDOWS),
})

export function pluginUsageRpcId(providerId: string): string | null {
  const id = providerId.trim()
  if (!RPC_PROVIDER_ID.test(id) || id.includes("..")) return null
  return `${PLUGIN_USAGE_RPC_PREFIX}${id}`
}

export function isRegisteredPluginUsageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const record = error as { _tag?: unknown; type?: unknown }
  if (typeof record.type !== "string" || !record.type) return false
  if (record.type === "rpc.unavailable" || record.type === "rpc.method_not_found") return false
  return record._tag === "RpcError" || record._tag === "RpcInternalError" || record._tag === undefined
}

export function parsePluginUsageOutput(
  raw: unknown,
  context: { requestedProviderId: string; providerId: string; modelId?: string; now?: () => number },
): ProviderUsageResponse | null {
  const parsed = pluginUsageOutputSchema.safeParse(raw)
  if (!parsed.success) return null
  const data = parsed.data
  const windows: Record<string, ProviderUsageWindow> = {}
  if (data.ok) {
    for (const [label, item] of Object.entries(data.windows)) {
      const usedPercent = item.usedPercent ?? (item.remainingPercent != null ? roundPercent(100 - item.remainingPercent) : null)
      const remainingPercent = item.remainingPercent ?? (item.usedPercent != null ? roundPercent(100 - item.usedPercent) : null)
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
    const response = await connection.client.rpc.call(
      {
        rpcID,
        method: PLUGIN_USAGE_RPC_METHOD,
        input: target.modelId ? { modelId: target.modelId } : {},
        location: { directory: target.location.directory },
      },
      { ...locationRequestOptions(target.location), signal: quotaSignal },
    )
    signal.throwIfAborted()
    return parsePluginUsageOutput(response.output, {
      requestedProviderId: target.providerId,
      providerId,
      modelId: target.modelId,
    }) ?? unavailable(target.providerId, target.modelId)
  } catch (error) {
    signal.throwIfAborted()
    if (quotaSignal.aborted || isRegisteredPluginUsageError(error)) {
      return unavailable(target.providerId, target.modelId)
    }
    return null
  }
}
