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

test("an explicit hold aligns at once, follows later layouts and releases a lost anchor", () => {
  const previousFrame = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0, aligned = 0, held = true
  globalThis.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  const drain = () => {
    while (frames.size) {
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(fn => fn(0))
    }
  }
  try {
    const reader = createVirtualReaderSettlement({
      enabled: () => true,
      getAnchor: () => ({ key: "visible", offset: 0 }),
      align: () => { aligned++; return held },
    })
    reader.hold({ key: "revealed", offset: 8 })
    assert.equal(aligned, 1, "The first correction is synchronous")
    drain(); assert.equal(aligned, 12)
    assert.equal(reader.capture().anchor?.key, "revealed", "A window shift retains the held anchor")
    reader.notify(); drain(); assert.equal(aligned, 24)
    held = false
    reader.notify(); drain(); assert.equal(aligned, 25)
    assert.equal(reader.capture().anchor?.key, "visible", "A lost anchor returns to the visible reader")
    reader.notify(); assert.equal(frames.size, 0)
  } finally {
    globalThis.requestAnimationFrame = previousFrame
    globalThis.cancelAnimationFrame = previousCancel
  }
})
