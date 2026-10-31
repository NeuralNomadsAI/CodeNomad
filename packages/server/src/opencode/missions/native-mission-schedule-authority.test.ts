import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import type { MissionDocument } from "../../missions/mission-document"
import { missionScheduleRequestSchema, type MissionScheduleRequest } from "../../missions/mission-schedule-contract"
import { nativeMissionScheduleControlExecution } from "./native-mission-schedule-authority"
import { NativeScheduleCalendarOwner } from "./native-schedule-owner"
import { nativeScheduleOwnerBindings } from "./native-schedule-owner-bindings"
import { ownerFixture } from "./native-schedule-owner-test-fixture"

function requestFor(doc: MissionDocument, action: "stop" | "check", requestID: string, issuedAt = Date.now()): MissionScheduleRequest & { action: "stop" | "check" } {
  return { ...missionScheduleRequestSchema.parse({ missionID: doc.id, action, requestID, expectedRevision: doc.revision,
    transport: { sessionID: "human", workspaceID: "workspace", scheduleID: doc.id, action, requestID, expectedRevision: doc.revision,
      location: { directory: doc.projectCanonical }, profileSource: doc.calendarOwner!.profileSource,
      issuedAt, digest: "a".repeat(64), proof: "b".repeat(64) } }), action }
}

function guardedOwner(f: Awaited<ReturnType<typeof ownerFixture>>, doc: MissionDocument, current: () => true) {
  return new NativeScheduleCalendarOwner({ store: f.store, native: f.native,
    bindings: nativeScheduleOwnerBindings(f.ctx, Effect.runPromise), installation: doc.calendarOwner!.installation,
    profileSource: doc.calendarOwner!.profileSource, current })
}

test("an expired transport cannot publish a fresh control intent", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  const before = await f.read(), request = requestFor(before, "stop", "expired_stop", Date.now() - 30_001)
  const execution = nativeMissionScheduleControlExecution(request, f.current)
  const values = structuredClone([...f.values]), calls = [...f.calls]
  assert.throws(execution.current, /expired/)
  await assert.rejects(guardedOwner(f, before, execution.current).prepareControl(request), /policy-unqualified/)
  assert.deepEqual([...f.values], values); assert.deepEqual(f.calls, calls)
})

test("only the exact committed control lifts admission freshness and ownership stays live", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  const before = await f.read(), request = requestFor(before, "stop", "guarded_stop")
  let owned = true, checks = 0
  const execution = nativeMissionScheduleControlExecution(request, () => {
    checks++; if (!owned) throw new Error("Ownership changed"); return true
  })
  execution.current()
  const owner = guardedOwner(f, before, execution.current), calls = [...f.calls]
  const prepared = await owner.prepareControl(request)
  assert.deepEqual(f.calls, calls, "durable admission precedes external calendar effects")
  for (const patch of [
    (doc: MissionDocument) => { doc.id = "other_mission" },
    (doc: MissionDocument) => { doc.calendarOwner!.operation.requestID = "other_request" },
    (doc: MissionDocument) => { doc.calendarOwner!.operation.expectedRevision++ },
    (doc: MissionDocument) => { doc.calendarOwner!.operation.action = "pause" },
    (doc: MissionDocument) => { doc.calendarOwner!.operation.fingerprint = "0".repeat(64) },
  ]) {
    const wrong = structuredClone(prepared); patch(wrong)
    assert.throws(() => execution.admitControl(wrong), /admission proof differs/)
  }
  assert.equal(execution.admitControl(prepared), true)
  assert.equal(execution.signal.aborted, false)
  await owner.reconcile(before.id)
  owned = false
  const saved = structuredClone([...f.values])
  assert.throws(execution.current, /Ownership changed/)
  await assert.rejects(owner.reconcile(before.id), /policy-unqualified/)
  assert.deepEqual([...f.values], saved)
  assert(checks > 2)
})

test("Check admits its own committed receipt before continuing the original pending control", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  const before = await f.read()
  await f.owner.prepareInterruption({ missionID: before.id, requestID: "original_stop", expectedRevision: before.revision, action: "stop" })
  const stopped = await f.read(), request = requestFor(stopped, "check", "check_original_stop")
  const execution = nativeMissionScheduleControlExecution(request, f.current), calls = [...f.calls]
  const owner = guardedOwner(f, stopped, execution.current), prepared = await owner.prepareControl(request)
  assert.equal(prepared.calendarOwner!.operation.requestID, "original_stop")
  assert.deepEqual(f.calls, calls)
  assert.equal(execution.admitControl(prepared), true)
  const result = await owner.reconcile(before.id)
  assert.equal(result.calendarOwner!.operation.pending, false)
  assert.equal(result.state, "stopped")
})
