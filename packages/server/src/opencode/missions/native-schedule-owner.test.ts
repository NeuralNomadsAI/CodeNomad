import assert from "node:assert/strict"
import { renameSync } from "node:fs"
import test from "node:test"
import { Effect } from "effect"
import { stableToken } from "../../missions/receipt-identity"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import { nativeScheduleCarrierLookupKey, NATIVE_SCHEDULE_CARRIER_MARKER, readNativeScheduleCarrierOwnership,
  claimNativeScheduleCarrierWake, closeNativeScheduleCarrierClaimLocked, readNativeScheduleCarrierBinding } from "./native-schedule-carrier-binding"
import { readNativeScheduleAuxiliaryWakeBinding } from "./native-schedule-owner-bindings"
import { missionCalendarOwnerReady, nativeScheduleOwnerControlReceipt } from "./native-schedule-owner"
import { ownerFixture } from "./native-schedule-owner-test-fixture"

test("Play persists ownership before carrier, acknowledges auxiliary first, and replay creates nothing", async t => {
  const f = await ownerFixture(t), before = await f.read()
  assert.equal(f.calls.length, 0)
  const input = { missionID: before.id, requestID: "first_play", expectedRevision: before.revision, action: "play" as const }
  const doc = await f.owner.control(input)
  assert.equal(doc.calendarOwner?.operation.pending, false)
  assert.equal(missionCalendarOwnerReady(doc), true)
  assert.deepEqual(f.calls.filter(call => call.startsWith("create:")), ["create:reconciliation", "create:principal"])
  assert.equal(doc.launchedCount, 0)
  assert.equal(doc.calendarOwner?.profileSource.profileID, "profile")
  const count = f.calls.length
  await f.owner.control(input)
  assert.equal(f.calls.length, count)
  await assert.rejects(f.owner.control({ ...input, configuration: { ...doc.configuration, objective: "changed" } }), /request conflict/)
})

test("delayed auxiliary creation preserves Play origin and the inclusive first-interval end for every and in", async t => {
  for (const timing of [{ kind: "every" as const, intervalMs: 900_000 }, { kind: "in" as const, delayMs: 900_000 }]) {
    const f = await ownerFixture(t, timing)
    await f.control("configure", "bound_first_slot", { ...f.configuration,
      launch: { ...f.configuration.launch, ends: { maxLaunches: 3, afterMs: 900_000, at: null } } })
    f.delayAuxiliary(30_000)
    const doc = await f.control("play"), slot = doc.calendarOwner!.slots.find(item => item.role === "principal")!
    const native = f.calendars.get(slot.scheduleID!)!
    assert.equal(doc.calendarOwner!.operation.pending, false)
    assert.equal(native.createdAt, f.now); assert.equal(slot.anchorAt, f.now)
    assert.equal(native.nextDueAt, f.now + 900_000); assert.equal(native.endsAt, native.nextDueAt)
    assert.equal(doc.firstPlayedAt, f.now); assert.equal(doc.launchedCount, 0)
  }
})

test("ends-only in replacement keeps its frozen absolute one-shot and original duration", async t => {
  const f = await ownerFixture(t, { kind: "in", delayMs: 900_000 }), original = await f.control("play")
  f.advance(100_000)
  const doc = await f.control("configure", "in_bounds", { ...original.configuration,
    launch: { ...original.configuration.launch, ends: { maxLaunches: 3, afterMs: 900_000, at: null } } })
  const slot = doc.calendarOwner!.slots.find(item => item.role === "principal")!, native = f.calendars.get(slot.scheduleID!)!
  assert.equal(doc.calendarOwner!.operation.pending, false)
  assert.equal(doc.oneShotAt, original.oneShotAt); assert.equal(native.nextDueAt, original.oneShotAt)
  assert.equal(native.createdAt, original.firstPlayedAt)
  assert.deepEqual(native.when, { type: "in", in: "900000 millis", tz: "UTC" })
})

