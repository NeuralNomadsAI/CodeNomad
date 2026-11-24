import { findMentionStart } from "../prompt-input/usePromptPicker"

// API 4 `composer.prefill` (dev-docs/PANEL_EXTENSIONS.md#api-4): text added to the
// displayed conversation's draft, never sent, never a command or an open mention.
export const PREFILL_LIMITS = { bytes: 2048, refs: 16 } as const
const MARKER = /\{\{(\d+)\}\}/g

/** The 1-based reference indexes `text` cites, or `invalid` when a marker or a reference is unmatched. */
export function prefillMarkers(text: string, refCount: number): number[] | "invalid" {
  const used = new Set<number>()
  for (const match of text.matchAll(MARKER)) {
    const index = Number(match[1])
    if (!Number.isSafeInteger(index) || index < 1 || index > Math.min(refCount, PREFILL_LIMITS.refs)) return "invalid"
    used.add(index)
  }
  return used.size === refCount ? [...used].sort((a, b) => a - b) : "invalid"
}

/**
 * Appends `text`, its `{{n}}` replaced by the n-th Location-relative path quoted
 * as code (`` `path` ``), to `draft`: nothing between them when the draft is
 * empty, `\n` after a final line break, else `\n\n`. Refused when the text is
 * empty or over 2,048 UTF-8 bytes after substitution, a path holds a backtick or
 * a line break, or the resulting draft starts with `/` (a command, `/btw`) or ends
 * in a mention the composer's picker would open (`findMentionStart`).
 */
export function composePrefill(draft: string, text: string, paths: readonly string[]):
  { status: "added"; draft: string } | { status: "too-long" | "invalid" } {
  if (!text.trim() || prefillMarkers(text, paths.length) === "invalid" || paths.some(path => !path || /[`\r\n]/.test(path))) return { status: "invalid" }
  const added = text.replace(MARKER, (_marker, index: string) => `\`${paths[Number(index) - 1]}\``).replace(/\r\n?/g, "\n")
  if (new TextEncoder().encode(added).length > PREFILL_LIMITS.bytes) return { status: "too-long" }
  const existing = draft.replace(/\r\n?/g, "\n")
  const result = existing + (!existing ? "" : existing.endsWith("\n") ? "\n" : "\n\n") + added
  if (result.trim().startsWith("/") || findMentionStart(result) !== -1) return { status: "invalid" }
  return { status: "added", draft: result }
}
