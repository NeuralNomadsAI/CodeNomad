import assert from "node:assert/strict"
import test from "node:test"
import { DAY, DUE, RecurringDayFixture } from "./recurring-day-fixture"

const running = (f: RecurringDayFixture) => [...f.jobs.values()].filter(job => job.status === "running").map(job => job.type).sort()
const status = async (f: RecurringDayFixture, record: { requestID: string; action: string; expectedRevision: number }) =>
  await f.rpc("recurrenceControlStatus", { scheduleID: (await f.snapshot()).id, ...record }) as { outcome: string; controlsComplete?: boolean }

test("Resume after a paused Run now leaves only the daily Job, which still settles the passage", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("run-now")
  assert.deepEqual(running(f), ["codenomad.missions.recurrence.settle"])
  const resumed = await f.control("resume")
  assert.equal(resumed.state, "running")
  assert.deepEqual(running(f), ["codenomad.missions.recurrence"], "one Job per running schedule")
  assert((await f.document())!.controls.every(control => control.controlsComplete))
  await f.model(); await f.advance(f.now + 3_600_000)
  const settled = await f.snapshot()
  assert.equal(settled.pending, null)
  assert.equal(settled.latestResult?.trigger, "manual")
  assert.deepEqual(running(f), ["codenomad.missions.recurrence"])
})

test("a settlement-only wake never admits a scheduled passage once pending has cleared", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  await f.restart() // Running desired state without a live Job: the reread race's document shape.
  f.now = DUE + 60_000
  assert.equal((await f.document())!.pending, null)
  assert.equal(await f.wake(true), "idle")
  assert.equal(f.starts.length, 0)
  assert.equal((await f.document())!.pending, null, "no daily reservation either")
  assert.equal(await f.wake(false), "started", "the same document is genuinely due for the daily role")
  assert.equal(f.starts.length, 1)
})

test("a lost Play completion reconciles from the observed running Job, without replay, after the passage archives", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  const play = (await f.document())!.controls.at(-1)!
  // The Job started but its completion write was lost.
  f.rewriteDocument(doc => { doc.controls.at(-1).controlsComplete = false; doc.controls.at(-1).targetsKnown = false })
  await f.advance(DUE); await f.model(); await f.advance(DUE + 3_600_000)
  const archived = await f.document()
  assert.equal(archived!.pending, null)
  assert.equal(archived!.controls.find(item => item.requestID === play.requestID)!.controlsComplete, false, "archive alone does not settle Play")
  const starts = f.starts.length, jobs = [...f.jobs.values()]
  const exact = { requestID: play.requestID, action: "play", expectedRevision: play.expectedRevision }
  assert.equal((await status(f, exact)).outcome, "committed")
  assert.deepEqual([...f.jobs.values()], jobs, "reconciliation starts no Job")
  assert.equal(f.starts.length, starts, "and replays nothing")
  assert.equal((await status(f, { ...exact, expectedRevision: play.expectedRevision + 1 })).outcome, "unknown")
  assert.equal((await f.control("pause")).state, "paused")
})

test("an unobserved Play stays genuinely unknown", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  const play = (await f.document())!.controls.at(-1)!
  f.rewriteDocument(doc => { doc.controls.at(-1).controlsComplete = false })
  await f.restart() // No live Job remains.
  const exact = { requestID: play.requestID, action: "play", expectedRevision: play.expectedRevision }
  assert.equal((await status(f, exact)).outcome, "unknown")
  assert.equal((await f.document())!.controls.at(-1)!.controlsComplete, false)
  assert.equal(f.jobs.size, 0)
  await f.advance(DUE + DAY)
  assert.equal(f.starts.length, 0, "no rearm after restart")
})
