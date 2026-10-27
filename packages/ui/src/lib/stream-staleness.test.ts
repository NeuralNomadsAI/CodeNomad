import assert from "node:assert/strict"
import test from "node:test"

import { createStreamStalenessWatchdog } from "./stream-staleness"

const FAST = { thresholdMs: 100, checkIntervalMs: 20 }

// Manual fake-time harness: the interval callback handed to the injected setTimer is
// captured and fired by hand while the injected clock moves in explicit steps.
function harness(options: { thresholdMs?: number; checkIntervalMs?: number } = {}) {
  let now = 0
  let created = 0
  let cleared = 0
  let fire: (() => void) | undefined
  const reasons: string[] = []
  const watchdog = createStreamStalenessWatchdog({
    ...options,
    now: () => now,
    setTimer: ((callback: () => void) => {
      created += 1
      fire = callback
      return 0 as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval,
    clearTimer: (() => {
      cleared += 1
      fire = undefined
    }) as unknown as typeof clearInterval,
    onStale: reason => reasons.push(reason),
  })
  const tick = () => fire?.()
  const advance = (ms: number) => { now += ms; tick() }
  // Moves the clock without firing the interval: simulates the gap between
  // silence crossing the threshold and the next interval tick (or a suspended
  // tab where no tick ran at all).
  const elapse = (ms: number) => { now += ms }
  return { watchdog, reasons, tick, advance, elapse, created: () => created, cleared: () => cleared }
}

test("stale() is false right after activity()", () => {
  const { watchdog } = harness(FAST)
  watchdog.setConnected(true)
  watchdog.activity()
  assert.equal(watchdog.stale(), false)
})

test("silence just under the threshold stays fresh while connected", () => {
  const { watchdog, reasons, advance } = harness(FAST)
  watchdog.setConnected(true)
  watchdog.activity()
  advance(FAST.thresholdMs - 1)
  assert.deepEqual(reasons, [])
  assert.equal(watchdog.stale(), false)
})

test("silence at the threshold fires onStale once per episode", () => {
  const { watchdog, reasons, advance, tick } = harness()
  watchdog.setConnected(true)
  watchdog.activity()
  advance(45_000)
  assert.deepEqual(reasons, ["stream stale"])
  assert.equal(watchdog.stale(), true)
  tick()
  advance(15_000)
  assert.deepEqual(reasons, ["stream stale"], "no repeat while the episode is open")
})

test("activity clears the episode and a later silence fires again", () => {
  const { watchdog, reasons, advance } = harness(FAST)
  watchdog.setConnected(true)
  watchdog.activity()
  advance(FAST.thresholdMs)
  assert.deepEqual(reasons, ["stream stale"])
  watchdog.activity()
  assert.equal(watchdog.stale(), false)
  advance(FAST.thresholdMs)
  assert.deepEqual(reasons, ["stream stale", "stream stale"])
})

test("disconnect stops decisions; reconnect starts a fresh silence deadline", () => {
  const { watchdog, reasons, advance } = harness(FAST)
  watchdog.setConnected(true)
  watchdog.activity()
  advance(FAST.thresholdMs)
  assert.deepEqual(reasons, ["stream stale"])
  watchdog.setConnected(false)
  assert.equal(watchdog.stale(), false)
  advance(FAST.thresholdMs)
  assert.deepEqual(reasons, ["stream stale"], "no decision while disconnected")
  watchdog.setConnected(true)
  advance(FAST.checkIntervalMs)
  assert.deepEqual(reasons, ["stream stale"], "the reconnection resets the silence baseline")
  advance(FAST.thresholdMs - FAST.checkIntervalMs)
  assert.deepEqual(reasons, ["stream stale", "stream stale"], "a full threshold of silence measured from the reconnection fires again")
  assert.equal(watchdog.stale(), true)
})

test("a replacement connection gets its own deadline, not the dead stream's", () => {
  const { watchdog, reasons, advance, elapse, tick } = harness()
  watchdog.setConnected(true)
  watchdog.activity()
  // The dying stream goes silent; the watchdog disconnects it and a
  // replacement attempt begins at t30 without ever opening (no activity).
  elapse(30_000)
  watchdog.setConnected(false)
  watchdog.setConnected(true)
  // The replacement is still connecting 20 s later: it must not inherit the
  // dead stream's already-elapsed silence, or an online/visible probe would
  // close it before it can ever open.
  elapse(20_000)
  assert.equal(watchdog.probe(), false, "a replacement connecting for 20 s is not stale")
  assert.deepEqual(reasons, [])
  tick()
  assert.equal(watchdog.stale(), false)
  // Silence measured from the reconnection crosses the threshold at t75.
  advance(26_000)
  assert.deepEqual(reasons, ["stream stale"], "a full threshold of silence after the reconnection fires")
  assert.equal(watchdog.stale(), true)
})

test("the interval is created on the first connection only and destroyed by dispose", () => {
  const first = harness(FAST)
  first.watchdog.setConnected(true)
  assert.equal(first.created(), 1)
  first.watchdog.setConnected(false)
  first.watchdog.setConnected(true)
  assert.equal(first.created(), 1, "reconnection reuses the running interval")
  first.watchdog.dispose()
  assert.equal(first.cleared(), 1)
  first.watchdog.setConnected(true)
  assert.equal(first.created(), 1, "a disposed watchdog never restarts its interval")

  const never = harness(FAST)
  never.watchdog.activity()
  never.advance(1_000)
  assert.equal(never.created(), 0, "no timer without a connection")
})

test("activity() before any connection does not create a timer", () => {
  const { watchdog, advance, created } = harness(FAST)
  watchdog.activity()
  advance(FAST.thresholdMs)
  assert.equal(created(), 0)
})

test("probe acts between threshold-crossing and the next interval tick", () => {
  const { watchdog, reasons, elapse, tick } = harness()
  watchdog.setConnected(true)
  watchdog.activity()
  assert.equal(watchdog.probe(), false, "a fresh stream never probes stale")
  elapse(45_000)
  assert.equal(watchdog.stale(), false, "no interval tick ran, so no episode is open yet")
  assert.equal(watchdog.probe(), true, "the elapsed-time probe fires without the interval")
  assert.deepEqual(reasons, [], "the probe never opens the episode itself")
  tick()
  assert.equal(watchdog.stale(), true, "the interval backstop still opens its episode")
})

test("activity resets the probe; disconnect gates it off", () => {
  const { watchdog, elapse } = harness(FAST)
  watchdog.setConnected(true)
  watchdog.activity()
  elapse(FAST.thresholdMs)
  assert.equal(watchdog.probe(), true)
  watchdog.activity()
  assert.equal(watchdog.probe(), false, "activity clears the probe together with the episode")
  elapse(FAST.thresholdMs)
  watchdog.setConnected(false)
  assert.equal(watchdog.probe(), false, "no probe decision while disconnected")
})
