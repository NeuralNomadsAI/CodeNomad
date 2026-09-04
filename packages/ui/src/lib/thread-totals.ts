import type { SessionInfo } from "../stores/sessions"

export interface ThreadTotals {
  cost: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
}

export function computeThreadTotals(
  family: { id: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number } }[],
  infoMap: Map<string, SessionInfo> | undefined,
): ThreadTotals {
  let cost = 0
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  for (const session of family) {
    const sessionInfo = infoMap?.get(session.id)
    inputTokens += sessionInfo?.inputTokens ?? session.tokens?.input ?? 0
    outputTokens += sessionInfo?.outputTokens ?? session.tokens?.output ?? 0
    reasoningTokens += sessionInfo?.reasoningTokens ?? session.tokens?.reasoning ?? 0
    if (!sessionInfo?.isSubscriptionModel) {
      cost += sessionInfo?.cost ?? session.cost ?? 0
    }
  }
  return { cost, inputTokens, outputTokens, reasoningTokens }
}
