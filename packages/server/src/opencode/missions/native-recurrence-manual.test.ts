import assert from "node:assert/strict"
import test from "node:test"
import { RecurringDayFixture } from "./recurring-day-fixture"

const dailyJobs = (f: RecurringDayFixture) => [...f.jobs.values()].filter(job => job.type === "codenomad.missions.recurrence")

test("Run now beside a live daily Job never starts a second observer when the Job read fails", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  assert.equal(dailyJobs(f).filter(job => job.status === "running").length, 1)
  // Fail the first schedule-Job read after admission: the observer decision.
  let failed = 0
  f.failScheduleJobRead = () => f.starts.length === 1 && failed++ === 0
  await f.control("run-now")
  f.failScheduleJobRead = undefined
  assert.ok(failed >= 1, "the injected failure was consumed")
  assert.equal(f.starts.length, 1)
  assert.deepEqual([...f.jobs.values()].map(job => job.type), ["codenomad.missions.recurrence"],
    "an unknown read of a desired-running schedule is not proof that its daily Job is gone")
  // The live daily Job alone observes and settles the manual passage.
  await f.model(); await f.advance(f.now + 3_600_000)
  assert.equal((await f.snapshot()).latestResult?.trigger, "manual")
  assert.equal((await f.snapshot()).latestResult?.outcome, "completed")
})

test("authenticated Run now from paused starts once without arming the daily Job", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  const manual = await f.control("run-now")
  assert.equal(manual.state, "paused")
  assert.equal(dailyJobs(f).length, 0)
  assert.deepEqual([...f.jobs.values()].map(job => job.type), ["codenomad.missions.recurrence.settle"], "settlement-only observer")
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
    assert.equal(dailyJobs(f).length, 0)
  }
  await f.model()
  await f.control("resume")
  assert.equal((await f.snapshot()).latestResult?.outcome, "completed")
  assert.equal(f.starts.length, 1)
  assert.equal((await f.document())!.lastDaily, null)
})
