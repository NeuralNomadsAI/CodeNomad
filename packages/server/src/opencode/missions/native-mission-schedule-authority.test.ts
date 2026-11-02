import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import type { MissionDocument } from "../../missions/mission-document"
import { MissionDocumentPassageEngine } from "../../missions/mission-document-passage-engine"
import { missionScheduleRequestSchema, type MissionScheduleRequest } from "../../missions/mission-schedule-contract"
import { NATIVE_MISSION_SCHEDULE_CONTROL_TIMEOUT_MS, nativeMissionScheduleControlExecution } from "./native-mission-schedule-authority"
import { NativeScheduleCalendarOwner, nativeScheduleOwnerControlReceipt } from "./native-schedule-owner"
import { nativeScheduleOwnerBindings } from "./native-schedule-owner-bindings"
import { ownerFixture } from "./native-schedule-owner-test-fixture"

function requestFor<Action extends "stop" | "check" | "run-now">(doc: MissionDocument, action: Action, requestID: string, issuedAt = Date.now()): MissionScheduleRequest & { action: Action } {
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

test("Run now retains exact manual authority past 30 s without extending its original 95 s deadline", async t => {
  const f = await ownerFixture(t)
  await f.control("play"); await f.control("pause")
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: f.now })
  let deadlines = 0
  t.mock.method(AbortSignal, "timeout", (delay: number) => {
    assert.equal(delay, NATIVE_MISSION_SCHEDULE_CONTROL_TIMEOUT_MS); deadlines++
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException("Control deadline elapsed", "TimeoutError")), delay)
    return controller.signal
  })
  const before = await f.read(), request = requestFor(before, "run-now", "manual_slow")
  let owned = true, admit = false
  const execution = nativeMissionScheduleControlExecution(request, () => {
    if (!owned) throw new Error("Ownership changed")
    return true
  })
  const signal = execution.signal, owner = guardedOwner(f, before, execution.current)
  const engine = new MissionDocumentPassageEngine(f.store, {
    incarnation: "manual_test", now: Date.now, current: execution.current,
    verifyWake: async () => { throw new Error("Manual run has no wake") },
    coverage: async () => ({ complete: true, wakes: [], current: execution.current }),
    snapshot: async () => ({ changed: true, checkpoints: [], current: execution.current }),
    admit: async doc => {
      if (!admit) { t.mock.timers.tick(35_000); execution.current(); return { kind: "unknown" } }
      return { kind: "admitted", passageID: doc.pending!.id, messageID: doc.pending!.messageID,
        coordinatorSessionID: doc.pending!.coordinatorSessionID, at: Date.now() }
    },
    observe: async () => ({ outcome: "completed", current: execution.current }),
  })
  assert.throws(() => execution.admitControl(before), /admission proof differs/)
  assert.equal(await engine.runNow({ ...request, reserved: execution.admitControl }), "unknown")
  const reserved = await f.read(), original = structuredClone(reserved.pending!)
  assert.equal(original.origin.kind, "manual"); assert.equal(original.manualExpectedRevision, request.expectedRevision)
  assert.equal(nativeScheduleOwnerControlReceipt(reserved, request.requestID), undefined)
  for (const patch of [
    (doc: MissionDocument) => { doc.id = "other_mission" },
    (doc: MissionDocument) => { doc.pending!.origin = { kind: "manual", requestID: "other_request" } },
    (doc: MissionDocument) => { doc.pending!.origin = { kind: "immediate", requestID: request.requestID } },
    (doc: MissionDocument) => { delete doc.pending!.manualExpectedRevision },
    (doc: MissionDocument) => { doc.pending!.manualExpectedRevision!++ },
    (doc: MissionDocument) => { doc.revision = request.expectedRevision },
    (doc: MissionDocument) => { doc.pending = null },
  ]) {
    const foreign = structuredClone(reserved); patch(foreign)
    assert.throws(() => execution.admitControl(foreign), /admission proof differs/)
  }
  // The production Run now callback promotes the committed readback under exclusion,
  // before even the first reconciliation can cross the transport freshness window.
  await owner.reconcile(request.missionID)
  assert.equal(Date.now() - request.transport.issuedAt, 35_000)
  assert.equal(execution.current(), true); assert.equal(execution.signal, signal)
  admit = true
  assert.equal(await engine.reconcile(request), "settled")
  const settled = await f.read()
  assert.equal(settled.pending, null); assert.equal(settled.launchedCount, 1); assert.equal(settled.successfulCount, 1)
  for (const key of ["id", "missionID", "coordinatorSessionID", "messageID", "manualExpectedRevision"] as const)
    assert.equal(settled.history[0][key], original[key])
  assert.equal(nativeScheduleOwnerControlReceipt(settled, request.requestID), undefined)
  assert.equal(execution.admitControl(settled), true, "an already archived exact manual reservation retains its original proof")
  owned = false; assert.throws(execution.current, /Ownership changed/); owned = true
  t.mock.timers.tick(59_999)
  assert.equal(execution.current(), true)
  t.mock.timers.tick(1)
  assert.equal(signal.aborted, true); assert.equal(deadlines, 1)
  assert.throws(execution.current, error => error === signal.reason)
  assert.throws(() => execution.admitControl(settled), error => error === signal.reason)
  const saved = structuredClone([...f.values])
  await assert.rejects(engine.reconcile(request), error => error === signal.reason)
  assert.deepEqual([...f.values], saved)
})

test("Run now cannot reserve or promote absent or foreign proof after admission freshness expires", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  t.mock.timers.enable({ apis: ["Date"], now: f.now })
  const before = await f.read(), request = requestFor(before, "run-now", "manual_expired")
  const execution = nativeMissionScheduleControlExecution(request, f.current)
  const engine = new MissionDocumentPassageEngine(f.store, {
    incarnation: "manual_expired", now: Date.now, current: execution.current,
    verifyWake: async () => { throw new Error("Unexpected wake") }, coverage: async () => { throw new Error("Unexpected coverage") },
    snapshot: async () => ({ changed: true, checkpoints: [], current: execution.current,
      revalidate: async () => { t.mock.timers.tick(30_001) } }),
    admit: async () => { throw new Error("Unexpected admission") }, observe: async () => undefined,
  })
  const saved = structuredClone([...f.values]), calls = [...f.calls]
  await assert.rejects(engine.runNow(request), /policy-unqualified/)
  assert.deepEqual([...f.values], saved); assert.deepEqual(f.calls, calls)
  assert.throws(() => execution.admitControl(before), /admission proof differs/)
  assert.throws(execution.current, /expired/)
  const foreign = new MissionDocumentPassageEngine(f.store, {
    incarnation: "foreign_manual", now: Date.now, current: f.current,
    verifyWake: async () => { throw new Error("Unexpected wake") }, coverage: async () => { throw new Error("Unexpected coverage") },
    snapshot: async () => ({ changed: true, checkpoints: [], current: f.current }),
    admit: async () => ({ kind: "unknown" }), observe: async () => undefined,
  })
  await foreign.runNow({ ...request, requestID: "foreign_manual" })
  const foreignReservation = await f.read()
  assert.throws(() => execution.admitControl(foreignReservation), /admission proof differs/)
  assert.throws(execution.current, /expired/)
})
