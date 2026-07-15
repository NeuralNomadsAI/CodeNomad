import type { UsageProvider } from "../types"
import { fetchJson, getString, notConfigured, safeFetch, toNumber, toTimestamp, toUsageWindow } from "../shared"

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

async function resolveCursorToken(): Promise<string | null> {
  const accessToken = getString(process.env.CURSOR_ACCESS_TOKEN) ?? getString(process.env.CURSOR_TOKEN)
  const refreshToken = getString(process.env.CURSOR_REFRESH_TOKEN)
  const expiresAt = accessToken ? decodeJwtExpiration(accessToken) : null
  if (accessToken && (!expiresAt || expiresAt > Date.now() + 5 * 60_000)) return accessToken
  if (!refreshToken) return accessToken
  const payload = await fetchJson("https://api2.cursor.sh/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB", refresh_token: refreshToken }),
  })
  return getString(payload?.access_token)
}

async function cursorPost(url: string, token: string): Promise<any> {
  return fetchJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: "{}",
  })
}

const cursor: UsageProvider = {
  id: "cursor",
  name: "Cursor",
  aliases: ["cursor"],
  async fetchQuota() {
    const token = await resolveCursorToken().catch(() => null)
    if (!token) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const usage = await cursorPost("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", token)
      const plan = await cursorPost("https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo", token).catch(() => null)
      const source = usage?.planUsage ?? {}
      const limit = toNumber(source.limit)
      const remaining = toNumber(source.remaining)
      const explicit = toNumber(source.totalPercentUsed)
      const resetAt = toTimestamp(usage?.billingCycleEnd ?? plan?.planInfo?.billingCycleEnd)
      return {
        windows: {
          billing_cycle: toUsageWindow({
            usedPercent: explicit ?? (limit && remaining !== null ? ((limit - remaining) / limit) * 100 : null),
            resetAt,
            valueLabel: toNumber(source.totalSpend) !== null ? `$${(toNumber(source.totalSpend)! / 100).toFixed(2)}` : null,
          }),
        },
      }
    })
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

const openCodeGo: UsageProvider = {
  id: "opencode-go",
  name: "OpenCode Go",
  aliases: ["opencode-go", "opencode"],
  async fetchQuota() {
    const workspaceId = getString(process.env.OPENCODE_GO_WORKSPACE_ID)
    const authCookie = getString(process.env.OPENCODE_GO_AUTH_COOKIE)
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
