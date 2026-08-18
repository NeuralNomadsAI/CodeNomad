import type { MessageStatus } from "./types"

/**
 * Single source of truth for deriving a message's lifecycle status from its
 * server-side info, shared by the live SSE path (session-events) and the REST
 * snapshot path (session-api) so a force-reload can never disagree with the
 * streaming derivation.
 *
 * Follows the OpenCode SDK contract (1.17.x):
 *   - Only assistant messages carry `error` and a completion timestamp.
 *   - Assistant completion is `time.completed` (NOT `time.end`, which is a
 *     part-level field, not message completion).
 *   - User messages expose only `time.created` and are complete once
 *     persisted — they have no pending/streaming server state.
 */
export function deriveMessageStatus(info: {
  role?: string
  error?: unknown
  time?: { completed?: number } | null
}): MessageStatus {
  if (info.error) return "error"
  if (info.role === "user") return "complete"
  const completed = info.time?.completed
  return typeof completed === "number" && completed > 0 ? "complete" : "streaming"
}

export function shouldShowGeneratingPlaceholder(
  hasContent: boolean,
  role: "user" | "assistant",
  status: MessageStatus,
): boolean {
  return !hasContent && role === "assistant" && status === "streaming"
}
