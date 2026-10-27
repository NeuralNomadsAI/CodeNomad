import assert from "node:assert/strict"
import { test } from "node:test"
import { compareRank, dateBounds, diverseHits, idfWeights, rankedExcerpt, searchTerms, textJudge, type Rank } from "./history-ranking"
import { historyRankedInputSchema } from "./history-ranked-contract"
import { formatRankedHistory } from "./history-ranked-service"

test("terms are distinct Unicode words, longest first, at most six; syntax stays literal", () => {
  assert.deepEqual(searchTerms("ÉTÉ été été Français x _ ab cd ef gh ij kl"), ["français", "été", "ab", "cd", "ef", "gh"])
  assert.deepEqual(searchTerms("(réflexion|RÉFLEXION).* [a-z]"), ["réflexion"])
  assert.deepEqual(searchTerms("a ! _"), [])
})

test("Unicode judge folds accents and enforces whole-word boundaries", () => {
  const judge = textJudge(["été", "panel"], "été panel", [2, 1])
  assert.deepEqual(judge("ÉTÉ PANEL").matched, [true, true])
  assert.deepEqual(judge("préété panels panel_name").matched, [false, false])
  assert.equal(textJudge(["kelvin"], "kelvin", [1])("KELVIN").at, 0)
})

test("IDF lowers frequent filler terms and the rarest term anchors excerpts", () => {
  const weights = idfWeights([[true, true], [true, false], [true, false], [true, false]], 2)
  assert(weights[1] > weights[0])
  const text = `the ${"padding ".repeat(80)}rare ${"tail ".repeat(80)}`
  const found = textJudge(["the", "rare"], "the rare", weights)(text)
  assert.equal(found.at, text.indexOf("rare"))
  const excerpt = rankedExcerpt(text, found.at)
  assert(excerpt.includes("rare")); assert(excerpt.length <= 320); assert(!excerpt.includes("the"))
})

test("exact phrase earns a bonus over separated terms", () => {
  const judge = textJudge(["panel", "blank"], "panel blank", [1, 2])
  assert.equal(judge("panel blank").score, 6)
  assert.equal(judge("blank in the panel").score, 3)
  assert.equal(judge("panel blanks").score, 1)
})

test("rank prefers prose, then weighted score, then recency; diversity never duplicates hits", () => {
  const row = (messageID: string, sessionID: string, score: number, createdAt = 1, prose = true): Rank => ({ messageID, sessionID, score, createdAt, prose })
  const rows = [row("a", "s", 8), row("b", "s", 7), row("c", "peer", 2), row("d", "tool", 99, 2, false)]
  assert.deepEqual(diverseHits(rows, 4).map(row => row.messageID), ["a", "c", "d", "b"])
  assert(compareRank(row("new", "s", 1, 2), row("old", "s", 1, 1)) < 0)
})

test("real UTC dates are inclusive, including leap days and early years", () => {
  assert.deepEqual(dateBounds("2024-02-29", "2024-02-29"), { low: Date.parse("2024-02-29Z"), high: Date.parse("2024-03-01Z") })
  assert.equal(dateBounds("0001-01-01").low, Date.parse("0001-01-01T00:00:00Z"))
  for (const value of ["2025-02-29", "2024-02-30", "2024-13-01", "24-01-01", "2024-1-01"]) assert.throws(() => dateBounds(value), /real dates/)
  assert.throws(() => dateBounds("2025-03-02", "2025-03-01"), /since is after/)
})

test("versioned ranked contract bounds limits and rejects selectors and regex options", () => {
  assert.equal(historyRankedInputSchema.parse({ version: 1, query: "panel" }).limit, 10)
  for (const extra of [{ version: 2 }, { limit: 21 }, { limit: 0 }, { since: "2026-02-30" }, { project: "other" }, { regex: true }, { sessionID: "foreign" }]) {
    assert.equal(historyRankedInputSchema.safeParse({ version: 1, query: "panel", ...extra }).success, false)
  }
})

test("formatter reports capped verified counts and how to read a whole session", () => {
  const text = formatRankedHistory({ version: 1, status: "ranked", scanned: 2, candidates: 2, judged: 1, skipped: 0,
    hits: [], sessions: [], matchedSessions: 0, capped: true, caps: ["total_time"] })
  assert.match(text, /0 session\(s\).*verified match/)
  assert.match(text, /Scan capped.*total_time/)
  assert.match(text, /examined subset/)
  assert.match(text, /opencode api get \/api\/session\//)
})
