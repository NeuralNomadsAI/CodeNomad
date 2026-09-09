import assert from "node:assert/strict"
import { test } from "node:test"
import { createVirtualReaderSettlement } from "./virtual-reader-settlement.ts"

test("reader settlement sleeps between layouts and cannot resurrect cancelled ownership", () => {
  const previousFrame = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0, enabled = true, aligned = 0
  globalThis.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  const drain = () => {
    let count = 0
    while (frames.size) {
      assert.ok(++count <= 12, "Each layout notification schedules bounded work")
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(fn => fn(0))
    }
  }
  try {
    const reader = createVirtualReaderSettlement({
      enabled: () => enabled,
      getAnchor: () => ({ key: "reader", offset: -24 }),
      align: anchor => { assert.deepEqual(anchor, { key: "reader", offset: -24 }); aligned++ },
    })
    const cancelled = reader.capture()
    reader.cancel()
    reader.settle(cancelled)
    assert.equal(frames.size, 0, "A gesture before the deferred roll cannot be undone")
    reader.settle(reader.capture())
    drain(); assert.equal(aligned, 12)
    assert.equal(frames.size, 0, "An idle retained reader does not keep running frames")
    reader.notify(); drain(); assert.equal(aligned, 24, "Late layout changes retain the same reader")
    reader.notify(); reader.cancel(); drain(); assert.equal(aligned, 24)
    reader.notify(); assert.equal(frames.size, 0)
    reader.settle(reader.capture()); enabled = false; drain(); assert.equal(aligned, 24)
  } finally {
    globalThis.requestAnimationFrame = previousFrame
    globalThis.cancelAnimationFrame = previousCancel
  }
})
