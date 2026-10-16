import assert from "node:assert/strict"
import { test } from "node:test"
import { createVirtualReaderSettlement } from "./virtual-reader-settlement.ts"

test("a hold aligns at once, then on every frame of a window that nothing extends, then releases", () => {
  const previousFrame = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0, aligned = 0, held = true, enabled = true
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
      enabled: () => enabled,
      align: () => { aligned++; return held },
    })
    const element = {} as HTMLElement
    reader.hold({ key: "revealed", offset: 8, element })
    assert.equal(aligned, 1, "The first correction is synchronous")
    step(5); assert.equal(aligned, 6, "Each frame of the window re-measures the element")
    assert.equal(reader.held()?.key, "revealed")
    // 1 + 5 frames so far: the window ends after 30.
    assert.equal(step(100), 24)
    assert.equal(aligned, 30)
    assert.equal(reader.held(), undefined, "The hold ends with its window")
    assert.equal(frames.size, 0, "A released anchor keeps no frame running")
    // A jump's row, or the reader across a rolling window, is held the same way.
    reader.hold({ key: "jumped", offset: 0 })
    assert.equal(step(100), 29)
    assert.equal(reader.held(), undefined, "A row hold ends with its window")
    reader.hold({ key: "revealed", offset: 8, element })
    held = false
    step(1)
    assert.equal(reader.held(), undefined, "A lost element releases the hold")
    held = true
    reader.hold({ key: "jumped", offset: 0 })
    reader.cancel(); assert.equal(frames.size, 0, "A gesture cancels the hold")
    reader.hold({ key: "jumped", offset: 0 })
    enabled = false; step(1)
    assert.equal(reader.held(), undefined, "A disabled list releases the hold")
  } finally {
    globalThis.requestAnimationFrame = previousFrame
    globalThis.cancelAnimationFrame = previousCancel
  }
})
