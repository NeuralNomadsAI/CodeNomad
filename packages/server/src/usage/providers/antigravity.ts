import { postBoundedJson } from "../bounded-fetch"
import { asObject, getString, toTimestamp, toUsageWindow } from "../shared"
import type { ProviderUsage } from "../types"

// Quota host and Hub User-Agent:
// https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/constants.ts
const QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
const USER_AGENT = "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)"

// Canonical labels only: upstream names/descriptions can echo credentials.
const FAMILIES = new Map([
  ["gemini models", "Gemini"], ["gemini", "Gemini"],
  ["claude and gpt models", "Claude/GPT"], ["claude and gpt", "Claude/GPT"],
])

/** Requires saved project context; never discovers, invents or onboards a project. */
export async function antigravityQuota(access: string, project: string, signal: AbortSignal,
  safeIdentity: (value: string) => boolean): Promise<ProviderUsage> {
  const payload = asObject(await postBoundedJson(QUOTA_URL, { Authorization: `Bearer ${access}`, "User-Agent": USER_AGENT }, { project }, signal))
  if (!Array.isArray(payload?.groups) || !payload.groups.length) throw new Error("Google usage unavailable")
  const windows: ProviderUsage["windows"] = {}
  for (const raw of payload.groups) {
    const group = asObject(raw)
    if (!group || !Array.isArray(group.buckets)) throw new Error("Google usage unavailable")
    const name = getString(group.displayName)
    if ([group.displayName, group.groupId, group.family]
      .some(value => typeof value === "string" && !safeIdentity(value))) continue
    if (group.displayName !== undefined && !name) throw new Error("Google usage unavailable")
    const family = name ? FAMILIES.get(name.toLowerCase()) : null
    // Unnamed single groups are plan-wide; multiple groups need explicit identity.
    if (name ? !family : payload.groups.length !== 1) continue
    for (const rawBucket of group.buckets) {
      const bucket = asObject(rawBucket)
      if (!bucket) throw new Error("Google usage unavailable")
      if ([bucket.bucketId, bucket.displayName, bucket.window]
        .some(value => typeof value === "string" && !safeIdentity(value))) continue
      const window = getString(bucket.window)?.toLowerCase()
      if (window !== "5h" && window !== "weekly") continue
      const fraction = bucket.remainingFraction
      if (fraction !== undefined && (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1)) {
        throw new Error("Google usage unavailable")
      }
      const resetAt = typeof bucket.resetTime === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(bucket.resetTime)
        ? toTimestamp(bucket.resetTime) : null
      if (bucket.resetTime !== undefined && resetAt === null) throw new Error("Google usage unavailable")
      const key = family ? `${window}:${family}` : window
      if (!safeIdentity(key)) continue
      if (windows[key]) throw new Error("Google usage unavailable")
      windows[key] = toUsageWindow({ usedPercent: fraction === undefined ? null : (1 - fraction) * 100,
        resetAt, windowSeconds: window === "5h" ? 18_000 : 604_800 })
    }
  }
  if (!Object.values(windows).some(window => window.usedPercent !== null)) throw new Error("Google usage unavailable")
  return { windows }
}
