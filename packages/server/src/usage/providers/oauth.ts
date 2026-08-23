import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { UsageProvider } from "../types"
import {
  decodeJwtClaims,
  fetchJson,
  getAuthEntry,
  getCredential,
  getString,
  notConfigured,
  oauthTokenNeedsRefresh,
  resolveWindowLabel,
  safeFetch,
  toNumber,
  toTimestamp,
  toUsageWindow,
  writeOpenCodeAuthEntry,
} from "../shared"
import type { AuthEntry } from "../types"

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
let codexRefreshPromise: Promise<AuthEntry> | null = null

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

async function refreshCodexOauth(entry: AuthEntry): Promise<AuthEntry> {
  if (!codexRefreshPromise) {
    codexRefreshPromise = (async () => {
      const refreshToken = getString(entry.refresh)
      if (!refreshToken) throw new Error("OpenAI OAuth entry has no refresh token")
      const response = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_CLIENT_ID }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`OpenAI OAuth refresh failed with HTTP ${response.status}`)
      const payload = await response.json() as Record<string, unknown>
      const access = getString(payload.access_token)
      if (!access) throw new Error("OpenAI OAuth refresh returned no access token")
      const expiresIn = Number(payload.expires_in ?? 3600)
      if (!Number.isFinite(expiresIn)) throw new Error("OpenAI OAuth refresh returned an invalid expiry")
      const refreshed: AuthEntry = {
        ...entry,
        type: "oauth",
        access,
        refresh: getString(payload.refresh_token) ?? refreshToken,
        expires: Date.now() + expiresIn * 1000,
      }
      writeOpenCodeAuthEntry("openai", refreshed)
      return refreshed
    })().finally(() => { codexRefreshPromise = null })
  }
  return codexRefreshPromise
}

export function parseCodexUsage(payload: any) {
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
  if (payload?.credits) {
    const balance = toNumber(payload.credits.balance)
    const valueLabel = payload.credits.unlimited ? "Unlimited" : balance === null ? null : `$${balance.toFixed(2)}`
    windows.credits_balance = toUsageWindow({ usedPercent: null, valueLabel })
  }
  if (payload?.spend_control?.individual_limit) {
    const limit = payload.spend_control.individual_limit
    const used = toNumber(limit.used)
    const maximum = toNumber(limit.limit)
    windows.credits = toUsageWindow({
      usedPercent: toNumber(limit.used_percent),
      valueLabel: used !== null && maximum !== null ? `${used.toFixed(0)} / ${maximum.toFixed(0)} used` : null,
    })
  }
  return { windows }
}

const codexAliases = ["openai", "codex", "chatgpt"] as const
const codex: UsageProvider = {
  id: "codex",
  name: "Codex",
  aliases: codexAliases,
  async fetchQuota() {
    const entries = [getAuthEntry(codexAliases), getCodexCliAuthEntry()].filter((entry): entry is AuthEntry => Boolean(entry))
    const entry = entries.find((candidate) => !oauthTokenNeedsRefresh(candidate)) ?? entries[0]
    if (!entry || (!getString(entry.access) && !getString(entry.token) && !getString(entry.refresh))) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const fresh = entry.type === "oauth" && oauthTokenNeedsRefresh(entry) ? await refreshCodexOauth(entry) : entry
      const token = getString(fresh.access) ?? getString(fresh.token)
      if (!token) throw new Error("OpenAI OAuth entry has no access token")
      const accountId = getString(fresh.accountId) ?? getString(decodeJwtClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id)
      const payload = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
        },
      })
      return parseCodexUsage(payload)
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