test("ends-only every replacement preserves the native future phase after consumed slots", async t => {
  const interval = 900_000, f = await ownerFixture(t, { kind: "every", intervalMs: interval }), original = await f.control("play")
  const principal = original.calendars.find(item => item.role === "principal")!, native = f.calendars.get(principal.scheduleID)!
  native.nextDueAt = f.now + 3 * interval; native.runCount = 2
  await f.store.change(original.id, original.revision, f.current, value => {
    for (const run of [1, 2]) missionDocumentChanges.processWake(value,
      { scheduleID: principal.scheduleID, run, messageID: `msg_${principal.scheduleID}_${run}`, dueAt: f.now + run * interval })
  })
  f.advance(2 * interval + 10_000)
  const doc = await f.control("configure", "every_bounds", { ...original.configuration,
    launch: { ...original.configuration.launch, ends: { maxLaunches: 3, afterMs: 3 * interval, at: null } } })
  const slot = doc.calendarOwner!.slots.find(item => item.role === "principal")!, replaced = f.calendars.get(slot.scheduleID!)!
  assert.equal(doc.calendarOwner!.operation.pending, false)
  assert.equal(replaced.nextDueAt, native.nextDueAt); assert.equal(replaced.endsAt, native.nextDueAt)
  assert.equal(replaced.createdAt, f.now + 2 * interval); assert.equal(doc.firstPlayedAt, original.firstPlayedAt)
  assert.notEqual(slot.scheduleID, principal.scheduleID); assert.equal(doc.launchedCount, 0)
})

test("paused temporal replacement completes paused mappings and Resume retains their identity and phase", async t => {
  const f = await ownerFixture(t), original = await f.control("play")
  await f.control("pause"); f.advance(100_000)
  const edited = await f.control("configure", "paused_timing", { ...original.configuration,
    launch: { ...original.configuration.launch, timing: { kind: "every", intervalMs: 1_800_000 } } })
  assert.equal(edited.calendarOwner!.operation.pending, false); assert.equal(edited.synchronization, null)
  assert.equal(edited.state, "paused"); assert.equal(edited.calendars.length, 2)
  assert([...f.calendars.values()].every(info => info.status === "paused"))
  const phase = [...f.calendars.values()].map(info => info.nextDueAt), creates = f.calls.filter(call => call.startsWith("create:")).length
  const resumed = await f.control("resume")
  assert.equal(resumed.calendarOwner!.operation.pending, false); assert.equal(resumed.state, "running")
  assert.deepEqual(resumed.calendars, edited.calendars)
  assert.deepEqual([...f.calendars.values()].map(info => info.nextDueAt), phase)
  assert.equal(f.calls.filter(call => call.startsWith("create:")).length, creates)
  assert.equal(phase[1], f.now + 100_000 + 1_800_000)
})

test("lost create ACK adopts one exact candidate; absence never resends a dispatched create", async t => {
  const f = await ownerFixture(t)
  f.loseCreateACK()
  const pending = await f.control("play")
  assert.equal(pending.calendarOwner?.operation.pending, true)
  const complete = await f.owner.reconcile(pending.id)
  assert.equal(complete.calendarOwner?.operation.pending, false)
  assert.equal(f.calls.filter(call => call === "create:reconciliation").length, 1)
  const other = await ownerFixture(t)
  other.loseCreateWithoutCandidate()
  await other.control("play")
  const held = await other.owner.reconcile((await other.read()).id)
  assert.equal(held.calendarOwner?.operation.pending, true)
  assert.equal(other.calls.filter(call => call === "create:reconciliation").length, 1)
})

