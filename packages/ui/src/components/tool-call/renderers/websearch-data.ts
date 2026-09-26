export interface WebSearchResult {
  title: string
  url: string
  host: string
  published?: string
  snippet: string
}

// Native websearch persists Markdown content, not the structured runtime output.
// Reject ambiguous envelopes rather than hiding unknown provider output.
export function parseWebSearchResults(text: string): WebSearchResult[] | undefined {
  if (text.trim() === "No search results found. Please try a different query.") return []
  if (text.length > 10_000) return undefined
  const results: WebSearchResult[] = []
  for (const line of text.trim().split("\n")) {
    const heading = /^## \[(.*)\]\((https?:\/\/\S+)\)$/.exec(line)
    if (heading) {
      let url: URL
      try { url = new URL(heading[2]) } catch { return undefined }
      if (!url.hostname || url.username || url.password) return undefined
      results.push({ title: heading[1] || heading[2], url: url.href, host: url.host, snippet: "" })
      if (results.length > 50) return undefined
      continue
    }
    const result = results.at(-1)
    if (!result || line.startsWith("## [")) return undefined
    if (!result.snippet && !result.published && /^Published: \S+$/.test(line)) {
      result.published = line.slice(11)
    } else result.snippet += `${line}\n`
  }
  return results.length ? results.map(result => ({ ...result, snippet: result.snippet.trim() })) : undefined
}
