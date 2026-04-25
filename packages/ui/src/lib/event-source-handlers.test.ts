import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { attachEventSourceHandlers } from "./event-source-handlers.ts"

class FakeEventSource extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
}

const logger = {
  warn() {},
  error() {},
}

describe("attachEventSourceHandlers", () => {
  it("requests reconnect when EventSource emits close", () => {
    const source = new FakeEventSource()
    let reconnects = 0

    attachEventSourceHandlers(source as unknown as EventSource, {
      onEvent() {},
      onError: () => {
        reconnects += 1
      },
      logger,
    })

    source.dispatchEvent(new Event("close"))

    assert.equal(reconnects, 1)
  })

  it("requests reconnect when EventSource invokes onclose", () => {
    const source = new FakeEventSource()
    let reconnects = 0

    attachEventSourceHandlers(source as unknown as EventSource, {
      onEvent() {},
      onError: () => {
        reconnects += 1
      },
      logger,
    })

    source.onclose?.()

    assert.equal(reconnects, 1)
  })

  it("requests reconnect once when a close notification hits multiple handlers", () => {
    const source = new FakeEventSource()
    let reconnects = 0

    attachEventSourceHandlers(source as unknown as EventSource, {
      onEvent() {},
      onError: () => {
        reconnects += 1
      },
      logger,
    })

    source.onclose?.()
    source.dispatchEvent(new Event("close"))
    source.onerror?.()

    assert.equal(reconnects, 1)
  })
})
