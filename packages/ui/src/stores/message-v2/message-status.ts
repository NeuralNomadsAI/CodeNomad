import type { MessageStatus } from "./types"

/**
 * Single source of truth for deriving a message's lifecycle status from its
 * server-side info (`error` + `time.end`). Used by BOTH the live SSE path
 * (session-events) and the REST snapshot path (session-api) so a force-reload
 * can never disagree with the streaming derivation — for either role. A user
 * message without `time.end` is just as in-flight as an assistant one: the
 * server may simply not have recorded the end yet when the snapshot was
 * taken, and forcing it to "complete" would disagree with the SSE echo.
 */
export function deriveMessageStatus(info: { error?: unknown; time?: { end?: number } | null }): MessageStatus {
  const hasError = Boolean(info.error)
  const hasEnded = typeof info.time?.end === "number" && info.time.end > 0
  return hasError ? "error" : hasEnded ? "complete" : "streaming"
}
