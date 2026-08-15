import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isInitialMessageLoad } from "./message-loading-visibility.ts"

describe("message loading visibility", () => {
  it("shows loading UI only before the first message snapshot", () => {
    assert.equal(isInitialMessageLoad(true, 0), true)
    assert.equal(isInitialMessageLoad(false, 0), false)
    assert.equal(isInitialMessageLoad(true, 1), false)
    assert.equal(isInitialMessageLoad(true, 20), false)
  })

  it("keeps established timeline state during a background refresh", () => {
    assert.equal(isInitialMessageLoad(true, 12), false)
  })
})
