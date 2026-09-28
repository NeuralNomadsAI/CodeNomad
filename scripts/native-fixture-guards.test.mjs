import assert from "node:assert/strict"
import test from "node:test"
import { fixturePaginationGuard, stopFixtureChild } from "./native-fixture-guards.mjs"

test("fixture cleanup escalates a stuck owned child and returns a bounded failure", async () => {
  const signals = []
  let released = false
  const child = { pid: 123, kill: signal => signals.push(signal ?? "SIGTERM"), unref: () => { released = true } }
  await assert.rejects(stopFixtureChild(child, new Promise(() => {}), 5, 5), /forced termination/)
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
  assert.equal(released, true)
})

test("fixture cleanup accepts an owned child closing after forced termination", async () => {
  let closed
  const stopped = new Promise(resolve => { closed = resolve })
  const signals = []
  const child = { kill: signal => { signals.push(signal ?? "SIGTERM"); if (signal === "SIGKILL") closed() } }
  await stopFixtureChild(child, stopped, 5, 5)
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("native pagination rejects cycles instead of looping indefinitely", () => {
  const accept = fixturePaginationGuard()
  accept("one"); accept("two")
  assert.throws(() => accept("one"), /repeated a nonterminal cursor/)
})
