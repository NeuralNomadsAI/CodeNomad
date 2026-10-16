import assert from "node:assert/strict"
import { test } from "node:test"
import { trackHeightDelta } from "./height-delta.ts"

test("height changes coalesce into one per-frame delta and zero heights only rebase", () => {
  const previousFrame = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  globalThis.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)) }
  try {
    const element = { clientHeight: 500 }
    const deltas: number[] = []
    const tracker = trackHeightDelta(element as HTMLElement, delta => deltas.push(delta))

    tracker.update()
    assert.equal(frames.size, 0, "An unchanged height is no change")
    element.clientHeight = 450; tracker.update()
    element.clientHeight = 420; tracker.update()
    assert.equal(frames.size, 1, "One frame per burst")
    flush(); assert.deepEqual(deltas, [80], "A shrink is a positive delta")

    element.clientHeight = 0; tracker.update()
    element.clientHeight = 600; tracker.update()
    assert.equal(frames.size, 0, "Hiding and mounting only rebase")
    element.clientHeight = 650; tracker.update(); flush()
    assert.deepEqual(deltas, [80, -50])

    element.clientHeight = 600; assert.equal(tracker.update(), true)
    assert.equal(tracker.update(), false, "Only a change is reported")
    element.clientHeight = 550; assert.equal(tracker.update(false), true); flush()
    assert.deepEqual(deltas, [80, -50, 0], "An unanchored change drops the pending delta and only rebases")

    element.clientHeight = 600; tracker.update(); tracker.dispose(); flush()
    element.clientHeight = 500; tracker.update(); flush()
    assert.deepEqual(deltas, [80, -50, 0], "Disposal drops the pending delta and ignores later changes")
    assert.equal(frames.size, 0)
  } finally {
    globalThis.requestAnimationFrame = previousFrame
    globalThis.cancelAnimationFrame = previousCancel
  }
})
