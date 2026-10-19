import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "./api-client"
import { connectWorkspaceEvents } from "./event-transport"

type Deliver = (event: unknown) => void

interface FakeTransport {
  deliver: Deliver
  emitError: () => void
}

describe("workspace event transport coalescing", () => {
  const install = (mock: { method: (object: object, key: string, implementation: (...args: never[]) => unknown) => unknown }): FakeTransport => {
    const transport: FakeTransport = { deliver: () => {}, emitError: () => {} }
    mock.method(serverApi as unknown as object, "connectEvents", ((onEvent: (event: unknown) => void, onError?: () => void) => {
      transport.deliver = onEvent
      transport.emitError = () => onError?.()
      return { close() {}, onopen: null }
    }) as never)
    return transport
  }

  it("coalesces same-tick events into one FIFO batch per flush", async ctx => {
    const transport = install(ctx.mock)
    const batches: unknown[][] = []
    const connection = await connectWorkspaceEvents({ onBatch: events => batches.push([...events]) })
    try {
      transport.deliver({ type: "a" })
      transport.deliver({ type: "b" })
      transport.deliver({ type: "c" })
      assert.equal(batches.length, 0, "events received in the same tick stay buffered")

      await new Promise(resolve => setTimeout(resolve, 0))
      assert.deepEqual(batches, [[{ type: "a" }, { type: "b" }, { type: "c" }]], "one batch preserves arrival order")

      transport.deliver({ type: "d" })
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.equal(batches.length, 2, "a later tick flushes its own batch")
      assert.deepEqual(batches[1], [{ type: "d" }])
    } finally {
      connection.disconnect()
    }
  })

  it("flushes buffered events before reporting transport errors", async ctx => {
    const transport = install(ctx.mock)
    const sequence: string[] = []
    const connection = await connectWorkspaceEvents({
      onBatch: events => sequence.push(`batch:${events.length}`),
      onError: () => sequence.push("error"),
      onStatus: status => sequence.push(`status:${status}`),
    })
    try {
      transport.deliver({ type: "a" })
      transport.deliver({ type: "b" })
      transport.emitError()
      const errorIndex = sequence.indexOf("error")
      assert.ok(errorIndex > -1, "the error is reported")
      assert.ok(sequence.slice(0, errorIndex).includes("batch:2"), "buffered events flush before the error")
    } finally {
      connection.disconnect()
    }
  })

  it("flushes buffered events synchronously on disconnect", async ctx => {
    const transport = install(ctx.mock)
    const batches: unknown[][] = []
    const connection = await connectWorkspaceEvents({ onBatch: events => batches.push([...events]) })
    transport.deliver({ type: "a" })
    connection.disconnect()
    assert.deepEqual(batches, [[{ type: "a" }]], "delivered events are never dropped by a disconnect")
  })
})
