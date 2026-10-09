import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import test from "node:test"
import { DAY, DUE, RecurringDayFixture } from "./recurring-day-fixture"

// Run with: node --import tsx --test src/opencode/missions/recurring-day.e2e.test.ts
// All model-produced business state goes through registered real mission_* tools.
// The fixture never appends journal events, fabricates final reports or calls recurrence reserve/finish.

test("A. Full day: paused create, due work, real tools, archive and a distinct next day", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  const created = await f.create()
  assert.equal(created.title, "Daily offline review")
  assert.equal(created.state, "paused")
  assert.equal(f.jobs.size, 0)
  assert.equal(f.coordinators.length, 0)
  assert.equal((await f.control("play")).state, "running")
  await f.advance(DUE - 1)
  assert.equal(f.starts.length, 0)
  await f.advance(DUE)
  assert.equal(f.coordinators.length, 1)
  assert.equal(f.starts.length, 1)
  const firstSession = f.coordinators[0].id, firstMessage = f.starts[0].id
  const pending = await f.document()
  assert(pending?.pending, "real native CAS persisted pending")
  await f.model({ child: true })
  // The native execution terminal wakes settlement after a short debounce, not the hourly wake.
  await f.advance(DUE + 5_000)
  const settled = await f.snapshot()
  assert.equal(settled.pending, null)
  assert.equal(settled.latestResult?.outcome, "completed")
  assert.equal(settled.history.length, 1)
  assert.equal(settled.nextDueAt, DUE + DAY)
  assert.deepEqual(f.calls.map(c => c.name), ["read", "shell", "subagent", "mission_inspect", "mission_report"])
  assert.equal(f.sessions.length, 2)
  assert.equal(f.sessions.find(s => s.parentID)?.parentID, firstSession)
  await f.advance(DUE + DAY)
  assert.equal(f.coordinators.length, 2)
  assert.equal(f.starts.length, 2)
  assert.notEqual(f.coordinators[1].id, firstSession)
  assert.notEqual(f.starts[1].id, firstMessage)
  // Hourly ceiling (24) + the due wake + one post-event settlement debounce.
  assert(f.wakeups <= 26, `no per-minute polling: ${f.wakeups} wakes in ~one day`)
  await f.model()
  await f.advance(DUE + DAY + 3_600_000)
  assert.equal((await f.snapshot()).history.length, 2)
  assert.notEqual((await f.snapshot()).history[0].passageID, (await f.snapshot()).history[1].passageID)
})

test("B. Restart pending: Interrupted, explicit Resume reconciles without another start", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play"); await f.advance(DUE)
  await f.model({ report: false, keepActive: true })
  const before = await f.document(), ids = f.starts.map(m => m.id)
  await f.restart()
  const interrupted = await f.snapshot()
  assert.equal(interrupted.state, "interrupted")
  assert(interrupted.interruptionReason)
  assert(interrupted.pending)
  assert.deepEqual((await f.document())?.pending, before?.pending)
  assert.equal(f.jobs.size, 0, "plugin startup must not silently rearm")
  assert(interrupted.actions.includes("resume"))
  await f.control("resume")
  assert.deepEqual(f.starts.map(m => m.id), ids)
  assert.equal(f.coordinators.length, 1)
  await f.model(); await f.advance(DUE + 3_600_000)
  assert.equal((await f.snapshot()).latestResult?.outcome, "completed")
  await f.advance(DUE + DAY)
  assert.equal(f.starts.length, 2)
  assert.equal(f.coordinators.length, 2)
})

test("C. Crash boundaries: pending CAS, native create and admission reconcile under the original identities only", async t => {
  for (const point of ["after-pending", "after-create", "after-message"] as const) {
    await t.test(point, async () => {
      const f = await RecurringDayFixture.open()
      try {
        await f.create(); await f.control("play")
        f.crash = point
        await f.advance(DUE)
        assert.equal(f.crashHits, 1, "failpoint must actually run")
        const before = await f.document()
        assert(before?.pending, "write-ahead pending survives failure")
        const passage = before.pending.passage
        assert.equal(f.coordinators.length, point === "after-pending" ? 0 : 1)
        assert.equal(f.starts.length, point === "after-message" ? 1 : 0)
        await f.restart(); await f.control("resume")
        await f.advance(DUE + 3_600_000)
        // Resume never invents a new identity: the original session/message is admitted
        // at most once (native first admission wins), never a second coordinator message.
        assert.deepEqual(f.coordinators.map(s => s.id), [passage.coordinatorSessionID])
        assert.deepEqual(f.starts.map(m => m.id), [passage.messageID], "one original start message, no resend")
        await f.model(); await f.advance(DUE + 2 * 3_600_000)
        assert.equal((await f.snapshot()).latestResult?.outcome, "completed")
        assert.equal(f.starts.length, 1)
      } finally { await f.close() }
    })
  }
})

