import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot, createSignal } from "solid-js"
import { createDeadlineMemo } from "./deadline-memo"
import { getRetrySeconds, shouldShowIdleStatus } from "../stores/session-status"

test("status work runs at its own deadline and stops when disposed", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 })
  createRoot(dispose => {
    const [retryAt, setRetryAt] = createSignal(0)
    let unrelatedRuns = 0
    const unrelated = createDeadlineMemo(() => ++unrelatedRuns)
    const idle = createDeadlineMemo((now, wakeAt) =>
      shouldShowIdleStatus({ status: "idle", parentId: "root", idleSince: 10_000 }, now, false, wakeAt))
    const retry = createDeadlineMemo((now, wakeAt) => getRetrySeconds(retryAt(), now, wakeAt))
    try {
      t.mock.timers.tick(4_999)
      assert.equal(idle(), true)
      t.mock.timers.tick(1)
      assert.equal(idle(), false)
      setRetryAt(17_000)
      assert.equal(retry(), 2)
      t.mock.timers.tick(500)
      assert.equal(retry(), 2)
      t.mock.timers.tick(1)
      assert.equal(retry(), 1)
      assert.equal(unrelated(), 1)
    } finally {
      dispose()
    }
    t.mock.timers.tick(2_000)
    assert.equal(retry(), 1)
  })
})
