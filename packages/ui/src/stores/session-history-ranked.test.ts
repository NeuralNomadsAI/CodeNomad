import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"
import { findRankedHistoryMatches, rankedHistoryNoticeKeys } from "./session-history"
import { destroyOpenCodeData } from "./opencode-data"
import { rankedExcerptParts, rankedSearchTerms } from "../lib/ranked-search"
import { sessionSearchDestination, setSessionSearchDestination, clearSessionSearchDestination } from "./session-search"
import type { RankedHistoryPage, RankedHistoryResult } from "../../../server/src/server/routes/session-history-ranked-contract"

const page: RankedHistoryPage = { version: 1, status: "ranked", scanned: 100, candidates: 3, judged: 3, skipped: 0,
  prefilterBypassed: 0, matchedSessions: 2, capped: true, exclusions: ["unknown_directory"], examinedBefore: 0, cursor: "older-window",
  hits: ["a", "b", "a"].map((sessionID, n) => ({ sessionID, messageID: `m-${n}`, role: "user", kind: "text", partIndex: 0, excerpt: "ÉTÉ rare", createdAt: n })) }

test("workspace ranked search is one bounded request and preserves native list order and notes", async () => {
  const original = serverApi.queryRankedHistory, literal = serverApi.querySessionHistory
  const calls: unknown[] = []
  try {
    serverApi.queryRankedHistory = async (_id, input) => { calls.push(input); return page }
    serverApi.querySessionHistory = async () => { throw new Error("Ranked search must not traverse literal pages") }
    const result = await findRankedHistoryMatches("ranked-unit", "rare ÉTÉ", false, new AbortController().signal)
    assert.deepEqual(calls, [{ version: 1, query: "rare ÉTÉ", includeTechnical: false, limit: 40 }])
    assert.equal(result, page)
    assert.deepEqual(rankedHistoryNoticeKeys(result), ["history.rankedRecent", "history.rankedCapped", "history.rankedExcluded"])
    assert.deepEqual(page.hits.map(hit => hit.sessionID), ["a", "b", "a"])
  } finally { serverApi.queryRankedHistory = original; serverApi.querySessionHistory = literal }
})

test("unsupported ranked search is explicit and starts no fallback traversal", async () => {
  const original = serverApi.queryRankedHistory
  try {
    serverApi.queryRankedHistory = async () => ({ status: "unsupported" })
    const result = await findRankedHistoryMatches("ranked-unit", "needle", false, new AbortController().signal)
    assert.deepEqual(result, { status: "unsupported" })
    assert.deepEqual(rankedHistoryNoticeKeys(result), ["history.rankedUnsupported"])
    assert.deepEqual(rankedHistoryNoticeKeys(undefined), [])
  } finally { serverApi.queryRankedHistory = original }
})

test("obsolete ranked reads abort before dispatch or reject late results without publication", async () => {
  const original = serverApi.queryRankedHistory
  let resolve!: (value: RankedHistoryResult) => void, calls = 0, published = 0
  const controller = new AbortController()
  try {
    serverApi.queryRankedHistory = async (_id, _input, signal) => {
      calls++; assert.equal(signal, controller.signal)
      return new Promise(done => { resolve = done })
    }
    const pending = findRankedHistoryMatches("ranked-unit", "old", false, controller.signal).then(() => published++)
    controller.abort(); resolve(page)
    await assert.rejects(pending, /abort/i)
    await assert.rejects(findRankedHistoryMatches("ranked-unit", "new", false, controller.signal), /abort/i)
    assert.equal(calls, 1); assert.equal(published, 0)
  } finally { serverApi.queryRankedHistory = original }
})

test("ranked reads fence connection replacement and surface blocked errors", async () => {
  const original = serverApi.queryRankedHistory
  try {
    serverApi.queryRankedHistory = async () => { destroyOpenCodeData("ranked-reconnect"); return page }
    await assert.rejects(findRankedHistoryMatches("ranked-reconnect", "needle", false, new AbortController().signal))
    serverApi.queryRankedHistory = async () => ({ status: "blocked", reason: "unavailable" })
    await assert.rejects(findRankedHistoryMatches("ranked-unit", "needle", false, new AbortController().signal))
  } finally { serverApi.queryRankedHistory = original }
})

test("ranked excerpts share native term extraction and highlight Unicode whole terms", () => {
  const terms = rankedSearchTerms("ÉTÉ été Français İstanbul İSTANBUL")
  assert.deepEqual(terms, ["Français", "İstanbul", "ÉTÉ"])
  const parts = rankedExcerptParts("ÉTÉ Français İstanbul étés", terms)
  assert.deepEqual(parts.filter(part => part.match).map(part => part.text), ["ÉTÉ", "Français", "İstanbul"])
  assert.equal(parts.map(part => part.text).join(""), "ÉTÉ Français İstanbul étés")
})

test("destination highlights remain exact-session-owned and clear on their owner only", () => {
  const match = { id: "hit", messageId: "m", role: "user" as const, start: 0, end: 0, occurrence: 0, preview: "rare" }
  setSessionSearchDestination("ranked-destination", "target", "rare ÉTÉ", match)
  clearSessionSearchDestination("ranked-destination", "source")
  assert.equal(sessionSearchDestination("ranked-destination", "source"), undefined)
  assert.equal(sessionSearchDestination("ranked-destination", "target")?.query, "rare ÉTÉ")
  clearSessionSearchDestination("ranked-destination", "target")
  assert.equal(sessionSearchDestination("ranked-destination", "target"), undefined)
})

test("every locale has the older-window action and exact range placeholders", async () => {
  for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const { messagingMessages } = await import(`../lib/i18n/messages/${locale}/messaging.ts`)
    assert.match(messagingMessages["history.rankedRecent"], /\{messages\}/, locale)
    assert.match(messagingMessages["history.rankedRange"], /\{start\}/, locale)
    assert.match(messagingMessages["history.rankedRange"], /\{end\}/, locale)
    assert(messagingMessages["history.furtherBack"], locale)
    assert(messagingMessages["history.rankedEmpty"], locale)
  }
})

test("older-window reads replace results, carry opaque cursors and reject obsolete continuations", async () => {
  const original = serverApi.queryRankedHistory, calls: any[] = [], controller = new AbortController()
  const older: RankedHistoryPage = { ...page, examinedBefore: 100, scanned: 80, cursor: null, hits: [page.hits[2]], capped: false, exclusions: [] }
  try {
    serverApi.queryRankedHistory = async (_id, input) => { calls.push(input); return input.cursor ? older : page }
    const first = await findRankedHistoryMatches("ranked-unit", "rare ÉTÉ", false, controller.signal)
    assert(first.status === "ranked")
    const second = await findRankedHistoryMatches("ranked-unit", "rare ÉTÉ", false, controller.signal, first.cursor!)
    assert.equal(second, older)
    assert.deepEqual(rankedHistoryNoticeKeys(second), ["history.rankedRange"])
    assert.equal(calls[1].cursor, "older-window"); assert.equal(calls[1].limit, 40)
    await findRankedHistoryMatches("ranked-unit", "new query", true, controller.signal)
    assert.equal(calls[2].cursor, undefined)
    serverApi.queryRankedHistory = async () => { controller.abort(); return older }
    await assert.rejects(findRankedHistoryMatches("ranked-unit", "rare ÉTÉ", false, controller.signal, "older-window"), /abort/i)
    assert.deepEqual(rankedHistoryNoticeKeys({ ...older, scanned: 0 }), ["history.rankedEmpty"])
  } finally { serverApi.queryRankedHistory = original }
})
