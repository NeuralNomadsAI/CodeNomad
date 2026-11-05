import type { UsageProvider } from "../types"
import { fetchBoundedJson, parseQuotaBaseURL } from "../bounded-fetch"
import {
  asObject,
  fetchJson,
  getCredential,
  notConfigured,
  ProviderHttpError,
  result,
  resolveWindowLabel,
  safeFetch,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../shared"

const kimiAliases = ["kimi-for-coding", "kimi"] as const
const kimi: UsageProvider = {
  id: "kimi-for-coding",
  name: "Kimi for Coding",
  aliases: kimiAliases,
  async fetchQuota(auth) {
    const key = getCredential(auth, kimiAliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload = await fetchJson("https://api.kimi.com/coding/v1/usages", {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      })
      const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
      const usage = payload?.usage
      if (usage) {
        const limit = toNumber(usage.limit)
        const remaining = toNumber(usage.remaining)
        windows.weekly = toUsageWindow({
          usedPercent: limit && remaining !== null ? 100 - (remaining / limit) * 100 : null,
          resetAt: toTimestamp(usage.resetTime),
        })
      }
      for (const item of Array.isArray(payload?.limits) ? payload.limits : []) {
        const duration = toNumber(item?.window?.duration)
        const unit = item?.window?.timeUnit
        const multiplier = unit === "TIME_UNIT_MINUTE" ? 60 : unit === "TIME_UNIT_HOUR" ? 3600 : unit === "TIME_UNIT_DAY" ? 86_400 : null
        const seconds = duration !== null && multiplier ? duration * multiplier : null
        const limit = toNumber(item?.detail?.limit)
        const remaining = toNumber(item?.detail?.remaining)
        windows[resolveWindowLabel(seconds)] = toUsageWindow({
          usedPercent: limit && remaining !== null ? 100 - (remaining / limit) * 100 : null,
          windowSeconds: seconds,
          resetAt: toTimestamp(item?.detail?.resetTime),
        })
      }
      return { windows }
    })
  },
}

const nanoAliases = ["nano-gpt", "nanogpt", "nano_gpt"] as const
const nanoGpt: UsageProvider = {
  id: "nano-gpt",
  name: "NanoGPT",
  aliases: nanoAliases,
  async fetchQuota(auth) {
    const key = getCredential(auth, nanoAliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload = await fetchJson("https://nano-gpt.com/api/subscription/v1/usage", {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      })
      const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
      for (const [label, source] of [["daily", payload?.daily], ["monthly", payload?.monthly]] as const) {
        if (!source) continue
        const fraction = toNumber(source.percentUsed)
        const used = toNumber(source.used)
        const limit = toNumber(source.limit ?? source.limits?.[label])
        windows[label] = toUsageWindow({
          usedPercent: fraction !== null ? fraction * 100 : used !== null && limit ? (used / limit) * 100 : null,
          windowSeconds: label === "daily" ? 86_400 : null,
          resetAt: toTimestamp(source.resetAt ?? payload?.period?.currentPeriodEnd),
        })
      }
      return { windows }
    })
  },
}

