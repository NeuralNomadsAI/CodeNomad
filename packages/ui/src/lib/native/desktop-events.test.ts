import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createTerminalErrorNotifier, mapDesktopEventTransportStatus } from "./desktop-events.ts"

describe("createTerminalErrorNotifier", () => {
  it("calls onError once for repeated terminal notifications", () => {
    let errors = 0
    const notifyTerminalError = createTerminalErrorNotifier({
      onError: () => {
        errors += 1
      },
    })

    notifyTerminalError()
    notifyTerminalError()

    assert.equal(errors, 1)
  })
})

describe("mapDesktopEventTransportStatus", () => {
  it("maps native connected state to shared connected state", () => {
    assert.equal(mapDesktopEventTransportStatus("connected"), "connected")
  })

  it("maps native connecting state to shared connecting state", () => {
    assert.equal(mapDesktopEventTransportStatus("connecting"), "connecting")
  })

  it("maps native transient failures to shared disconnected state", () => {
    assert.equal(mapDesktopEventTransportStatus("disconnected"), "disconnected")
    assert.equal(mapDesktopEventTransportStatus("error"), "disconnected")
    assert.equal(mapDesktopEventTransportStatus("unauthorized"), "disconnected")
  })
})
