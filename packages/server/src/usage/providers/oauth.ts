import type { UsageProvider } from "../types"
import {
  fetchJson,
  getOAuthEntry,
  getString,
  notConfigured,
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
const copilot: UsageProvider = {
  id: "github-copilot",
  name: "GitHub Copilot",
  aliases: copilotAliases,
  async fetchQuota(auth) {
    const entry = getOAuthEntry(auth, copilotAliases)
    const token = getString(entry?.access) ?? getString(entry?.token)
    if (!token) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload = await fetchJson("https://api.github.com/copilot_internal/user", {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          "Editor-Version": "vscode/1.96.2",
          "X-Github-Api-Version": "2025-04-01",
        },
      })
      const resetAt = toTimestamp(payload?.quota_reset_date)
      const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
      for (const [key, snapshot] of Object.entries({
        chat: payload?.quota_snapshots?.chat,
        completions: payload?.quota_snapshots?.completions,
        premium: payload?.quota_snapshots?.premium_interactions,
      })) {
        if (!snapshot) continue
        const source = snapshot as Record<string, unknown>
        if (source.unlimited === true) {
          windows[key] = toUsageWindow({ usedPercent: null, resetAt, valueLabel: "Unlimited" })
          continue
        }
        const entitlement = toNumber(source.entitlement)
        const remaining = toNumber(source.remaining)
        const counted = entitlement !== null && entitlement > 0 && remaining !== null
        // Same fallback as VS Code Copilot Chat: percent_remaining is server-computed.
        const percentRemaining = toNumber(source.percent_remaining)
        if (!counted && percentRemaining === null) continue
        windows[key] = toUsageWindow({
          usedPercent: counted ? 100 - (remaining / entitlement) * 100 : 100 - percentRemaining!,
          resetAt,
          valueLabel: counted ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)}` : null,
        })
      }
      if (!Object.keys(windows).length) throw new Error("GitHub Copilot usage response contained no quota data")
      return { windows }
    })
  },
}

export const oauthProviders: UsageProvider[] = [codex, copilot]
