import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ConnectionResyncGate } from "./connection-resync-gate.ts"

describe("connection resync gate", () => {
  it("skips initial connection and resyncs once after a stream failure", () => {
    const gate = new ConnectionResyncGate()
    assert.equal(gate.observe("instance", "connecting"), false)
    assert.equal(gate.observe("instance", "connected"), false)
    assert.equal(gate.observe("instance", "error"), false)
    assert.equal(gate.observe("instance", "connected"), true)
    assert.equal(gate.observe("instance", "connected"), false)
  })

  it("does not resync a deliberately stopped or cleared workspace", () => {
    const gate = new ConnectionResyncGate()
    assert.equal(gate.observe("instance", "disconnected", "workspace stopped"), false)
    assert.equal(gate.observe("instance", "connected"), false)
    gate.observe("instance", "disconnected")
    gate.clear("instance")
    assert.equal(gate.observe("instance", "connected"), false)
  })

  it("does not claim browser transport reconnect authority", () => {
    const gate = new ConnectionResyncGate()
    assert.equal("observeTransport" in gate, false)
  })
})
