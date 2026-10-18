// Display bounds for long text blocks. The native text stays complete in the
// store (copy, search and speech read it there); rendering shows a prefix and
// an in-place reveal of the rest. Measured in Chromium: prose Markdown renders
// 50 000 characters in about 35 ms, highlighted code 10 000 in about 70 ms, and
// unhighlighted code or plain text a full megabyte in under 100 ms.

/** Prose Markdown (assistant/user text, subagent prompts and reports) renders this many characters before its reveal. */
export const MARKDOWN_TEXT_RENDER_CHARACTER_LIMIT = 50_000
/** Tool output (shell, read, diff, ANSI, patches) renders this many characters before its reveal. */
export const TOOL_OUTPUT_RENDER_CHARACTER_LIMIT = 10_000
/** One reveal extends a block by at most this many characters, so no render jumps by more than about ¼ MB. */
export const TEXT_REVEAL_CHARACTER_STEP = 250_000
/** Markdown longer than this renders its code blocks without syntax highlighting (highlighting costs ~5 µs per character). */
export const MARKDOWN_HIGHLIGHT_CHARACTER_LIMIT = 100_000
/** While a reply streams, Markdown longer than this re-renders at most every interval below, without highlighting. */
export const STREAMING_INSTANT_RENDER_CHARACTER_LIMIT = 10_000
export const STREAMING_RENDER_INTERVAL_MS = 200

export interface RenderTextWindow {
  /** The displayed prefix of the source. */
  text: string
  /** Source characters after `text`; zero when the whole source renders. */
  hidden: number
  /** Whether the next reveal renders the whole remainder. */
  revealsAll: boolean
  /** Characters the next reveal adds (all of `hidden` when `revealsAll`). */
  nextReveal: number
}

/**
 * A text read through `slice`, so a window never builds a copy of the whole text.
 * Strings are text sources; `joinedTextSource` joins parts only where sliced.
 */
export interface TextSource {
  readonly length: number
  slice(start: number, end: number): string
}

/** `parts.join("")` as a text source: a slice copies only the characters it covers. */
export function joinedTextSource(parts: readonly string[]): TextSource {
  const length = parts.reduce((total, part) => total + part.length, 0)
  return {
    length,
    slice(start, end) {
      let result = ""
      let offset = 0
      for (const part of parts) {
        if (offset >= end) break
        const next = offset + part.length
        if (next > start) result += part.slice(Math.max(0, start - offset), Math.min(part.length, end - offset))
        offset = next
      }
      return result
    },
  }
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}

/** Where a window of `budget` characters of `source` (at least that long) ends. */
function windowEnd(source: TextSource, budget: number): number {
  // End on a line break within the last tenth of the budget when there is one, so
  // code lines and terminal escape sequences stay whole; never split a surrogate pair.
  const from = budget - Math.floor(budget / 10)
  const lineEnd = source.slice(from, budget).lastIndexOf("\n")
  if (lineEnd >= 0) return from + lineEnd + 1
  if (budget > 0 && isHighSurrogate(source.slice(budget - 1, budget).charCodeAt(0))) return budget - 1
  return budget
}

/** The displayed window of `source` after `revealSteps` reveals beyond `limit`. */
export function getRenderTextWindow(source: TextSource, limit: number, revealSteps = 0): RenderTextWindow {
  const budget = Math.max(0, limit) + Math.max(0, revealSteps) * TEXT_REVEAL_CHARACTER_STEP
  const length = source.length
  if (length <= budget) return { text: source.slice(0, length), hidden: 0, revealsAll: true, nextReveal: 0 }
  const end = windowEnd(source, budget)
  const revealsAll = length <= budget + TEXT_REVEAL_CHARACTER_STEP
  // A step that does not reveal everything ends on its own line break: count exactly that.
  const nextEnd = revealsAll ? length : windowEnd(source, budget + TEXT_REVEAL_CHARACTER_STEP)
  return { text: source.slice(0, end), hidden: length - end, revealsAll, nextReveal: nextEnd - end }
}
