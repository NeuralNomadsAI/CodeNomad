import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { controlNativeMissionSchedule } from "./native-mission-schedule-control"
import { missionSchedulePayloadDigest } from "../../missions/mission-schedule-contract"
import { ownerFixture } from "./native-schedule-owner-test-fixture"

test("native deletion conflicts are input-bound refusals and exact tombstone replay stays read-only", async () => {
  const tombstone = { id: "deleted_schedule", deletedAt: 100, requestID: "delete_original", expectedRevision: 5, deleteManagedSessions: false }
  const original = { missionID: tombstone.id, requestID: tombstone.requestID, expectedRevision: 5, action: "delete" as const,
    transport: { sessionID: "human_cookie" } }
  const execute = (request: object) => Effect.runPromise(controlNativeMissionSchedule({} as never, {
    request, store: { read: async () => structuredClone(tombstone) }, current: () => true,
  } as never, undefined, Effect.runPromise).pipe(Effect.scoped))
  const recovered = await execute(original)
  assert.ok("deleted" in recovered && recovered.deleted)
  assert.equal(recovered.pending, false)
  for (const patch of [{ requestID: "another_delete" }, { expectedRevision: 6 }, { deleteManagedSessions: true }]) {
    const request = { ...original, ...patch }, result = await execute(request)
    assert.ok("refusal" in result)
    assert.deepEqual(result.refusal, { missionID: original.missionID, requestID: request.requestID, action: "delete",
      expectedRevision: request.expectedRevision, payloadDigest: missionSchedulePayloadDigest(request), reason: "control-conflict" })
    assert.equal(result.pending, false)
  }
})

test("native manual passage identities refuse changed revision or another action before native effects", async t => {
  const f = await ownerFixture(t), document = await f.read()
  const snapshot = { ...document, pending: { origin: { kind: "manual", requestID: "manual_original" }, manualExpectedRevision: 5 } }
  for (const [action, expectedRevision] of [["run-now", 6], ["pause", 5]] as const) {
    const request = { missionID: document.id, requestID: "manual_original", action, expectedRevision, transport: { sessionID: "human_cookie" } }
    const result = await Effect.runPromise(controlNativeMissionSchedule({} as never, {
      request, store: { read: async () => structuredClone(snapshot) }, current: () => true,
    } as never, undefined, Effect.runPromise).pipe(Effect.scoped))
    assert.ok("refusal" in result)
    assert.equal(result.refusal?.reason, "control-conflict")
    assert.equal(result.pending, false)
    assert.equal(f.calls.length, 0)
  }
})
