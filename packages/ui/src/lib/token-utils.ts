import type { ClientPart } from "../types/message"

/**
 * Count the total character content of a message part.
 *
 * Used by both the xray histogram overlay (message-timeline) and the
 * bulk-delete toolbar token pills (message-section) so both surfaces
 * derive token estimates from the same logic.
 *
 * Skips `filediff` metadata — it contains full before/after file content
 * and would inflate the character count by 10-100x for large files.
 */
export function getPartCharCount(part: ClientPart): number {
  if (!part) return 0
  let count = 0

  if (typeof (part as any).text === "string") {
    count += (part as any).text.length
  }

  if (part.type === "tool") {
    const state = (part as any).state
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
      if (state.metadata) {
        for (const [key, val] of Object.entries(state.metadata)) {
          if (key === "filediff") continue
          if (typeof val === "string") {
            count += val.length
          } else if (val && typeof val === "object") {
            try {
              count += JSON.stringify(val).length
            } catch {}
          }
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
