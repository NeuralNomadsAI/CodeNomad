export interface TextSearchOccurrence {
  start: number
  end: number
  occurrence: number
  preview: string
}

const PREVIEW_RADIUS = 56

export function findTextSearchOccurrences(text: string, query: string, limit: number, normalizedQuery?: string): TextSearchOccurrence[] {
  const haystack = text.toLocaleLowerCase()
  const needle = normalizedQuery ?? query.toLocaleLowerCase()
  const matches: TextSearchOccurrence[] = []
  let from = 0
  while (from < haystack.length && matches.length < limit) {
    const start = haystack.indexOf(needle, from)
    if (start === -1) break
    const end = start + query.length
    const previewStart = Math.max(0, start - PREVIEW_RADIUS)
    const previewEnd = Math.min(text.length, end + PREVIEW_RADIUS)
    matches.push({
      start,
      end,
      occurrence: matches.length,
      preview: `${previewStart > 0 ? "..." : ""}${text.slice(previewStart, previewEnd).replace(/\s+/g, " ").trim()}${previewEnd < text.length ? "..." : ""}`,
    })
    from = end > start ? end : start + 1
  }
  return matches
}
