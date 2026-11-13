import assert from "node:assert/strict"
import { test } from "node:test"
import { scheduleDeferredHighlight } from "./markdown-highlight-schedule"

/** Installs a capturing idle scheduler; returns the queued drains. */
function captureIdle(): { drains: Array<() => void> } {
  const drains: Array<() => void> = []
  ;(globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (callback: () => void) => {
    drains.push(callback)
    return drains.length
  }
  return { drains }
}

test("an idle drain admits exactly one queued render and rearms", () => {
  const { drains } = captureIdle()
  const rendered: number[] = []
  for (let index = 0; index < 3; index++) scheduleDeferredHighlight(() => rendered.push(index))
  assert.equal(drains.length, 1, "one drain is armed")

  drains.shift()!()
  assert.deepEqual(rendered, [0], "the first drain renders only the first queued render")
  assert.equal(drains.length, 1, "the drain rearms with the remaining queue")

  drains.shift()!()
  assert.deepEqual(rendered, [0, 1])
  drains.shift()!()
  assert.deepEqual(rendered, [0, 1, 2])
  assert.equal(drains.length, 0, "an emptied queue arms nothing")
})

test("a drain over an empty queue arms nothing", () => {
  const { drains } = captureIdle()
  scheduleDeferredHighlight(() => {})
  const drain = drains.shift()!
  drain()
  assert.equal(drains.length, 0, "the emptied queue does not rearm")
  drain()
  assert.equal(drains.length, 0)
})
