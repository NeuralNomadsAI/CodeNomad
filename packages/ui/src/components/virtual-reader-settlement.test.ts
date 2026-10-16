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

test("an element hold aligns at once, then on every frame of a window layout never extends", () => {
  const previousFrame = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0, aligned = 0, held = true
  globalThis.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  /** Runs `count` animation frames; returns how many ran before the queue emptied. */
  const step = (count: number) => {
    let ran = 0
    while (ran < count && frames.size) {
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(fn => fn(0))
      ran++
    }
    return ran
  }
  try {
    const reader = createVirtualReaderSettlement({
      enabled: () => true,
      getAnchor: () => ({ key: "visible", offset: 0 }),
      align: () => { aligned++; return held },
    })
    const element = {} as HTMLElement
    reader.hold({ key: "revealed", offset: 8, element })
    assert.equal(aligned, 1, "The first correction is synchronous")
    step(5); assert.equal(aligned, 6, "Each frame of the window re-measures the element")
    assert.equal(reader.capture().anchor?.key, "revealed", "A window shift retains the held anchor")
    step(15); reader.notify()
    // 1 + 20 frames so far: the window ends after 30, whatever layout or scrolling does.
    assert.equal(step(100), 9, "Layout notifications never extend the window")
    assert.equal(aligned, 30)
    assert.equal(reader.held(), undefined, "The hold ends with its window")
    reader.notify(); assert.equal(frames.size, 0)
    reader.hold({ key: "revealed", offset: 8, element })
    held = false
    reader.notify(); step(1)
    assert.equal(reader.held(), undefined, "A lost element releases the hold")
    assert.equal(reader.capture().anchor?.key, "visible", "Then the visible reader is captured again")
    held = true
    reader.settle(reader.capture()); step(100)
    const before = aligned
    reader.notify(); assert.equal(frames.size, 1, "A retained reader re-arms on layout or scroll"); step(100)
    assert.equal(aligned, before + 12)
  } finally {
    globalThis.requestAnimationFrame = previousFrame
    globalThis.cancelAnimationFrame = previousCancel
  }
})