test("C2. A transient admission failure retries the same identities on a later wake, without Resume", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  f.crash = "after-create"
  await f.advance(DUE)
  const passage = (await f.document())!.pending!.passage
  assert.equal(f.starts.length, 0)
  assert.equal((await f.snapshot()).state, "running", "a failed admission does not end the Job")
  await f.advance(DUE + 3_600_000)
  assert.deepEqual(f.coordinators.map(s => s.id), [passage.coordinatorSessionID])
  assert.deepEqual(f.starts.map(m => m.id), [passage.messageID])
  await f.model(); await f.advance(DUE + 2 * 3_600_000)
  assert.equal((await f.snapshot()).latestResult?.outcome, "completed")
})

test("C4. A recorded admission is never re-sent when its start message later disappears natively", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play"); await f.advance(DUE)
  const pending = (await f.document())!.pending!
  assert(pending.admission, "admission recorded")
  assert.equal(f.admissions, 1)
  f.pruneMessage(pending.passage.messageID)
  assert.equal(f.starts.length, 0, "the delivered start message is gone from native history")
  await f.advance(DUE + 3_600_000)
  assert.equal(f.admissions, 1, "absence after a recorded admission is history, never a resend")
  await f.model(); await f.advance(DUE + 3_600_000 + 5_000)
  const settled = await f.snapshot()
  assert.equal(settled.pending, null, "settles by family quiescence without the pruned message")
  assert.equal(settled.latestResult?.outcome, "completed")
  assert.equal(f.admissions, 1)
  assert.equal(f.coordinators.length, 1)
})

test("C3. A deleted watched conversation archives failed/not-started and unblocks later days and Run now", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  f.watch("ses_watched_source")
  await f.create(); await f.control("play")
  f.deleteSession("ses_watched_source")
  await f.advance(DUE)
  assert.equal(f.starts.length, 0, "no start message can be built")
  await f.advance(DUE + 3_600_000)
  const archived = await f.snapshot()
  assert.equal(archived.pending, null, "a stuck passage no longer blocks the schedule")
  assert.equal(archived.latestResult?.outcome, "failed")
  assert.equal((archived.latestResult as { reason?: string }).reason, "not-started")
  assert.equal(f.coordinators.length, 1, "the coordinator session is kept as-is")
  const doc = (await f.document())!
  assert.equal(doc.lastDaily?.at, DUE, "the scheduled day is settled normally")
  assert.deepEqual(doc.cursors, [], "cursors never advance for an unstarted passage")
  assert(archived.actions.includes("run-now"))
  assert.equal(archived.nextDueAt, DUE + DAY)
  assert.equal(f.starts.length, 0)
})

test("D. Run now has distinct IDs and leaves the daily civil-day schedule untouched", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  const before = await f.snapshot()
  await f.control("run-now")
  assert.equal(f.starts.length, 1)
  const manualMessage = f.starts[0].id, manualSession = f.coordinators[0].id
  await f.model(); await f.advance(f.now + 3_600_000)
  assert.equal((await f.snapshot()).nextDueAt, before.nextDueAt)
  assert.equal((await f.document())?.lastDaily, null, "manual passage cannot consume the daily high-water mark")
  await f.advance(DUE)
  assert.equal(f.starts.length, 2)
  assert.notEqual(f.starts[1].id, manualMessage)
  assert.notEqual(f.coordinators[1].id, manualSession)
})

test("E. Pause cancels wakeups and future admissions; Stop is terminal", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  assert.equal((await f.control("pause")).state, "paused")
  const wakes = f.wakeups
  await f.advance(DUE + DAY)
  assert.equal(f.wakeups, wakes, "Pause cancels the Job rather than leaving polling behind")
  assert.equal(f.starts.length, 0)
  await f.control("play")
  assert.equal((await f.control("stop")).state, "stopped")
  const count = f.starts.length
  await f.advance(DUE + 2 * DAY)
  assert.equal(f.starts.length, count)
  const stopped = await f.snapshot()
  assert.deepEqual(stopped.actions, [])
  await assert.rejects(f.control("play"))
  await assert.rejects(f.control("resume"))
  await assert.rejects(f.control("run-now"))
})

const settleJobs = (f: RecurringDayFixture) => [...f.jobs.values()].filter(job => job.type === "codenomad.missions.recurrence.settle" && job.status === "running")

