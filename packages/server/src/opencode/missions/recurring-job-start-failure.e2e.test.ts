import assert from "node:assert/strict"
import test from "node:test"
import { DAY, DUE, RecurringDayFixture } from "./recurring-day-fixture"

const status = async (f: RecurringDayFixture, record: { requestID: string; action: string; expectedRevision: number }) =>
  await f.rpc("recurrenceControlStatus", { scheduleID: (await f.snapshot()).id, ...record }) as { outcome: string; controlsComplete?: boolean }

test("a Play whose native Job never started settles as Interrupted for an explicit Resume, without retry", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  f.jobStartFailure = "absent"
  const failed = await f.control("play")
  assert.equal(f.jobs.size, 0, "no Job was registered")
  assert.equal(failed.state, "interrupted")
  assert.equal(failed.interruptionReason, "error")
  assert(failed.actions.includes("resume") && failed.actions.includes("pause"))
  const play = (await f.document())!.controls.at(-1)!
  assert.equal(play.controlsComplete, true, "the definitive outcome releases the backend permit")
  const exact = { requestID: play.requestID, action: "play", expectedRevision: play.expectedRevision }
  assert.equal((await status(f, exact)).outcome, "committed", "a lost reply reads the same settled record")
  await f.advance(DUE + DAY)
  assert.equal(f.jobs.size, 0, "nothing retried the start")
  assert.equal(f.starts.length, 0)
  f.jobStartFailure = undefined
  const resumed = await f.control("resume")
  assert.equal(resumed.state, "running", "explicit Resume starts the one daily Job")
  assert.equal(resumed.interruptionReason, undefined)
})

test("a Job start failure without positive absence stays unknown until the running Job is observed", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  f.jobStartFailure = "registered"
  await f.control("play", 500)
  const play = (await f.document())!.controls.at(-1)!
  assert.equal(play.controlsComplete, false, "a running Job is never reported as a failed start")
  f.jobStartFailure = undefined
  const exact = { requestID: play.requestID, action: "play", expectedRevision: play.expectedRevision }
  assert.equal((await status(f, exact)).outcome, "committed", "reconciled only from the observed running Job")
  assert.equal((await f.snapshot()).state, "running")
})
