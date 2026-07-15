import type { UsageProvider } from "../types"
import { fetchJson, getCredential, notConfigured, result, toNumber, toTimestamp, toUsageWindow } from "../shared"

const INACTIVE_WINDOW_STATUS = 3

function pickChatModel(models: any[]): any | null {
  return (
    models.find((model) => /^minimax-m/i.test(String(model?.model_name ?? "")) && (toNumber(model?.current_interval_total_count) ?? 0) > 0) ??
    models.find((model) => ["general", "chat", "text"].includes(String(model?.model_name ?? "").toLowerCase())) ??
    models.find((model) => toNumber(model?.current_interval_remaining_percent) !== null) ??
    models[0] ??
    null
  )
}

function isUsablePayload(payload: any): boolean {
  if (payload?.base_resp && payload.base_resp.status_code !== 0) return false
  return Array.isArray(payload?.model_remains) && payload.model_remains.length > 0
}

function usedPercent(model: any, prefix: "interval" | "weekly", tokenPlan: boolean): number | null {
  const remainingPercent = toNumber(model?.[`current_${prefix}_remaining_percent`])
  if (remainingPercent !== null) return 100 - remainingPercent
  const total = toNumber(model?.[`current_${prefix}_total_count`])
  const rawUsage = toNumber(model?.[`current_${prefix}_usage_count`])
  if (!total || rawUsage === null) return null
  const used = tokenPlan ? total - rawUsage : rawUsage
  return (Math.max(0, used) / total) * 100
}

function windowSeconds(model: any, prefix: "interval" | "weekly"): number | null {
  const startAt = toTimestamp(prefix === "interval" ? model?.start_time : model?.weekly_start_time)
  const resetAt = toTimestamp(prefix === "interval" ? model?.end_time : model?.weekly_end_time)
  if (startAt !== null && resetAt !== null && resetAt > startAt) return Math.floor((resetAt - startAt) / 1000)
  const remainsMs = toNumber(prefix === "interval" ? model?.remains_time : model?.weekly_remains_time)
  return remainsMs && remainsMs > 0 ? Math.floor(remainsMs / 1000) : null
}

function createMiniMaxProvider(input: {
  id: string
  name: string
  aliases: readonly string[]
  tokenPlanUrl: string
  codingPlanUrl: string
}): UsageProvider {
  return {
    id: input.id,
    name: input.name,
    aliases: input.aliases,
    async fetchQuota() {
      const key = getCredential(input.aliases, ["key", "token"])
      if (!key) return notConfigured(this.id, this.name)
      try {
        let tokenPlan = true
        let payload: any = null
        try {
          const tokenPayload = await fetchJson(input.tokenPlanUrl, { headers: { Authorization: `Bearer ${key}` } })
          if (isUsablePayload(tokenPayload)) payload = tokenPayload
        } catch {
          // Fall back to the legacy Coding Plan endpoint below.
        }
        if (!payload) {
          tokenPlan = false
          const codingPayload = await fetchJson(input.codingPlanUrl, { headers: { Authorization: `Bearer ${key}` } })
          if (isUsablePayload(codingPayload)) payload = codingPayload
        }
        if (!payload) throw new Error("Provider returned no usable quota data")
        const model = pickChatModel(Array.isArray(payload?.model_remains) ? payload.model_remains : [])
        if (!model) throw new Error("No model quota data available")
        const intervalResetAt = toTimestamp(model?.end_time)
        const windows: Record<string, ReturnType<typeof toUsageWindow>> = {
          "5h": toUsageWindow({
            usedPercent: usedPercent(model, "interval", tokenPlan),
            windowSeconds: windowSeconds(model, "interval"),
            resetAt: intervalResetAt,
          }),
        }
        const weeklyStatus = toNumber(model?.current_weekly_status)
        const hasWeekly = weeklyStatus !== INACTIVE_WINDOW_STATUS && (
          toNumber(model?.current_weekly_remaining_percent) !== null || (toNumber(model?.current_weekly_total_count) ?? 0) > 0
        )
        if (hasWeekly) {
          windows.weekly = toUsageWindow({
            usedPercent: usedPercent(model, "weekly", tokenPlan),
            windowSeconds: windowSeconds(model, "weekly"),
            resetAt: toTimestamp(model?.weekly_end_time),
          })
        }
        return result(this.id, this.name, { ok: true, configured: true, usage: { windows } })
      } catch (error) {
        return result(this.id, this.name, {
          ok: false,
          configured: true,
          error: error instanceof Error ? error.message : "Request failed",
        })
      }
    },
  }
}

export const miniMaxProviders: UsageProvider[] = [
  createMiniMaxProvider({
    id: "minimax-coding-plan",
    name: "MiniMax Coding Plan",
    aliases: ["minimax-coding-plan", "minimax"],
    tokenPlanUrl: "https://api.minimax.io/v1/token_plan/remains",
    codingPlanUrl: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  }),
  createMiniMaxProvider({
    id: "minimax-cn-coding-plan",
    name: "MiniMax Coding Plan CN",
    aliases: ["minimax-cn-coding-plan", "minimaxi"],
    tokenPlanUrl: "https://api.minimaxi.com/v1/token_plan/remains",
    codingPlanUrl: "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
  }),
]
