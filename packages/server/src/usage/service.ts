import { createHash } from "node:crypto"
import type { ProviderUsageResponse, ProviderUsageWindow } from "../api-types"
import { apiKeyProviders } from "./providers/api-key"
import { creditProviders } from "./providers/credits"
import { extraProviders } from "./providers/extra"
import { miniMaxProviders } from "./providers/minimax"
import { oauthProviders } from "./providers/oauth"
import { specialProviders } from "./providers/special"
import { xaiProviders } from "./providers/xai"
import type { AuthFile, ProviderReadContext, ProviderResult, UsageProvider } from "./types"

const CACHE_TTL_MS = 60_000
const FAILURE_CACHE_TTL_MS = 5_000
const providers = [
  ...oauthProviders, ...apiKeyProviders, ...miniMaxProviders, ...specialProviders, ...xaiProviders, ...extraProviders, ...creditProviders,
]
const registry = new Map<string, UsageProvider>()

for (const provider of providers) {
  registry.set(provider.id, provider)
  for (const alias of provider.aliases) registry.set(alias.toLowerCase(), provider)
}

// Keyed by provider; `identity` digests the credentials it may read, so a
// credential or account switch never serves another account's snapshot.
const cache = new Map<string, { identity: string; result: ProviderResult; expiresAt: number }>()
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
  const name = (model: string) => model.split("/").pop() ?? model
  const matched = entries.find(([model]) => normalizeModelId(name(model)) === target) ?? entries.find(([model]) => {
    const candidate = normalizeModelId(name(model))
    return candidate.includes(target) || target.includes(candidate)
  })
  if (!matched) return usage.windows
  if (!Object.keys(usage.windows).length) return matched[1].windows
  // Model-scoped limits (e.g. Claude's weekly Opus cap) add to the plan's
  // windows rather than hiding them; `window:Model` keeps both distinct.
  const scoped = Object.entries(matched[1].windows).map(([window, value]) => [`${window}:${name(matched[0])}`, value])
  return { ...usage.windows, ...Object.fromEntries(scoped) }
}

async function fetchProvider(provider: UsageProvider, auth: AuthFile, context?: ProviderReadContext): Promise<ProviderResult> {
  context?.signal?.throwIfAborted()
  const identity = createHash("sha256").update(JSON.stringify([
    provider.aliases.map(alias => auth[alias] ?? null),
    context?.settingsStatus ?? null, context?.settings?.baseURL ?? null, context?.settings?.apiKey ?? null,
  ])).digest("hex")
  const cached = cache.get(provider.id)
  if (cached?.identity === identity && cached.expiresAt > Date.now()) return cached.result
  const key = `${provider.id}\0${identity}`
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const request = provider.fetchQuota(auth, context).then((result) => {
    context?.signal?.throwIfAborted()
    cache.set(provider.id, { identity, result, expiresAt: Date.now() + (result.ok ? CACHE_TTL_MS : FAILURE_CACHE_TTL_MS) })
    return result
  }).finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

export async function getProviderUsage(
  requestedProviderId: string,
  options: { modelId?: string; auth?: AuthFile; context?: ProviderReadContext } = {},
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
  const result = await fetchProvider(provider, options.auth ?? {}, options.context)
  options.context?.signal?.throwIfAborted()
  const reason = !result.ok && (result.unavailableReason === "openai-token-sharing-unsupported" || result.unavailableReason === "provider-error" || result.unavailableReason === "minimax-limits-not-shared" || result.unavailableReason === "invalid-base-url")
    ? result.unavailableReason : undefined
  return {
    requestedProviderId,
    providerId: provider.id,
    providerName: result.providerName,
    modelId: options.modelId,
    supported: true,
    configured: result.configured,
    ok: result.ok,
    windows: result.ok ? selectModelWindows(result, options.modelId) : {},
    fetchedAt: result.fetchedAt,
    ...(reason ? { unavailableReason: reason } : {}),
    ...(reason === "provider-error" && typeof result.providerErrorCode === "string" && /^\d{1,8}$/.test(result.providerErrorCode) && result.providerErrorCode.trim() === result.providerErrorCode
      ? { providerErrorCode: result.providerErrorCode } : {}),
    ...(reason === "openai-token-sharing-unsupported" && result.unavailableAction === "chatgpt-usage"
      ? { unavailableAction: result.unavailableAction } : {}),
  }
}

export function clearProviderUsageCache(): void {
  cache.clear()
}
