import type { ProviderUsage, UsageProvider } from "../types"
import {
  asObject,
  fetchJson,
  formatMoney,
  getAuthEntry,
  getCredential,
  getString,
  notConfigured,
  safeFetch,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../shared"

const balance = (value: number, prefix = "$") => toUsageWindow({
  usedPercent: null,
  valueLabel: `${value < 0 ? "-" : ""}${prefix}${formatMoney(Math.abs(value))}`,
})

function bearer(key: string, extra: Record<string, string> = {}): RequestInit {
  return { headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...extra } }
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("No quota data in response")
  return value
}

// Rolling five-hour, rolling weekly and calendar-month limits.
const CLINE_WINDOWS: Record<string, { key: string; seconds: number | null }> = {
  five_hour: { key: "5h", seconds: 5 * 3600 },
  weekly: { key: "weekly", seconds: 7 * 86_400 },
  monthly: { key: "monthly", seconds: null },
}

export function parseClinePassUsage(payload: unknown): ProviderUsage {
  const windows: ProviderUsage["windows"] = {}
  const limits = asObject(asObject(payload)?.data)?.limits
  for (const item of Array.isArray(limits) ? limits : []) {
    const limit = asObject(item)
    const kind = CLINE_WINDOWS[String(limit?.type)]
    const usedPercent = toNumber(limit?.percentUsed)
    if (!kind || usedPercent === null) continue
    windows[kind.key] = toUsageWindow({ usedPercent, windowSeconds: kind.seconds, resetAt: toTimestamp(limit?.resetsAt) })
  }
  if (!Object.keys(windows).length) throw new Error("No quota data in response")
  return { windows }
}

const clinePass: UsageProvider = {
  id: "cline-pass",
  name: "ClinePass",
  aliases: ["cline-pass"],
  async fetchQuota(auth) {
    const key = getCredential(auth, this.aliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () =>
      parseClinePassUsage(await fetchJson("https://api.cline.bot/api/v1/users/me/plan/usage-limits", bearer(key))))
  },
}

const deepInfra: UsageProvider = {
  id: "deepinfra",
  name: "DeepInfra",
  aliases: ["deepinfra", "deep-infra", "deep_infra"],
  async fetchQuota(auth) {
    const key = getCredential(auth, this.aliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload = await fetchJson("https://api.deepinfra.com/v1/me?checklist=true", bearer(key))
      // Negative when funds are available, positive when money is owed.
      const raw = payload?.checklist?.stripe_balance
      const stripeBalance = required(String(raw ?? "").trim() ? toNumber(raw) : null)
      return { windows: { credits_balance: balance(-stripeBalance) } }
    })
  },
}

const CHARM_CREDIT_USD = 0.05

const hyper: UsageProvider = {
  id: "hyper",
  name: "Charm Hyper",
  aliases: ["hyper"],
  async fetchQuota(auth) {
    const key = getCredential(auth, this.aliases, ["key", "token"])
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const credits = required(toNumber((await fetchJson("https://hyper.charm.land/v1/credits", bearer(key)))?.balance))
      return {
        windows: {
          credits_balance: balance(credits * CHARM_CREDIT_USD),
          credits: toUsageWindow({ usedPercent: null, valueLabel: Number.isInteger(credits) ? String(credits) : formatMoney(credits) }),
        },
      }
    })
  },
}

const kilo: UsageProvider = {
  id: "kilo",
  name: "Kilo Code",
  aliases: ["kilo", "kilocode", "kilo-code"],
  async fetchQuota(auth) {
    const key = getCredential(auth, this.aliases, ["key", "token", "access"])
    if (!key) return notConfigured(this.id, this.name)
    const entry = getAuthEntry(auth, this.aliases)
    const organization = getString(entry?.kilocodeOrganizationId) ?? getString(entry?.organizationId) ?? getString(entry?.accountId)
    return safeFetch(this.id, this.name, async () => {
      const payload = await fetchJson("https://api.kilo.ai/api/profile/balance",
        bearer(key, organization ? { "x-kilocode-organizationid": organization } : {}))
      return { windows: { credits_balance: balance(required(toNumber(payload?.balance))) } }
    })
  },
}

// The platform API key is separate from ZenMux's inference key, so OpenCode never holds it.
const zenMux: UsageProvider = {
  id: "zenmux",
  name: "ZenMux",
  aliases: ["zenmux"],
  async fetchQuota() {
    const key = getString(process.env.ZENMUX_PLATFORM_API_KEY)
    if (!key) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => {
      const payload = await fetchJson("https://zenmux.ai/api/v1/management/payg/balance", bearer(key))
      return { windows: { credits_balance: balance(required(toNumber(payload?.data?.total_credits))) } }
    })
  },
}

export function parseExeDevUsage(payload: unknown): ProviderUsage {
  const data = asObject(payload)
  const spent = required(toNumber(data?.total_cost_usd))
  const allowance = required(toNumber(data?.monthly_allowance_usd))
  const resetAt = required(toTimestamp(data?.period_end))
  if (allowance < 0) throw new Error("No quota data in response")
  return {
    windows: {
      monthly: toUsageWindow({
        usedPercent: allowance > 0 ? (spent / allowance) * 100 : null,
        resetAt,
        valueLabel: `$${formatMoney(spent)} / $${formatMoney(allowance)}`,
      }),
    },
  }
}

// exe.dev usage tokens are issued outside OpenCode.
const exeDev: UsageProvider = {
  id: "exe-dev",
  name: "exe.dev",
  aliases: ["exe-dev"],
  async fetchQuota() {
    const token = getString(process.env.EXE_DEV_USAGE_TOKEN)
    if (!token) return notConfigured(this.id, this.name)
    return safeFetch(this.id, this.name, async () => parseExeDevUsage(await fetchJson("https://exe.dev/exec", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "text/plain" },
      body: "billing credits usage --group=day --json",
    })))
  },
}

export const creditProviders: UsageProvider[] = [clinePass, deepInfra, hyper, kilo, zenMux, exeDev]
