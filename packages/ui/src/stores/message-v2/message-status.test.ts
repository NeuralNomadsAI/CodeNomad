import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { deriveMessageStatus } from "./message-status.ts"

// This derivation is the single source of truth shared by the live SSE path
// (session-events) and the REST snapshot path (session-api). It must behave
// identically for user and assistant infos — a user message without a
// recorded end time is just as in-flight as an assistant one.
describe("deriveMessageStatus", () => {
  it("derives streaming when no end time is recorded", () => {
    assert.equal(deriveMessageStatus({ time: {} }), "streaming")
    assert.equal(deriveMessageStatus({ time: { end: 0 } }), "streaming")
    assert.equal(deriveMessageStatus({}), "streaming")
  })

  it("derives complete once an end time is recorded", () => {
    assert.equal(deriveMessageStatus({ time: { end: 1720000000000 } }), "complete")
  })

  it("derives error when an error is present, regardless of end time", () => {
    assert.equal(deriveMessageStatus({ error: { name: "Error", data: {} } }), "error")
    assert.equal(deriveMessageStatus({ error: { name: "Error", data: {} }, time: { end: 1720000000000 } }), "error")
  })
})
