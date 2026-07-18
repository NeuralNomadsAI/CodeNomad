import type { UsageProvider } from "../types"
import {
  fetchJson,
  getAuthEntry,
  getCredential,
  notConfigured,
  resolveWindowLabel,
  safeFetch,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../shared"

const codexAliases = ["openai", "codex", "chatgpt"] as const
const codex: UsageProvider = {
  id: "codex",
  name: "Codex",
  aliases: codexAliases,
  async fetchQuota() {
    const entry = getAuthEntry(codexAliases)
    const token = entry && (typeof entry.access === "string" ? entry.access : typeof entry.token === "string" ? entry.token : null)
    if (!token) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const accountId = typeof entry?.accountId === "string" ? entry.accountId : null
      const payload = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
        },
      })
      const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
      for (const source of [payload?.rate_limit?.primary_window, payload?.rate_limit?.secondary_window]) {
        if (!source) continue
        const seconds = toNumber(source.limit_window_seconds)
        windows[resolveWindowLabel(seconds)] = toUsageWindow({
          usedPercent: toNumber(source.used_percent),
          windowSeconds: seconds,
          resetAt: toTimestamp(source.reset_at),
        })
      }
      return { windows }
    })
  },
}

const copilotAliases = ["github-copilot", "copilot"] as const
const copilot: UsageProvider = {
  id: "github-copilot",
  name: "GitHub Copilot",
  aliases: copilotAliases,
  async fetchQuota() {
    const token = getCredential(copilotAliases, ["access", "token"])
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
        const entitlement = toNumber(source.entitlement)
        const remaining = toNumber(source.remaining)
        windows[key] = toUsageWindow({
          usedPercent: entitlement && remaining !== null ? 100 - (remaining / entitlement) * 100 : null,
          resetAt,
          valueLabel: entitlement !== null && remaining !== null ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)}` : null,
        })
      }
      return { windows }
    })
  },
}

export const oauthProviders: UsageProvider[] = [codex, copilot]