const openRouterAliases = ["openrouter"] as const
const openRouter: UsageProvider = {
  id: "openrouter",
  name: "OpenRouter",
  aliases: openRouterAliases,
  async fetchQuota(auth, context) {
    const key = context?.settings?.apiKey ?? getCredential(auth, openRouterAliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    // An unreadable native configuration cannot authorize the public fallback.
    if (context?.settingsStatus === "unavailable" || context?.settingsStatus === "unresolved") {
      return result(this.id, this.name, { ok: false, configured: true, unavailableReason: "provider-error" })
    }
    const base = parseQuotaBaseURL(context?.settings?.baseURL ?? "https://openrouter.ai/api/v1")
    if (!base) return result(this.id, this.name, { ok: false, configured: true, unavailableReason: "invalid-base-url" })
    const baseURL = base.href.replace(/\/+$/, "")
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
    const signal = context?.signal ?? AbortSignal.timeout(15_000)
    return safeFetch(this.id, this.name, async () => {
      const data = asObject(asObject(await fetchBoundedJson(`${baseURL}/key`, headers, signal))?.data)
      const limit = toNumber(data?.limit)
      const remaining = toNumber(data?.limit_remaining)
      if (!data || (data.limit !== null && (limit === null || limit < 0))) throw new Error("Invalid key quota")
      const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
      if (limit !== null) {
        windows.key_limit = {
          ...toUsageWindow({ usedPercent: remaining === null ? null : limit > 0 ? ((limit - remaining) / limit) * 100 : 100 }),
          ...(remaining !== null ? { balanceUSD: { remaining: Math.max(0, remaining), total: limit } } : {}),
        }
      }
      // Account credits require a management key; failure leaves the key limit usable.
      const creditsSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
      const credits = asObject(asObject(await fetchBoundedJson(`${baseURL}/credits`, headers, creditsSignal).catch(() => null))?.data)
      const total = toNumber(credits?.total_credits)
      const used = toNumber(credits?.total_usage)
      if (total !== null && total >= 0 && used !== null && used >= 0) windows.credits = {
        ...toUsageWindow({ usedPercent: total > 0 ? (used / total) * 100 : null }),
        balanceUSD: { remaining: Math.max(0, total - used), total },
      }
      signal.throwIfAborted()
      return { windows }
    })
  },
}

const CREDIT_LIMIT_TYPE = "CREDIT_LIMIT"
const UNIT_SECONDS: Record<number, number> = { 3: 3_600, 6: 604_800 }

function unitWindowSeconds(unit: unknown, count: number | null): number | null {
  const unitSeconds = typeof unit === "number" ? UNIT_SECONDS[unit] : undefined
  return unitSeconds !== undefined && count !== null ? unitSeconds * count : null
}

function createTokenLimitProvider(input: { id: string; name: string; aliases: readonly string[]; url: string }): UsageProvider {
  return {
    id: input.id,
    name: input.name,
    aliases: input.aliases,
    async fetchQuota(auth, context) {
      const key = context?.settings?.apiKey ?? getCredential(auth, input.aliases, ["key", "token"])
      if (!key) return notConfigured(this.id, this.name)
      try {
        const payload = asObject(await fetchBoundedJson(input.url,
          { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, context?.signal))
        if (payload?.success === false || (payload?.code !== undefined && toNumber(payload.code) !== 200)) {
          const code = String(payload?.code)
          return result(this.id, this.name, { ok: false, configured: true, unavailableReason: "provider-error",
            ...(/^\d{1,8}$/.test(code) ? { providerErrorCode: code } : {}) })
        }
        const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
        for (const limit of Array.isArray(payload?.data?.limits) ? payload.data.limits : []) {
          const number = toNumber(limit?.number)
          if (limit && (limit.type === "TOKENS_LIMIT" || limit.type === "TIME_LIMIT")) {
            const usedPercent = toNumber(limit.percentage)
            if (usedPercent === null) continue
            const seconds = limit.type === "TIME_LIMIT" ? 30 * 86_400 : unitWindowSeconds(limit.unit, number)
            const label = limit.type === "TIME_LIMIT" ? "mcp-tools" : resolveWindowLabel(seconds)
            windows[label] = toUsageWindow({
              usedPercent,
              windowSeconds: seconds,
              resetAt: toTimestamp(limit.nextResetTime),
            })
          } else if (limit && limit.type === CREDIT_LIMIT_TYPE) {
            const usedPercent = toNumber(limit.percentage)
            const remaining = toNumber(limit.remaining)
            const allowance = toNumber(limit.usage)
            const consumed = toNumber(limit.currentValue) ?? (allowance !== null && remaining !== null ? allowance - remaining : null)
            const percent = usedPercent ?? (allowance !== null && allowance > 0 && consumed !== null ? (consumed / allowance) * 100 : null)
            if (percent === null) continue
            const seconds = unitWindowSeconds(limit.unit, number)
            windows[resolveWindowLabel(seconds)] = toUsageWindow({
              usedPercent: percent,
              windowSeconds: seconds,
              resetAt: toTimestamp(limit.nextResetTime),
            })
          }
        }
        if (!Object.keys(windows).length) return result(this.id, this.name, {
          ok: false, configured: true, unavailableReason: "provider-error",
        })
        return result(this.id, this.name, { ok: true, configured: true, usage: { windows } })
      } catch (error) {
        return result(this.id, this.name, { ok: false, configured: true,
          ...(error instanceof ProviderHttpError ? { status: error.status } : { unavailableReason: "provider-error" as const }) })
      }
    },
  }
}

const zai = createTokenLimitProvider({
  id: "zai-coding-plan",
  name: "z.ai",
  aliases: ["zai-coding-plan", "zai", "z.ai"],
  url: "https://api.z.ai/api/monitor/usage/quota/limit",
})

const zhipu = createTokenLimitProvider({
  id: "zhipuai-coding-plan",
  name: "Zhipu AI Coding Plan",
  aliases: ["zhipuai-coding-plan", "zhipuai", "zhipu"],
  url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
})

const waferAliases = ["wafer", "wafer-ai", "wafer_ai", "wafer.ai"] as const
const wafer: UsageProvider = {
  id: "wafer",
  name: "Wafer.ai",
  aliases: waferAliases,
  async fetchQuota(auth) {
    const key = getCredential(auth, waferAliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload = await fetchJson("https://pass.wafer.ai/v1/inference/quota", {
        headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
      })
      const remaining = toNumber(payload?.remaining_included_requests)
      const limit = toNumber(payload?.included_request_limit)
      const startAt = toTimestamp(payload?.window_start)
      const resetAt = toTimestamp(payload?.window_end)
      const seconds = startAt !== null && resetAt !== null ? Math.round((resetAt - startAt) / 1000) : 5 * 3600
      return {
        windows: {
          [resolveWindowLabel(seconds)]: toUsageWindow({
            usedPercent: toNumber(payload?.current_period_used_percent),
            windowSeconds: seconds,
            resetAt,
            valueLabel: remaining !== null && limit !== null ? `${remaining} / ${limit}` : null,
          }),
        },
      }
    })
  },
}

export const apiKeyProviders: UsageProvider[] = [kimi, nanoGpt, openRouter, zai, zhipu, wafer]
