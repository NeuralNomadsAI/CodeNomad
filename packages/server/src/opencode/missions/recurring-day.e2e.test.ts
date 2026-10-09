import assert from "node:assert/strict"
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

test("C. Crash boundaries: pending CAS, native create and admission reconcile without replay", async t => {
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
        const sessions = f.coordinators.map(s => s.id), messages = f.starts.map(m => m.id)
        assert.equal(sessions.length, point === "after-pending" ? 0 : 1)
        assert.equal(messages.length, point === "after-message" ? 1 : 0)
        await f.restart(); await f.control("resume")
        await f.advance(DUE + 3_600_000)
        assert.deepEqual(f.coordinators.map(s => s.id), sessions, "Resume is reconcile-only, even with native absence")
        assert.deepEqual(f.starts.map(m => m.id), messages, "no resend on Resume")
        assert(f.starts.length <= 1)
        if (point === "after-message") {
          await f.model(); await f.advance(DUE + 2 * 3_600_000)
          assert.equal((await f.snapshot()).latestResult?.outcome, "completed")
        } else {
          assert((await f.snapshot()).pending, "incomplete native effects stay held, not automatically replayed")
        }
      } finally { await f.close() }
    })
  }
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
