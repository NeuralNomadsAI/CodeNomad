import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { canMarkSessionIdleSeen } from "./session-idle-attention.ts"

describe("idle marker attention", () => {
  it("retains unseen idle while hidden or blurred and clears only when active, visible, and focused", () => {
    assert.equal(canMarkSessionIdleSeen({ active: true, visibilityState: "hidden", focused: true }), false)
    assert.equal(canMarkSessionIdleSeen({ active: true, visibilityState: "visible", focused: false }), false)
    assert.equal(canMarkSessionIdleSeen({ active: false, visibilityState: "visible", focused: true }), false)
    assert.equal(canMarkSessionIdleSeen({ active: true, visibilityState: "visible", focused: true }), true)
  })
})
