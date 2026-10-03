import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"
import { findHistoryMatches, planSessionTechnicalPartDeletion, executeSessionTechnicalPartDeletion, walkHistory } from "./session-history"
import { getOpenCodeInstanceGeneration } from "./opencode-data"

const empty = { status: "page" as const, scanned: 32, tools: 0, reasoning: 0, skipped: 0, hits: [], candidates: [], cursor: null }
const query = { query: "needle", purpose: "search" as const, includeTechnical: true, sessionID: "s" }
test("workspace search fills a result page across sparse scan batches and continues losslessly", async () => {
  const original = serverApi.querySessionHistory
  const cursors: Array<string | undefined> = []
  const progress: number[] = []
  try {
    serverApi.querySessionHistory = async (_instance, input) => {
      cursors.push(input.cursor)
      const n = Number(input.cursor ?? 0)
      if (n === 0) return { ...empty, skipped: 1, cursor: "1" }
      return { ...empty, cursor: n < 35 ? String(n + 1) : null, hits: [{ sessionID: `s-${n}`, messageID: `m-${n}`, role: "user", partIndex: 0, kind: "text", excerpt: "needle" }] }
    }
    const workspaceQuery = { ...query, sessionID: undefined }
    const result = await findHistoryMatches("history-tests", workspaceQuery, new AbortController().signal, page => progress.push(page.hits.length))
    assert.equal(result.hits.length, 32)
    assert.equal(result.skipped, 1)
    assert.equal(result.cursor, "33")
    assert.deepEqual(progress, Array.from({ length: 33 }, (_, n) => n))
    const next = await findHistoryMatches("history-tests", { ...workspaceQuery, cursor: result.cursor! }, new AbortController().signal)
    assert.equal(next.cursor, null)
    assert.deepEqual([...result.hits, ...next.hits].map(hit => hit.messageID), Array.from({ length: 35 }, (_, n) => `m-${n + 1}`))
    assert.equal(cursors.length, 36)
  } finally { serverApi.querySessionHistory = original }
})
test("search retains an entire final transport batch and fences cancellation and cyclic cursors", async () => {
  const original = serverApi.querySessionHistory
  try {
    const hit = { sessionID: "s", role: "user", partIndex: 0, kind: "text" as const, excerpt: "needle" }
    serverApi.querySessionHistory = async (_instance, input) => ({ ...empty, cursor: input.cursor ? "third" : "second",
      hits: Array.from({ length: input.cursor ? 32 : 31 }, (_, n) => ({ ...hit, messageID: `${input.cursor ?? "first"}-${n}` })) })
    const result = await findHistoryMatches("history-tests", query, new AbortController().signal)
    assert.equal(result.hits.length, 63)
    assert.equal(new Set(result.hits.map(hit => hit.messageID)).size, 63)
    assert.equal(result.cursor, "third")
    const controller = new AbortController()
    let published = 0
    serverApi.querySessionHistory = async () => { controller.abort(); return empty }
    await assert.rejects(findHistoryMatches("history-tests", query, controller.signal, () => published++), /abort/i)
    assert.equal(published, 0)
    serverApi.querySessionHistory = async () => ({ ...empty, cursor: "repeat", hits: [{ ...hit, messageID: "m" }] })
    await assert.rejects(findHistoryMatches("history-tests", { ...query, cursor: "repeat" }, new AbortController().signal))
  } finally { serverApi.querySessionHistory = original }
})
test("aborted history requests never publish a late page or start another page", async () => {
  const original = serverApi.querySessionHistory
  const controller = new AbortController()
  let resolve!: (value: typeof empty) => void
  let requests = 0, visits = 0
  try {
    serverApi.querySessionHistory = () => { requests++; return new Promise(done => { resolve = done }) }
    const pending = walkHistory("history-tests", query, () => visits++, controller.signal)
    controller.abort()
    resolve(empty)
    await assert.rejects(pending, /abort/i)
    assert.equal(visits, 0)
    assert.equal(requests, 1)
  } finally { serverApi.querySessionHistory = original }
})
test("repeated cursors fail rather than reporting a complete cleanup plan", async () => {
  const original = serverApi.querySessionHistory
  try {
    serverApi.querySessionHistory = async () => ({ ...empty, cursor: "repeat" })
    await assert.rejects(planSessionTechnicalPartDeletion("history-tests", "s"))
  } finally { serverApi.querySessionHistory = original }
})
test("cleanup cancellation stops between batches, preserving confirmed revisions", async () => {
  const original = serverApi.pruneSessionHistory
  const controller = new AbortController()
  const candidates = Array.from({ length: 33 }, (_, index) => ({ messageID: `m${index}`, revision: "a".repeat(64), toolCount: 1, reasoningCount: 0 }))
  let calls = 0
  try {
    serverApi.pruneSessionHistory = async (_instance, input) => {
      calls++
      assert.deepEqual(input.candidates, candidates.slice(0, 16))
      return { results: input.candidates.map(item => ({ messageID: item.messageID,
        result: { status: "pruned", messageID: item.messageID, revision: "b".repeat(64), removedCount: 1 } })) }
    }
    await assert.rejects(executeSessionTechnicalPartDeletion({ instanceId: "history-tests", sessionId: "s",
      generation: getOpenCodeInstanceGeneration("history-tests"), toolCount: 33, reasoningCount: 0, skipped: 0, candidates },
    { signal: controller.signal, progress: () => controller.abort() }), /abort/i)
    assert.equal(calls, 1)
  } finally { serverApi.pruneSessionHistory = original }
})
