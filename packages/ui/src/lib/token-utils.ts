import type { ClientPart } from "../types/message"

/**
 * Count the total character content of a message part.
 *
 * Used by both the xray histogram overlay (message-timeline) and the
 * bulk-delete toolbar token pills (message-section) so both surfaces
 * derive token estimates from the same logic.
 *
 * Note: For tool parts we intentionally only count `state.input` and
 * `state.output`. We exclude `state.metadata` from token estimation since
 * metadata can contain large or verbose diagnostic payloads that are not
 * representative of model context.
 */
export function getPartCharCount(part: ClientPart): number {
  if (!part) return 0
  let count = 0

  if (typeof (part as any).text === "string") {
    count += (part as any).text.length
  }

  if (part.type === "tool") {
    const state = (part as any).state
    // Tool calls may be compacted server-side. When that happens we treat the
    // tool payload as effectively absent from context for token estimation.
    const compacted = (state as any)?.time?.compacted
    if (compacted !== undefined && compacted !== null) {
      return 0
    }
    if (state) {
      if (state.input) {
        try {
          count += JSON.stringify(state.input).length
        } catch {}
      }
      if (state.output) {
        if (typeof state.output === "string") {
          count += state.output.length
        } else {
          try {
            count += JSON.stringify(state.output).length
          } catch {}
        }
      }
    }
  }

  if (Array.isArray((part as any).content)) {
    count += (part as any).content.reduce((acc: number, entry: unknown) => {
      if (typeof entry === "string") return acc + entry.length
      if (entry && typeof entry === "object") {
        let entryCount = (String((entry as any).text || "")).length + (String((entry as any).value || "")).length
        if (Array.isArray((entry as any).content)) {
          entryCount += (entry as any).content.reduce((innerAcc: number, sub: unknown) => {
            if (typeof sub === "string") return innerAcc + sub.length
            return innerAcc + (String((sub as any)?.text || "")).length
          }, 0)
        }
        return acc + entryCount
      }
      return acc
    }, 0)
  }
  return count
}