test("lost principal ACK leaves a claimable auxiliary whose consumed progress survives autonomous full synchronization", async t => {
  const f = await ownerFixture(t)
  const create = f.native.create
  f.native.create = async (target, guard) => {
    if (target.descriptor.role === "principal") assert.equal((await f.read()).calendars[0]?.role, "reconciliation")
    return create(target, guard)
  }
  f.loseCreateACK("principal")
  let doc = await f.control("play")
  assert.equal(doc.synchronization?.kind, "arm"); assert.equal(doc.calendarOwner!.operation.pending, true)
  assert.equal(doc.calendars.length, 1)
  const auxiliary = doc.calendars[0], principal = doc.calendarOwner!.slots.find(item => item.role === "principal")!
  assert.equal(auxiliary.role, "reconciliation"); assert.equal(auxiliary.highWater, 0)
  assert.equal((await Effect.runPromise(readNativeScheduleCarrierBinding(f.ctx, auxiliary.sessionID)))!.calendar.scheduleID, auxiliary.scheduleID)
  await assert.rejects(Effect.runPromise(readNativeScheduleCarrierBinding(f.ctx, principal.sessionID)), /ownership/)
  const wake = { missionID: doc.id, generation: doc.timeGeneration, sessionID: auxiliary.sessionID,
    scheduleID: auxiliary.scheduleID, run: 1, messageID: `msg_${auxiliary.scheduleID}_1` }
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, { id: "native", pid: process.pid, url: "http://127.0.0.1:1" }, Effect.runPromise, f.current), true)
  doc = await f.store.change(doc.id, doc.revision, f.current, value => missionDocumentChanges.processWake(value,
    { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: f.now }))
  assert.equal(await f.store.withExclusion(locked => closeNativeScheduleCarrierClaimLocked(f.ctx, doc.id, Effect.runPromise, f.current, locked)), true)
  doc = await f.owner.reconcile(doc.id)
  assert.equal(missionCalendarOwnerReady(doc), true); assert.equal(doc.synchronization, null)
  assert.equal(doc.calendars.find(item => item.role === "reconciliation")!.highWater, 1)
  assert.equal(f.calls.filter(call => call === "create:principal").length, 1)
  assert.equal(doc.launchedCount, 0); assert.equal(doc.pending, null)
  const mapped = doc.calendars.find(item => item.role === "principal")!
  doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    const principalWake = { scheduleID: mapped.scheduleID, run: 1, messageID: `msg_${mapped.scheduleID}_1`, dueAt: f.now }
    missionDocumentChanges.prepareWake(value, principalWake)
    missionDocumentChanges.reserve(value, { kind: "wake", wakes: [principalWake] }, f.now, [])
  })
  assert.equal(doc.pending!.origin.kind, "wake"); assert.equal(doc.launchedCount, 0)
})

test("full synchronization carries partial auxiliary preparing refs exactly and rejects progress resets or retired identity reuse", async t => {
  const f = await ownerFixture(t)
  f.loseCreateACK("principal")
  let doc = await f.control("play")
  const auxiliary = doc.calendars[0]
  doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    missionDocumentChanges.processWake(value, { scheduleID: auxiliary.scheduleID, run: 1, messageID: `msg_${auxiliary.scheduleID}_1`, dueAt: f.now })
    value.calendars[0].wakePreparing = { scheduleID: auxiliary.scheduleID, run: 2, messageID: `msg_${auxiliary.scheduleID}_2`, dueAt: f.now + 1 }
  })
  const progress = structuredClone(doc.calendars[0])
  doc = await f.owner.reconcile(doc.id)
  assert.equal(doc.synchronization, null); assert.deepEqual(doc.calendars.find(item => item.role === "reconciliation"), progress)
  const current = structuredClone(doc), requestID = "validate_partial"
  current.synchronization = { requestID, kind: "arm", retiredCalendars: [] }
  current.calendars = [progress]
  const calendars = structuredClone(doc.calendars)
  calendars.find(item => item.role === "reconciliation")!.highWater = 0
  assert.throws(() => missionDocumentChanges.synchronized(structuredClone(current), requestID, calendars), /identity reused/)
  const reused = structuredClone(current)
  reused.synchronization!.retiredCalendars = [progress]
  assert.throws(() => missionDocumentChanges.synchronized(reused, requestID, doc.calendars), /retired wake unresolved|identity reused/)
  const forged = structuredClone(doc.calendars)
  forged.find(item => item.role === "principal")!.highWater = 1
  assert.throws(() => missionDocumentChanges.synchronized(structuredClone(current), requestID, forged), /identity reused/)
})

