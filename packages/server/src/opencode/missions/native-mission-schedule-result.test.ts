import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { Effect } from "effect"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { nativeMissionScheduleResult } from "./native-mission-schedule-result"
import { missionScheduleRpcMethods } from "../../missions/mission-schedule-contract"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"

test("schedule status projects exact retained controls and keeps missing receipts unknown without mutations or private paths", async t => {
  const f = await ownerFixture(t)
  const played = await f.control("play", "play_original")
  const expectedRevision = played.calendarOwner!.receipts[0].expectedRevision
  await f.owner.reconcile(played.id)
  const doc = await f.read(), before = structuredClone([...f.values]), calls = [...f.calls]
  const response = await nativeMissionScheduleResult(f.ctx, doc, Effect.runPromise, false, "play_original")
  const validate = new Ajv().compile(missionScheduleRpcMethods.scheduleRead.output)
  assert.equal(validate(response), true, JSON.stringify(validate.errors))
  assert.deepEqual(response.document?.control, { requestID: "play_original", action: "play", expectedRevision, pending: false })
  assert.equal(response.pending, false)
  const missing = await nativeMissionScheduleResult(f.ctx, doc, Effect.runPromise, false, "not_recorded")
  assert.equal(missing.document?.control, null)
  assert.equal(missing.pending, true)
  assert.doesNotMatch(JSON.stringify(response), /registrationFile|sha256|configYamlPath|receipts|fingerprint/)
  assert.deepEqual([...f.values], before)
  assert.deepEqual(f.calls, calls)
})

test("manual status retains the original revision, completes on admission and survives archival independently of calendar Pause receipts", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  let doc = await f.control("pause")
  const expectedRevision = doc.revision
  doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    value.state = "running"
    changes.reserve(value, { kind: "manual", requestID: "manual_original" }, f.now, [])
    value.pending!.manualExpectedRevision = expectedRevision
    value.pending!.manualAllowed = true
    value.state = "paused"
  })
  const read = () => nativeMissionScheduleResult(f.ctx, doc, Effect.runPromise, false, "manual_original")
  assert.deepEqual((await read()).document?.control, { requestID: "manual_original", expectedRevision, action: "run-now", pending: true })
  doc = await f.store.change(doc.id, doc.revision, f.current, value => changes.admitted(value, value.pending!.id, f.now))
  assert.equal((await read()).pending, false)
  doc = await f.store.change(doc.id, doc.revision, f.current, value => changes.settle(value, value.pending!.id, "completed", f.now + 1))
  assert.equal((await read()).pending, false)
  assert.equal((await read()).document?.control?.expectedRevision, expectedRevision)
})

test("calendar Delete completion keeps document compaction pending until its exact tombstone is durable", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  const doc = await f.control("delete", "delete_original")
  assert.equal(doc.calendarOwner!.operation.pending, false)
  const before = await nativeMissionScheduleResult(f.ctx, doc, Effect.runPromise, false, "delete_original")
  assert.equal(before.pending, true)
  assert.equal(before.document?.control?.pending, false)
  const tombstone = await f.store.compact(doc.id, doc.revision, f.now + 1, f.current)
  const after = await nativeMissionScheduleResult(f.ctx, tombstone, Effect.runPromise, false, "delete_original")
  assert.equal(after.pending, false)
  assert.equal(after.document, null)
  assert.deepEqual(after.deletionReceipt, { id: doc.id, requestID: "delete_original", expectedRevision: doc.deletion!.expectedRevision, deleteManagedSessions: false })
})
