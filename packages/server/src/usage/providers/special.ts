import type { AuthFile, ProviderUsage, UsageProvider } from "../types"
import { asObject, getAuthEntry, getString, notConfigured, oauthTokenNeedsRefresh, ProviderHttpError, result, safeFetch, toNumber, toTimestamp, toUsageWindow } from "../shared"
import { fetchOpenCodeGoQuota, type OpenCodeGoAuth } from "../opencode-go-quota"
import { fetchBoundedJson } from "../bounded-fetch"

function decodeJwtExpiration(token: string): number | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return typeof parsed?.exp === "number" ? parsed.exp * 1000 : null
  } catch {
    return null
  }
}

const cursor: UsageProvider = {
  id: "cursor",
  name: "Cursor",
  aliases: ["cursor"],
  async fetchQuota(_auth, context) {
    const token = getString(process.env.CURSOR_ACCESS_TOKEN) ?? getString(process.env.CURSOR_TOKEN)
    if (!token) return notConfigured(this.id, this.name)
    const expiresAt = decodeJwtExpiration(token)
    if (expiresAt !== null && expiresAt <= Date.now() + 5 * 60_000) {
      return result(this.id, this.name, {
        ok: false,
        configured: true,
        error: "Cursor access token expired. Provide a current CURSOR_ACCESS_TOKEN or CURSOR_TOKEN.",
        unavailableReason: "cursor-token-expired",
      })
    }
    const timeout = AbortSignal.timeout(15_000)
    const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout
    let failedStatus: number | undefined
    const read = async (path: string, body?: object) => asObject(await fetchBoundedJson(`https://api2.cursor.sh/${path}`, {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json", "Connect-Protocol-Version": "1" } : {}),
    }, signal, undefined, body ? { method: "POST", body: JSON.stringify(body) } : {}))
    const optional = async (path: string, body?: object) => {
      try { return await read(path, body) } catch (error) {
        signal.throwIfAborted()
        if (error instanceof ProviderHttpError) {
          if (error.status === 401) throw error
          failedStatus = error.status
        }
        return null
      }
    }
    try {
      const usage = await optional("aiserver.v1.DashboardService/GetCurrentPeriodUsage", {})
      const source = asObject(usage?.planUsage) ?? {}
      const limit = toNumber(source.limit)
      const remaining = toNumber(source.remaining)
      const explicit = toNumber(source.totalPercentUsed)
      const spend = toNumber(source.totalSpend)
      if (explicit !== null || (limit !== null && remaining !== null) || spend !== null) {
        const plan = await optional("aiserver.v1.DashboardService/GetPlanInfo", {})
        return result(this.id, this.name, { ok: true, configured: true, usage: { windows: {
          billing_cycle: toUsageWindow({
            usedPercent: explicit ?? (limit && remaining !== null ? ((limit - remaining) / limit) * 100 : null),
            resetAt: toTimestamp(usage?.billingCycleEnd ?? plan?.planInfo?.billingCycleEnd),
            valueLabel: spend !== null ? `$${(spend / 100).toFixed(2)}` : null,
          }),
        } } })
      }
      // Private dashboard endpoints: preserve only independently identifiable meters.
      const profile = await read("auth/full_stripe_profile")
      const teamId = toNumber(profile?.teamId)
      const teamMember = profile?.isTeamMember === true || getString(profile?.membershipType)?.toLowerCase() === "enterprise" || teamId !== null
      if (teamMember && !(teamId !== null && Number.isSafeInteger(teamId) && teamId > 0)) {
        return result(this.id, this.name, { ok: false, configured: true, unavailableReason: "cursor-team-unavailable" })
      }
      if (teamMember && teamId !== null) {
        const requests = await optional("auth/usage")
        const hardLimit = await optional("aiserver.v1.DashboardService/GetHardLimit", { teamId })
        const windows: ProviderUsage["windows"] = {}
        // gpt-4 is the corroborated legacy bucket; other bucket semantics stay unknown.
        const bucket = asObject(requests?.["gpt-4"])
        const used = toNumber(bucket?.numRequests)
        const max = toNumber(bucket?.maxRequestUsage)
        if (used !== null && used >= 0) windows["requests:gpt-4"] = {
          ...toUsageWindow({ usedPercent: max !== null && max > 0 ? used / max * 100 : null }),
          consumption: { used, ...(max !== null && max >= 0 ? { limit: max } : {}) },
        }
        for (const [label, value] of [["per_user_limit", hardLimit?.hardLimitPerUser], ["team_limit", hardLimit?.hardLimit]] as const) {
          const amount = toNumber(value)
          if (amount !== null && amount >= 0) windows[label] = { ...toUsageWindow({ usedPercent: null }), limitUSD: amount }
        }
        if (Object.keys(windows).length) return result(this.id, this.name, { ok: true, configured: true, usage: { windows } })
      }
      return result(this.id, this.name, { ok: false, configured: true, status: failedStatus,
        unavailableReason: failedStatus === 403 ? "cursor-access-denied" : "cursor-usage-unavailable" })
    } catch (error) {
      const status = error instanceof ProviderHttpError ? error.status : undefined
      return result(this.id, this.name, { ok: false, configured: true, status,
        unavailableReason: status === 401 ? "cursor-token-expired" : status === 403 ? "cursor-access-denied" : "cursor-usage-unavailable" })
    }
  },
}