test("lost auxiliary ACK is read-only preflighted, claimed once, adopted without principal effects, then consumed before reconcile", async t => {
  const f = await ownerFixture(t)
  f.loseCreateACK("reconciliation")
  let doc = await f.control("play")
  assert.equal(doc.calendars.length, 0)
  const info = [...f.calendars.values()][0]
  info.runCount = 1
  const wake = { missionID: doc.id, generation: doc.timeGeneration, sessionID: info.sessionID,
    scheduleID: info.id, run: 1, messageID: `msg_${info.id}_1` }
  const preflight = () => readNativeScheduleAuxiliaryWakeBinding(f.ctx, wake, f.native, Effect.runPromise, f.current)
  const proof = await preflight()
  assert.equal(proof?.calendar.scheduleID, info.id); assert.equal((await f.read()).revision, doc.revision)
  const incarnation = { id: "native", pid: process.pid, url: "http://127.0.0.1:1" }
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, incarnation, Effect.runPromise, f.current, preflight), true)
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, incarnation, Effect.runPromise, f.current, preflight), false)
  doc = await f.owner.adoptAuxiliary(wake)
  assert.equal(doc.calendarOwner!.operation.pending, true); assert.equal(doc.calendars[0].scheduleID, info.id)
  assert.equal(f.calls.filter(call => call === "create:principal").length, 0)
  doc = await f.store.change(doc.id, doc.revision, f.current, value => missionDocumentChanges.processWake(value,
    { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: f.now }))
  assert.equal(await f.store.withExclusion(locked => closeNativeScheduleCarrierClaimLocked(f.ctx, doc.id, Effect.runPromise, f.current, locked)), true)
  doc = await f.owner.reconcile(doc.id)
  assert.equal(missionCalendarOwnerReady(doc), true)
  assert.equal(doc.calendars.find(item => item.role === "reconciliation")!.highWater, 1)
  assert.equal(f.calls.filter(call => call === "create:reconciliation").length, 1)
  assert.equal(doc.launchedCount, 0); assert.equal(doc.pending, null)
})

test("known auxiliary preflight rejects unacknowledged, foreign, ambiguous and stale evidence without adoption or claim", async t => {
  const f = await ownerFixture(t)
  f.loseCreateACK("reconciliation")
  const doc = await f.control("play"), info = [...f.calendars.values()][0]
  const wake = { missionID: doc.id, generation: doc.timeGeneration, sessionID: info.sessionID, scheduleID: info.id, run: 1, messageID: `msg_${info.id}_1` }
  const read = () => readNativeScheduleAuxiliaryWakeBinding(f.ctx, wake, f.native, Effect.runPromise, f.current)
  assert.equal(await read(), undefined)
  info.runCount = 1
  const proof = await read()
  assert(proof)
  f.calendars.set("sch_duplicate", { ...info, id: "sch_duplicate" })
  assert.equal(await read(), undefined)
  await assert.rejects(f.owner.adoptAuxiliary(wake), /unqualified/)
  f.calendars.delete("sch_duplicate")
  info.name = "foreign"
  assert.equal(await read(), undefined)
  info.name = proof.document.calendarOwner!.slots[0].name
  await f.store.change(doc.id, doc.revision, f.current, value => { value.blocked = "unknown" })
  await assert.rejects(claimNativeScheduleCarrierWake(f.ctx, wake, { id: "native", pid: process.pid, url: "http://127.0.0.1:1" },
    Effect.runPromise, f.current, async () => proof), /ownership/)
  assert.equal((await f.read()).calendars.length, 0)
})

test("replacement recovery requires consuming and closing its own auxiliary claim before retired cleanup", async t => {
  const f = await ownerFixture(t), original = await f.control("play")
  f.loseCreateACK("principal")
  let doc = await f.control("configure", "replace_lost_main", { ...original.configuration,
    launch: { ...original.configuration.launch, timing: { kind: "every", intervalMs: 1_800_000 } } })
  const auxiliary = doc.calendars[0], old = original.calendars.find(item => item.role === "reconciliation")!
  assert.notEqual(auxiliary.sessionID, old.sessionID)
  await assert.rejects(Effect.runPromise(readNativeScheduleCarrierBinding(f.ctx, old.sessionID)))
  const wake = { missionID: doc.id, generation: doc.timeGeneration, sessionID: auxiliary.sessionID,
    scheduleID: auxiliary.scheduleID, run: 1, messageID: `msg_${auxiliary.scheduleID}_1` }
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, { id: "native", pid: process.pid, url: "http://127.0.0.1:1" }, Effect.runPromise, f.current), true)
  doc = await f.owner.reconcile(doc.id)
  assert.equal(doc.calendarOwner!.error, "claim-held"); assert.equal(doc.calendarOwner!.operation.pending, true)
  doc = await f.store.change(doc.id, doc.revision, f.current, value => missionDocumentChanges.processWake(value,
    { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: f.now }))
  assert.equal(await f.store.withExclusion(locked => closeNativeScheduleCarrierClaimLocked(f.ctx, doc.id, Effect.runPromise, f.current, locked)), true)
  doc = await f.owner.reconcile(doc.id)
  assert.equal(missionCalendarOwnerReady(doc), true)
  assert.equal(doc.calendars.find(item => item.role === "reconciliation")!.highWater, 1)
  assert.equal(f.calls.filter(call => call === "create:principal").length, 2)
})

