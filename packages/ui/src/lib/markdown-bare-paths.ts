/** Lexical extraction of bare file-path candidates from markdown text.
 * Pure helpers only: the store-backed existence verification and DOM pass
 * live in components/markdown-bare-paths.ts. */

import { projectLinkPath } from "./markdown-project-links"

/** One wrap range: a substring of the inspected text and the href it links. */
export interface BarePathPiece {
  start: number
  end: number
  href: string
}

export interface BarePathCandidate {
  /** The token's full range; every reading stays inside it. */
  start: number
  end: number
  /** The whole token read as one path whose non-ASCII letters belong to the
   * file name (`docs/…-算法工作台MVP-design.md`). Probed first; undefined when
   * the token's edges are letter runs wrapping a path-shaped core, which is
   * prose around the token (`看看src/app.ts吧`), never one file name. */
  integral?: BarePathPiece
  /** The boundary reading: edge letter runs trim and interior letter runs
   * split the token, exactly as the ASCII-only grammar did; each piece is
   * gated and verified on its own. */
  pieces: BarePathPiece[]
}

/** An inline code span's one exact path candidate: the whole span. */
export interface InlineCodeCandidate {
  start: number
  end: number
  href: string
}

export const BARE_PATH_MAX_CANDIDATES = 64

// A token is a contiguous run of path characters plus every script's letters,
// marks and digits, optionally starting at a Windows drive prefix. The
// drive-shaped alternative also matches mid-token, but only when the drive
// letter is not glued to an ASCII word — a lookbehind keeps `File:/x` and
// `https://x` split at the colon like a scheme, while prose glued ahead of a
// real drive path (`打开C:\repo\src\app.ts`) keeps the prefix in one token.
// Boundaries are the charset itself — whitespace and punctuation, CJK text
// included, end a token — never `\b`.
const CANDIDATE = /(?:[A-Za-z]:)?(?:(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/]|[\p{L}\p{M}\p{Nd}._~+=@%\-/\\])+/gu
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/
// A drive prefix followed by a doubled separator is a scheme-shaped URL
// (`s://host/path`), not a path.
const DRIVE_WITH_DOUBLE_SEPARATOR = /^[A-Za-z]:[\\/]{2}/
// A doubled separator at the start names a scheme-relative or UNC URL; its
// whole span is one address, so no reading may split it.
const URL_ROOTED = /^[\\/]{2}/
// A separator-less candidate needs a real file shape: a stem of at least two
// characters, in any script, and a short ASCII extension.
const PLAIN_FILE_NAME = /^[\p{L}\p{M}\p{Nd}._~+=@%\-]{2,}\.[A-Za-z0-9]{1,8}$/u
// Pure ASCII digit runs separated by slashes (`27/11/2026`, `989/1000`, `7/10`)
// are dates or ratios, never bare source paths.
const NUMERIC_RATIO = /^\d+(?:[\\/]\d+)+$/
// Non-ASCII letters, marks and digits: prose glue at a token's edge,
// file-name content inside it. Every non-ASCII character in a token is one of
// these; CJK punctuation never enters a token.
const SCRIPT_RUN = /[^\u0000-\u007F]+/g

// The normalizations a link destination may differ from its literal by: a
// separator swap, a `./` prefix and a trailing slash. A reading whose
// resolved path differs any further — a percent escape that decodes, a
// fragment that strips — would let the literal text, the verified target and
// the generated destination name three different files, so it stays plain.
const LITERAL_PATH = (href: string) => href.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/([^/:])\/+$/, "$1")

const gated = (href: string): boolean => {
  if (!href || href.includes("@")) return false
  if (DRIVE_WITH_DOUBLE_SEPARATOR.test(href)) return false
  if (NUMERIC_RATIO.test(href)) return false
  const hasSeparator = href.includes("/") || href.includes("\\")
  if (!hasSeparator && !PLAIN_FILE_NAME.test(href)) return false
  const path = projectLinkPath(href)
  return path !== undefined && path === LITERAL_PATH(href)
}

