import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { deriveDisplayConnectionStatus } from "./connection-status.ts"

describe("deriveDisplayConnectionStatus", () => {
  it("overlays connecting while transport is down for connected instances", () => {
    assert.equal(deriveDisplayConnectionStatus("connected", "disconnected"), "connecting")
  })

  it("restores previous connected status when transport reconnects", () => {
    assert.equal(deriveDisplayConnectionStatus("connected", "connected"), "connected")
  })

  it("preserves disconnected instance status while transport is down", () => {
    assert.equal(deriveDisplayConnectionStatus("disconnected", "disconnected"), "disconnected")
  })

  it("preserves error instance status while transport is down", () => {
    assert.equal(deriveDisplayConnectionStatus("error", "disconnected"), "error")
  })

  it("does not clear legitimate instance connecting status after transport opens", () => {
    assert.equal(deriveDisplayConnectionStatus("connecting", "connected"), "connecting")
  })
})
