import type { ProviderUsageWindow } from "../api-types"
import { fetchBoundedJson } from "./bounded-fetch"
import { asObject, toNumber, toTimestamp, toUsageWindow } from "./shared"
import type { ProviderUsage } from "./types"

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const WINDOWS = [
  { label: "5h", seconds: 18_000, names: ["rolling", "rollingUsage"] },
  { label: "weekly", seconds: 604_800, names: ["weekly", "weeklyUsage"] },
  { label: "monthly", seconds: 2_592_000, names: ["monthly", "monthlyUsage"] },
] as const

export interface OpenCodeGoAuth {
  /** Go API key, Console service-account key or Console OAuth access token. */
  token: string
  orgID?: string
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

// Server-only: the token never leaves this request. x-org-id mirrors native's
// Console credential headers; its use by the usage endpoint is unverified.
export async function fetchOpenCodeGoQuota(auth: OpenCodeGoAuth, signal: AbortSignal): Promise<ProviderUsage> {
  const payload = await fetchBoundedJson(OPENCODE_GO_USAGE_URL, {
    Authorization: `Bearer ${auth.token}`, Accept: "application/json",
    ...(auth.orgID ? { "x-org-id": auth.orgID } : {}),
  }, signal)
  return parseOpenCodeGoQuota(payload)
}