test("K. Run now on an Interrupted schedule is observed by a settlement-only Job until it settles", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  await f.restart()
  assert.equal((await f.snapshot()).state, "interrupted")
  await f.control("run-now")
  assert.equal(f.starts.length, 1)
  assert.equal(settleJobs(f).length, 1, "no live schedule Job, so the observer starts regardless of stored state")
  assert.equal(dailyJobs(f).length, 0, "Run now never rearms daily scheduling")
  await f.model(); await f.advance(f.now + 3_600_000)
  const settled = await f.snapshot()
  assert.equal(settled.latestResult?.outcome, "completed")
  assert.equal(settled.latestResult?.trigger, "manual")
  assert.equal(settled.state, "interrupted")
  assert.equal(settleJobs(f).length, 0, "observer exits once settled")
})

test("L. Stop keeps a settlement-only observer until the pending passage archives; the schedule stays terminal", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play"); await f.advance(DUE)
  await f.model({ report: false, keepActive: true })
  const form = f.pendingForm() // Stop interrupts the coordinator; the open Form keeps the family unsettled.
  const stopped = await f.control("stop")
  assert.equal(stopped.state, "stopped")
  assert(stopped.pending, "Stop never clears live work")
  assert.equal(dailyJobs(f).length, 0)
  assert.equal(settleJobs(f).length, 1)
  await f.answerForm(form)
  await f.advance(DUE + 3_600_000)
  const archived = await f.snapshot()
  assert.equal(archived.pending, null)
  assert.equal(archived.latestResult?.outcome, "ended-without-report")
  assert.equal(archived.state, "stopped")
  assert.deepEqual(archived.actions, [])
  assert.equal(settleJobs(f).length, 0)
  await f.advance(DUE + DAY)
  assert.equal(f.starts.length, 1)
})

test("L2. After a restart, a stopped schedule's pending passage offers Check, which only observes it", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play"); await f.advance(DUE)
  await f.model({ report: false, keepActive: true })
  f.pendingForm(); await f.control("stop"); await f.restart()
  const parked = await f.snapshot()
  assert.equal(parked.state, "stopped")
  assert.deepEqual(parked.actions, ["check"])
  assert.equal(parked.pending?.status, "running")
  assert.equal(f.jobs.size, 0, "reads never restart the observer")
  // Stop already interrupted the coordinator and the restart cleared the Form,
  // so the Check-started observer can settle the family on its first wake.
  await f.control("check"); await f.advance(DUE + 3_600_000)
  assert.equal(settleJobs(f).length, 0, "the observer exits once settled")
  const archived = await f.snapshot()
  assert.equal(archived.pending, null)
  assert.equal(archived.latestResult?.outcome, "ended-without-report")
  assert.equal(archived.state, "stopped")
  assert.equal(f.starts.length, 1)
})

test("M. Transient wake failures warn without ending the Job; starting is not uncertain while observed", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  f.crash = "before-message"
  await f.advance(DUE)
  assert.equal(f.starts.length, 0)
  const starting = await f.snapshot()
  assert.equal(starting.state, "running")
  assert.equal(starting.pending?.status, "starting", "a live Job is still handling the unadmitted passage")
  assert.equal(starting.pending?.trigger, "daily")
  f.crash = "before-message"
  await f.advance(DUE + 3_600_000)
  const warned = await f.snapshot()
  assert.equal(warned.state, "running", "one transient failure does not interrupt scheduling")
  assert.equal(warned.interruptionReason, undefined)
  assert.equal(warned.lastError?.code, "admission-failed")
  assert.equal(warned.pending?.status, "uncertain")
  assert.equal(warned.pending?.reason, "admission-failing")
  assert.equal(dailyJobs(f).length, 1)
  await f.advance(DUE + 3_600_000 + 31_000)
  const recovered = await f.snapshot()
  assert.equal(recovered.lastError, undefined, "the next successful wake clears the warning")
  assert.equal(recovered.pending?.status, "running")
  assert.equal(f.starts.length, 1)
  await f.restart()
  assert.equal((await f.snapshot()).pending?.status, "running", "admitted work is not uncertain")
})

test("M2. An unadmitted passage without any live observer is uncertain (not observed)", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  f.crash = "after-create"
  await f.advance(DUE)
  await f.restart()
  const parked = await f.snapshot()
  assert.equal(parked.pending?.status, "uncertain")
  assert.equal(parked.pending?.reason, "not-observed")
})

const dailyJobs = (f: RecurringDayFixture) => [...f.jobs.values()].filter(job => job.type === "codenomad.missions.recurrence" && job.status === "running")

test("G. Run now on a paused schedule settles through a reconcile-only observer, never daily work", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create()
  assert.equal((await f.control("run-now")).state, "paused")
  assert.equal(f.starts.length, 1)
  assert.equal(dailyJobs(f).length, 0, "Run now never arms daily scheduling")
  await f.model()
  await f.advance(f.now + 3_600_000)
  const settled = await f.snapshot()
  assert.equal(settled.state, "paused")
  assert.equal(settled.pending, null)
  assert.equal(settled.latestResult?.outcome, "completed")
  assert.equal([...f.jobs.values()].filter(job => job.status === "running").length, 0, "observer exits once settled")
  await f.advance(DUE + DAY)
  assert.equal(f.starts.length, 1, "still paused: no daily passage")
  assert.deepEqual(settled.actions.includes("check"), false)
})

