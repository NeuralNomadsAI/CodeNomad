import type { MessageStatus } from "./types"

/**
 * Whether an assistant's text can still grow. OpenCode marks the model stream
 * finished (`time.streamed`) before the step's tools exit and `time.completed`
 * is set, so text is final as soon as it is streamed.
 */
export function isMessageTextStreaming(
  status: MessageStatus,
  time?: { streamed?: number } | null,
): boolean {
  if (status !== "streaming") return false
  const streamed = time?.streamed
  return !(typeof streamed === "number" && streamed > 0)
}

export function shouldShowGeneratingPlaceholder(
  hasContent: boolean,
  role: "user" | "assistant",
  status: MessageStatus,
): boolean {
  return !hasContent && role === "assistant" && status === "streaming"
}

export function getUserMessageMenuState(
  status: MessageStatus,
  delivery?: "queue" | "steer",
): "queue" | "steer" | "history" | "failed" {
  if (status === "error") return "failed"
  if (delivery) return delivery
  return status === "complete" ? "history" : "queue"
}
