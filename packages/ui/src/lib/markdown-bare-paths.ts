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
   * both token edges are letter runs, which is prose wrapping the token
   * (`看看src/app.ts吧`), never one file name. */
  integral?: BarePathPiece
  /** The boundary reading: edge letter runs trim and interior letter runs
   * split the token, exactly as the ASCII-only grammar did; each piece is
   * gated and verified on its own. */
  pieces: BarePathPiece[]
}

export const BARE_PATH_MAX_CANDIDATES = 64

// A token is a contiguous run of path characters plus every script's letters,
// marks and digits, optionally starting at a Windows drive prefix. Boundaries
// are the charset itself — whitespace and punctuation, CJK text included, end
// a token — never `\b`.
const CANDIDATE = /(?:[A-Za-z]:)?[\p{L}\p{M}\p{Nd}._~+=@%\-/\\]+/gu
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/
// A drive prefix followed by a doubled separator is a scheme-shaped URL
// (`s://host/path`), not a path.
const DRIVE_WITH_DOUBLE_SEPARATOR = /^[A-Za-z]:[\\/]{2}/
// A separator-less candidate needs a real file shape: a stem of at least two
// characters, in any script, and a short ASCII extension.
const PLAIN_FILE_NAME = /^[\p{L}\p{M}\p{Nd}._~+=@%\-]{2,}\.[A-Za-z0-9]{1,8}$/u
// Non-ASCII letters, marks and digits: prose glue at a token's edge,
// file-name content inside it. Every non-ASCII character in a token is one of
// these; CJK punctuation never enters a token.
const SCRIPT_RUN = /[^\u0000-\u007F]+/g

const gated = (href: string): boolean => {
  if (!href || href.includes("@")) return false
  if (DRIVE_WITH_DOUBLE_SEPARATOR.test(href)) return false
  const hasSeparator = href.includes("/") || href.includes("\\")
  if (!hasSeparator && !PLAIN_FILE_NAME.test(href)) return false
  return projectLinkPath(href) !== undefined
}

/** Non-overlapping leftmost-longest bare-path candidates in `text`, capped at
 * `BARE_PATH_MAX_CANDIDATES`. A token carrying non-ASCII letters offers the
 * integral reading first and the boundary pieces as fallback; existence gates
 * conversion downstream, and separator-bearing false positives (`and/or`)
 * stay legal candidates. */
export function barePathCandidates(text: string): BarePathCandidate[] {
  const candidates: BarePathCandidate[] = []
  for (const match of text.matchAll(CANDIDATE)) {
    if (candidates.length >= BARE_PATH_MAX_CANDIDATES) break
    const trimmed = match[0].replace(TRAILING_PUNCTUATION, "")
    if (!trimmed) continue
    const start = match.index!
    const end = start + trimmed.length
    const runs = [...trimmed.matchAll(SCRIPT_RUN)].map(run => [run.index!, run.index! + run[0].length] as const)
    if (runs.length === 0) {
      if (gated(trimmed)) candidates.push({ start, end, pieces: [{ start, end, href: trimmed }] })
      continue
    }
    const leading = runs[0][0] === 0 ? runs[0] : undefined
    const trailing = runs[runs.length - 1][1] === trimmed.length ? runs[runs.length - 1] : undefined
    const integral = leading && trailing ? undefined
      : gated(trimmed) ? { start, end, href: trimmed } : undefined
    const pieces: BarePathPiece[] = []
    let cursor = leading ? leading[1] : 0
    for (const run of runs) {
      if (run === leading || run === trailing) continue
      if (run[0] > cursor && gated(trimmed.slice(cursor, run[0]))) {
        pieces.push({ start: start + cursor, end: start + run[0], href: trimmed.slice(cursor, run[0]) })
      }
      cursor = run[1]
    }
    const tailEnd = trailing ? trailing[0] : trimmed.length
    if (tailEnd > cursor && gated(trimmed.slice(cursor, tailEnd))) {
      pieces.push({ start: start + cursor, end: start + tailEnd, href: trimmed.slice(cursor, tailEnd) })
    }
    if (integral || pieces.length > 0) {
      candidates.push(integral ? { start, end, integral, pieces } : { start, end, pieces })
    }
  }
  return candidates
}
