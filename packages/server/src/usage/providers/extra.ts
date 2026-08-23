import type { ProviderUsage, UsageProvider } from "../types"
import {
  asObject,
  fetchJson,
  getAuthEntry,
  getCredential,
  getString,
  notConfigured,
  result,
  safeFetch,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../shared"

const formatMoney = (value: number | null): string | null =>
  value === null || !Number.isFinite(value) ? null : value.toFixed(2)

// --- command-code ---
type CommandCodeCredits = {
  credits?: { monthlyCredits?: number; purchasedCredits?: number; freeCredits?: number }
  windowLimits?: {
    fiveHour?: { used?: number; cap?: number; resetAt?: number }
    weekly?: { used?: number; cap?: number; resetAt?: number }
  }
}
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const formatCredits = (value: number): string => String(Math.round((value + Number.EPSILON) * 100) / 100)
const parseCredits = (value: unknown): CommandCodeCredits | null =>
  value && typeof value === "object" ? (value as CommandCodeCredits) : null
const parseOrgId = (value: unknown): string | null | undefined => {
  if (!value || typeof value !== "object") return undefined
  const org = (value as { org?: { id?: unknown } }).org
  return typeof org?.id === "string" && org.id.trim() ? org.id.trim() : null
}
const parseCommandCodeCredits = (payload: CommandCodeCredits) => {
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
  for (const [label, value] of [
    ["monthly_credits", payload.credits?.monthlyCredits],
    ["purchased_credits", payload.credits?.purchasedCredits],
    ["free_credits", payload.credits?.freeCredits],
  ] as const) {
    if (isFiniteNumber(value)) windows[label] = toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: formatCredits(value) })
  }
  for (const [label, limit, seconds] of [
    ["5h", payload.windowLimits?.fiveHour, 5 * 60 * 60],
    ["weekly", payload.windowLimits?.weekly, 7 * 24 * 60 * 60],
  ] as const) {
    if (!isFiniteNumber(limit?.used) || !isFiniteNumber(limit.cap) || limit.cap <= 0) continue
    const resetAt = isFiniteNumber(limit.resetAt) ? (limit.resetAt < 1_000_000_000_000 ? limit.resetAt * 1000 : limit.resetAt) : null
    windows[label] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, (limit.used / limit.cap) * 100)),
      windowSeconds: seconds,
      resetAt,
      valueLabel: `${formatCredits(limit.used)} / ${formatCredits(limit.cap)}`,
    })
  }
  return windows
}
const requestJson = async (path: string, apiKey: string): Promise<unknown> => {
  const response = await fetch(`https://api.commandcode.ai${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 401 || response.status === 403) throw new Error("Command Code authentication failed")
  if (!response.ok) throw new Error(`Command Code usage API returned HTTP ${response.status}`)
  return response.json().catch(() => null)
}

const commandCodeAliases = ["command-code"] as const
const commandCode: UsageProvider = {
  id: "command-code",
  name: "Command Code",
  aliases: commandCodeAliases,
  async fetchQuota() {
    const key = getCredential(commandCodeAliases, ["key", "access", "token"]) ?? getString(process.env.COMMAND_CODE_API_KEY)
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const orgId = parseOrgId(await requestJson("/alpha/whoami", key))
      if (orgId === undefined) throw new Error("Command Code account could not be determined")
      const creditsPath = orgId ? `/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}` : "/alpha/billing/credits"
      const payload = parseCredits(await requestJson(creditsPath, key))
      if (!payload) throw new Error("Command Code usage data could not be parsed")
      const windows = parseCommandCodeCredits(payload)
      if (!Object.keys(windows).length) throw new Error("Command Code usage data could not be parsed")
      return { windows }
    })
  },
}

// --- crof ---
const crofAliases = ["crof"] as const
const crof: UsageProvider = {
  id: "crof",
  name: "CrofAI",
  aliases: crofAliases,
  async fetchQuota() {
    const key = getCredential(crofAliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload: any = await fetchJson("https://crof.ai/usage_api/", {
        headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
      })
      const credits = toNumber(payload?.credits)
      return {
        windows: {
          credits: toUsageWindow({
            usedPercent: null,
            windowSeconds: null,
            resetAt: null,
            valueLabel: credits !== null ? `$${formatMoney(credits)}` : null,
          }),
        },
      }
    })
  },
}

// --- deepseek ---
const deepseekAliases = ["deepseek"] as const
const deepseek: UsageProvider = {
  id: "deepseek",
  name: "DeepSeek",
  aliases: deepseekAliases,
  async fetchQuota() {
    const key = getCredential(deepseekAliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload: any = await fetchJson("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
      })
      const balanceInfos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
      const balanceInfo =
        balanceInfos.find((info: any) => info?.currency === "USD") ??
        balanceInfos.find((info: any) => info?.currency === "CNY") ??
        null
      const rawBalance = balanceInfo?.total_balance
      const totalBalance =
        typeof rawBalance === "number" || (typeof rawBalance === "string" && rawBalance.trim() !== "")
          ? toNumber(rawBalance)
          : null
      if (totalBalance === null) throw new Error("No quota data in response")
      const symbol = balanceInfo?.currency === "CNY" ? "¥" : "$"
      return {
        windows: {
          credits_balance: toUsageWindow({
            usedPercent: null,
            windowSeconds: null,
            resetAt: null,
            valueLabel: `${symbol}${formatMoney(totalBalance)}`,
          }),
        },
      }
    })
  },
}

// --- neuralwatt ---
const neuralwattWindowSeconds = (period: string | null | undefined): number | null => {
  if (period === "daily") return 86_400
  if (period === "weekly") return 604_800
  if (period === "monthly" || period === "month") return 30 * 86_400
  if (period === "yearly" || period === "year") return 365 * 86_400
  return null
}
const neuralwattAliases = ["neuralwatt"] as const
const neuralwatt: UsageProvider = {
  id: "neuralwatt",
  name: "NeuralWatt",
  aliases: neuralwattAliases,
  async fetchQuota() {
    const key = getCredential(neuralwattAliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload: any = await fetchJson("https://api.neuralwatt.com/v1/quota", {
        headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
      })
      const subscription = payload?.subscription ?? null
      const inOverage = Boolean(subscription?.in_overage)
      const allowance = payload?.key?.allowance ?? null
      const keyName = payload?.key?.name ?? null
      const creditsRemaining = toNumber(payload?.balance?.credits_remaining_usd)
      const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
      if (subscription) {
        const kwhIncluded = toNumber(subscription.kwh_included)
        const kwhUsed = toNumber(subscription.kwh_used)
        const plan = typeof subscription.plan === "string" && subscription.plan.trim() ? subscription.plan.trim() : null
        const subKey = plan ?? "plan_limit"
        const usedPercent = inOverage
          ? 100
          : kwhIncluded !== null && kwhIncluded > 0 && kwhUsed !== null
            ? Math.max(0, Math.min(100, (kwhUsed / kwhIncluded) * 100))
            : null
        const subResetAt = toTimestamp(subscription.kwh_reset_date) ?? toTimestamp(subscription.current_period_end)
        windows[subKey] = toUsageWindow({ usedPercent, windowSeconds: null, resetAt: subResetAt })
      }
      if (allowance) {
        const spent = toNumber(allowance.spent_usd)
        const limit = toNumber(allowance.limit_usd)
        const effectiveSpent = spent ?? 0
        const effectiveLimit =
          limit !== null && creditsRemaining !== null ? Math.min(limit, creditsRemaining + effectiveSpent) : (limit ?? creditsRemaining)
        const period = typeof allowance.period === "string" && allowance.period.trim() ? allowance.period.trim() : null
        const blocked = Boolean(allowance.blocked)
        const usedPercent = blocked
          ? 100
          : spent !== null && effectiveLimit !== null && effectiveLimit > 0
            ? Math.max(0, Math.min(100, (spent / effectiveLimit) * 100))
            : null
        const periodKey =
          period === "daily" || period === "weekly" || period === "monthly" || period === "month"
            ? period === "month"
              ? "monthly"
              : period
            : "billing_cycle"
        const labelName = typeof keyName === "string" && keyName.trim() ? keyName.trim() : null
        const resetAt = toTimestamp(allowance.reset_at)
        const windowSeconds = period ? neuralwattWindowSeconds(period) : null
        windows[periodKey] = toUsageWindow({
          usedPercent,
          windowSeconds,
          resetAt,
          ...(labelName ? { valueLabel: labelName } : {}),
        })
      } else if (creditsRemaining !== null) {
        windows.credits_balance = toUsageWindow({
          usedPercent: null,
          windowSeconds: null,
          resetAt: null,
          valueLabel: `$${formatMoney(creditsRemaining)}`,
        })
      }
      if (!Object.keys(windows).length) throw new Error("No quota data in response")
      return { windows }
    })
  },
}

// --- claude ---
const CLAUDE_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000
const CLAUDE_MAX_COOLDOWN_MS = 60 * 60 * 1000
let claudeCredentialFingerprint: string | null = null
let claudeCachedUsage: ProviderUsage | null = null
let claudeCooldownUntil = 0

function claudeCooldownFromResponse(response: Response): number {
  const raw = response.headers.get("retry-after")
  const seconds = raw ? Number(raw) : Number.NaN
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, CLAUDE_MAX_COOLDOWN_MS)
  if (raw) {
    const retryAt = Date.parse(raw)
    if (Number.isFinite(retryAt) && retryAt > Date.now()) return Math.min(retryAt - Date.now(), CLAUDE_MAX_COOLDOWN_MS)
  }
  return CLAUDE_DEFAULT_COOLDOWN_MS
}

function buildClaudeRateLimitResult(): ProviderUsage | null {
  return claudeCachedUsage
}

function buildClaudeUsage(payload: Record<string, unknown>): ProviderUsage {
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
  const models: Record<string, ProviderUsage> = {}
  const limits = Array.isArray(payload.limits) ? payload.limits : []
  for (const entry of limits) {
    const limit = asObject(entry)
    if (!limit) continue
    const usedPercent = toNumber(limit.percent)
    const resetAt = toTimestamp(limit.resets_at)
    if (limit.kind === "session") {
      windows["5h"] = toUsageWindow({ usedPercent, windowSeconds: 5 * 60 * 60, resetAt })
    } else if (limit.kind === "weekly_all") {
      windows["7d"] = toUsageWindow({ usedPercent, windowSeconds: 7 * 24 * 60 * 60, resetAt })
    } else if (limit.kind === "weekly_scoped") {
      const modelName = getString(asObject(asObject(limit.scope)?.model)?.display_name)
      if (modelName) {
        models[modelName] = { windows: { "7d": toUsageWindow({ usedPercent, windowSeconds: 7 * 24 * 60 * 60, resetAt }) } }
      }
    }
  }
  if (!limits.length) {
    const fiveHour = asObject(payload.five_hour)
    const sevenDay = asObject(payload.seven_day)
    if (fiveHour) {
      windows["5h"] = toUsageWindow({
        usedPercent: toNumber(fiveHour.utilization),
        windowSeconds: 5 * 60 * 60,
        resetAt: toTimestamp(fiveHour.resets_at),
      })
    }
    if (sevenDay) {
      windows["7d"] = toUsageWindow({
        usedPercent: toNumber(sevenDay.utilization),
        windowSeconds: 7 * 24 * 60 * 60,
        resetAt: toTimestamp(sevenDay.resets_at),
      })
    }
  }
  const spend = asObject(payload.spend)
  if (spend?.enabled === true) {
    const usedMoney = asObject(spend.used)
    const limitMoney = asObject(spend.limit)
    const usedMinor = toNumber(usedMoney?.amount_minor)
    const limitMinor = toNumber(limitMoney?.amount_minor)
    const exponent = toNumber(usedMoney?.exponent) ?? 2
    const currency = getString(usedMoney?.currency)
    const prefix = currency === "USD" || !currency ? "$" : `${currency} `
    const used = usedMinor === null ? null : usedMinor / 10 ** exponent
    const limit = limitMinor === null ? null : limitMinor / 10 ** (toNumber(limitMoney?.exponent) ?? 2)
    windows.extra_usage = toUsageWindow({
      usedPercent: toNumber(spend.percent),
      windowSeconds: null,
      resetAt: null,
      valueLabel: used === null ? null : `${prefix}${formatMoney(used)}${limit === null ? "" : ` / ${prefix}${formatMoney(limit)}`}`,
    })
  }
  return Object.keys(models).length ? { windows, models } : { windows }
}

const claudeAliases = ["claude", "anthropic"] as const
const claude: UsageProvider = {
  id: "claude",
  name: "Claude",
  aliases: claudeAliases,
  async fetchQuota() {
    const entry = asObject(getAuthEntry(claudeAliases))
    const accessToken = getString(entry?.access) ?? getString(entry?.token)
    if (!accessToken) return notConfigured(this.id, this.name)
    const refreshToken = getString(entry?.refresh) ?? ""
    const fingerprint = `${accessToken}\0${refreshToken}`
    if (claudeCredentialFingerprint !== fingerprint) {
      claudeCredentialFingerprint = fingerprint
      claudeCachedUsage = null
      claudeCooldownUntil = 0
    }
    if (Date.now() < claudeCooldownUntil) {
      const cached = buildClaudeRateLimitResult()
      return cached
        ? result(this.id, this.name, { ok: true, configured: true, usage: cached })
        : result(this.id, this.name, { ok: false, configured: true, error: "Rate limited. Retrying soon." })
    }
    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 429) {
        claudeCooldownUntil = Date.now() + claudeCooldownFromResponse(response)
        const cached = buildClaudeRateLimitResult()
        return cached
          ? result(this.id, this.name, { ok: true, configured: true, usage: cached })
          : result(this.id, this.name, { ok: false, configured: true, error: "Rate limited. Retrying soon." })
      }
      if (response.status === 401 || response.status === 403) {
        return result(this.id, this.name, { ok: false, configured: true, error: "Claude session expired. Open Claude Code to sign in again." })
      }
      if (!response.ok) return result(this.id, this.name, { ok: false, configured: true, error: `API error: ${response.status}` })
      const payload = (await response.json()) as Record<string, unknown>
      const usage = buildClaudeUsage(payload)
      claudeCachedUsage = usage
      return result(this.id, this.name, { ok: true, configured: true, usage })
    } catch (error) {
      return result(this.id, this.name, { ok: false, configured: true, error: error instanceof Error ? error.message : "Request failed" })
    }
  },
}

// --- github-copilot-addon ---
function buildCopilotWindows(payload: Record<string, unknown>): Record<string, ReturnType<typeof toUsageWindow>> {
  const quota = asObject(payload.quota_snapshots) ?? {}
  const resetAt = toTimestamp(payload.quota_reset_date)
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
  const addWindow = (label: string, snapshot?: Record<string, unknown>) => {
    if (!snapshot) return
    const entitlement = toNumber(snapshot.entitlement)
    const remaining = toNumber(snapshot.remaining)
    const usedPercent =
      entitlement && remaining !== null ? Math.max(0, Math.min(100, 100 - (remaining / entitlement) * 100)) : null
    const valueLabel =
      entitlement !== null && remaining !== null ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)} left` : null
    windows[label] = toUsageWindow({ usedPercent, windowSeconds: null, resetAt, valueLabel })
  }
  addWindow("chat", asObject(quota.chat) ?? undefined)
  addWindow("completions", asObject(quota.completions) ?? undefined)
  addWindow("premium", asObject(quota.premium_interactions) ?? undefined)
  return windows
}

const copilotAddon: UsageProvider = {
  id: "github-copilot-addon",
  name: "GitHub Copilot Add-on",
  aliases: ["github-copilot-addon"],
  async fetchQuota() {
    const token = getCredential(["github-copilot", "copilot"], ["access", "token"])
    if (!token) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload: any = await fetchJson("https://api.github.com/copilot_internal/user", {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          "Editor-Version": "vscode/1.96.2",
          "X-Github-Api-Version": "2025-04-01",
        },
      })
      const windows = buildCopilotWindows(payload as Record<string, unknown>)
      const premium = windows.premium ? { premium: windows.premium } : windows
      return { windows: premium }
    })
  },
}

export const extraProviders: UsageProvider[] = [commandCode, crof, deepseek, neuralwatt, claude, copilotAddon]
