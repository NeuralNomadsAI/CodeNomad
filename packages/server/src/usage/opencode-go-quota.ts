import type { ProviderUsageWindow } from "../api-types"
import { fetchBoundedJson } from "./bounded-fetch"
import { asObject, ProviderHttpError, toNumber, toTimestamp, toUsageWindow } from "./shared"
import type { ProviderUsage } from "./types"

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
export const OPENCODE_GO_CONSOLE_URL = "https://opencode.ai/console/api/go/status"
export const OPENCODE_GO_BILLING_URL = "https://opencode.ai/console/api/billing/status"
const WINDOWS = [
  { label: "5h", seconds: 18_000, names: ["rolling", "rollingUsage"] },
  { label: "weekly", seconds: 604_800, names: ["weekly", "weeklyUsage"] },
  { label: "monthly", seconds: 2_592_000, names: ["monthly", "monthlyUsage"] },
] as const

export interface OpenCodeGoAuth {
  /** Go API key, Console service-account key or Console OAuth access token. */
  token: string
  orgID?: string
  consoleOAuth?: true
}

// The endpoint is unversioned. Accept the current `usage.{rolling,weekly,monthly}`
// windows ({ status, percent, resetsAt }) and the older `*Usage` objects
// ({ usagePercent, resetInSec }). A declared but malformed window, an unknown
// status or an empty payload is not evidence: the whole read becomes unknown.
export function parseOpenCodeGoQuota(payload: unknown, now = Date.now()): ProviderUsage {
  const root = asObject(payload)
  const containers = [asObject(root?.usage), root].filter((value): value is Record<string, any> => Boolean(value))
  const windows: Record<string, ProviderUsageWindow> = {}
  for (const window of WINDOWS) {
    let source: unknown
    for (const container of containers) {
      const name = window.names.find(name => container[name] !== undefined && container[name] !== null)
      if (name) { source = container[name]; break }
    }
    if (source === undefined) continue
    const value = asObject(source)
    if (!value) throw new Error("Quota unavailable")
    const status = value.status
    if (status !== undefined && status !== "ok" && status !== "rate-limited") throw new Error("Quota unavailable")
    const percent = toNumber(value.percent ?? value.usagePercent)
    if (percent === null || percent < 0) throw new Error("Quota unavailable")
    let resetAt: number | null = null
    if (value.resetsAt !== undefined && value.resetsAt !== null) {
      resetAt = toTimestamp(value.resetsAt)
      if (resetAt === null) throw new Error("Quota unavailable")
    } else if (value.resetInSec !== undefined && value.resetInSec !== null) {
      const seconds = toNumber(value.resetInSec)
      if (seconds === null || seconds < 0) throw new Error("Quota unavailable")
      resetAt = now + seconds * 1000
    }
    windows[window.label] = toUsageWindow({
      usedPercent: status === "rate-limited" ? 100 : percent, windowSeconds: window.seconds, resetAt,
    })
  }
  if (!Object.keys(windows).length) throw new Error("Quota unavailable")
  return { windows }
}

// Console money is a decimal micro-cent string; reject unsafe magnitudes and malformed values.
function microCents(value: unknown): number | null {
  if (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value)) return null
  const amount = toNumber(value)
  return amount !== null && Math.abs(amount) <= Number.MAX_SAFE_INTEGER ? amount : null
}

function parseOpenCodeGoConsoleQuota(payload: unknown): ProviderUsage {
  const meters = asObject(asObject(asObject(payload)?.access)?.meters)
  const windows: ProviderUsage["windows"] = {}
  for (const [name, label, seconds] of [["fiveHour", "5h", 18_000], ["week", "weekly", 604_800], ["month", "monthly", 2_592_000]] as const) {
    if (meters?.[name] === undefined || meters[name] === null) continue
    const meter = asObject(meters?.[name])
    if (!meter) throw new Error("Quota unavailable")
    const used = microCents(meter.usedMicroCents), limit = microCents(meter.limitMicroCents)
    if (used === null || used < 0 || limit === null || limit <= 0) throw new Error("Quota unavailable")
    const resetAt = toTimestamp(meter.resetsAt)
    if (meter.resetsAt !== undefined && meter.resetsAt !== null && resetAt === null) throw new Error("Quota unavailable")
    windows[label] = toUsageWindow({ usedPercent: used / limit * 100, windowSeconds: seconds, resetAt })
  }
  return { windows }
}

// Server-only: Console OAuth uses workspace scope; API keys read only their Go quota endpoint.
export async function fetchOpenCodeGoQuota(auth: OpenCodeGoAuth, signal: AbortSignal): Promise<ProviderUsage> {
  const headers = {
    Authorization: `Bearer ${auth.token}`, Accept: "application/json",
    ...(auth.orgID ? { "x-org-id": auth.orgID } : {}),
  }
  if (auth.consoleOAuth) {
    if (!auth.orgID) throw new Error("Quota unavailable")
    const usage = parseOpenCodeGoConsoleQuota(await fetchBoundedJson(OPENCODE_GO_CONSOLE_URL, headers, signal))
    try {
      const billing = asObject(await fetchBoundedJson(OPENCODE_GO_BILLING_URL, headers, signal))
      const balance = microCents(billing?.availableMicroCents)
      if (balance !== null) usage.windows.credits_balance = { ...toUsageWindow({ usedPercent: null }), balanceUSD: { remaining: balance / 100_000_000 } }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ProviderHttpError && error.status === 401) throw error
      // A missing billing permission preserves the independently readable plan quota.
    }
    if (!Object.keys(usage.windows).length) throw new Error("Quota unavailable")
    return usage
  }
  const payload = await fetchBoundedJson(OPENCODE_GO_USAGE_URL, headers, signal, undefined, { errorCodes: ["api_key_expired"] })
  return parseOpenCodeGoQuota(payload)
}
