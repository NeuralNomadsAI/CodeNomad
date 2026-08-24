import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { UsageProvider } from "../types"
import {
  decodeJwtClaims,
  fetchJson,
  getCredential,
  getOAuthEntry,
  getString,
  notConfigured,
  oauthTokenNeedsRefresh,
  resolveWindowLabel,
  safeFetch,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../shared"
import type { AuthEntry } from "../types"

const CODEX_REAUTH_ERROR = "Codex session expired. Reconnect it in OpenCode or Codex CLI."

function getCodexCliAuthEntry(): AuthEntry | null {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json")
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { tokens?: Record<string, unknown> }
    const tokens = parsed.tokens
    if (!tokens || typeof tokens !== "object") return null
    const access = getString(tokens.access_token)
    const refresh = getString(tokens.refresh_token)
    if (!access && !refresh) return null
    return { type: "oauth", access, refresh, accountId: getString(tokens.account_id) }
  } catch {
    return null
  }
}

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
    const entries: AuthEntry[] = []
    const openCode = getOAuthEntry(codexAliases)
    if (openCode) entries.push(openCode)
    const codexCli = getCodexCliAuthEntry()
    if (codexCli) entries.push(codexCli)
    if (!entries.length) return notConfigured(this.id, this.name)
    entries.sort((left, right) =>
      Number(oauthTokenNeedsRefresh(left)) - Number(oauthTokenNeedsRefresh(right)))
    return safeFetch(this.id, this.name, async () => {
      let lastError: unknown
      for (const [index, entry] of entries.entries()) {
        if (oauthTokenNeedsRefresh(entry)) {
          lastError = new Error(CODEX_REAUTH_ERROR)
          continue
        }
        const token = getString(entry.access) ?? getString(entry.token)
        if (!token) {
          lastError = new Error("OpenAI OAuth entry has no access token")
          continue
        }
        try {
          const accountId = getString(entry.accountId) ?? getString(decodeJwtClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id)
          const payload = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
            },
          })
          return parseCodexUsage(payload)
        } catch (error) {
          lastError = error
          if (index === entries.length - 1 || !(error instanceof Error) || !/HTTP (401|403)\b/.test(error.message)) throw error
        }
      }
      throw lastError instanceof Error ? lastError : new Error("OpenAI OAuth credentials failed")
    })
  },
}

const copilotAliases = ["github-copilot", "copilot"] as const
const copilot: UsageProvider = {
  id: "github-copilot",
  name: "GitHub Copilot",
  aliases: copilotAliases,
  async fetchQuota() {
    const entry = getOAuthEntry(copilotAliases)
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
        const entitlement = toNumber(source.entitlement)
        const remaining = toNumber(source.remaining)
        if (entitlement === null || entitlement <= 0 || remaining === null) continue
        windows[key] = toUsageWindow({
          usedPercent: entitlement && remaining !== null ? 100 - (remaining / entitlement) * 100 : null,
          resetAt,
          valueLabel: entitlement !== null && remaining !== null ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)}` : null,
        })
      }
      if (!Object.keys(windows).length) throw new Error("GitHub Copilot usage response contained no quota data")
      return { windows }
    })
  },
}

export const oauthProviders: UsageProvider[] = [codex, copilot]
