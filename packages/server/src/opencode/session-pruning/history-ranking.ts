export function searchTerms(query: string): string[] {
  const terms: string[] = []
  for (const word of (query.match(/[\p{L}\p{N}_]{2,}/gu) ?? []).sort((a, b) => b.length - a.length)) {
    if (!terms.some(term => new RegExp(`^${term}$`, "iu").test(word))) terms.push(word)
    if (terms.length === 6) break
  }
  return terms
}

export function dateBounds(since?: string, until?: string) {
  const day = (value: string) => {
    const time = Date.parse(`${value}T00:00:00.000Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
      throw new Error("Dates must be real dates, YYYY-MM-DD")
    }
    return time
  }
  const low = since === undefined ? undefined : day(since)
  const high = until === undefined ? undefined : day(until) + 86_400_000
  if (low !== undefined && high !== undefined && low >= high) throw new Error("since is after until")
  return { low, high }
}

export function termPrefilterSQL(term: string): { sql: string; params: string[] } {
  const lower = term.toLowerCase()
  const asciiFold = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase())
  // Fixed literal passes keep per-row SQL work linear. Original tokens preserve
  // dotted-I self-matches. Exotic /iu folds (K/ſ) and arbitrary mixed non-ASCII
  // casing outside these four forms may be missed; the JS judge stays precise.
  const variants = [...new Set([term, lower, term.toUpperCase(), lower.charAt(0).toUpperCase() + lower.slice(1)].map(asciiFold))]
  return { sql: `(${variants.map(() => "instr(lower(m.data), ?) > 0").join(" OR ")} OR instr(m.data, char(92) || 'u') > 0)`, params: variants }
}

export function idfWeights(flags: readonly (readonly boolean[])[], termCount: number): number[] {
  return Array.from({ length: termCount }, (_, i) => Math.log(1 + flags.length / Math.max(1, flags.filter(row => row[i]).length)))
}

export function termScore(matched: readonly boolean[], weights: readonly number[]): number {
  return weights.reduce((sum, weight, i) => sum + (matched[i] ? weight : 0), 0)
}

export function rankedExcerpt(text: string, at: number): string {
  // Normalize after slicing so the original Unicode match offset stays valid.
  const start = Math.max(0, at - 160)
  return text.slice(start, start + 320).replace(/\s+/gu, " ").trim()
}

export function textJudge(terms: string[], query: string, weights: number[]) {
  const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const boundary = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])`, "iu")
  const matchers = terms.map(boundary)
  const phrase = boundary(query.trim())
  const bonus = weights.reduce((sum, weight) => sum + weight, 0)
  return (text: string) => {
    const positions = matchers.map(matcher => text.search(matcher))
    const matched = positions.map(at => at >= 0)
    const rarest = positions.reduce((best, at, i) => at >= 0 && (best < 0 || weights[i] > weights[best]) ? i : best, -1)
    return { matched, at: rarest < 0 ? -1 : positions[rarest], rarity: rarest < 0 ? 0 : weights[rarest],
      phrase: phrase.test(text), score: termScore(matched, weights) + (phrase.test(text) ? bonus : 0) }
  }
}

export interface Rank { sessionID: string; score: number; prose: boolean; createdAt: number; messageID: string }
export function compareRank(a: Rank, b: Rank): number {
  return Number(b.prose) - Number(a.prose) || b.score - a.score || b.createdAt - a.createdAt || a.messageID.localeCompare(b.messageID)
}

export function diverseHits<T extends Rank>(ranked: T[], limit: number): T[] {
  const ordered = [...ranked].sort(compareRank)
  const sessions = new Set<string>()
  const first = ordered.filter(hit => {
    if (sessions.has(hit.sessionID)) return false
    sessions.add(hit.sessionID)
    return true
  })
  const taken = new Set(first)
  return [...first, ...ordered.filter(hit => !taken.has(hit))].slice(0, limit)
}
