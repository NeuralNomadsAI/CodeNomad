import type { UsageProvider } from "../types"
import {
  fetchJson,
  getCredential,
  notConfigured,
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
  async fetchQuota() {
    const key = getCredential(kimiAliases, ["key", "token"])
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
  async fetchQuota() {
    const key = getCredential(nanoAliases, ["key", "token"])
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
  async fetchQuota() {
    const key = getCredential(openRouterAliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload = await fetchJson("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      })
      const total = toNumber(payload?.data?.total_credits)
      const used = toNumber(payload?.data?.total_usage)
      const remaining = total !== null && used !== null ? Math.max(0, total - used) : null
      return {
        windows: {
          credits: toUsageWindow({
            usedPercent: total && used !== null ? (used / total) * 100 : null,
            valueLabel: remaining !== null && total !== null ? `$${remaining.toFixed(2)} / $${total.toFixed(2)}` : null,
          }),
        },
      }
    })
  },
}

function createTokenLimitProvider(input: { id: string; name: string; aliases: readonly string[]; url: string }): UsageProvider {
  return {
    id: input.id,
    name: input.name,
    aliases: input.aliases,
    async fetchQuota() {
      const key = getCredential(input.aliases, ["key", "token"])
      if (!key) return notConfigured(this.id, this.name)
      return safeFetch(this.id, this.name, async () => {
        const payload = await fetchJson(input.url, { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } })
        const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
        for (const limit of Array.isArray(payload?.data?.limits) ? payload.data.limits : []) {
          const number = toNumber(limit?.number)
          if (limit && (limit.type === "TOKENS_LIMIT" || limit.type === "TIME_LIMIT")) {
            const seconds = limit.type === "TIME_LIMIT" ? 30 * 86_400 : limit.unit === 3 && number ? number * 3600 : null
            const label = limit.type === "TIME_LIMIT" ? "mcp-tools" : resolveWindowLabel(seconds)
            windows[label] = toUsageWindow({
              usedPercent: toNumber(limit.percentage),
              windowSeconds: seconds,
              resetAt: toTimestamp(limit.nextResetTime),
            })
          } else if (limit) {
            const usedPercent = toNumber(limit.percentage)
            const remaining = toNumber(limit.remaining)
            const allowance = toNumber(limit.usage)
            if (usedPercent === null && (remaining === null || allowance === null)) continue
            const seconds = limit.unit === 3 && number ? number * 3600 : null
            windows[resolveWindowLabel(seconds)] = toUsageWindow({
              usedPercent: usedPercent ?? (allowance !== null && allowance > 0 && remaining !== null ? ((allowance - remaining) / allowance) * 100 : null),
              windowSeconds: seconds,
              resetAt: toTimestamp(limit.nextResetTime),
            })
          }
        }
        return { windows }
      })
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
  async fetchQuota() {
    const key = getCredential(waferAliases, ["key", "token"])
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
