// ponytail: the daily reference is observed, not supplied by the Console API.
// Replace it with an upstream allowance when that contract becomes available.
export const OPENCODE_FREE_DAILY_REQUESTS = 800
const DAY_MS = 86_400_000

export function isOpenCodeFreeModel(providerId: string, modelId?: string): boolean {
  const model = modelId?.trim().toLowerCase()
  return providerId.trim().toLowerCase() === "opencode" && !!model && (model === "big-pickle" || model.endsWith("-free"))
}

/** UTC calendar day used by Console's 24h range. */
export function openCodeFreeWindow(now: number) {
  const from = Math.floor(now / DAY_MS) * DAY_MS
  return { from, to: now, resetAt: from + DAY_MS }
}
