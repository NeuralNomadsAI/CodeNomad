import type { SessionInfo } from "../stores/sessions"

export interface ThreadTotals {
  cost: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
}

export function computeThreadTotals(
  family: { id: string }[],
  infoMap: Map<string, SessionInfo> | undefined,
): ThreadTotals {
  let cost = 0
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  for (const session of family) {
    const sessionInfo = infoMap?.get(session.id)
    inputTokens += sessionInfo?.inputTokens ?? 0
    outputTokens += sessionInfo?.outputTokens ?? 0
    reasoningTokens += sessionInfo?.reasoningTokens ?? 0
    if (!sessionInfo?.isSubscriptionModel) {
      cost += sessionInfo?.cost ?? 0
    }
  }
  return { cost, inputTokens, outputTokens, reasoningTokens }
}
