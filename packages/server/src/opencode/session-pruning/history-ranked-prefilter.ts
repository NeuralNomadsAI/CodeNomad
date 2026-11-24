import { Buffer } from "node:buffer"

/** Necessary condition only. Work on UTF-8 bytes so rejected rows need no JS
 * string allocation, JSON projection or decoding. Exact masks still own IDF. */
export function mayContainHistoryTerms(terms: string[], technical: boolean, rawLimit = 64 * 1024): (raw: Buffer) => boolean {
  if (!terms.length) return () => false
  if (technical && terms.some(term => /\p{N}/u.test(term) || new RegExp(term, "iu").test("null"))) return () => true
  const pairs = terms.map(term => {
    const run = (term.match(/[A-Za-z0-9_]+/g) ?? []).sort((a, b) => b.length - a.length)[0]
    return run?.slice(Math.max(0, Math.floor((run.length - 2) / 2)), Math.max(0, Math.floor((run.length - 2) / 2)) + 2)
  })
  if (pairs.some(pair => !pair)) return () => true
  const needles = (pairs as string[]).flatMap(pair => [...pair].reduce<string[]>((prefixes, char) =>
    prefixes.flatMap(prefix => [...new Set([char.toLowerCase(), char.toUpperCase()])].map(value => prefix + value)), [""]))
    .map(value => Buffer.from(value))
  const kelvin = pairs.some(pair => /k/i.test(pair!)) ? Buffer.from("K") : undefined
  const longS = pairs.some(pair => /s/i.test(pair!)) ? Buffer.from("ſ") : undefined
  const unicodeEscape = Buffer.from("\\u")
  return raw => {
    if (raw.length > rawLimit || needles.some(needle => raw.includes(needle))
      || (kelvin && raw.includes(kelvin)) || (longS && raw.includes(longS))) return true
    // Escaped letters and surrogate pairs can hide the ASCII anchors. Control
    // escapes cannot hide prose words; stringified tool arguments may change them.
    for (let at = raw.indexOf(unicodeEscape); at >= 0; at = raw.indexOf(unicodeEscape, at + 2)) {
      if (technical) return true
      const hex = raw.toString("ascii", at + 2, at + 6)
      if (!/^[0-9a-f]{4}$/i.test(hex) || Number.parseInt(hex, 16) >= 32) return true
    }
    return false
  }
}
