import type { ProviderUsageResponse, ProviderUsageWindow } from "../api-types"
import { apiKeyProviders } from "./providers/api-key"
import { extraProviders } from "./providers/extra"
import { miniMaxProviders } from "./providers/minimax"
import { oauthProviders } from "./providers/oauth"
import { specialProviders } from "./providers/special"
import { xaiProviders } from "./providers/xai"
import type { ProviderResult, UsageProvider } from "./types"

const CACHE_TTL_MS = 60_000
const FAILURE_CACHE_TTL_MS = 5_000
const providers = [...oauthProviders, ...apiKeyProviders, ...miniMaxProviders, ...specialProviders, ...xaiProviders, ...extraProviders]
const registry = new Map<string, UsageProvider>()

for (const provider of providers) {
  registry.set(provider.id, provider)
  for (const alias of provider.aliases) registry.set(alias.toLowerCase(), provider)
}

const cache = new Map<string, { result: ProviderResult; expiresAt: number }>()
const pending = new Map<string, Promise<ProviderResult>>()

export function resolveUsageProvider(providerId: string): UsageProvider | null {
  return registry.get(providerId.trim().toLowerCase()) ?? null
}

function normalizeModelId(value: string): string {
  return value.toLowerCase().replace(/^models\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export function selectModelWindows(result: ProviderResult, modelId?: string): Record<string, ProviderUsageWindow> {
  const usage = result.usage
  if (!usage) return {}
  if (!modelId || !usage.models) return usage.windows
  const target = normalizeModelId(modelId)
  const entries = Object.entries(usage.models)
  const exact = entries.find(([name]) => normalizeModelId(name.split("/").pop() ?? name) === target)
  if (exact) return exact[1].windows
  const partial = entries.find(([name]) => {
    const candidate = normalizeModelId(name.split("/").pop() ?? name)
    return candidate.includes(target) || target.includes(candidate)
  })
  return partial?.[1].windows ?? usage.windows
}

async function fetchProvider(provider: UsageProvider): Promise<ProviderResult> {
  const cached = cache.get(provider.id)
  if (cached && cached.expiresAt > Date.now()) return cached.result
  const inFlight = pending.get(provider.id)
  if (inFlight) return inFlight
  const request = provider.fetchQuota().then((result) => {
    cache.set(provider.id, { result, expiresAt: Date.now() + (result.ok ? CACHE_TTL_MS : FAILURE_CACHE_TTL_MS) })
    return result
  }).finally(() => pending.delete(provider.id))
  pending.set(provider.id, request)
  return request
}

export async function getProviderUsage(
  requestedProviderId: string,
  options: { modelId?: string } = {},
): Promise<ProviderUsageResponse> {
  const provider = resolveUsageProvider(requestedProviderId)
  if (!provider) {
    return {
      requestedProviderId,
      providerId: null,
      providerName: requestedProviderId,
      modelId: options.modelId,
      supported: false,
      configured: false,
      ok: false,
      windows: {},
      fetchedAt: Date.now(),
    }
  }
  const result = await fetchProvider(provider)
  return {
    requestedProviderId,
    providerId: provider.id,
    providerName: result.providerName,
    modelId: options.modelId,
    supported: true,
    configured: result.configured,
    ok: result.ok,
    windows: selectModelWindows(result, options.modelId),
    fetchedAt: result.fetchedAt,
  }
}

export function clearProviderUsageCache(): void {
  cache.clear()
}
