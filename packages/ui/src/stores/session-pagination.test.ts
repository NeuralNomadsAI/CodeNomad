import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applySessionPage, getDefaultSessionPaginationState } from "./session-pagination-model.ts"

describe("session pagination cursor state", () => {
  it("stores the v2 next cursor and appends loaded pages", () => {
    const firstPage = applySessionPage(getDefaultSessionPaginationState(), ["root-1", "root-2"], true, true, "cursor-page-2")

    assert.deepEqual(firstPage.ids, ["root-1", "root-2"])
    assert.equal(firstPage.hasMore, true)
    assert.equal(firstPage.nextCursor, "cursor-page-2")

    const secondPage = applySessionPage(firstPage, ["root-2", "root-3"], false, false, undefined)

    assert.deepEqual(secondPage.ids, ["root-1", "root-2", "root-3"])
    assert.equal(secondPage.hasMore, false)
    assert.equal(secondPage.nextCursor, undefined)
  })

  it("resets ids and cursor when a fresh first page is loaded", () => {
    const previous = applySessionPage(getDefaultSessionPaginationState(), ["old-root"], true, true, "old-cursor")
    const next = applySessionPage(previous, ["new-root"], false, true, undefined)

    assert.deepEqual(next.ids, ["new-root"])
    assert.equal(next.hasMore, false)
    assert.equal(next.nextCursor, undefined)
  })
})
