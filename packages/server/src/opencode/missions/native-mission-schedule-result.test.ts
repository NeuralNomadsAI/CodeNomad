import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { Effect } from "effect"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { nativeMissionScheduleResult } from "./native-mission-schedule-result"
import { missionScheduleRpcMethods } from "../../missions/mission-schedule-contract"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"

test("absent document is a complete pre-dispatch read but an unknown exact receipt", async () => {
  const ctx = {} as Parameters<typeof nativeMissionScheduleResult>[0]
  const before = await nativeMissionScheduleResult(ctx, undefined, Effect.runPromise)
  const recovery = await nativeMissionScheduleResult(ctx, undefined, Effect.runPromise, false, "creation_original")
  assert.equal(before.document, null)
  assert.equal(before.pending, false)
  assert.equal(recovery.document, null)
  assert.equal(recovery.pending, true)
})

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
  const unrecorded = await nativeMissionScheduleResult(f.ctx, tombstone, Effect.runPromise, false, "check_unrecorded")
  assert.equal(unrecorded.pending, true)
  assert.equal("checkReceipt" in unrecorded, false)
})

test("persisted Check identity survives deletion compaction so exact reads settle without another write", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  const deleting = await f.control("delete", "delete_original")
  const checkExpectedRevision = deleting.revision
  const checked = await f.control("check", "check_compact")
  const tombstone = await f.store.compact(checked.id, checked.revision, f.now + 2, f.current)
  assert.deepEqual(tombstone.checks, [{ requestID: "check_compact", expectedRevision: checkExpectedRevision }])
  const recovered = await nativeMissionScheduleResult(f.ctx, tombstone, Effect.runPromise, false, "check_compact")
  const validate = new Ajv().compile(missionScheduleRpcMethods.scheduleRead.output)
  assert.equal(validate(recovered), true, JSON.stringify(validate.errors))
  assert.equal(recovered.pending, false)
  assert.equal("deleted" in recovered && recovered.deleted, true)
  assert.equal(recovered.document, null)
  assert.deepEqual(recovered.deletionReceipt, { id: deleting.id, requestID: "delete_original", expectedRevision: deleting.deletion!.expectedRevision, deleteManagedSessions: false })
  assert.deepEqual(recovered.checkReceipt, { id: deleting.id, requestID: "check_compact", expectedRevision: checkExpectedRevision, action: "check" })
  const foreign = await nativeMissionScheduleResult(f.ctx, tombstone, Effect.runPromise, false, "check_foreign")
  assert.equal(foreign.pending, true)
  assert.equal("checkReceipt" in foreign, false)
})

test("compaction omits checks linked to superseded incomplete operations and tombstone schema rejects invalid check lists", async t => {
  const { missionTombstoneSchema } = await import("../../missions/mission-document")
  const f = await ownerFixture(t)
  await f.control("play")
  const deleting = await f.control("delete", "delete_superseded")
  const staged = await f.store.change(deleting.id, deleting.revision, f.current, value => {
    value.calendarOwner!.checks = [
      { requestID: "check_uncompleted_play", expectedRevision: 0, fingerprint: "d".repeat(64), originalRequestID: "play_never_completed" },
      { requestID: "check_completed_delete", expectedRevision: deleting.revision, fingerprint: "e".repeat(64), originalRequestID: "delete_superseded" },
    ]
  })
  const tombstone = await f.store.compact(staged.id, staged.revision, f.now + 1, f.current)
  assert.deepEqual(tombstone.checks, [{ requestID: "check_completed_delete", expectedRevision: deleting.revision }])
  assert.equal((await nativeMissionScheduleResult(f.ctx, tombstone, Effect.runPromise, false, "check_uncompleted_play")).pending, true)
  assert.equal((await nativeMissionScheduleResult(f.ctx, tombstone, Effect.runPromise, false, "check_completed_delete")).pending, false)
  assert.throws(() => missionTombstoneSchema.parse({ ...tombstone, checks: [{ requestID: "dup_check", expectedRevision: 0 }, { requestID: "dup_check", expectedRevision: 1 }] }))
  assert.throws(() => missionTombstoneSchema.parse({ ...tombstone, checks: [{ requestID: "future_check", expectedRevision: tombstone.revision }] }))
})
