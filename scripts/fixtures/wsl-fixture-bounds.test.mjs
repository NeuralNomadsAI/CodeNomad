import assert from "node:assert/strict"
import { test } from "node:test"
import { boundedFixtureOperation } from "./wsl-fixture-bounds.mjs"

test("a never-settling request cannot retain the polling deadline", async () => {
  await assert.rejects(boundedFixtureOperation(() => new Promise(() => {}), Date.now() + 20, "poll"), /poll timed out/)
})

test("whole-run abort interrupts a pending operation", async () => {
  const controller = new AbortController()
  const pending = boundedFixtureOperation(() => new Promise(() => {}), Date.now() + 10_000, "run", controller.signal)
  controller.abort(new Error("whole-run deadline"))
  await assert.rejects(pending, /whole-run deadline/)
})

test("bounded cleanup remains available after run abort and expired work never starts", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(boundedFixtureOperation(() => { calls++ }, Date.now() + 100, "run", controller.signal))
  await assert.rejects(boundedFixtureOperation(() => { calls++ }, Date.now() - 1, "expired"), /expired timed out/)
  assert.equal(calls, 0)
  await boundedFixtureOperation(() => { calls++ }, Date.now() + 100, "cleanup")
  assert.equal(calls, 1)
})
