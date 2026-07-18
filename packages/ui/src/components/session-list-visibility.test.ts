import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { shouldMountSessionList, shouldRenderSessionRows } from "./session-list-visibility"

describe("session list visibility", () => {
  it("does not mount inside a closed floating drawer", () => {
    assert.equal(shouldMountSessionList("floating-closed"), false)
    assert.equal(shouldMountSessionList("floating-open"), true)
    assert.equal(shouldMountSessionList("pinned"), true)
  })

  it("keeps the error state exclusive from session rows", () => {
    assert.equal(shouldRenderSessionRows(true, true), false)
    assert.equal(shouldRenderSessionRows(false, true), true)
    assert.equal(shouldRenderSessionRows(false, false), false)
  })
})
