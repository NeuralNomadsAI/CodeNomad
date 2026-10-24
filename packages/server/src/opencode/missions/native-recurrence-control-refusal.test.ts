import assert from "node:assert/strict"
import test from "node:test"
import { RecurringDayFixture } from "./recurring-day-fixture"

const status = (f: RecurringDayFixture, scheduleID: string, requestID: string, action: string, expectedRevision: number) =>
  f.rpc("recurrenceControlStatus", { scheduleID, requestID, action, expectedRevision }) as Promise<{ outcome: string; reason?: string }>

test("native status proves a control refused before any record instead of leaving it unknown", async t => {
  const f = await RecurringDayFixture.open(); t.after(() => f.close())
  await f.create(); await f.control("play")
  const doc = (await f.document())!
  const stale = doc.revision - 1
  // The scheduler (or another window) advanced the revision after the UI rendered.
  await f.control("pause", 500, { requestID: "pause_stale", expectedRevision: stale })
  assert.equal((await f.document())!.revision, doc.revision, "refused before any native write")
  assert.deepEqual(await status(f, doc.id, "pause_stale", "pause", stale), { version: 1, scheduleID: doc.id, requestID: "pause_stale",
    expectedRevision: stale, outcome: "rejected", reason: "revision-conflict" })

  // Inadmissible at the current revision: the same pure refusal any in-flight attempt meets.
  await f.control("play", 500, { requestID: "play_running", expectedRevision: doc.revision })
  assert.equal((await status(f, doc.id, "play_running", "play", doc.revision)).reason, "control-conflict")
  // Admissible but unrecorded may still be in flight: genuinely unknown.
  assert.equal((await status(f, doc.id, "pause_unsent", "pause", doc.revision)).outcome, "unknown")

  // Run now with a stale revision is refused the same way.
  await f.control("run-now", 500, { requestID: "manual_stale", expectedRevision: stale })
  const manual = await f.rpc("recurrenceRunNowStatus", { scheduleID: doc.id, requestID: "manual_stale", expectedRevision: stale }) as
    { outcome: string; reason?: string; passageID: string | null }
  assert.deepEqual([manual.outcome, manual.reason, manual.passageID], ["rejected", "revision-conflict", null])
  assert.equal(f.starts.length, 0, "nothing was started")

  // A fresh control under a new identity still commits.
  assert.equal((await f.control("pause")).state, "paused")
  const committed = (await f.document())!.controls.at(-1)!
  assert.equal((await status(f, doc.id, committed.requestID, "pause", committed.expectedRevision)).outcome, "committed")
})
