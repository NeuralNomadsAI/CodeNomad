const DEFAULT_PAGE_SIZE = 9_000
const MAX_SYNTHETIC_FENCE_LENGTH = 32
const MAX_LANGUAGE_LENGTH = 48

interface Fence {
  marker: "`" | "~"
  length: number
  language: string
}

export interface MissionMarkdownPage {
  /** Exact contiguous source excerpt. Copy/source views must use this, never markdownText. */
  sourceText: string
  /** Display-only Markdown; null means render sourceText literally in a pre/code surface. */
  markdownText: string | null
}

function sourceBoundary(text: string, offset: number): number {
  const bounded = Math.min(offset, text.length)
  const current = text.charCodeAt(bounded), previous = text.charCodeAt(bounded - 1)
  return current >= 0xDC00 && current <= 0xDFFF && previous >= 0xD800 && previous <= 0xDBFF
    ? bounded - 1 : bounded
}

function fenceRun(text: string, start: number, end: number): { marker: Fence["marker"]; length: number; infoStart: number } | undefined {
  let cursor = start
  while (cursor < end && text[cursor] === " " && cursor - start < 4) cursor++
  if (cursor - start > 3) return undefined
  const marker = text[cursor]
  if (marker !== "`" && marker !== "~") return undefined
  const markerStart = cursor
  while (cursor < end && text[cursor] === marker) cursor++
  const length = cursor - markerStart
  return length >= 3 ? { marker, length, infoStart: cursor } : undefined
}

function closesFence(text: string, start: number, end: number, fence: Fence): boolean {
  const run = fenceRun(text, start, end)
  if (!run || run.marker !== fence.marker || run.length < fence.length) return false
  for (let cursor = run.infoStart; cursor < end; cursor++) {
    if (text[cursor] !== " " && text[cursor] !== "\t" && text[cursor] !== "\r") return false
  }
  return true
}

function opensFence(text: string, start: number, end: number): Fence | undefined {
  const run = fenceRun(text, start, end)
  if (!run) return undefined
  // Backticks in an info string invalidate a backtick opener. Scan without copying
  // an arbitrarily long source line or retaining unbounded language metadata.
  if (run.marker === "`") {
    for (let cursor = run.infoStart; cursor < end; cursor++) {
      if (text[cursor] === "`") return undefined
    }
  }
  let languageStart = run.infoStart
  while (languageStart < end && /[ \t]/.test(text[languageStart])) languageStart++
  let languageEnd = languageStart
  while (languageEnd < end && !/[ \t\r]/.test(text[languageEnd])) languageEnd++
  const token = languageEnd - languageStart <= MAX_LANGUAGE_LENGTH
    ? text.slice(languageStart, languageEnd) : ""
  return {
    marker: run.marker,
    length: run.length,
    language: /^[A-Za-z0-9_+.-]+$/.test(token) ? token : "",
  }
}

/**
 * Zero-based bounded excerpts, not a Markdown document paginator. Only standalone
 * fences indented by at most three spaces receive continuation context; nested
 * lists/quotes, tables, HTML blocks and arbitrary paragraph excerpts do not promise
 * full-document Markdown equivalence. Raw HTML escaping remains the renderer's job.
 *
 * The scan reads the authorized prefix through the final boundary line (including
 * that line's remainder to distinguish real delimiters), never parses/renders the
 * whole document or allocates its prefix. Fence state is constant-size. Synthetic
 * context adds at most 115 characters; source boundaries may shift by one UTF-16
 * unit to keep a surrogate pair together, without gaps or overlap between pages.
 */
export function missionMarkdownPage(text: string, page: number, pageSize = DEFAULT_PAGE_SIZE): MissionMarkdownPage {
  if (!Number.isSafeInteger(page) || page < 0) throw new RangeError("Invalid Markdown page")
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
    throw new RangeError("Markdown page size must be between 1 and 9000")
  }
  const start = sourceBoundary(text, page * pageSize)
  const end = sourceBoundary(text, (page + 1) * pageSize)
  const sourceText = text.slice(start, end)
  if (!sourceText) return { sourceText, markdownText: sourceText }

  let active: Fence | undefined
  let initial: Fence | undefined
  let final: Fence | undefined
  let interrupted = false
  let lineStart = 0
  while (lineStart < end) {
    const newline = text.indexOf("\n", lineStart)
    const nextLine = newline < 0 ? text.length : newline + 1
    const lineEnd = newline < 0 ? text.length : newline
    const before = active
    const closing = before && closesFence(text, lineStart, lineEnd, before)
    const opening = !before ? opensFence(text, lineStart, lineEnd) : undefined
    const after = closing ? undefined : opening ?? before

    if (start >= lineStart && start < nextLine) {
      initial = start === lineStart || start < lineEnd ? before : after
      if (start > lineStart && start < lineEnd && (opening || closing)) interrupted = true
      // A body fragment can look like a closer only after cutting away its original
      // line prefix. Do not let the display-only opener consume incidental markers.
      if (before && start > lineStart && closesFence(text, start, Math.min(end, lineEnd), before)) interrupted = true
    }
    if (end > lineStart && end <= nextLine) {
      final = end < lineEnd ? before : after
      if (end < lineEnd && (opening || closing)) interrupted = true
      const run = before && fenceRun(text, lineStart, lineEnd)
      // A truncated body line such as ``` followed by non-whitespace later in the
      // source must not turn into a synthetic closing delimiter at the page end.
      if (end < lineEnd && run && run.marker === before?.marker && run.length >= before.length) interrupted = true
    }
    active = after
    lineStart = nextLine
  }

  if (interrupted || (initial && initial.length > MAX_SYNTHETIC_FENCE_LENGTH)
    || (final && final.length > MAX_SYNTHETIC_FENCE_LENGTH)) {
    return { sourceText, markdownText: null }
  }
  const prefix = initial ? `${initial.marker.repeat(initial.length)}${initial.language}\n` : ""
  const suffix = final ? `${sourceText.endsWith("\n") ? "" : "\n"}${final.marker.repeat(final.length)}\n` : ""
  return { sourceText, markdownText: prefix + sourceText + suffix }
}
