import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { Context } from "effect"
import { RecurringDayFixture } from "./recurring-day-fixture"

const dailyJobs = (f: RecurringDayFixture) => [...f.jobs.values()].filter(job => job.type === "codenomad.missions.recurrence")

/** Run now refused before any effect: no reserved passage, record, session, start or Job. */
async function assertRunNowRefusedBeforeEffects(f: RecurringDayFixture) {
  const before = (await f.document())!
  await f.control("run-now", 500)
  const after = (await f.document())!
  assert.equal(after.revision, before.revision, "no CAS")
  assert.equal(after.pending, null, "no passage reserved")
  assert.equal(after.controls.some(item => item.action === "run-now"), false, "no control record")
  assert.equal(f.starts.length, 0, "no native session or start message")
  assert.equal(f.jobs.size, 0, "no daily or settlement-only Job")
}

test("Run now fails safe before any CAS or native effect when the qualified native graph is unavailable", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  const owned = f as unknown as { graph: Context.Context<never> }, graph = owned.graph
  // The actual native Job contract the reviewed due callback consumes is missing its start/cancel.
  owned.graph = Context.add(graph, Context.Service<never, unknown>("@opencode/Job"), { get: () => undefined })
  await assertRunNowRefusedBeforeEffects(f)
  owned.graph = graph
  const manual = await f.control("run-now")
  assert.equal(manual.state, "paused")
  assert.equal(f.starts.length, 1, "a valid Run now still starts exactly once")
  assert.deepEqual([...f.jobs.values()].map(job => job.type), ["codenomad.missions.recurrence.settle"], "one settlement-only observer")
})

test("Run now refuses a retargeted physical root before reserving a passage or starting a Job", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  const root = (await f.document())!.config.roots[0].directory
  const other = await mkdtemp(path.join(path.dirname(root), "recurring-retarget-"))
  t.after(() => rm(other, { recursive: true, force: true }))
  execFileSync("git", ["init", "-q", other])
  // Same directory, different Git family: the checkout now belongs to another repository.
  await rename(path.join(root, ".git"), path.join(root, ".git-owned"))
  await writeFile(path.join(root, ".git"), `gitdir: ${path.join(other, ".git").replaceAll("\\", "/")}\n`)
  await assertRunNowRefusedBeforeEffects(f)
  await rm(path.join(root, ".git"))
  await rename(path.join(root, ".git-owned"), path.join(root, ".git"))
  await f.control("run-now")
  assert.equal(f.starts.length, 1, "the restored owned root admits Run now once")
  assert.equal(dailyJobs(f).length, 0, "paused Run now never arms the daily Job")
})

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