test("H. Restart while paused with a pending manual passage exposes Check passage, reconcile-only", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("run-now")
  await f.model({ report: false, keepActive: true })
  const ids = f.starts.map(m => m.id)
  await f.restart()
  const parked = await f.snapshot()
  assert.equal(parked.state, "paused")
  assert(parked.pending)
  assert.equal(f.jobs.size, 0, "plugin startup must not silently rearm the observer")
  assert(parked.actions.includes("check"))
  const checked = await f.control("check")
  assert.equal(checked.state, "paused")
  assert.equal(checked.actions.includes("check"), false, "observer already running")
  assert.equal(dailyJobs(f).length, 0)
  assert.deepEqual(f.starts.map(m => m.id), ids, "check never resends")
  await f.model(); await f.advance(f.now + 3_600_000)
  const settled = await f.snapshot()
  assert.equal(settled.latestResult?.outcome, "completed")
  assert.equal(settled.state, "paused")
  await f.advance(DUE + DAY)
  assert.equal(f.starts.length, 1)
  assert.equal(f.coordinators.length, 1)
})

/** A loaded Windows host can exceed the 3 s spawnSync timeout of a synchronous
 * Git placement read; make that deterministic for every synchronous git spawn. */
function timeOutSynchronousGit() {
  const original = childProcess.execFileSync
  let attempts = 0
  childProcess.execFileSync = ((file: string, ...rest: unknown[]) => {
    if (file === "git") { attempts++; throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) }
    return (original as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof original
  syncBuiltinESMExports()
  return { attempts: () => attempts, restore: () => { childProcess.execFileSync = original; syncBuiltinESMExports() } }
}

test("H2. Check after restart, Play and Pause stay admitted when synchronous Git spawns time out", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("run-now")
  await f.model({ report: false, keepActive: true })
  await f.restart()
  const git = timeOutSynchronousGit(); t.after(git.restore)
  const checked = await f.control("check")
  assert.equal(checked.state, "paused")
  assert.equal(checked.actions.includes("check"), false, "observer restarted")
  await f.model(); await f.advance(f.now + 3_600_000)
  assert.equal((await f.snapshot()).latestResult?.outcome, "completed")
  assert.equal((await f.control("play")).state, "running")
  assert.equal((await f.control("pause")).state, "paused")
  assert.equal(git.attempts(), 0, "control fences reread captured routing inputs instead of spawning Git synchronously")
  assert.equal(f.starts.length, 1)
})

test("I. Seventy sequential daily passages never exhaust the passage business cache", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  for (let day = 0; day < 70; day++) {
    await f.advance(DUE + day * DAY)
    assert.equal(f.starts.length, day + 1, `day ${day} admitted`)
    await f.model()
    await f.advance(DUE + day * DAY + 3_600_000)
    assert.equal((await f.snapshot()).pending, null, `day ${day} settled`)
  }
  const done = await f.snapshot()
  assert.equal(done.history.length, 30)
  assert.equal(f.errors.length, 0)
})

test("F2. A native terminal failure without a final report archives failed with one start and no retry", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play"); await f.advance(DUE)
  await f.model({ report: false, failed: true })
  await f.advance(DUE + 5_000)
  const settled = await f.snapshot()
  assert.equal(settled.pending, null)
  assert.equal(settled.latestResult?.outcome, "failed")
  assert.equal(f.starts.length, 1)
  assert.equal(f.coordinators.length, 1)
  await f.advance(DUE + 3_600_000)
  assert.equal(f.starts.length, 1, "Missions never retries or replays a failed passage")
  assert.equal((await f.snapshot()).nextDueAt, DUE + DAY)
})

test("F. Pending Form prevents settlement; idle without report is not completed", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play"); await f.advance(DUE)
  const form = f.pendingForm()
  await f.model()
  await f.advance(DUE + 3_600_000)
  assert((await f.snapshot()).pending)
  assert.equal((await f.snapshot()).history.length, 0)
  await f.answerForm(form)
  await f.advance(DUE + 2 * 3_600_000)
  assert.equal((await f.snapshot()).latestResult?.outcome, "completed")
  await f.advance(DUE + DAY)
  await f.model({ report: false })
  await f.advance(DUE + DAY + 3_600_000)
  const ended = await f.snapshot()
  assert.equal(ended.pending, null)
  assert.equal(ended.latestResult?.outcome, "ended-without-report")
  assert.equal(ended.history.length, 2)
})