test("verified current auxiliary remains claimable while paused, blocked or deleting; principals keep their control barrier", async t => {
  for (const state of ["paused", "blocked", "deleting"] as const) {
    const f = await ownerFixture(t), armed = await f.control("play")
    const doc = await f.store.change(armed.id, armed.revision, f.current, value => {
      if (state === "paused") value.state = "paused"
      else if (state === "blocked") value.blocked = "unknown"
      else missionDocumentChanges.requestDeletion(value, "delete_exact", f.now)
    })
    const auxiliary = doc.calendars.find(item => item.role === "reconciliation")!, principal = doc.calendars.find(item => item.role === "principal")!
    assert.equal(await claimNativeScheduleCarrierWake(f.ctx, { missionID: doc.id, generation: doc.timeGeneration, sessionID: auxiliary.sessionID,
      scheduleID: auxiliary.scheduleID, run: 1, messageID: `msg_${auxiliary.scheduleID}_1` },
    { id: "native", pid: process.pid, url: "http://127.0.0.1:1" }, Effect.runPromise, f.current), true)
    if (state !== "paused") await assert.rejects(Effect.runPromise(readNativeScheduleCarrierBinding(f.ctx, principal.sessionID)), /ownership/)
  }
})

test("ambiguous create candidates are paused, remain uncertain and cannot arm a principal", async t => {
  const f = await ownerFixture(t)
  f.loseCreateACK(); await f.control("play")
  const first = [...f.calendars.values()][0]
  f.calendars.set("sch_duplicate", { ...structuredClone(first), id: "sch_duplicate" })
  const doc = await f.owner.reconcile((await f.read()).id)
  assert.equal(doc.calendarOwner?.error, "ambiguous-create")
  assert([...f.calendars.values()].every(info => info.status === "paused"))
  assert.equal(f.calls.includes("create:principal"), false)
})

test("Pause/Resume and instructions edit preserve native identity/phase, counters and original Play time", async t => {
  const f = await ownerFixture(t), armed = await f.control("play")
  const maps = structuredClone(armed.calendars), phase = [...f.calendars.values()].map(info => info.nextDueAt)
  const paused = await f.control("pause")
  assert.equal(paused.state, "paused")
  assert([...f.calendars.values()].every(info => info.status === "paused"))
  await f.control("resume")
  const edited = await f.control("configure", "edit_notes", { ...armed.configuration, objective: "Future instructions" })
  assert.deepEqual(edited.calendars, maps)
  assert.deepEqual([...f.calendars.values()].map(info => info.nextDueAt), phase)
  assert.equal(edited.firstPlayedAt, armed.firstPlayedAt)
  assert.equal(f.calls.filter(call => call.startsWith("create:")).length, 2)
})

test("temporal replacement cleans exact old carriers and reverse indices before completing new mappings", async t => {
  const f = await ownerFixture(t), armed = await f.control("play"), old = [...f.sessions.keys()]
  const edited = await f.control("configure", "frequency_edit", { ...armed.configuration,
    launch: { ...armed.configuration.launch, timing: { kind: "every", intervalMs: 60 * 60_000 } } })
  assert.equal(edited.calendarOwner?.operation.pending, false)
  assert.equal(edited.timeGeneration, armed.timeGeneration + 1)
  assert.equal(edited.firstPlayedAt, armed.firstPlayedAt)
  for (const id of old) { assert.equal(f.sessions.has(id), false); assert.equal(f.values.has(nativeScheduleCarrierLookupKey(f.ctx, id)), false) }
  assert.equal(edited.calendars.length, 2)
})

