import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { deriveDisplayConnectionStatus, seedConnectionStatusIfMissing } from "./connection-status.ts"

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

describe("seedConnectionStatusIfMissing", () => {
  it("does not overwrite a connected status received before client attachment", () => {
    const connected = new Map([["workspace-1", "connected" as const]])
    assert.equal(seedConnectionStatusIfMissing(connected, "workspace-1", "connecting"), connected)
    assert.equal(connected.get("workspace-1"), "connected")
  })

  it("seeds connecting when no stream status has arrived", () => {
    const seeded = seedConnectionStatusIfMissing(new Map(), "workspace-1", "connecting")
    assert.equal(seeded.get("workspace-1"), "connecting")
  })
})
