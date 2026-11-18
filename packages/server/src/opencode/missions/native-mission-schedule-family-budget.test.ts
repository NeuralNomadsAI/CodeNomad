import assert from "node:assert/strict"
import { readFileSync, realpathSync } from "node:fs"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { Effect, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { assertRecurrenceProofFresh } from "../../missions/recurrence-control-proof"
import { controlOperationID } from "../../missions/receipt-identity"
import { missionScheduleRequestSchema } from "../../missions/mission-schedule-contract"
import { actorFixture } from "./native-mission-schedule-actors-test-fixture"
import { nativeMissionScheduleControlExecution } from "./native-mission-schedule-authority"
import { NativeScheduleCalendarOwner } from "./native-schedule-owner"
import { nativeScheduleOwnerBindings } from "./native-schedule-owner-bindings"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { controlNativeScheduledPassage } from "./native-scheduled-passage-controls"
import type { MissionNativeService } from "./native-service-adapter"

// Each test uses the real 50 s family/10 s recheck budgets and real wall time.
// Global fetch/discovery mocks require sequential execution in this file.
for (const blocked of [true, false]) test(blocked
  ? "real-clock Stop cancels a blocked grandchild at the shared 50 s budget, then records a partial root receipt"
  : "real-clock Stop retains committed authority through a successful 35 s grandchild interrupt", {
  timeout: 120_000, concurrency: false,
}, async t => {
  const calendar = await ownerFixture(t)
  await calendar.control("play")
  const f = await actorFixture(t, calendar), before = await f.read()
  const passageRevision = (await f.control.snapshot()).missions[0].revision
  const profileSource = structuredClone(before.calendarOwner!.profileSource)
  const physicalRoot = realpathSync(f.directory), profileBytes = readFileSync(profileSource.configYamlPath, "utf8")
  let ownershipChecks = 0
  const ownership = (): true => {
    ownershipChecks++
    assert.equal(realpathSync(f.directory), physicalRoot)
    assert.equal(readFileSync(profileSource.configYamlPath, "utf8"), profileBytes)
    assert.equal(profileSource.profileID, before.pending!.configuration.profileID)
    assert.equal(profileSource.executionHost, before.pending!.configuration.executionHost)
    return true
  }
  const requestID = blocked ? "real_clock_blocked_stop" : "real_clock_slow_stop"
  // Bridge authentication precedes the internal execution-phase factory in production.
  // This composed check covers phase authority, with a schema-valid non-authenticating proof.
  const request = missionScheduleRequestSchema.parse({ missionID: before.id, requestID, expectedRevision: before.revision, action: "stop",
    transport: { sessionID: "human_fixture_session", workspaceID: "human_fixture_workspace", requestID,
      location: { directory: f.directory }, scheduleID: before.id, expectedRevision: before.revision, action: "stop",
      digest: "a".repeat(64), issuedAt: Date.now(), proof: "b".repeat(64), profileSource } })
  const execution = nativeMissionScheduleControlExecution(request, ownership)
  const owner = new NativeScheduleCalendarOwner({ store: calendar.store, native: calendar.native,
    bindings: nativeScheduleOwnerBindings(calendar.ctx, Effect.runPromise), installation: before.calendarOwner!.installation,
    profileSource, current: execution.current })
  const calendarCalls = [...calendar.calls]
  const doc = await owner.prepareInterruption({ missionID: request.missionID, requestID,
    expectedRevision: request.expectedRevision, action: "stop" })
  assert.equal(execution.admitControl(doc), true)
  assert.deepEqual(calendar.calls, calendarCalls, "intent CAS must precede external calendar effects")
  assert.equal(doc.state, "stopped"); assert.equal(doc.calendarOwner!.operation.pending, true)
  assert.notEqual(doc.id, doc.pending!.missionID)

  const attempts: Array<{ id: string; at: number }> = []
  const finalizers: Array<{ at: number; completed: boolean }> = []
  let completedGrandchildren = 0
  f.state.interruptEffect = id => {
    attempts.push({ id, at: performance.now() })
    if (id !== "ses_grandchild") return Effect.void
    let completed = false
    return Effect.gen(function* () {
      if (blocked) yield* Effect.never
      else yield* Effect.sleep(35_000)
      completed = true
      completedGrandchildren++
    }).pipe(Effect.ensuring(Effect.sync(() => { finalizers.push({ at: performance.now(), completed }) })))
  }
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected admission, ENV or passage business effect") }
  const native: MissionNativeService = {
    location: Schema.decodeUnknownSync(Location.Info)({ directory: f.directory,
      project: { id: doc.projectID, canonical: doc.projectCanonical, directory: f.directory } }),
    assertCurrent: execution.current, get: async ({ sessionID }) => f.sessions.get(sessionID), create: unexpected,
    environment: unexpected, inbox: async () => [], message: async () => undefined,
    cancelInbox: unexpected, admit: unexpected, sourceMessages: unexpected,
  }
  // Preserve the full production entry: document missionID must never overwrite the passage journal ID.
  const entry = { missionID: doc.id, requestID, action: "stop" as const, current: execution.current, signal: execution.signal }
  const startedAt = performance.now()
  const result = await f.invoke(() => calendar.store.withExclusion(locked => controlNativeScheduledPassage({
    document: doc, locked, storage: f.storage, native, authority: execution.current, current: execution.current,
    signal: execution.signal, profile: profileSource, now: Date.now,
    observation: { assertCurrent: execution.current, exists: async id => f.sessions.has(id),
      session: unexpected, children: async () => [], requests: async () => false },
    lifecycle: f.port(),
  }, entry)), execution.current)
  const elapsedMs = performance.now() - startedAt
  assert.deepEqual(result, { pending: false }, "durable actor receipt must finish despite the expired admission proof")
  assert(Date.now() - request.transport.issuedAt >= 35_000)
  assert.throws(() => assertRecurrenceProofFresh(request.transport.issuedAt))
  assert.equal(execution.current(), true)
  assert.equal(execution.signal.aborted, false)
  assert(ownershipChecks > 5, "committed execution must continue checking physical/profile ownership")

  const snapshot = await f.control.snapshot(), mission = snapshot.missions[0], operation = mission.control!
  assert.equal(snapshot.discardedEvents, 0); assert(!snapshot.controlUnavailable)
  assert.equal(mission.id, f.pending.missionID)
  assert.equal(operation.id, controlOperationID(mission.id, requestID))
  assert.equal(operation.expectedRevision, passageRevision)
  assert.equal(operation.requestID, requestID); assert.equal(operation.action, "stop")
  assert.deepEqual(operation.pending, []); assert.equal(operation.receipts!.length, 1)
  assert.deepEqual(operation.targets.map(target => target.sessionID), [f.coordinatorID])
  const ack = operation.receipts![0].nativeAcknowledgement!
  assert.equal(ack.missionID, f.pending.missionID); assert.equal(ack.operationID, operation.id)
  assert.equal(ack.sessionID, f.coordinatorID); assert.equal(ack.action, "stop")
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition !== "interrupt-observed") throw new Error("Missing actor interruption acknowledgement")
  assert.equal(ack.interrupt.interrupted, true)
  const rootAttempt = attempts.find(attempt => attempt.id === f.coordinatorID)
  assert(rootAttempt, "root interruption must be attempted after the family walk")
  const rootAfterMs = rootAttempt.at - startedAt
  if (blocked) {
    assert(rootAfterMs >= 49_000 && rootAfterMs < 65_000, `root attempted after ${rootAfterMs} ms; expected the 50 s family boundary, not 85 s`)
    assert(elapsedMs >= 59_000 && elapsedMs < 80_000, `post-root 10 s recheck must stay bounded: ${elapsedMs} ms`)
    assert.equal(ack.descendants!.complete, false); assert(ack.descendants!.unconfirmed > 0)
    assert.equal(finalizers.length, 2, "both blocked family and post-root calls must be cancelled and joined")
    assert(finalizers.every(item => !item.completed)); assert(finalizers[0].at <= rootAttempt.at)
    assert.equal(completedGrandchildren, 0); assert(f.active.has("ses_grandchild"))
  } else {
    assert(rootAfterMs >= 35_000 && rootAfterMs < 50_000, `successful slow interrupt must precede the family deadline: ${rootAfterMs} ms`)
    assert.deepEqual(attempts.map(attempt => attempt.id), ["ses_grandchild", "ses_child", f.coordinatorID])
    assert.equal(ack.descendants!.complete, true); assert.equal(ack.descendants!.unconfirmed, 0)
    assert.equal(finalizers.length, 1); assert.equal(finalizers[0].completed, true)
    assert.equal(completedGrandchildren, 1); assert.equal(f.active.size, 0)
  }
  assert(!f.active.has(f.coordinatorID))
  assert.deepEqual(calendar.calls, calendarCalls, "calendar effects must not precede the durable actor receipt")
  const after = await f.read()
  assert.equal(after.state, "stopped"); assert.equal(after.launchedCount, 1)
  assert.equal(after.calendarOwner!.operation.requestID, requestID)
  assert.equal(after.calendarOwner!.operation.expectedRevision, request.expectedRevision)
  assert.equal(after.calendarOwner!.operation.pending, true)
  for (const key of ["id", "missionID", "coordinatorSessionID", "messageID", "admittedAt"] as const)
    assert.equal(after.pending![key], before.pending![key], `original pending ${key} must survive`)
  assert.equal(f.admissions.size, 0)
  assert(!f.calls.some(call => call.kind === "environment" || call.kind === "synthetic"))
  const intent = [...f.values.values()].find(value => value?.type === "mission.control-requested" && value.requestID === requestID)
  assert.equal(intent.missionID, f.pending.missionID)
  assert.equal("current" in intent, false); assert.equal("signal" in intent, false)
  const saved = JSON.stringify([...f.values]), callCount = f.calls.length, finalized = finalizers.length
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(JSON.stringify([...f.values]), saved, "cancelled callbacks must not perform late journal writes")
  assert.equal(f.calls.length, callCount); assert.equal(finalizers.length, finalized)
  assert.equal(completedGrandchildren, blocked ? 0 : 1)
  t.diagnostic(JSON.stringify({ kind: blocked ? "blocked-50s" : "successful-35s", elapsedMs: Math.round(elapsedMs),
    rootAfterMs: Math.round(rootAfterMs), finalizers: finalizers.map(item => ({ afterMs: Math.round(item.at - startedAt), completed: item.completed })),
    receipt: { requestID: operation.requestID, pending: operation.pending, complete: ack.descendants!.complete }, launchedCount: after.launchedCount }))
})