test("authoritative reverse index protects tampered markers and held cleanup with children", async t => {
  const f = await ownerFixture(t), armed = await f.control("play"), principal = armed.calendars.find(item => item.role === "principal")!
  const session = f.sessions.get(principal.sessionID)
  delete session.metadata[NATIVE_SCHEDULE_CARRIER_MARKER]
  const owned = await Effect.runPromise(readNativeScheduleCarrierOwnership(f.ctx, principal.sessionID))
  assert(owned); assert.equal(owned.verified, false)
  session.metadata[NATIVE_SCHEDULE_CARRIER_MARKER] = { missionID: armed.id, timeGeneration: 1, role: "principal", slot: 0 }
  f.blocked.add(principal.sessionID)
  const stopped = await f.control("stop")
  assert.equal(stopped.state, "stopped")
  assert.equal(stopped.calendarOwner?.operation.pending, true)
  assert(f.values.has(nativeScheduleCarrierLookupKey(f.ctx, principal.sessionID)))
  f.blocked.clear()
  const complete = await f.owner.reconcile(stopped.id)
  assert.equal(complete.calendarOwner?.operation.pending, false)
  assert.equal(f.sessions.size, 0)
  assert.equal(complete.calendars.length, 0)
})

test("last admitted passage keeps auxiliary armed after quota; settlement then permits exact cleanup", async t => {
  const f = await ownerFixture(t, undefined, 1), armed = await f.control("play"), principal = armed.calendars.find(item => item.role === "principal")!
  let doc = await f.store.change(armed.id, armed.revision, f.current, value => {
    const wake = { scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1`, dueAt: f.now }
    missionDocumentChanges.prepareWake(value, wake)
    missionDocumentChanges.reserve(value, { kind: "wake", wakes: [wake] }, f.now + 1, [])
    missionDocumentChanges.admitted(value, value.pending!.id, f.now + 2)
  })
  doc = await f.owner.reconcile(doc.id)
  assert.equal(doc.state, "finished")
  const aux = doc.calendars.find(item => item.role === "reconciliation")!
  assert.equal(f.calendars.get(aux.scheduleID)?.status, "active")
  assert.equal(f.calendars.get(principal.scheduleID)?.status, "paused")
  assert.equal(doc.launchedCount, 1)
  doc = await f.store.change(doc.id, doc.revision, f.current, value => missionDocumentChanges.settle(value, value.pending!.id, "completed", f.now + 3))
  doc = await f.owner.reconcile(doc.id)
  assert.equal(doc.calendarOwner?.operation.pending, false)
  assert.equal(f.sessions.size, 0)
  assert.equal(doc.launchedCount, 1)
})

test("physical directory retarget blocks native effects instead of recapturing a different root", async t => {
  const f = await ownerFixture(t), armed = await f.control("play"), count = f.calls.length
  const moved = `${f.directory}-retargeted`
  renameSync(f.directory, moved)
  try {
    const doc = await f.owner.reconcile(armed.id)
    assert.equal(doc.calendarOwner?.operation.pending, true)
    assert.equal(f.calls.length, count)
  } finally { renameSync(moved, f.directory) }
})

test("H9 converts an unplayed oneTime binding to scheduled and back without native effects or deleting its conversation", async t => {
  const f = await ownerFixture(t)
  const request = "one_time_creation", id = `msn_${stableToken(`project\0${request}`, 24)}`
  const immediate = { ...f.configuration, launch: { ...f.configuration.launch, timing: { kind: "immediate" as const } } }
  const old = await f.store.create(id, immediate, f.now - 1, f.current, { creationRequestID: request,
    creationDigest: "f".repeat(64), coordinatorSessionID: "ses_unprompted_existing", location: { directory: f.directory }, firstPlay: null })
  f.sessions.set("ses_unprompted_existing", { id: "ses_unprompted_existing" })
  const scheduled = await f.owner.control({ missionID: id, requestID: "convert_scheduled", expectedRevision: old.revision,
    action: "configure", configuration: f.configuration })
  assert.equal(scheduled.id, id); assert.equal(scheduled.oneTime, null); assert.equal(scheduled.firstPlayedAt, null)
  assert.equal(scheduled.state, "paused"); assert.equal(scheduled.calendars.length, 0); assert.equal(f.calls.length, 0)
  const converted = await f.owner.control({ missionID: id, requestID: "convert_immediate", expectedRevision: scheduled.revision,
    action: "configure", configuration: immediate })
  assert.equal(converted.id, id); assert.equal(converted.state, "paused"); assert.equal(converted.calendars.length, 0)
  assert.equal(nativeScheduleOwnerControlReceipt(converted, "convert_immediate")?.pending, false)
  assert.equal(f.calls.length, 0); assert(f.sessions.has("ses_unprompted_existing"))
})

test("completed human request proof survives automatic reconciliation and rejects changed replay payload", async t => {
  const f = await ownerFixture(t), before = await f.read()
  const input = { missionID: before.id, requestID: "human_play", expectedRevision: before.revision, action: "play" as const }
  await f.owner.control(input)
  const reconciled = await f.owner.reconcile(before.id)
  assert.equal(nativeScheduleOwnerControlReceipt(reconciled, input.requestID)?.pending, false)
  const count = f.calls.length
  await f.owner.control(input)
  assert.equal(f.calls.length, count)
  await assert.rejects(f.owner.control({ ...input, deleteManagedSessions: true }), /request conflict/)
})

test("manual consent is invalidated by a newer Pause while quota and original pending remain intact", async t => {
  const f = await ownerFixture(t), armed = await f.control("play")
  let doc = await f.store.change(armed.id, armed.revision, f.current, value => {
    missionDocumentChanges.reserve(value, { kind: "manual", requestID: "manual_run" }, f.now + 1, [])
    value.pending!.manualAllowed = true
  })
  const identity = doc.pending!.id
  doc = await f.control("pause")
  assert.equal(doc.pending!.id, identity)
  assert.equal(doc.pending!.manualAllowed, false)
  assert.equal(doc.launchedCount, 0)
  f.allowPendingResume()
  await assert.rejects(f.control("resume"), /admission is uncertain/)
})

test("a pending Check keeps its original operation proof through later automatic reconciliation", async t => {
  const f = await ownerFixture(t)
  f.loseCreateACK()
  const pending = await f.control("play", "original_play")
  const input = { missionID: pending.id, requestID: "explicit_check", expectedRevision: pending.revision, action: "check" as const }
  const complete = await f.owner.control(input)
  assert.equal(nativeScheduleOwnerControlReceipt(complete, "explicit_check")?.pending, false)
  const later = await f.owner.reconcile(complete.id)
  assert.equal(nativeScheduleOwnerControlReceipt(later, "original_play")?.pending, false)
  assert.equal(nativeScheduleOwnerControlReceipt(later, "explicit_check")?.pending, false)
  const count = f.calls.length
  await f.owner.control(input)
  assert.equal(f.calls.length, count)
})

test("an active auxiliary keeps its native wake and ownership until an after-idle cleanup can finish", async t => {
  const f = await ownerFixture(t), armed = await f.control("play"), auxiliary = armed.calendars.find(item => item.role === "reconciliation")!
  f.blocked.add(auxiliary.sessionID)
  const stopped = await f.control("stop")
  assert.equal(stopped.calendarOwner?.operation.pending, true)
  assert.equal(f.calendars.get(auxiliary.scheduleID)?.status, "active")
  assert(f.values.has(nativeScheduleCarrierLookupKey(f.ctx, auxiliary.sessionID)))
  f.blocked.clear()
  const done = await f.owner.reconcile(stopped.id)
  assert.equal(done.calendarOwner?.operation.pending, false)
  assert.equal(f.calendars.size, 0); assert.equal(f.sessions.size, 0)
})

test("native one-shot done cannot close an unprocessed wake, but closes after its high-water is handled", async t => {
  const f = await ownerFixture(t, { kind: "at", at: Date.now() + 60_000, zone: "UTC" }), armed = await f.control("play")
  const principal = armed.calendars.find(item => item.role === "principal")!, info = f.calendars.get(principal.scheduleID)!
  info.status = "done"; info.runCount = 1; info.nextDueAt = null
  let doc = await f.owner.reconcile(armed.id)
  assert.equal(doc.state, "running")
  doc = await f.store.change(doc.id, doc.revision, f.current, value => missionDocumentChanges.processWake(value,
    { scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1`, dueAt: f.now }))
  doc = await f.owner.reconcile(doc.id)
  assert.equal(doc.state, "finished"); assert.equal(doc.launchedCount, 0)
  assert.equal(f.calendars.size, 0)
})

