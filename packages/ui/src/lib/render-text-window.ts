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

export interface RenderTextWindow {
  /** The displayed prefix of the source. */
  text: string
  /** Source characters after `text`; zero when the whole source renders. */
  hidden: number
  /** Whether the next reveal renders the whole remainder. */
  revealsAll: boolean
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}

/** The displayed window of `source` after `revealSteps` reveals beyond `limit`. */
export function getRenderTextWindow(source: string, limit: number, revealSteps = 0): RenderTextWindow {
  const budget = Math.max(0, limit) + Math.max(0, revealSteps) * TEXT_REVEAL_CHARACTER_STEP
  if (source.length <= budget) return { text: source, hidden: 0, revealsAll: true }
  let end = budget
  // End on a line break near the budget when there is one, so code lines and
  // terminal escape sequences stay whole; never split a surrogate pair.
  const lineEnd = source.lastIndexOf("\n", end - 1)
  if (lineEnd >= 0 && lineEnd >= end - Math.floor(budget / 10)) end = lineEnd + 1
  else if (end > 0 && isHighSurrogate(source.charCodeAt(end - 1))) end -= 1
  return {
    text: source.slice(0, end),
    hidden: source.length - end,
    revealsAll: source.length <= budget + TEXT_REVEAL_CHARACTER_STEP,
  }
}
