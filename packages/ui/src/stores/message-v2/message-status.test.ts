import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { deriveMessageStatus } from "./message-status.ts"

// This derivation is the single source of truth shared by the live SSE path
// (session-events) and the REST snapshot path (session-api). It follows the
// OpenCode SDK contract: assistant completion is `time.completed`; user
// messages are complete once persisted; only assistants carry `error`.
describe("deriveMessageStatus", () => {
  it("treats persisted user messages as complete (no server pending state)", () => {
    assert.equal(deriveMessageStatus({ role: "user", time: { } }), "complete")
    assert.equal(deriveMessageStatus({ role: "user", time: { completed: undefined } }), "complete")
  })

  it("derives assistant completion from time.completed", () => {
    assert.equal(deriveMessageStatus({ role: "assistant", time: { completed: 1720000000000 } }), "complete")
  })

  it("derives assistant streaming when time.completed is absent or zero", () => {
    assert.equal(deriveMessageStatus({ role: "assistant", time: {} }), "streaming")
    assert.equal(deriveMessageStatus({ role: "assistant", time: { completed: 0 } }), "streaming")
    assert.equal(deriveMessageStatus({ role: "assistant" }), "streaming")
  })

  it("derives error when an assistant error is present, regardless of completion", () => {
    assert.equal(deriveMessageStatus({ role: "assistant", error: { name: "Error", data: {} } }), "error")
    assert.equal(
      deriveMessageStatus({ role: "assistant", error: { name: "Error", data: {} }, time: { completed: 1720000000000 } }),
      "error",
    )
  })
})
