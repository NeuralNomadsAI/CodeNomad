import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { flushFrameBatchedMounts, scheduleFrameBatchedMount } from "./frame-batch-schedule"

const globalScope = globalThis as unknown as Record<string, unknown>

const armed: Array<() => void> = []
const cancelled: number[] = []
let originalRequest: unknown
let hadRequest = false
let originalCancel: unknown
let hadCancel = false

afterEach(() => {
  armed.length = 0
  cancelled.length = 0
  // Node has no animation frames: restore the original state exactly,
  // including absence, so later tests in this process pick their own path.
  if (hadRequest) globalScope.requestAnimationFrame = originalRequest
  else delete globalScope.requestAnimationFrame
  if (hadCancel) globalScope.cancelAnimationFrame = originalCancel
  else delete globalScope.cancelAnimationFrame
})

function installFrameScheduler() {
  hadRequest = "requestAnimationFrame" in globalScope
  originalRequest = globalScope.requestAnimationFrame
  hadCancel = "cancelAnimationFrame" in globalScope
  originalCancel = globalScope.cancelAnimationFrame
  globalScope.requestAnimationFrame = (callback: () => void) => {
    armed.push(callback)
    return armed.length
  }
  globalScope.cancelAnimationFrame = (handle: number) => {
    cancelled.push(handle)
  }
}

test("a synchronous flush drains the queue and invalidates the armed frame", () => {
  installFrameScheduler()
  const mounted: number[] = []
  scheduleFrameBatchedMount(() => mounted.push(1))
  scheduleFrameBatchedMount(() => mounted.push(2))
  scheduleFrameBatchedMount(() => mounted.push(3))
  assert.equal(armed.length, 1, "the mounts share one armed frame")

  flushFrameBatchedMounts()
  assert.deepEqual(mounted, [1, 2, 3])
  assert.deepEqual(cancelled, [1], "the flush invalidates the armed frame callback")
  assert.equal(armed.length, 1, "the flush arms nothing")

  // A mount scheduled after the flush arms a fresh frame.
  scheduleFrameBatchedMount(() => mounted.push(4))
  assert.equal(armed.length, 2)
  armed.pop()!()
  assert.deepEqual(mounted, [1, 2, 3, 4])
})

test("an ordinary frame batch mounts two queued items per frame", () => {
  installFrameScheduler()
  const mounted: number[] = []
  scheduleFrameBatchedMount(() => mounted.push(1))
  scheduleFrameBatchedMount(() => mounted.push(2))
  scheduleFrameBatchedMount(() => mounted.push(3))

  const frame = armed.pop()!
  frame()
  assert.deepEqual(mounted, [1, 2], "a frame batch joins two mounts")
  frame()
  assert.deepEqual(mounted, [1, 2, 3])
})