/** Non-overlapping leftmost-longest bare-path candidates in `text`, capped at
 * `BARE_PATH_MAX_CANDIDATES` readings — the integral probe and every boundary
 * piece each name one file lookup, so one glued run of paths cannot multiply
 * directory reads past the cap. A token carrying non-ASCII letters offers the
 * integral reading first and the boundary pieces as fallback; existence gates
 * conversion downstream, and separator-bearing false positives (`and/or`)
 * stay legal candidates. */
export function barePathCandidates(text: string): BarePathCandidate[] {
  const candidates: BarePathCandidate[] = []
  let budget = BARE_PATH_MAX_CANDIDATES
  for (const match of text.matchAll(CANDIDATE)) {
    if (budget <= 0) break
    const trimmed = match[0].replace(TRAILING_PUNCTUATION, "")
    if (!trimmed) continue
    // A URL keeps its span intact: its rejected whole never falls back to
    // pieces, so a non-ASCII path segment cannot leak a local file link.
    if (URL_ROOTED.test(trimmed)) continue
    const start = match.index!
    const end = start + trimmed.length
    const runs = [...trimmed.matchAll(SCRIPT_RUN)].map(run => [run.index!, run.index! + run[0].length] as const)
    if (runs.length === 0) {
      if (gated(trimmed)) {
        candidates.push({ start, end, pieces: [{ start, end, href: trimmed }] })
        budget -= 1
      }
      continue
    }
    const leading = runs[0][0] === 0 ? runs[0] : undefined
    const trailing = runs[runs.length - 1][1] === trimmed.length ? runs[runs.length - 1] : undefined
    // An edge letter run glued straight to a word character is prose around
    // the token (`看看src/app.ts吧`); one whose inner neighbour is a separator
    // is the path's own segment (`项目/v2/启动`), and both-edges tokens made
    // of segments read as one path.
    const separator = (char: string | undefined) => char === "/" || char === "\\"
    const leadingIsSegment = Boolean(leading && separator(trimmed[leading[1]]))
    const trailingIsSegment = Boolean(trailing && separator(trimmed[trailing[0] - 1]))
    const wrapsProse = Boolean(leading && trailing) && !leadingIsSegment && !trailingIsSegment
    let integral: BarePathPiece | undefined
    if (!wrapsProse && gated(trimmed)) integral = { start, end, href: trimmed }
    const pieces: BarePathPiece[] = []
    // A trimmed edge run can expose punctuation the token-level trim never
    // saw (`看看README.md.吧`); trim it off each piece the same way.
    const pushPiece = (from: number, to: number) => {
      const href = trimmed.slice(from, to).replace(TRAILING_PUNCTUATION, "")
      if (href && gated(href)) pieces.push({ start: start + from, end: start + from + href.length, href })
    }
    let cursor = leading ? leading[1] : 0
    for (const run of runs) {
      if (run === leading || run === trailing) continue
      if (run[0] > cursor) pushPiece(cursor, run[0])
      cursor = run[1]
    }
    if ((trailing ? trailing[0] : trimmed.length) > cursor) pushPiece(cursor, trailing ? trailing[0] : trimmed.length)
    if (integral) {
      if (budget > 0) budget -= 1
      else integral = undefined
    }
    if (pieces.length > budget) pieces.length = budget
    budget -= pieces.length
    if (integral || pieces.length > 0) {
      candidates.push(integral ? { start, end, integral, pieces } : { start, end, pieces })
    }
  }
  return candidates
}

// Admit only literal path segments. A colon is valid only in a drive prefix.
const INLINE_PATH = /^(?:(?:[A-Za-z]:)?[\\/])?[\p{L}\p{M}\p{Nd}._~+=-]+(?:[\\/][\p{L}\p{M}\p{Nd}._~+=-]+)*[\\/]?$/u
const INLINE_FILE_NAME = /^[^\\/]{2,}\.[A-Za-z0-9]{1,8}$/u

export function inlineCodeCandidates(text: string): InlineCodeCandidate[] {
  if (!INLINE_PATH.test(text) || NUMERIC_RATIO.test(text)) return []
  if (!/[\\/]/.test(text) && !INLINE_FILE_NAME.test(text)) return []
  return [{ start: 0, end: text.length, href: text }]
}
