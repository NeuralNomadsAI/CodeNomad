/** Lexical extraction of bare file-path candidates from markdown text.
 * Pure helpers only: the store-backed existence verification and DOM pass
 * live in components/markdown-bare-paths.ts. */

import { projectLinkPath } from "./markdown-project-links"

export interface BarePathCandidate {
  start: number
  end: number
  href: string
}

export const BARE_PATH_MAX_CANDIDATES = 64

// A candidate is a contiguous run of path characters, optionally starting at
// a Windows drive prefix. Boundaries are the charset itself — whitespace, CJK
// text and punctuation end a token — never `\b`.
const CANDIDATE = /(?:[A-Za-z]:)?[A-Za-z0-9._~+=@%\-/\\]+/g
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/
// A drive prefix followed by a doubled separator is a scheme-shaped URL
// (`s://host/path`), not a path.
const DRIVE_WITH_DOUBLE_SEPARATOR = /^[A-Za-z]:[\\/]{2}/
// A separator-less candidate needs a real file shape: a stem of at least two
// characters and a short extension (`README.md`, not `b.c`).
const PLAIN_FILE_NAME = /^[A-Za-z0-9._~+=@%\-]{2,}\.[A-Za-z0-9]{1,8}$/

/** Non-overlapping leftmost-longest bare-path candidates in `text`, capped at
 * `BARE_PATH_MAX_CANDIDATES`. Existence still gates conversion downstream;
 * separator-bearing false positives (`and/or`) stay legal candidates. */
export function barePathCandidates(text: string): BarePathCandidate[] {
  const candidates: BarePathCandidate[] = []
  for (const match of text.matchAll(CANDIDATE)) {
    if (candidates.length >= BARE_PATH_MAX_CANDIDATES) break
    const raw = match[0]
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "")
    // An `@` makes a token an email address, never a path.
    if (!trimmed || trimmed.includes("@")) continue
    if (DRIVE_WITH_DOUBLE_SEPARATOR.test(trimmed)) continue
    const hasSeparator = trimmed.includes("/") || trimmed.includes("\\")
    if (!hasSeparator && !PLAIN_FILE_NAME.test(trimmed)) continue
    if (projectLinkPath(trimmed) === undefined) continue
    // Trimming removes characters from the end only; the match start stands.
    const start = match.index!
    candidates.push({ start, end: start + trimmed.length, href: trimmed })
  }
  return candidates
}

// Admit only literal path segments. A colon is valid only in a drive prefix.
const INLINE_PATH = /^(?:(?:[A-Za-z]:)?[\\/])?[\p{L}\p{M}\p{Nd}._~+=-]+(?:[\\/][\p{L}\p{M}\p{Nd}._~+=-]+)*[\\/]?$/u
const INLINE_FILE_NAME = /^[^\\/]{2,}\.[A-Za-z0-9]{1,8}$/u

export function inlineCodeCandidates(text: string): BarePathCandidate[] {
  if (!INLINE_PATH.test(text)) return []
  if (!/[\\/]/.test(text) && !INLINE_FILE_NAME.test(text)) return []
  return [{ start: 0, end: text.length, href: text }]
}
