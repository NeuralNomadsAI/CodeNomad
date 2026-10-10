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

test("the failed start's Interrupted(error) and its completed record commit in one revision", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  f.jobStartFailure = "absent"
  const before = (await f.document())!.revision
  await f.control("play")
  const doc = (await f.document())!
  // beginControl, then exactly one write: no crash can leave Interrupted(error) with an incomplete record.
  assert.equal(doc.revision, before + 2)
  assert.equal(doc.interruptionReason, "error")
  assert.equal(doc.controls.at(-1)!.controlsComplete, true)
})

test("an incomplete start intent already marked Interrupted(error) resolves from a definite no-Job read", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  f.jobStartFailure = "absent"
  await f.control("play")
  // The residual state: Interrupted(error) written, the original record not completed
  // (an older two-write crash, or the daily Job's own fatal exit after an unproven start).
  f.rewriteDocument(doc => { doc.controls.at(-1).controlsComplete = false; doc.controls.at(-1).targetsKnown = false })
  const play = (await f.document())!.controls.at(-1)!
  const exact = { requestID: play.requestID, action: "play", expectedRevision: play.expectedRevision }
  assert.equal((await status(f, exact)).outcome, "committed", "resolved without starting anything")
  assert.equal(f.jobs.size, 0)
  assert.equal((await f.snapshot()).state, "interrupted")
  f.jobStartFailure = undefined
  assert.equal((await f.control("resume")).state, "running")
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
