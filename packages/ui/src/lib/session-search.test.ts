import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { findTextSearchOccurrences } from "./session-search-matches.ts"

test("session search bounds matches from repetitive output", () => {
  assert.equal(findTextSearchOccurrences("match ".repeat(2_000), "match", 1_000).length, 1_000)
})

test("text occurrence search is case-insensitive on the original string", () => {
  assert.equal(findTextSearchOccurrences("Needle", "needle", 1)[0]?.start, 0)
})

test("text occurrence search retains original offsets around expanding case folds", () => {
  assert.deepEqual(findTextSearchOccurrences("İİxy", "xy", 1)[0], {
    start: 2,
    end: 4,
    occurrence: 0,
    preview: "İİxy",
  })
})

test("text occurrence search retains original offsets around contextual case folds", () => {
  assert.deepEqual(findTextSearchOccurrences("I\u0307abc", "ABC", 1)[0], {
    start: 2,
    end: 5,
    occurrence: 0,
    preview: "I\u0307abc",
  })
})

test("oversized literal search preserves the complete case-insensitive query without one oversized regex", () => {
  const query = "Ab".repeat(50_000)
  const prefix = "prefix:"
  const result = findTextSearchOccurrences(`${prefix}${query.toLowerCase()}:suffix`, query, 1)[0]
  assert.equal(result?.start, prefix.length)
  assert.equal(result?.end, prefix.length + query.length)
})

test("message search errors settle the current revision before refresh scheduling", async () => {
  const source = await readFile(new URL("../components/message-section.tsx", import.meta.url), "utf8")
  assert.match(source, /catch \(error\)[\s\S]*lastCompletedSearchRevision = store\(\)\.getSessionRevision\(props\.sessionId\)[\s\S]*searchRefreshRequested = false[\s\S]*finally/)
})
