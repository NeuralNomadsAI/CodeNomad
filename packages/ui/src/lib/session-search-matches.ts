export interface TextSearchOccurrence {
  start: number
  end: number
  occurrence: number
  preview: string
}

const PREVIEW_RADIUS = 56
const LITERAL_REGEX_CHUNK_CHARACTERS = 4_096

function escapeLiteralPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function makeTextSearchPreview(text: string, start: number, end: number): string {
  const previewStart = Math.max(0, start - PREVIEW_RADIUS)
  const previewEnd = Math.min(text.length, end + PREVIEW_RADIUS)
  const value = end - start <= PREVIEW_RADIUS * 2
    ? text.slice(previewStart, previewEnd)
    : `${text.slice(previewStart, start + PREVIEW_RADIUS)}...${text.slice(end - PREVIEW_RADIUS, previewEnd)}`
  return `${previewStart > 0 ? "..." : ""}${value.replace(/\s+/g, " ").trim()}${previewEnd < text.length ? "..." : ""}`
}

export function* iterateTextSearchOccurrences(text: string, query: string, from = 0): Generator<{ start: number; end: number }> {
  if (!query) return
  if (query.length <= LITERAL_REGEX_CHUNK_CHARACTERS) {
    const pattern = new RegExp(escapeLiteralPattern(query), "giu")
    pattern.lastIndex = Math.max(0, from)
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      if (start === undefined) continue
      yield { start, end: start + match[0].length }
    }
    return
  }

  const foldedText = text.toLowerCase()
  const foldedQuery = query.toLowerCase()
  let foldedFrom = text.slice(0, Math.max(0, from)).toLowerCase().length
  let originalOffset = 0
  let foldedOffset = 0
  const originalBoundary = (target: number): number | undefined => {
    if (target < foldedOffset) return undefined
    while (foldedOffset < target && originalOffset < text.length) {
      const width = text.codePointAt(originalOffset)! > 0xffff ? 2 : 1
      foldedOffset += text.slice(originalOffset, originalOffset + width).toLowerCase().length
      originalOffset += width
    }
    return foldedOffset === target ? originalOffset : undefined
  }

  while (true) {
    const foldedStart = foldedText.indexOf(foldedQuery, foldedFrom)
    if (foldedStart < 0) return
    const start = originalBoundary(foldedStart)
    const end = originalBoundary(foldedStart + foldedQuery.length)
    if (start !== undefined && end !== undefined && text.slice(start, end).toLowerCase() === foldedQuery) {
      yield { start, end }
      foldedFrom = foldedStart + foldedQuery.length
    } else {
      foldedFrom = foldedStart + 1
    }
  }
}

export function findTextSearchOccurrences(text: string, query: string, limit: number): TextSearchOccurrence[] {
  const matches: TextSearchOccurrence[] = []
  for (const { start, end } of iterateTextSearchOccurrences(text, query)) {
    if (matches.length >= limit) break
    matches.push({
      start,
      end,
      occurrence: matches.length,
      preview: makeTextSearchPreview(text, start, end),
    })
  }
  return matches
}