test("an unreserved uncertain claim keeps retired proof and prevents principal replacement admission", async t => {
  const f = await ownerFixture(t), armed = await f.control("play"), principal = armed.calendars.find(item => item.role === "principal")!
  await claimNativeScheduleCarrierWake(f.ctx, { missionID: armed.id, generation: 1, sessionID: principal.sessionID,
    scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1` },
  { id: "native_test", pid: process.pid, url: "http://127.0.0.1:1" }, Effect.runPromise, f.current)
  const pending = await f.control("configure", "edit_uncertain", { ...armed.configuration,
    launch: { ...armed.configuration.launch, timing: { kind: "every", intervalMs: 60 * 60_000 } } })
  assert.equal(pending.calendarOwner?.error, "claim-held")
  assert.equal(pending.calendarOwner?.operation.pending, true)
  assert(pending.synchronization!.retiredCalendars.some(item => item.scheduleID === principal.scheduleID))
  assert.equal(f.calls.filter(value => value === "create:principal").length, 1)
  assert(f.values.has(nativeScheduleCarrierLookupKey(f.ctx, principal.sessionID)))
})

test("technical high-water closes principal claim at reservation, permits auxiliary claim and never regresses on business settle", async t => {
  const f = await ownerFixture(t), armed = await f.control("play"), principal = armed.calendars.find(item => item.role === "principal")!
  const auxiliary = armed.calendars.find(item => item.role === "reconciliation")!
  const incarnation = { id: "test_native", pid: process.pid, url: "http://127.0.0.1:1" }
  const principalWake = { missionID: armed.id, generation: armed.timeGeneration, sessionID: principal.sessionID,
    scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1` }
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, principalWake, incarnation, Effect.runPromise, f.current), true)
  let doc = await f.store.change(armed.id, armed.revision, f.current, value => {
    const wake = { scheduleID: principal.scheduleID, run: 1, messageID: principalWake.messageID, dueAt: f.now }
    missionDocumentChanges.prepareWake(value, wake)
    missionDocumentChanges.reserve(value, { kind: "wake", wakes: [wake] }, f.now + 1, [])
  })
  assert.equal(doc.calendars.find(item => item.role === "principal")!.highWater, 1)
  assert.equal(doc.pending!.admittedAt, null); assert.equal(doc.launchedCount, 0)
  assert.equal(await f.store.withExclusion(locked => closeNativeScheduleCarrierClaimLocked(f.ctx, doc.id, Effect.runPromise, f.current, locked)), true)
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, { ...principalWake, sessionID: auxiliary.sessionID, scheduleID: auxiliary.scheduleID,
    messageID: `msg_${auxiliary.scheduleID}_1` }, incarnation, Effect.runPromise, f.current), true)
  doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    missionDocumentChanges.processWake(value, { scheduleID: principal.scheduleID, run: 2, messageID: `msg_${principal.scheduleID}_2`, dueAt: f.now + 2 })
    missionDocumentChanges.admitted(value, value.pending!.id, f.now + 3)
    missionDocumentChanges.settle(value, value.pending!.id, "completed", f.now + 4)
  })
  assert.equal(doc.calendars.find(item => item.role === "principal")!.highWater, 2)
  assert.equal(doc.calendars.find(item => item.role === "principal")!.pendingWake, null)
  assert.equal(doc.launchedCount, 1)
})

test("known paused admitted final passage can resume through the internal proof port without new reservation/count", async t => {
  const f = await ownerFixture(t, undefined, 1), armed = await f.control("play")
  let doc = await f.store.change(armed.id, armed.revision, f.current, value => {
    missionDocumentChanges.reserve(value, { kind: "manual", requestID: "original_manual" }, f.now + 1, [])
    missionDocumentChanges.admitted(value, value.pending!.id, f.now + 2)
  })
  const pending = structuredClone(doc.pending)
  await f.control("pause")
  await assert.rejects(f.control("resume"), /resume proof unavailable/)
  f.allowPendingResume()
  doc = await f.control("resume")
  assert.equal(doc.state, "finished") // quota stays exhausted; only the admitted actor may continue.
  assert.equal(doc.pending!.id, pending!.id)
  assert.equal(doc.pending!.messageID, pending!.messageID)
  assert.equal(doc.launchedCount, 1)
  assert.equal(f.calls.filter(value => value.startsWith("create:")).length, 2)
})