function parseOllamaUsage(html: string) {
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
  for (const [label, pattern] of [
    ["session", /Session\s+usage[^0-9]*([0-9.]+)%/i],
    ["weekly", /Weekly\s+usage[^0-9]*([0-9.]+)%/i],
  ] as const) {
    const match = html.match(pattern)
    if (match) windows[label] = toUsageWindow({ usedPercent: toNumber(match[1]) })
  }
  const premium = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i)
  if (premium) {
    const used = toNumber(premium[1])
    const total = toNumber(premium[2])
    windows.premium = toUsageWindow({
      usedPercent: total && used !== null ? (used / total) * 100 : null,
      valueLabel: used !== null && total !== null ? `${used} / ${total}` : null,
    })
  }
  return windows
}

const ollamaCloud: UsageProvider = {
  id: "ollama-cloud",
  name: "Ollama Cloud",
  aliases: ["ollama-cloud", "ollamacloud"],
  async fetchQuota() {
    const cookie = getString(process.env.OLLAMA_CLOUD_COOKIE)
    if (!cookie) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const response = await fetch("https://ollama.com/settings", {
        headers: { Cookie: cookie, "User-Agent": "CodeNomad usage provider" },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`)
      const windows = parseOllamaUsage(await response.text())
      if (Object.keys(windows).length === 0) throw new Error("No usage data available")
      return { windows }
    })
  },
}

function parseOpenCodeGoUsage(html: string, now = Date.now()) {
  const normalized = html.replace(/&quot;|&#34;|\\u0022|\\"/g, '"')
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
  for (const [label, field] of Object.entries({ "5h": "rollingUsage", weekly: "weeklyUsage", monthly: "monthlyUsage" })) {
    const match = normalized.match(new RegExp(`["']?${field}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`, "s"))
    if (!match) continue
    const capture = (name: string) => toNumber(match[1]?.match(new RegExp(`["']?${name}["']?\\s*:\\s*["']?(-?\\d+(?:\\.\\d+)?)`))?.[1])
    const usedPercent = capture("usagePercent")
    const resetInSec = capture("resetInSec")
    if (usedPercent !== null && resetInSec !== null) {
      windows[label] = toUsageWindow({ usedPercent, resetAt: now + Math.max(0, resetInSec) * 1000 })
    }
  }
  return windows
}

// The selected native Go key or OpenCode Console credential, without refreshing
// tokens. Self-hosted Console credentials (keys or tokens) are never sent to opencode.ai.
export function openCodeGoAuth(auth: AuthFile): OpenCodeGoAuth | null {
  const entry = getAuthEntry(auth, ["opencode-go", "opencode"])
  if (!entry) return null
  if (entry.server !== undefined) {
    const server = getString(entry.server)
    try { if (!server || new URL(server).origin !== "https://opencode.ai") return null } catch { return null }
  }
  const orgID = getString(entry.orgId)
  const scope = orgID ? { orgID } : {}
  if (entry.type === "api") {
    const key = getString(entry.key)
    return key ? { token: key, ...scope } : null
  }
  if (entry.type !== "oauth" || oauthTokenNeedsRefresh(entry)) return null
  const access = getString(entry.access)
  return access ? { token: access, ...scope, consoleOAuth: true } : null
}

const openCodeGo: UsageProvider = {
  id: "opencode-go",
  name: "OpenCode Go",
  aliases: ["opencode-go", "opencode"],
  async fetchQuota(auth, context) {
    const workspaceId = getString(process.env.OPENCODE_GO_WORKSPACE_ID)
    const authCookie = getString(process.env.OPENCODE_GO_AUTH_COOKIE)
    const native = openCodeGoAuth(auth)
    if (native) {
      const timeout = AbortSignal.timeout(15_000)
      const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout
      try {
        return result(this.id, this.name, { ok: true, configured: true, usage: await fetchOpenCodeGoQuota(native, signal) })
      } catch (error) {
        const expired = error instanceof ProviderHttpError && error.status === 401 && error.code === "api_key_expired"
        return result(this.id, this.name, { ok: false, configured: true,
          ...(error instanceof ProviderHttpError ? { status: error.status } : {}),
          ...(expired ? { unavailableReason: "opencode-go-key-expired", unavailableAction: "opencode-go-new-key" } : {}),
        })
      }
    }
    if (!workspaceId || !authCookie) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const response = await fetch(`https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`, {
        headers: { Cookie: `auth=${authCookie.replace(/^auth=/, "")}`, "User-Agent": "CodeNomad usage provider" },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`)
      const windows = parseOpenCodeGoUsage(await response.text())
      if (Object.keys(windows).length === 0) throw new Error("No usage data available")
      return { windows }
    })
  },
}

export const specialProviders: UsageProvider[] = [cursor, ollamaCloud, openCodeGo]
