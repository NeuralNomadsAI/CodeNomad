import assert from "node:assert/strict"
import test from "node:test"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import { admitNativeMissionScheduleCodeWake } from "./native-mission-schedule-code-admission"
import type { NativeScheduleCalendarInfo } from "./native-schedule-calendar-service"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { runningMissionCodeWake } from "./native-mission-automation"

async function admission(t: test.TestContext) {
  const f = await ownerFixture(t)
  f.createCodeRows()
  const doc = await f.control("play"), principal = doc.calendars.find(item => item.role === "principal")!
  const info = f.calendars.get(principal.scheduleID)!
  const row = { ...info, nextDueAt: f.now + 1000 }
  const wake = (run: number) => ({ missionID: doc.id, generation: doc.timeGeneration, sessionID: principal.sessionID,
    scheduleID: principal.scheduleID, run, messageID: `msg_${principal.scheduleID}_${run}` })
  const admitNow = (run: number, value: NativeScheduleCalendarInfo | null) =>
    admitNativeMissionScheduleCodeWake(wake(run), { store: f.store, current: f.current, row: async () => value ? structuredClone(value) : undefined })
  // As the tool does: the run's own program is live while it asks for admission.
  const admit = (run = 1, value: NativeScheduleCalendarInfo | null = row) => runningMissionCodeWake(principal.scheduleID, run, () => admitNow(run, value))
  const prepared = async () => (await f.read()).calendars.find(item => item.scheduleID === principal.scheduleID)!.wakePreparing
  return { f, row, admit, admitNow, prepared, principal }
}

test("a running code program is admitted once, from its row's unchanged count and next due time", async t => {
  const { f, row, admit, prepared, principal } = await admission(t)
  assert.equal((await admit()).state, "pending")
  assert.deepEqual(await prepared(), { scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1`, dueAt: row.nextDueAt })
  const revision = (await f.read()).revision
  assert.equal((await admit()).state, "pending")
  assert.equal((await f.read()).revision, revision, "a retried run writes nothing")
  assert.equal((await admit(2)).state, "rejected", "a later run waits for the admitted one")
  assert.equal((await admit(1, { ...row, runCount: 1 })).state, "pending", "counted after its admission")
  // OpenCode resumed the row after failed runs: the same count now belongs to its next slot.
  assert.equal((await admit(1, { ...row, nextDueAt: row.nextDueAt! + 60_000 })).state, "pending")
  assert.equal((await prepared())!.dueAt, row.nextDueAt! + 60_000)
  const doc = await f.read()
  await f.store.change(doc.id, doc.revision, f.current, value => missionDocumentChanges.processWake(value, (value.calendars
    .find(item => item.scheduleID === principal.scheduleID)!).wakePreparing!))
  assert.equal((await admit()).state, "applied")
  await assert.rejects(admit(1, { ...row, code: false }), /schedule-calendar-requires-code/)
})

test("prompt, paused, foreign and barrier states admit nothing", async t => {
  const { f, row, admit, prepared } = await admission(t)
  await assert.rejects(admit(1, { ...row, code: false }), /schedule-calendar-requires-code/)
  for (const value of [null, { ...row, status: "paused" as const }, { ...row, nextDueAt: null }, { ...row, runCount: 1 }])
    assert.equal((await admit(1, value)).state, "rejected")
  await f.control("pause")
  assert.equal((await admit()).state, "rejected")
  assert.equal(await prepared(), null)
})

test("a matching row without its live program cannot admit a future occurrence", async t => {
  const { admitNow, row, prepared } = await admission(t)
  assert.equal((await admitNow(1, row)).state, "rejected")
  assert.equal(await prepared(), null)
})
