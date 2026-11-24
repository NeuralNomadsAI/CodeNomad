import assert from "node:assert/strict"
import test from "node:test"
import { DUE, RecurringDayFixture } from "./recurring-day-fixture"

// Control-record journeys through the real plugin RPCs; see recurring-day.e2e.test.ts for the fixture contract.

test("An unknown Run now outcome is settled by its passage and never blocks Play or Run now", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  // The first attempt and the observer's immediate retry both fail.
  f.crash = "before-message"; f.crashRepeat = 2
  const parked = await f.control("run-now")
  assert.equal(f.starts.length, 0)
  assert(parked.pending, "the reserved passage stays pending under its original identity")
  assert.equal((await f.document())!.controls.at(-1)!.controlsComplete, false, "the first attempt's outcome is unknown")
  await f.advance(f.now + 3_600_000)
  await f.until(() => f.starts.length === 1, "the observer admits the original start message")
  await f.model(); await f.advance(f.now + 3_600_000)
  await f.until(async () => (await f.snapshot()).pending === null, "the manual passage settles")
  assert.equal((await f.document())!.controls.every(item => item.controlsComplete), true)
  assert.equal((await f.control("play")).state, "running")
  assert.equal((await f.control("pause")).state, "paused")
  await f.control("run-now")
  assert.equal(f.starts.length, 2)
})

for (const action of ["pause", "stop"] as const) {
  test(`${action} completes when the passage is reserved but its mission journal does not exist yet`, async t => {
    const f = await RecurringDayFixture.open(); t.after(() => f.close())
    await f.create(); await f.control("play")
    f.crash = "after-create"
    await f.advance(DUE)
    assert.equal(f.crashHits, 1)
    assert.equal(f.starts.length, 0)
    const controlled = await f.control(action)
    const record = (await f.document())!.controls.at(-1)!
    assert.equal(record.action, action)
    assert.equal(record.controlsComplete, true, "no journal mission means no actors to interrupt")
    assert.deepEqual(record.targets, [])
    if (action === "pause") {
      assert(controlled.actions.includes("resume"), "the schedule keeps an exit beyond retrying Pause")
      await f.control("resume"); await f.advance(DUE + 3_600_000)
      await f.until(() => f.starts.length === 1, "Resume admits the original start message")
      assert.equal(f.coordinators.length, 1)
    } else {
      assert.equal(controlled.state, "stopped")
      await f.advance(DUE + 3_600_000)
      await f.until(async () => (await f.snapshot()).pending === null, "the unadmitted stopped passage archives")
      assert.equal((await f.snapshot()).latestResult?.reason, "not-started")
      assert.equal(f.starts.length, 0)
    }
  })
}
