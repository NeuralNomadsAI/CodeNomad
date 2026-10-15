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

    assert.equal(tracker.update(), false, "An unchanged height is no change")
    element.clientHeight = 450; assert.equal(tracker.update(), true)
    element.clientHeight = 420; tracker.update()
    assert.equal(frames.size, 1, "One frame per burst")
    flush(); assert.deepEqual(deltas, [80], "A shrink is a positive delta")

    element.clientHeight = 0; tracker.update()
    element.clientHeight = 600; tracker.update()
    assert.equal(frames.size, 0, "Hiding and mounting only rebase")
    element.clientHeight = 650; tracker.update(false)
    assert.equal(frames.size, 0, "A declined change only rebases")
    element.clientHeight = 700; tracker.update(); flush()
    assert.deepEqual(deltas, [80, -50])

    element.clientHeight = 600; tracker.update(); tracker.dispose(); flush()
    assert.deepEqual(deltas, [80, -50], "Disposal drops a pending delta")
  } finally {
    globalThis.requestAnimationFrame = previousFrame
    globalThis.cancelAnimationFrame = previousCancel
  }
})
