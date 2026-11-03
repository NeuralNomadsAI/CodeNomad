import type { SessionStatsInfo } from "@opencode/client"
import type { ProviderUsageResponse } from "../api-types"

// ponytail: a 200-request reference per UTC day; replace this heuristic with an
// upstream counter when Zen exposes one. Actual limits vary with capacity/IP.
export const OPENCODE_FREE_DAILY_REQUESTS = 200
const DAY_MS = 86_400_000

export function isOpenCodeFreeModel(providerId: string, modelId?: string): boolean {
  const model = modelId?.trim().toLowerCase()
  return providerId.trim().toLowerCase() === "opencode" && !!model && (model === "big-pickle" || model.endsWith("-free"))
}

/** UTC calendar day used as the estimation window. */
export function openCodeFreeWindow(now: number) {
  const from = Math.floor(now / DAY_MS) * DAY_MS
  return { from, to: now, resetAt: from + DAY_MS }
}

/** Estimate from this service's recorded steps: other clients behind the same IP are not seen. */
export function estimateOpenCodeFreeUsage(stats: Pick<SessionStatsInfo, "models">, providerId: string, modelId: string | undefined, now: number): ProviderUsageResponse {
  const steps = stats.models.filter(({ model }) => isOpenCodeFreeModel(model.providerID, model.id)).reduce((sum, model) => {
    if (!Number.isSafeInteger(model.steps) || model.steps < 0 || !Number.isSafeInteger(sum + model.steps)) throw new Error("Invalid free-model step count")
    return sum + model.steps
  }, 0)
  const usedPercent = Math.min(100, (steps / OPENCODE_FREE_DAILY_REQUESTS) * 100)
  return {
    requestedProviderId: providerId, providerId: "opencode-free", providerName: "OpenCode Zen", modelId,
    supported: true, configured: true, ok: true, estimated: true, fetchedAt: now,
    windows: { daily: { usedPercent, remainingPercent: 100 - usedPercent, windowSeconds: DAY_MS / 1000,
      resetAt: openCodeFreeWindow(now).resetAt, valueLabel: `${steps} / ${OPENCODE_FREE_DAILY_REQUESTS}` } },
  }
}
