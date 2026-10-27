// Shared with the native engine: original spelling, /iu deduplication, six longest terms.
export { searchTerms as rankedSearchTerms } from "../../../server/src/opencode/session-pruning/history-ranking"

export type SearchHighlightQuery = string | readonly string[]

export function rankedTermMatcher(terms: readonly string[]): RegExp | undefined {
  if (!terms.length) return undefined
  const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`, "giu")
}

export function rankedExcerptParts(text: string, terms: readonly string[]) {
  const matcher = rankedTermMatcher(terms), parts: Array<{ text: string; match: boolean }> = []
  let after = 0
  if (matcher) for (const match of text.matchAll(matcher)) {
    if (match.index > after) parts.push({ text: text.slice(after, match.index), match: false })
    parts.push({ text: match[0], match: true })
    after = match.index + match[0].length
  }
  if (after < text.length) parts.push({ text: text.slice(after), match: false })
  return parts
}
