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
  it("separates malformed data from callback failures without reconnect or replay", () => {
    const source = new FakeEventSource()
    const errors: string[] = []
    const received: unknown[] = []
    let reconnects = 0
    attachEventSourceHandlers(source as unknown as EventSource, {
      onEvent(event) { received.push(event); throw new Error("consumer failed") },
      onError() { reconnects++ },
      logger: { warn() {}, error(message) { errors.push(message) } },
    })
    source.onmessage!(new MessageEvent("message", { data: "malformed" }))
    source.onmessage!(new MessageEvent("message", { data: '{"type":"fixture"}' }))
    assert.deepEqual(errors, ["Failed to parse event", "Failed to dispatch event"])
    assert.deepEqual(received, [{ type: "fixture" }])
    assert.equal(reconnects, 0)
  })

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
