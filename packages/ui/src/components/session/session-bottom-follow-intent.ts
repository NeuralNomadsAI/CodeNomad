import type { VirtualFollowBottomIntent } from "../virtual-follow-list"

export interface SessionBottomFollowIntent extends VirtualFollowBottomIntent {
  sessionId: string
}

export function resolveSessionBottomFollowIntent(
  intent: SessionBottomFollowIntent | null,
  sessionId: string,
): VirtualFollowBottomIntent | null {
  if (!intent || intent.sessionId !== sessionId) return null
  return { token: intent.token, minItemCount: intent.minItemCount }
}

export function shouldClearSessionBottomFollowIntent(
  intent: SessionBottomFollowIntent | null,
  state: { sessionId: string; messageCount: number; streamingActive: boolean },
) {
  if (!intent) return false
  if (intent.sessionId !== state.sessionId) return false
  return state.messageCount >= (intent.minItemCount ?? 0) && !state.streamingActive
}
