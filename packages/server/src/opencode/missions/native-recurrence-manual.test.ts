import assert from "node:assert/strict"
import test from "node:test"
import { RecurringDayFixture } from "./recurring-day-fixture"

test("authenticated Run now from paused starts once without arming the daily Job", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  const manual = await f.control("run-now")
  assert.equal(manual.state, "paused")
  assert.equal(f.jobs.size, 0)
  assert.equal(f.starts.length, 1)
  const doc = (await f.document())!
  const due = doc.pending!.passage.due
  assert.equal(due.kind, "manual")
  if (due.kind !== "manual") assert.fail("manual identity required")
  for (let n = 0; n < 2; n++) {
    const status = await f.rpc("recurrenceRunNowStatus", { scheduleID: doc.id,
      requestID: due.requestID, expectedRevision: due.expectedRevision }) as { outcome: string }
    assert.equal(status.outcome, "accepted")
    assert.equal(f.starts.length, 1)
    assert.equal(f.jobs.size, 0)
  }
  await f.model()
  await f.control("resume")
  assert.equal((await f.snapshot()).latestResult?.outcome, "completed")
  assert.equal(f.starts.length, 1)
  assert.equal((await f.document())!.lastDaily, null)
})
