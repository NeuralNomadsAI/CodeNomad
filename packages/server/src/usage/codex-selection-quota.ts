import { parseCodexUsage } from "./providers/oauth"
import { asObject, toNumber, toTimestamp } from "./shared"

// Display parsers may omit malformed windows and clamp percentages. A mutation
// decision must instead reject incomplete or contradictory availability evidence.
export function parseCodexSelectionQuota(payload: unknown) {
  const rate = asObject(asObject(payload)?.rate_limit)
  if (!rate) throw new Error("Quota unavailable")
  if ([rate.allowed, rate.limit_reached].some(flag => flag !== undefined && typeof flag !== "boolean")) {
    throw new Error("Quota unavailable")
  }
  const sources = [rate.primary_window, rate.secondary_window].filter(source => source !== null && source !== undefined)
  if (!sources.length) throw new Error("Quota unavailable")
  const durations = new Set<number>()
  let exhausted = false
  for (const source of sources) {
    const window = asObject(source)
    const seconds = toNumber(window?.limit_window_seconds)
    const used = toNumber(window?.used_percent)
    const reset = toTimestamp(window?.reset_at)
    if (seconds === null || seconds <= 0 || durations.has(seconds)
      || used === null || used < 0 || used > 100 || reset === null || reset <= Date.now()) {
      throw new Error("Quota unavailable")
    }
    durations.add(seconds)
    exhausted ||= used === 100
  }
  if (!exhausted && (rate.allowed === false || rate.limit_reached === true)) throw new Error("Quota unavailable")
  return parseCodexUsage(payload)
}
