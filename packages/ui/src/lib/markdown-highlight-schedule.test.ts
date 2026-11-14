import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { scheduleDeferredHighlight } from "./markdown-highlight-schedule"

const globalScope = globalThis as unknown as Record<string, unknown>
let hadIdle = false
let originalIdle: unknown

afterEach(() => {
  // Node has no idle callbacks: restore the original state exactly,
  // including absence, so later tests in this process pick their own path.
  if (hadIdle) globalScope.requestIdleCallback = originalIdle
  else delete globalScope.requestIdleCallback
})

/** Installs a capturing idle scheduler; returns the queued drains. */
function captureIdle(): { drains: Array<() => void> } {
  const drains: Array<() => void> = []
  hadIdle = "requestIdleCallback" in globalScope
  originalIdle = globalScope.requestIdleCallback
  globalScope.requestIdleCallback = (callback: () => void) => {
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
