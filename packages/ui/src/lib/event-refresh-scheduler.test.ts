import assert from "node:assert/strict"
import test from "node:test"

import { ACTIVITY_REFRESH_INTERVAL_MS, EVENT_REFRESH_DEBOUNCE_MS, createEventRefreshScheduler } from "./event-refresh-scheduler"

function harness() {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let nextTimer = 0
  const runs: number[] = []
  let release: (() => void) | undefined
  const scheduler = createEventRefreshScheduler(() => {
    runs.push(now)
    return new Promise<void>(resolve => { release = resolve })
  }, {
    now: () => now,
    setTimer: (callback, ms) => { timers.set(++nextTimer, { at: now + ms, callback }); return nextTimer as never },
    clearTimer: timer => { timers.delete(timer as never) },
  })
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  const advance = async (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at
      timers.delete(due[0])
      due[1].callback()
      await flush()
    }
    now = target
    await flush()
  }
  const settle = async () => { release?.(); release = undefined; await flush(); await flush() }
  return { scheduler, runs, advance, settle, pending: () => timers.size, time: () => now }
}

test("continuous activity coalesces into one read per interval, measured from settlement", async () => {
  const { scheduler, runs, advance, settle, time } = harness()
  scheduler.schedule("i", "activity")
  // Events every 20 ms never postpone the first read (no debounce starvation).
  for (let index = 0; index < 5; index++) { await advance(20); scheduler.schedule("i", "activity") }
  assert.deepEqual(runs, [EVENT_REFRESH_DEBOUNCE_MS])
  // Activity during the run reschedules once, from its settlement.
  for (let index = 0; index < 50; index++) { scheduler.schedule("i", "activity"); await advance(20) }
  assert.equal(runs.length, 1, "never a second concurrent or back-to-back read")
  const settledAt = time()
  await settle()
  for (let index = 0; index < 300; index++) { scheduler.schedule("i", "activity"); await advance(20) }
  assert.equal(runs.length, 2)
  assert.equal(runs[1], settledAt + ACTIVITY_REFRESH_INTERVAL_MS)
})

test("urgent invalidations preempt a throttled activity read, and cancel forgets demand", async () => {
  const { scheduler, runs, advance, settle, pending } = harness()
  scheduler.schedule("i", "urgent")
  await advance(EVENT_REFRESH_DEBOUNCE_MS)
  await settle()
  scheduler.schedule("i", "activity")
  await advance(1_000)
  assert.equal(runs.length, 1, "activity waits for the interval")
  scheduler.schedule("i", "urgent")
  await advance(EVENT_REFRESH_DEBOUNCE_MS)
  assert.equal(runs.length, 2, "a journal change is prompt")
  await settle()
  assert.equal(pending(), 0, "the preempted activity read is covered by the urgent one")

  scheduler.schedule("i", "activity")
  scheduler.cancel("i")
  await advance(ACTIVITY_REFRESH_INTERVAL_MS * 2)
  assert.equal(runs.length, 2)
  // Demand that arrived during a run is dropped when cancelled before settlement.
  scheduler.schedule("i", "urgent")
  await advance(EVENT_REFRESH_DEBOUNCE_MS)
  scheduler.schedule("i", "urgent")
  scheduler.cancel("i")
  await settle()
  await advance(ACTIVITY_REFRESH_INTERVAL_MS * 2)
  assert.equal(runs.length, 3)
})
