import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot, createSignal } from "solid-js"
import { createDeadlineMemo } from "./deadline-memo"
import { createDescendantActivity } from "../components/session-child-activity"
import { carrySessionProjection } from "../stores/session-projection"
import { getRetrySeconds, shouldShowIdleStatus } from "../stores/session-status"
import type { Session } from "../types/session"

test("status work runs at its own deadline and stops when disposed", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 })
  const setTimer = t.mock.method(globalThis, "setTimeout")
  const clearTimer = t.mock.method(globalThis, "clearTimeout")
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
      const pending = setTimer.mock.calls.at(-1)!.result
      dispose()
      assert.ok(clearTimer.mock.calls.some(call => call.arguments[0] === pending))
    }
    t.mock.timers.tick(2_000)
    assert.equal(retry(), 1)
  })
})

test("an unrelated family update leaves mounted descendant deadline work unchanged", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 })
  createRoot(dispose => {
    const parent = { id: "parent", parentId: null, time: { created: 1, updated: 1 } } as Session
    const child = { ...parent, id: "child", parentId: parent.id, status: "idle", idleSince: 10_000 } as Session
    const sibling = { ...parent, id: "sibling" }
    const [rows, setRows] = createSignal(new Map([parent, child, sibling].map(row => [row.id, row])))
    const update = (before: Session, after: Session) => {
      const next = new Map(rows()).set(after.id, after)
      carrySessionProjection(rows(), next, before, after)
      setRows(next)
    }
    let scans = 0
    const activity = createDescendantActivity(rows, () => parent.id, (row, now, wakeAt) => {
      scans++
      return shouldShowIdleStatus(row, now, false, wakeAt)
    })
    try {
      assert.equal(activity()?.idle, 1)
      update(sibling, { ...sibling, title: "renamed" })
      assert.equal(activity()?.idle, 1)
      assert.equal(scans, 1)
      const archived = { ...parent, time: { ...parent.time, archived: 10_001 } }
      update(parent, archived)
      assert.equal(activity(), undefined)
      update(archived, parent)
      assert.equal(activity()?.idle, 1)
      assert.equal(scans, 2)
      t.mock.timers.tick(5_000)
      assert.equal(activity(), undefined)
      assert.equal(scans, 3)
    } finally { dispose() }
  })
})
