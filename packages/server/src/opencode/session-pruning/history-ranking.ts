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

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Match decoded readable strings. JSON decoding belongs to the scalar's shared
// history projection, so control escapes and literal backslashes keep their meaning.
export function termMask(terms: string[]): (data: string) => number {
  if (!terms.length) return () => 0
  const all = (1 << terms.length) - 1
  const ordered = terms.map((term, index) => ({ term, index })).sort((a, b) => b.term.length - a.term.length)
  const matcher = new RegExp(ordered.map(({ term }) => `(${escape(term)})`).join("|"), "giu")
  // A longer alternative may contain shorter query terms at the same position.
  const contained = ordered.map(({ term }) => terms.reduce((mask, other, i) =>
    new RegExp(escape(other), "iu").test(term) ? mask | (1 << i) : mask, 0))
  return data => {
    let mask = 0
    matcher.lastIndex = 0
    for (let match; (match = matcher.exec(data));) {
      mask |= contained[match.findIndex((value, i) => i > 0 && value !== undefined) - 1]
      if (mask === all) break
      // Monotonic forward scan, including overlapping substring alternatives.
      // Boundaries belong to the judge; this is a substring superset.
      matcher.lastIndex = match.index + (data.codePointAt(match.index)! > 0xffff ? 2 : 1)
    }
    return mask
  }
}

export function idfWeights(flags: readonly (readonly boolean[] | undefined)[], termCount: number): number[] {
  const known = flags.filter((row): row is readonly boolean[] => row !== undefined)
  return Array.from({ length: termCount }, (_, i) => Math.log(1 + known.length / Math.max(1, known.filter(row => row[i]).length)))
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

export interface Rank { sessionID: string; score: number; prose: boolean; createdAt: number; messageID: string; unknown?: boolean }
export function compareRank(a: Rank, b: Rank): number {
  return Number(Boolean(a.unknown)) - Number(Boolean(b.unknown)) || Number(b.prose) - Number(a.prose)
    || b.score - a.score || b.createdAt - a.createdAt || a.messageID.localeCompare(b.messageID)
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
