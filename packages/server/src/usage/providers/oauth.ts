import type { ProviderUsage, UsageProvider } from "../types"
import { fetchBoundedJson, parseQuotaBaseURL } from "../bounded-fetch"
import {
  asObject,
  getOAuthEntry,
  getString,
  notConfigured,
  result,
  resolveWindowLabel,
  safeFetch,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../shared"

export function parseCodexUsage(payload: any) {
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
  for (const source of [payload?.rate_limit?.primary_window, payload?.rate_limit?.secondary_window]) {
    if (!source) continue
    const seconds = toNumber(source.limit_window_seconds)
    const usedPercent = toNumber(source.used_percent)
    if (usedPercent === null) continue
    windows[resolveWindowLabel(seconds)] = toUsageWindow({
      usedPercent,
      windowSeconds: seconds,
      resetAt: toTimestamp(source.reset_at),
    })
  }
  if (payload?.credits?.unlimited === true || toNumber(payload?.credits?.balance) !== null) {
    const balance = toNumber(payload.credits.balance)
    const valueLabel = payload.credits.unlimited ? "Unlimited" : balance === null ? null : `$${balance.toFixed(2)}`
    windows.credits_balance = toUsageWindow({ usedPercent: null, valueLabel })
  }
  if (payload?.spend_control?.individual_limit) {
    const limit = payload.spend_control.individual_limit
    const used = toNumber(limit.used)
    const maximum = toNumber(limit.limit)
    const usedPercent = toNumber(limit.used_percent)
    if (usedPercent !== null || (used !== null && maximum !== null)) {
      windows.credits = toUsageWindow({
        usedPercent,
        valueLabel: used !== null && maximum !== null ? `${used.toFixed(0)} / ${maximum.toFixed(0)} used` : null,
      })
    }
  }
  if (!Object.keys(windows).length) throw new Error("Codex usage response contained no quota data")
  return { windows }
}

const codexAliases = ["openai", "codex", "chatgpt"] as const
const codex: UsageProvider = {
  id: "codex",
  name: "Codex",
  aliases: codexAliases,
  async fetchQuota() {
    // Subscription usage requires an owned session and selected native connection.
    // The route uses native-codex.ts; unscoped callers must never read host auth.
    return notConfigured(this.id, this.name)
  },
}

const copilotAliases = ["github-copilot", "copilot"] as const

function copilotEndpoint(enterpriseUrl: unknown): string | null {
  if (enterpriseUrl === undefined) return "https://api.github.com/copilot_internal/user"
  if (typeof enterpriseUrl !== "string") return null
  // Validate the raw authority before URL normalization can discard ports or paths.
  if (!/^(?:https:\/\/)?[a-z0-9.-]+\/?$/i.test(enterpriseUrl)) return null
  const url = parseQuotaBaseURL(/^https:\/\//i.test(enterpriseUrl) ? enterpriseUrl : `https://${enterpriseUrl}`)
  if (!url) return null
  const endpoint = parseQuotaBaseURL(`https://api.${url.hostname}/copilot_internal/user`)
  return endpoint?.href ?? null
}

function copilotPlan(payload: Record<string, any>): ProviderUsage["copilotPlan"] {
  if (payload.access_type_sku === "free_limited_copilot") return "free"
  if (payload.access_type_sku === "free_educational_quota") return "student"
  const plans: Record<string, NonNullable<ProviderUsage["copilotPlan"]>> = {
    individual: "pro", individual_pro: "proPlus", individual_max: "max", individual_edu: "student",
    business: "business", enterprise: "enterprise",
  }
  return typeof payload.copilot_plan === "string" && Object.prototype.hasOwnProperty.call(plans, payload.copilot_plan)
    ? plans[payload.copilot_plan] : undefined
}

const copilot: UsageProvider = {
  id: "github-copilot",
  name: "GitHub Copilot",
  aliases: copilotAliases,
  async fetchQuota(auth, context) {
    const entry = getOAuthEntry(auth, copilotAliases)
    const token = getString(entry?.access) ?? getString(entry?.token)
    if (!token) return notConfigured(this.id, this.name)
    const endpoint = copilotEndpoint(entry?.enterpriseUrl)
    if (!endpoint) return result(this.id, this.name, { ok: false, configured: true, unavailableReason: "invalid-base-url" })
    return safeFetch(this.id, this.name, async () => {
      const payload = asObject(await fetchBoundedJson(endpoint, {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "X-Github-Api-Version": "2025-04-01",
      }, context?.signal))
      const resetAt = toTimestamp(payload?.quota_reset_date_utc) ?? toTimestamp(payload?.quota_reset_date)
        ?? toTimestamp(payload?.limited_user_reset_date)
      const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
      for (const [key, snapshot] of Object.entries({
        chat: payload?.quota_snapshots?.chat,
        completions: payload?.quota_snapshots?.completions,
        premium: payload?.quota_snapshots?.premium_interactions,
      })) {
        if (!snapshot) continue
        const source = asObject(snapshot)
        if (!source) continue
        const snapshotReset = toTimestamp(toNumber(source.quota_reset_at)) ?? resetAt
        if (source.unlimited === true) {
          const creditsUsed = toNumber(source.credits_used)
          windows[key] = { ...toUsageWindow({ usedPercent: null, resetAt: snapshotReset }),
            consumption: source.has_quota !== false && creditsUsed !== null && creditsUsed >= 0
              ? { creditsUsed } : { unlimited: true } }
          continue
        }
        const entitlement = toNumber(source.entitlement)
        if (entitlement === 0) continue
        const remaining = toNumber(source.quota_remaining)
        const counted = entitlement !== null && entitlement > 0 && remaining !== null && remaining >= 0
        const percentRemaining = toNumber(source.percent_remaining)
        if (!counted && percentRemaining === null) continue
        const usedPercent = percentRemaining !== null ? 100 - percentRemaining : 100 - (remaining! / entitlement!) * 100
        // quota_remaining shares entitlement's basis; credits_used is an unmetered pool count.
        windows[key] = { ...toUsageWindow({ usedPercent, resetAt: snapshotReset }),
          ...(entitlement !== null && entitlement > 0 ? { consumption: {
            used: Math.max(0, counted ? entitlement - remaining! : entitlement * usedPercent / 100), limit: entitlement,
          } } : {}) }
      }
      if (!Object.keys(windows).length) throw new Error("GitHub Copilot usage response contained no quota data")
      return { windows, ...(payload ? { copilotPlan: copilotPlan(payload) } : {}) }
    })
  },
}

export const oauthProviders: UsageProvider[] = [codex, copilot]
