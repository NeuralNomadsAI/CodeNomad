import assert from "node:assert/strict"
import test from "node:test"
import { findTextSearchOccurrences } from "./session-search-matches.ts"

test("session search bounds matches from repetitive output", () => {
  assert.equal(findTextSearchOccurrences("match ".repeat(2_000), "match", 1_000).length, 1_000)
})

test("text occurrence search reuses a bounded normalized query", () => {
  assert.equal(findTextSearchOccurrences("Needle", "needle", 1, "needle")[0]?.start, 0)
})
