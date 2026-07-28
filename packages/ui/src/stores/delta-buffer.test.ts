import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { setTimeout as delay } from "node:timers/promises"

import {
  clearPendingDeltasForPart,
  enqueueDelta,
  flushPendingDeltasForMessage,
  resetDeltaBufferForTests,
  setFlushCallback,
  setRecoveryCallback,
} from "./delta-buffer.ts"

type DeltaBatch = Array<{ instanceId: string; messageId: string; partId: string; field: string; delta: string }>

describe("delta buffer", () => {
  beforeEach(() => {
    resetDeltaBufferForTests()
  })

  afterEach(() => {
    resetDeltaBufferForTests()
  })

  it("concatenates matching deltas and flushes them once", async () => {
    const flushed: DeltaBatch[] = []
    setFlushCallback((batch) => flushed.push(batch))

    enqueueDelta("instance-1", "message-1", "part-1", "text", "hello")
    enqueueDelta("instance-1", "message-1", "part-1", "text", " world")

    await delay(75)

    assert.equal(flushed.length, 1)
    assert.deepEqual(flushed[0], [
      { instanceId: "instance-1", messageId: "message-1", partId: "part-1", field: "text", delta: "hello world" },
    ])
  })

  it("clears pending deltas for a full part update before a stale timer flush", async () => {
    const flushed: DeltaBatch[] = []
    setFlushCallback((batch) => flushed.push(batch))

    enqueueDelta("instance-1", "message-1", "part-1", "text", "stale")
    clearPendingDeltasForPart("instance-1", "message-1", "part-1")

    await delay(75)

    assert.deepEqual(flushed, [])
  })

  it("flushes pending message deltas before applying message.updated", async () => {
    const timerFlushes: DeltaBatch[] = []
    const applied: Array<{ instanceId: string; delta: { messageId: string; partId: string; field: string; delta: string } }> = []
    setFlushCallback((batch) => timerFlushes.push(batch))

    enqueueDelta("instance-1", "message-1", "part-1", "text", "before update")
    flushPendingDeltasForMessage("instance-1", "message-1", (instanceId, delta) => {
      applied.push({ instanceId, delta })
    })

    await delay(75)

    assert.deepEqual(applied, [
      {
        instanceId: "instance-1",
        delta: { messageId: "message-1", partId: "part-1", field: "text", delta: "before update" },
      },
    ])
    assert.deepEqual(timerFlushes, [])
  })

  it("keeps clear and flush operations isolated by instance, message, and part", async () => {
    const timerFlushes: DeltaBatch[] = []
    const applied: Array<{ instanceId: string; delta: { messageId: string; partId: string; field: string; delta: string } }> = []
    setFlushCallback((batch) => timerFlushes.push(batch))

    enqueueDelta("instance-1", "message-1", "part-1", "text", "drop")
    enqueueDelta("instance-1", "message-1", "part-2", "text", "same message")
    enqueueDelta("instance-1", "message-2", "part-1", "text", "other message")
    enqueueDelta("instance-2", "message-1", "part-1", "text", "other instance")

    clearPendingDeltasForPart("instance-1", "message-1", "part-1")
    flushPendingDeltasForMessage("instance-1", "message-1", (instanceId, delta) => {
      applied.push({ instanceId, delta })
    })

    await delay(75)

    assert.deepEqual(applied, [
      {
        instanceId: "instance-1",
        delta: { messageId: "message-1", partId: "part-2", field: "text", delta: "same message" },
      },
    ])
    assert.deepEqual(timerFlushes, [
      [
        { instanceId: "instance-1", messageId: "message-2", partId: "part-1", field: "text", delta: "other message" },
        { instanceId: "instance-2", messageId: "message-1", partId: "part-1", field: "text", delta: "other instance" },
      ],
    ])
  })

  it("drops oversized deltas and requests bounded authoritative recovery", async () => {
    const recoveries: unknown[] = []
    const flushed: DeltaBatch[] = []
    setRecoveryCallback((pending) => recoveries.push(pending))
    setFlushCallback((batch) => flushed.push(batch))

    enqueueDelta("instance-1", "message-1", "part-1", "text", "x".repeat(300_000), "session-1")
    await delay(75)

    assert.deepEqual(flushed, [])
    assert.deepEqual(recoveries, [{
      instanceId: "instance-1", sessionId: "session-1", messageId: "message-1", partId: "part-1", field: "text",
    }])
  })
})
