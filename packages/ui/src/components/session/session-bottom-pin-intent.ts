import type { VirtualExplicitBottomPinIntent } from "../virtual-follow-list"

export interface SessionBottomPinIntent extends VirtualExplicitBottomPinIntent {
  sessionId: string
  createdMessageCount: number
  observedStreaming: boolean
}

export function getSubmitBottomPinTargetCount(messageCount: number, streamingActive: boolean) {
  return messageCount + (streamingActive ? 1 : 2)
}

export function resolveSessionBottomPinIntent(
  intent: SessionBottomPinIntent | null,
  sessionId: string,
): VirtualExplicitBottomPinIntent | null {
  if (!intent || intent.sessionId !== sessionId) return null
  return { token: intent.token, minItemCount: intent.minItemCount }
}

export function shouldClearSessionBottomPinIntent(
  intent: SessionBottomPinIntent | null,
  state: { sessionId: string; messageCount: number; streamingActive: boolean },
) {
  if (!intent) return false
  if (intent.sessionId !== state.sessionId) return false
  if (state.streamingActive) return false
  if (state.messageCount >= (intent.minItemCount ?? 0)) return true
  return intent.observedStreaming && state.messageCount > intent.createdMessageCount
}
