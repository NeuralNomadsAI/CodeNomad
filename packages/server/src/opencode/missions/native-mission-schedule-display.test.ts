import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { observeNativeMissionSchedule } from "./native-mission-schedule-display"
import { missionScheduleView } from "../../missions/mission-schedule-view"
import { missionScheduleRpcMethods } from "../../missions/mission-schedule-contract"
import { projectMissionDocument } from "../../missions/mission-document"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"

test("display reads only the exact principal rows, merges native dates and scopes technical counters to their generation", async t => {
  const f = await ownerFixture(t, { kind: "multi", calendars: [
    { expression: "15 9 * * *", zone: "UTC" }, { expression: "45 17 * * *", zone: "UTC" },
  ] })
  const beforePlay = missionScheduleView(await f.read())
  assert.equal(beforePlay.document!.observation.state, "unarmed")
  assert.ok(beforePlay.document!.availableActions.includes("play"))
  const doc = await f.control("play"), principals = doc.calendars.filter(item => item.role === "principal")
  for (const [index, item] of principals.entries()) {
    const info = f.calendars.get(item.scheduleID)!
    info.nextDueAt = [123_456, 99_999][index]; info.runCount = index + 1
  }
  f.calendars.get(doc.calendars.find(item => item.role === "reconciliation")!.scheduleID)!.runCount = 999
  const before = structuredClone([...f.values]), offset = f.calls.length
  const observation = await observeNativeMissionSchedule(doc, f.native, async () => true)
  assert.deepEqual(observation, { state: "known", nativeStatus: "active", nextDueAt: 99_999, wakeCount: 3, timeGeneration: doc.timeGeneration, kind: "launch" })
  assert.deepEqual(f.calls.slice(offset), ["get:principal", "get:principal"])
  assert.deepEqual([...f.values], before)
  const view = missionScheduleView(doc, undefined, observation)
  assert.ok(view.document!.availableActions.includes("pause"), "an armed calendar can be paused between passages")
  const validate = new Ajv().compile(missionScheduleRpcMethods.scheduleRead.output)
  assert.equal(validate(view), true, JSON.stringify(validate.errors))
  assert.doesNotMatch(JSON.stringify(view), /registrationFile|configYamlPath|sha256/)
})

test("missing, foreign, partial, retired and revision-racing native observations stay entirely unknown", async t => {
  const f = await ownerFixture(t), doc = await f.control("play")
  const id = doc.calendars.find(item => item.role === "principal")!.scheduleID
  const original = structuredClone(f.calendars.get(id)!)
  const read = () => observeNativeMissionSchedule(doc, f.native, async () => true)
  f.calendars.delete(id)
  assert.equal((await read()).state, "unknown")
  f.calendars.set(id, { ...original, sessionID: "foreign" })
  assert.equal((await read()).state, "unknown")
  f.calendars.set(id, original)
  assert.equal((await observeNativeMissionSchedule(doc, f.native, async () => false)).state, "unknown")
  assert.equal((await observeNativeMissionSchedule(doc, { ...f.native, assertCurrent: () => { throw new Error("retired") } }, async () => true)).state, "unknown")
  const incomplete = structuredClone(doc)
  incomplete.calendarOwner!.operation.pending = true
  assert.equal((await observeNativeMissionSchedule(incomplete, f.native, async () => true)).state, "unknown")
  f.calendars.get(id)!.status = "paused"
  assert.equal((await read()).nextDueAt, null, "a paused row's persisted dueAt is not an active next wake")
  assert.equal((await read()).nativeStatus, "paused", "native state is distinct from desired running")
  f.calendars.get(id)!.status = "active"; f.calendars.get(id)!.nextDueAt = null
  assert.equal((await read()).state, "unknown", "an active row without its next due is incomplete")
})

test("actions retain terminal, uncertainty, pending-admission and global quota barriers; H9 sees prepared wakes", async t => {
  const f = await ownerFixture(t), doc = await f.control("play")
  const actions = () => missionScheduleView(doc).document!.availableActions
  assert.ok(actions().includes("run-now"))
  const principal = doc.calendars.find(item => item.role === "principal")!
  principal.wakePreparing = { scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1`, dueAt: f.now }
  assert.equal(projectMissionDocument(doc).edit.reason, "uncertain")
  assert.ok(!actions().includes("configure"))
  assert.ok(!actions().includes("run-now"))
  principal.wakePreparing = null
  changes.reserve(doc, { kind: "manual", requestID: "manual_check" }, f.now, [])
  assert.equal(projectMissionDocument(doc).edit.reason, "passage")
  assert.ok(!actions().includes("run-now"))
  doc.state = "paused"
  assert.ok(!actions().includes("resume"), "an uncertain original admission cannot be bypassed")
  changes.admitted(doc, doc.pending!.id, f.now)
  assert.ok(actions().includes("resume"))
  doc.state = "stopped"
  assert.ok(!actions().some(action => ["play", "resume", "run-now", "pause"].includes(action)))
  assert.ok(actions().includes("check"))
  doc.deletion = { requestID: "delete_check", expectedRevision: doc.revision, requestedAt: f.now, deleteManagedSessions: false }
  assert.deepEqual(actions(), ["check"])
})
