import test from "node:test"
import assert from "node:assert/strict"
import { parseSessionFilterQuery } from "./session-filter-query"

test("parseSessionFilterQuery: extracts is:pinned and returns sanitized text", () => {
  const result = parseSessionFilterQuery("is:pinned auth refactor")
  assert.equal(result.pinnedFilter, true)
  assert.equal(result.sanitizedQuery, "auth refactor")
})

test("parseSessionFilterQuery: extracts is:unpinned (case insensitive) and returns sanitized text", () => {
  const result = parseSessionFilterQuery("fix bug IS:UNPINNED")
  assert.equal(result.pinnedFilter, false)
  assert.equal(result.sanitizedQuery, "fix bug")
})

test("parseSessionFilterQuery: returns undefined pinnedFilter when no tokens present", () => {
  const result = parseSessionFilterQuery("just normal search")
  assert.equal(result.pinnedFilter, undefined)
  assert.equal(result.sanitizedQuery, "just normal search")
})

test("parseSessionFilterQuery: handles token-only queries", () => {
  const result = parseSessionFilterQuery("is:pinned")
  assert.equal(result.pinnedFilter, true)
  assert.equal(result.sanitizedQuery, "")
})
