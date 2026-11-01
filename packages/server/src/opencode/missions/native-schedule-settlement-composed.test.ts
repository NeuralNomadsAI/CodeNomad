import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect, Schema } from "effect"
import { Schedule } from "@opencode/schema/schedule"
import { SessionMessage } from "@opencode/schema/session-message"
import { MissionDocumentPassageEngine, type DocumentPassagePorts } from "../../missions/mission-document-passage-engine"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import type { MissionWake } from "../../missions/mission-document"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { acquireNativeScheduledPassageCoverage } from "./native-scheduled-passage-coverage"
import type { MissionNativeService } from "./native-service-adapter"
import { NATIVE_SCHEDULE_CARRIER_SIGNAL, claimNativeScheduleCarrierWake, nativeScheduleClaimKey,
  nativeScheduleCarrierLookupKey, closeNativeScheduleCarrierClaimLocked } from "./native-schedule-carrier-binding"

/** Real owner + document engine + native coverage over one shared native-row
 * fixture. Only external admission/family proof and the native I/O are controlled. */
async function composed(t: test.TestContext, maximum = 3) {
  const f = await ownerFixture(t, { kind: "every", intervalMs: 900_000 }, maximum)
  const armed = await f.control("play"), principal = armed.calendars.find(item => item.role === "principal")!
  const auxiliary = armed.calendars.find(item => item.role === "reconciliation")!
  const messages = new Map<string, typeof SessionMessage.Info.Type>(), business: string[] = []
  let now = f.now, quietFamily = false, originalAdmissions = 0
  const native = { location: f.ctx.location,
    get: async ({ sessionID }: { sessionID: string }) => {
      const session = f.sessions.get(sessionID)
      if (!session) throw new Error("Native session missing")
      return structuredClone(session)
    }, message: async ({ messageID }: { messageID: string }) => messages.get(messageID),
  } as unknown as MissionNativeService
  const schedule = {
    enabled: () => Effect.succeed(true),
    get: (id: string) => Effect.sync(() => {
      const row = f.calendars.get(id)
      if (!row) throw new Error("Native calendar missing")
      return Schema.decodeUnknownSync(Schedule.Info)({ id: row.id, sessionID: row.sessionID, name: row.name, when: row.when, tz: "UTC",
        action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL }, status: row.status, runCount: row.runCount,
        ...(row.nextDueAt === null ? {} : { nextDueAt: row.nextDueAt }), ...(row.endsAt === null ? {} : { endsAt: row.endsAt }),
        time: { created: row.createdAt, updated: row.createdAt } })
    }),
  }
  const graph = Context.make(Context.Service<never, unknown>("@opencode/Schedule"), schedule)
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseWith(graph)(effect)
  const coverage = await run(acquireNativeScheduledPassageCoverage(native, run)), signal = new AbortController().signal
  f.native.wakeAcknowledged = async (target, wake, current) => {
    current()
    const doc = await f.read()
    try {
      const verified = await coverage.verifyWake(doc, { ...wake, missionID: doc.id, generation: target.descriptor.timeGeneration,
        sessionID: target.descriptor.sessionID }, current, signal)
      verified.current(); return verified.wake.dueAt === wake.dueAt
    } catch { return false }
  }
  const ports: DocumentPassagePorts = {
    incarnation: "composed_native", now: () => now, current: f.current,
    verifyWake: (doc, wake) => coverage.verifyWake(doc, wake, f.current, signal),
    coverage: (doc, window) => coverage.coverage(doc, window, f.current, signal),
    snapshot: async () => { business.push("source"); return { changed: true, checkpoints: [], current: f.current } },
    admit: async doc => {
      business.push("admit")
      const pending = doc.pending!
      if (pending.admittedAt === null) originalAdmissions++
      return { kind: pending.admittedAt === null ? "admitted" : "recorded", passageID: pending.id, messageID: pending.messageID,
        coordinatorSessionID: pending.coordinatorSessionID, at: now }
    },
    observe: async () => { business.push("observe"); return quietFamily ? { outcome: "completed", current: f.current } : undefined },
  }
  const engine = new MissionDocumentPassageEngine(f.store, ports)
  const occurrence = (): MissionWake => ({ scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1`, dueAt: f.now + 900_000 })
  const acknowledge = (wake = occurrence(), present = true) => {
    const row = f.calendars.get(wake.scheduleID)!
    row.runCount = wake.run; row.nextDueAt = wake.dueAt + 900_000
    if (present) messages.set(wake.messageID, Schema.decodeUnknownSync(SessionMessage.Info)({ type: "user", id: wake.messageID,
      text: NATIVE_SCHEDULE_CARRIER_SIGNAL, time: { created: now }, metadata: { schedule: { id: wake.scheduleID, run: wake.run, dueAt: wake.dueAt, late: false } } }))
  }
  const incoming = () => ({ ...occurrence(), missionID: armed.id, generation: armed.timeGeneration, sessionID: principal.sessionID })
  return { ...f, armed, principal, auxiliary, engine, coverage, signal, business, messages, ports, occurrence, acknowledge, incoming,
    advance: (ms: number) => { now += ms; f.advance(ms) }, familyQuiet: () => { quietFamily = true }, admissions: () => originalAdmissions }
}

test("composed Pause → Run now → success closes its paused suppression window and permits the next explicit Run now", async t => {
  const f = await composed(t)
  await f.control("pause")
  f.advance(900_001) // The stored next slot can become overdue during a native pause.
  const maps = (await f.read()).calendars
  f.familyQuiet()
  for (const requestID of ["manual_first", "manual_second"]) {
    const before = await f.read()
    assert.equal(await f.engine.runNow({ missionID: before.id, requestID, expectedRevision: before.revision }), "settled")
    const settled = await f.read()
    assert.equal(settled.fanIn!.completed, true); assert.equal(settled.state, "paused"); assert.equal(settled.pending, null)
    await f.owner.reconcile(before.id)
  }
  const doc = await f.read()
  assert.equal(doc.launchedCount, 2); assert.equal(doc.settledCount, 2); assert.equal(f.admissions(), 2)
  assert.deepEqual(doc.calendars, maps)
  assert([...f.calendars.values()].every(row => row.status === "paused"))
})

test("composed last-quota settlement retains auxiliary while family is live, then removes every carrier after positive idle proof", async t => {
  const f = await composed(t, 1)
  f.advance(900_001); f.acknowledge()
  assert.equal(await f.engine.wake({ missionID: f.armed.id, wake: f.incoming() }), "started")
  let doc = await f.owner.reconcile(f.armed.id)
  assert.equal(doc.state, "finished"); assert(doc.pending)
  assert.equal(f.calendars.get(f.principal.scheduleID)!.status, "paused")
  assert.equal(f.calendars.get(f.auxiliary.scheduleID)!.status, "active")
  const pendingID = doc.pending!.id
  assert.equal(await f.engine.reconcile({ missionID: doc.id }), "pending")
  assert.equal((await f.read()).pending!.id, pendingID)
  f.familyQuiet()
  assert.equal(await f.engine.reconcile({ missionID: doc.id }), "settled")
  assert.equal((await f.read()).fanIn!.completed, true)
  f.blocked.add(f.auxiliary.sessionID)
  doc = await f.owner.reconcile(doc.id)
  assert.equal(doc.calendarOwner!.operation.pending, true)
  assert(f.values.has(nativeScheduleCarrierLookupKey(f.ctx, f.auxiliary.sessionID)))
  f.blocked.clear()
  doc = await f.owner.reconcile(doc.id)
  assert.equal(doc.calendarOwner!.operation.pending, false); assert.equal(doc.pending, null)
  assert.equal(doc.launchedCount, 1); assert.equal(doc.settledCount, 1); assert.equal(f.admissions(), 1)
  assert.equal(f.calendars.size, 0); assert.equal(f.sessions.size, 0); assert.equal(doc.calendars.length, 0)
})

test("composed Stop with an admitted pending settles through paused coverage and cleans principal plus auxiliary", async t => {
  const f = await composed(t)
  f.advance(900_001); f.acknowledge()
  await f.engine.wake({ missionID: f.armed.id, wake: f.incoming() })
  const pendingID = (await f.read()).pending!.id
  let doc = await f.control("stop")
  assert.equal(doc.pending!.id, pendingID); assert.equal(doc.state, "stopped")
  f.familyQuiet()
  assert.equal(await f.engine.reconcile({ missionID: doc.id }), "settled")
  assert.equal((await f.read()).fanIn!.completed, true)
  doc = await f.owner.reconcile(doc.id)
  assert.equal(doc.state, "stopped"); assert.equal(doc.pending, null)
  assert.equal(doc.launchedCount, 1); assert.equal(f.admissions(), 1)
  assert.equal(f.sessions.size, 0); assert.equal(f.calendars.size, 0)
})

test("paused observation never authorizes new principal admission, even with a positive contiguous native wake", async t => {
  const f = await composed(t)
  f.advance(900_001); f.acknowledge()
  await f.native.pause({ missionID: f.armed.id, descriptor: f.armed.calendarOwner!.slots.find(item => item.role === "principal")! }, f.principal.scheduleID, f.current)
  const before = await f.read()
  const preflight = await f.engine.preflight({ missionID: before.id, wake: f.incoming() })
  assert.equal(preflight.messagePresent, true); assert.equal(preflight.ready, false)
  assert.equal(await f.engine.wake({ missionID: before.id, wake: f.incoming() }), "unknown")
  const doc = await f.read()
  assert.equal(doc.pending, null); assert.equal(doc.launchedCount, 0); assert.equal(doc.calendars[1].highWater, 0)
  assert.deepEqual(f.business, [])
  await f.control("pause")
  assert.equal(await f.engine.wake({ missionID: doc.id, wake: f.incoming() }), "ignored")
  assert.equal((await f.read()).pending, null); assert.equal((await f.read()).launchedCount, 0)
  assert.deepEqual(f.business, [])
})

test("paused suppression preserves an in-flight preparation through missing ACK/message, then consumes only its exact positive proof", async t => {
  const f = await composed(t)
  f.advance(900_001)
  let doc = await f.read()
  doc = await f.store.change(doc.id, doc.revision, f.current, value => changes.prepareWake(value, f.occurrence()))
  await f.control("pause")
  f.familyQuiet()
  doc = await f.read()
  assert.equal(await f.engine.runNow({ missionID: doc.id, requestID: "manual_with_preparation", expectedRevision: doc.revision }), "settled")
  const retained = await f.read()
  assert.equal(retained.fanIn!.completed, false); assert.deepEqual(retained.calendars[1].wakePreparing, f.occurrence())
  assert.equal(retained.calendars[1].highWater, 0)
  await assert.rejects(f.engine.runNow({ missionID: doc.id, requestID: "blocked_manual", expectedRevision: retained.revision }), /Manual passage conflict/)
  f.acknowledge(f.occurrence(), false)
  await f.engine.reconcile({ missionID: doc.id })
  assert.deepEqual((await f.read()).calendars[1].wakePreparing, f.occurrence())
  f.acknowledge()
  await f.engine.reconcile({ missionID: doc.id })
  doc = await f.read()
  assert.equal(doc.fanIn!.completed, true); assert.equal(doc.calendars[1].highWater, 1); assert.equal(doc.calendars[1].wakePreparing, null)
  assert.equal(doc.launchedCount, 1); assert.equal(f.admissions(), 1)
})

test("Delete consumes an exact acknowledged current preparation, closes its claim before removal, and permits compaction without business", async t => {
  const f = await composed(t)
  f.advance(900_001)
  let doc = await f.read()
  doc = await f.store.change(doc.id, doc.revision, f.current, value => changes.prepareWake(value, f.occurrence()))
  f.acknowledge()
  const incarnation = { id: "native_delete", pid: process.pid, url: "http://127.0.0.1:1" }
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, f.incoming(), incarnation, Effect.runPromise, f.current), true)
  const remove = f.native.remove
  f.native.remove = async (...args) => {
    const current = await f.read(), claim = f.values.get(nativeScheduleClaimKey(f.ctx, doc.id)) as { settled?: { highWater: number } }
    assert.equal(claim.settled?.highWater, 1)
    assert.equal(current.calendars.find(item => item.scheduleID === f.principal.scheduleID)!.highWater, 1)
    assert.equal(current.calendars.find(item => item.scheduleID === f.principal.scheduleID)!.wakePreparing, null)
    return remove(...args)
  }
  doc = await f.control("delete", "delete_prepared")
  assert.equal(doc.calendarOwner!.operation.pending, false); assert.equal(doc.calendars.length, 0)
  assert.equal(f.calendars.size, 0); assert.equal(f.sessions.size, 0)
  assert.equal(doc.launchedCount, 0); assert.equal(doc.pending, null); assert.deepEqual(f.business, [])
  const tombstone = await f.store.compact(doc.id, doc.revision, f.now + 900_002, f.current)
  assert.equal(tombstone.requestID, "delete_prepared")
})

test("Delete with unknown ACK or missing original retains current preparation, high-water, claim and every native target", async t => {
  for (const proof of ["no-ack", "missing-message", "pruned-after-read"] as const) {
    const f = await composed(t)
    f.advance(900_001)
    let doc = await f.read()
    doc = await f.store.change(doc.id, doc.revision, f.current, value => changes.prepareWake(value, f.occurrence()))
    if (proof !== "no-ack") f.acknowledge(f.occurrence(), proof === "pruned-after-read")
    if (proof === "pruned-after-read") {
      const acknowledge = f.native.wakeAcknowledged
      let reads = 0
      f.native.wakeAcknowledged = async (...args) => {
        const result = await acknowledge(...args)
        if (++reads === 1) f.messages.delete(f.occurrence().messageID)
        return result
      }
    }
    await claimNativeScheduleCarrierWake(f.ctx, f.incoming(), { id: "uncertain_native", pid: process.pid, url: "http://127.0.0.1:1" }, Effect.runPromise, f.current)
    doc = await f.control("delete", "delete_uncertain")
    assert.equal(doc.calendarOwner!.operation.pending, true); assert.equal(doc.calendarOwner!.error, "wake-unresolved")
    const principal = doc.calendars.find(item => item.role === "principal")!
    assert.equal(principal.highWater, 0); assert.deepEqual(principal.wakePreparing, f.occurrence())
    assert.equal(f.calendars.size, 2); assert.equal(f.sessions.size, 2)
    assert.equal(f.calls.some(call => call.startsWith("remove")), false)
    assert.equal(await f.store.withExclusion(locked => closeNativeScheduleCarrierClaimLocked(f.ctx, doc.id, Effect.runPromise, f.current, locked)), false)
    await assert.rejects(f.store.compact(doc.id, doc.revision, f.now + 900_002, f.current), /reconciliation pending/)
    assert.equal(doc.launchedCount, 0); assert.deepEqual(f.business, [])
  }
})

test("prepareInterruption commits only the exact durable intent; pending and completed replays invoke no native calendar effects", async t => {
  for (const action of ["pause", "stop", "delete"] as const) {
    const f = await ownerFixture(t), armed = await f.control("play"), nativeCalls = f.calls.length
    const input = { missionID: armed.id, expectedRevision: armed.revision, requestID: `prepare_${action}`, action }
    const prepared = await f.owner.prepareInterruption(input)
    assert.equal(prepared.state, action === "pause" ? "paused" : "stopped")
    assert.equal(prepared.calendarOwner!.operation.requestID, input.requestID)
    assert.equal(prepared.calendarOwner!.operation.expectedRevision, input.expectedRevision)
    assert.equal(prepared.calendarOwner!.operation.pending, true)
    assert.equal(f.calls.length, nativeCalls)
    assert.deepEqual(await f.owner.prepareInterruption(input), prepared)
    assert.equal(f.calls.length, nativeCalls)
    await assert.rejects(f.owner.prepareInterruption({ ...input, expectedRevision: input.expectedRevision + 1 }), /request conflict/)
    await assert.rejects(f.owner.prepareInterruption({ ...input, deleteManagedSessions: true }), /request conflict/)
    await assert.rejects(f.owner.prepareInterruption({ ...input, requestID: "invalid_prepare", action: "play" } as never), /interruption action required/)
    assert.equal(f.calls.length, nativeCalls)
    const complete = await f.owner.reconcile(armed.id), after = f.calls.length
    assert.equal(complete.calendarOwner!.operation.requestID, input.requestID)
    assert.equal(complete.calendarOwner!.operation.pending, false)
    assert.deepEqual(await f.owner.prepareInterruption(input), complete)
    assert.equal(f.calls.length, after)
  }
})
