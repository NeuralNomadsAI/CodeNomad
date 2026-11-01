import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import test from "node:test"
import { Service } from "@opencode/client/service"
import { Effect, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { MissionControl } from "../../missions/control"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { controlResumeAdmissionID } from "../../missions/receipt-identity"
import { scheduledActorCalendarBarrier } from "./native-mission-schedule-actors"
import { actorFixture as fixture } from "./native-mission-schedule-actors-test-fixture"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { controlNativeScheduledPassage } from "./native-scheduled-passage-controls"
import type { MissionNativeService } from "./native-service-adapter"

const current = () => true as const, at = Date.parse("2026-10-01T00:00:00Z")

test("an exact completed lastControl survives automatic reconcile without manufacturing an actor barrier", () => {
  for (const action of ["pause", "stop", "resume", "delete"] as const) {
    const lastControl = { requestID: "original_human", expectedRevision: 17, action, pending: false as const,
      fingerprint: "a".repeat(64), startedAt: at }
    const owner = { operation: { ...lastControl, requestID: "reconcile_31", expectedRevision: 31, action: "reconcile" }, receipts: [], lastControl }
    const actorAction = action === "resume" ? "start" : action === "delete" ? "stop" : action
    const captured = scheduledActorCalendarBarrier(owner, lastControl.requestID, actorAction)
    assert.deepEqual(captured, lastControl)
    assert.equal(scheduledActorCalendarBarrier({ ...owner, operation: { ...owner.operation, requestID: "reconcile_32" } }, lastControl.requestID, actorAction, captured), lastControl)
    for (const wrong of [{ ...lastControl, requestID: "other" }, { ...lastControl, action: "configure" }, { ...lastControl, pending: true },
      { ...lastControl, expectedRevision: undefined }, { ...lastControl, expectedRevision: 18 }, { ...lastControl, fingerprint: "b".repeat(64) }]) {
      assert.equal(scheduledActorCalendarBarrier({ ...owner, lastControl: wrong }, lastControl.requestID, actorAction, captured), undefined)
    }
    assert.equal(scheduledActorCalendarBarrier({ operation: owner.operation, receipts: [] }, lastControl.requestID, actorAction), undefined,
      "desired state or a newer reconciliation generation supplies no explicit receipt")
    if (action === "delete") for (const other of ["pause", "start"] as const)
      assert.equal(scheduledActorCalendarBarrier(owner, lastControl.requestID, other), undefined, "delete authorizes only Stop")
  }
})

test("pending interruption requires the exact current intent; retained receipts cannot override newer explicit controls", () => {
  for (const action of ["pause", "stop", "delete", "resume", "play"] as const) {
    const operation = { requestID: "human", expectedRevision: 17, action, pending: true, fingerprint: "a".repeat(64), startedAt: at }
    const owner = { operation, receipts: [] as unknown[], lastControl: undefined as unknown }
    const actorAction = action === "resume" || action === "play" ? "start" : action === "delete" ? "stop" : action
    const captured = scheduledActorCalendarBarrier(owner, "human", actorAction)
    if (actorAction === "start") { assert.equal(captured, undefined); continue }
    assert.deepEqual(captured, operation)
    assert.equal(scheduledActorCalendarBarrier(owner, "human", actorAction, captured), operation)
    assert.equal(scheduledActorCalendarBarrier(owner, "human", actorAction === "pause" ? "stop" : "pause", captured), undefined)
    for (const patch of [{ requestID: "other" }, { action: "resume" }, { pending: false }, { expectedRevision: 18 }, { fingerprint: "b".repeat(64) }])
      assert.equal(scheduledActorCalendarBarrier({ ...owner, operation: { ...operation, ...patch } }, "human", actorAction, captured), undefined)
    assert.equal(scheduledActorCalendarBarrier({ ...owner, operation: { ...operation, action: "reconcile", requestID: "reconcile" }, lastControl: operation }, "human", actorAction), undefined,
      "a retained pending record supplies no current durable intent")
    const receipt = { ...operation, pending: false }
    for (const newer of ["pause", "stop", "delete", "play", "resume", "configure"] as const) {
      const superseding = { ...operation, action: newer, requestID: "newer", expectedRevision: 18 }
      assert.equal(scheduledActorCalendarBarrier({ operation: superseding, receipts: [receipt] }, "human", actorAction), undefined)
      assert.equal(scheduledActorCalendarBarrier({ operation: { ...superseding, action: "reconcile" }, receipts: [receipt, { ...superseding, pending: false }] },
        "human", actorAction, receipt), undefined, "reconciliation must not hide a superseding human receipt")
    }
  }
  const resume = { requestID: "resume", expectedRevision: 1, action: "resume", pending: false }
  assert.equal(scheduledActorCalendarBarrier({ operation: { ...resume, action: "reconcile", requestID: "auto", pending: true }, receipts: [resume] },
    "resume", "start"), undefined, "completed Resume receipt cannot cross unknown current calendars")
})

test("manual walk cancellation joins the native fiber finalizer before attempting the root, without cancelling lifecycle", async t => {
  const f = await fixture(t), walk = new AbortController(), timeout = AbortSignal.timeout
  let captured = false, blocked = false, joined = false, currentCalls = 0
  // Trigger the existing walk signal directly: this checks cancellation, not its real-clock ceiling.
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    if (!captured && milliseconds > 49_000 && milliseconds <= 50_000) { captured = true; return walk.signal }
    return timeout(milliseconds)
  })
  f.state.interruptEffect = sessionID => {
    if (sessionID === f.coordinatorID) assert.equal(joined, true, "root must wait for the losing fiber finalizer")
    if (sessionID !== "ses_grandchild" || blocked) return Effect.void
    blocked = true
    return Effect.gen(function* () {
      walk.abort(new Error("Manual walk cancellation"))
      yield* Effect.never
    }).pipe(Effect.ensuring(Effect.gen(function* () {
      yield* Effect.sleep(15)
      joined = true
    })))
  }
  const request = await f.prepare("pause")
  const result = await f.invoke(() => f.control.lifecycle(request), () => { currentCalls++; return true })
  assert.equal(captured, true); assert.equal(blocked, true); assert.equal(joined, true); assert.ok(currentCalls > 0)
  assert.ok(f.calls.some(call => call.kind === "interrupt" && call.id === f.coordinatorID))
  const ack = result.mission.control!.receipts![0].nativeAcknowledgement!
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition !== "interrupt-observed") return
  assert.equal(ack.descendants!.complete, false, "the aborted walk retains partial evidence")
  assert.equal(ack.interrupt.interrupted, true)
  assert.equal(f.active.size, 0)
})

for (const kind of ["get", "scan"] as const) test(`lifecycle deadline cancels and joins native ${kind} authority reads`, async t => {
  const f = await fixture(t), lifecycle = new AbortController(), timeout = AbortSignal.timeout
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => milliseconds === 85_000 ? lifecycle.signal : timeout(milliseconds))
  const request = await f.prepare("pause")
  let entered = false, completed = false, joined = false
  f.state.storageEffect = read => read !== kind ? Effect.void : Effect.gen(function* () {
    entered = true; lifecycle.abort()
    // Finite fallback also makes the unfixed implementation fail without hanging.
    yield* Effect.sleep(50); completed = true
  }).pipe(Effect.ensuring(Effect.gen(function* () { yield* Effect.sleep(15); joined = true })))
  await assert.rejects(f.invoke(() => f.control.lifecycle(request)), /retry the remaining native controls/)
  assert.equal(entered, true); assert.equal(completed, false); assert.equal(joined, true)
  assert.deepEqual(f.calls, [])
})

for (const kind of ["get", "scan"] as const) test(`walk cancellation joins checkpoint ${kind} reads before the root interrupt`, async t => {
  const f = await fixture(t), walk = new AbortController(), timeout = AbortSignal.timeout
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => milliseconds > 49_000 && milliseconds <= 50_000 ? walk.signal : timeout(milliseconds))
  let reads = 0, entered = false, completed = false, joined = false
  f.state.beforeFetch = () => {
    f.state.beforeFetch = () => {}
    f.state.storageEffect = read => {
      // First checkpoint is the shared level check; second is the per-effect check.
      if (read !== kind || ++reads !== 2) return Effect.void
      f.state.storageEffect = undefined
      return Effect.gen(function* () {
        entered = true; walk.abort()
        yield* Effect.sleep(50); completed = true
      }).pipe(Effect.ensuring(Effect.gen(function* () { yield* Effect.sleep(15); joined = true })))
    }
  }
  f.state.beforeInterrupt = () => { assert.equal(joined, true, "native reads must finish cancellation before root control") }
  const request = await f.prepare("pause"), result = await f.invoke(() => f.control.lifecycle(request))
  assert.equal(entered, true); assert.equal(completed, false); assert.equal(joined, true)
  assert.ok(f.calls.some(call => call.kind === "interrupt" && call.id === f.coordinatorID))
  const ack = result.mission.control!.receipts![0].nativeAcknowledgement!
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition === "interrupt-observed") assert.equal(ack.descendants!.complete, false)
})

for (const action of ["pause", "stop"] as const) test(`runtime-shaped ${action} selects the passage identity before real actor transport and calendar effects`, async t => {
  const calendar = await ownerFixture(t)
  await calendar.control("play")
  const f = await fixture(t, calendar), before = await f.read(), requestID = `runtime_${action}`
  const doc = await calendar.owner.prepareInterruption({ missionID: before.id, requestID, expectedRevision: before.revision, action })
  const calendarCalls = calendar.calls.length
  const signal = new AbortController().signal
  // The production runtime passes its complete entry, including the document ID.
  const entry = { missionID: doc.id, requestID, action, current, signal }
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected passage admission or business effect") }
  const native: MissionNativeService = {
    location: Schema.decodeUnknownSync(Location.Info)({ directory: f.directory,
      project: { id: doc.projectID, canonical: doc.projectCanonical, directory: f.directory } }),
    assertCurrent: current, get: async ({ sessionID }) => f.sessions.get(sessionID), create: unexpected,
    environment: unexpected, inbox: async () => [], message: async () => undefined,
    cancelInbox: unexpected, admit: unexpected, sourceMessages: unexpected,
  }
  const result = await f.invoke(() => calendar.store.withExclusion(locked => controlNativeScheduledPassage({
    document: doc, locked, storage: f.storage, native, authority: current, current, signal,
    profile: doc.calendarOwner!.profileSource, now: () => calendar.now,
    observation: { assertCurrent: current, exists: async id => f.sessions.has(id),
      session: unexpected, children: async () => [], requests: async () => false },
    lifecycle: f.port(),
  }, entry)))
  assert.deepEqual(result, { pending: false })
  assert.notEqual(entry.missionID, f.pending.missionID)
  const snapshot = await f.control.snapshot(), operation = snapshot.missions[0].control!
  assert.equal(operation.requestID, requestID); assert.equal(operation.action, action)
  assert.deepEqual(operation.pending, [])
  assert.equal(operation.receipts![0].nativeAcknowledgement!.disposition, "interrupt-observed")
  assert.deepEqual(f.calls.filter(call => call.kind === "interrupt").slice(0, 3).map(call => call.id),
    ["ses_grandchild", "ses_child", f.coordinatorID])
  assert.equal(f.active.size, 0)
  assert.equal(calendar.calls.length, calendarCalls, "actors interrupt before any native calendar cleanup")
  assert.equal((await f.read()).calendarOwner!.operation.pending, true)
  assert.equal((await f.read()).launchedCount, 1)
  const intent = [...f.values.values()].find(value => value?.type === "mission.control-requested" && value.requestID === requestID)
  assert.equal(intent.missionID, f.pending.missionID)
  assert.equal("current" in intent, false); assert.equal("signal" in intent, false)
})

for (const action of ["pause", "stop"] as const) test(`${action} uses full deepest-first family control and real native acknowledgement`, async t => {
  const f = await fixture(t)
  for (const id of f.sessions.keys()) f.inboxes.set(id, [{ id: `inb_${id}`, sessionID: id, type: "synthetic", delivery: "queue", time: { created: at },
    payload: { text: "owned", metadata: { "codenomad.mission": { missionID: f.pending.missionID } } } }])
  const request = await f.prepare(action), result = await f.invoke(() => f.control.lifecycle(request))
  const ack = result.mission.control!.receipts![0].nativeAcknowledgement!
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition !== "interrupt-observed") return
  assert.deepEqual(f.calls.filter(call => call.kind === "interrupt").slice(0, 3).map(call => call.id), ["ses_grandchild", "ses_child", f.coordinatorID])
  assert.equal(f.active.size, 0); assert.equal(ack.descendants!.complete, true)
  assert.equal(ack.descendants!.observed, 2)
  assert.equal(f.calls.some(call => call.kind === "cancel"), action === "stop")
  assert.equal(f.inboxes.get(f.coordinatorID)!.length, action === "stop" ? 0 : 1)
  assert.equal((await f.read()).launchedCount, 1)
  const count = f.calls.length
  await f.invoke(() => f.control.lifecycle(request))
  assert.equal(f.calls.length, count, "saved lifecycle receipts prevent replay")
})

for (const action of ["pause", "stop", "delete"] as const) test(`${action} interrupts its family despite pending calendar error and retains honest partial evidence`, async t => {
  const f = await fixture(t), actorAction = action === "delete" ? "stop" : action
  const request = await f.prepare(actorAction, `pending_${action}`, true)
  if (action === "delete") await f.change(next => {
    changes.requestDeletion(next, request.requestID, at + 3)
    next.calendarOwner!.operation.action = "delete"
  })
  f.state.stuck = f.coordinatorID
  const before = await f.read(), result = await f.invoke(() => f.control.lifecycle(request))
  const operation = result.mission.control!, ack = operation.receipts![0].nativeAcknowledgement!
  assert.deepEqual(operation.pending, []); assert.equal(operation.requestID, request.requestID); assert.equal(operation.action, actorAction)
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition !== "interrupt-observed") return
  assert.equal(ack.interrupt.interrupted, false); assert.equal(ack.descendants!.complete, false)
  assert.ok(ack.descendants!.unconfirmed > 0)
  assert.deepEqual(f.calls.filter(call => call.kind === "interrupt").slice(0, 3).map(call => call.id), ["ses_grandchild", "ses_child", f.coordinatorID])
  assert.deepEqual((await f.read()).calendarOwner, before.calendarOwner, "actor acknowledgement must preserve pending/error calendar evidence")
  assert.equal(f.calls.some(call => call.kind === "environment" || call.kind === "synthetic"), false)
})

for (const action of ["pause", "stop", "delete"] as const) test(`real calendar-owner ${action} pause failure still permits a genuine actor control receipt`, async t => {
  const calendar = await ownerFixture(t)
  await calendar.control("play")
  const f = await fixture(t, calendar)
  calendar.native.pause = async (target, _id, guard) => { guard(); calendar.calls.push(`failed-pause:${target.descriptor.role}`); throw new Error("Native pause unavailable") }
  const doc = await calendar.control(action, `owner_${action}`), actorAction = action === "delete" ? "stop" : action
  assert.equal(doc.state, action === "pause" ? "paused" : "stopped")
  assert.equal(doc.calendarOwner!.operation.pending, true); assert.equal(doc.calendarOwner!.error, "native-uncertain")
  assert.ok(calendar.calls.includes("failed-pause:principal"))
  const request = await f.request(actorAction, doc.calendarOwner!.operation.requestID)
  const result = await f.invoke(() => f.control.lifecycle(request)), ack = result.mission.control!.receipts![0].nativeAcknowledgement!
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition !== "interrupt-observed") return
  assert.equal(ack.descendants!.complete, true); assert.equal(f.active.size, 0)
  assert.deepEqual((await calendar.read()).calendarOwner, doc.calendarOwner)
  const count = f.calls.length
  await f.invoke(() => f.control.lifecycle(request))
  assert.equal(f.calls.length, count, "the genuine lifecycle receipt prevents repeat actor effects while calendars remain pending")
})

for (const action of ["pause", "stop", "delete"] as const) test(`prepared ${action} interrupts the real actor fixture before any calendar pause attempt`, async t => {
  const calendar = await ownerFixture(t)
  await calendar.control("play")
  const f = await fixture(t, calendar), before = await calendar.read(), order: string[] = []
  const input = { missionID: before.id, requestID: `prepare_before_${action}`, expectedRevision: before.revision, action }
  calendar.native.pause = async (_target, _id, guard) => {
    guard(); order.push("calendar-pause")
    assert.equal(f.active.size, 0, "actor interruption must finish before native calendar effects")
    throw new Error("Native calendar pause unavailable")
  }
  f.state.beforeInterrupt = () => { order.push("actor-interrupt") }
  const prepared = await calendar.owner.prepareInterruption(input)
  assert.equal(prepared.calendarOwner!.operation.pending, true)
  assert.deepEqual(order, [])
  assert.equal(f.active.size, 3)
  const actorAction = action === "delete" ? "stop" : action
  const request = await f.request(actorAction, input.requestID)
  const result = await f.invoke(() => f.control.lifecycle(request)), ack = result.mission.control!.receipts![0].nativeAcknowledgement!
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition !== "interrupt-observed") return
  assert.equal(ack.descendants!.complete, true)
  assert.equal(f.active.size, 0)
  const reconciled = await calendar.owner.reconcile(prepared.id)
  assert.deepEqual(order, ["actor-interrupt", "actor-interrupt", "actor-interrupt", "calendar-pause"])
  assert.equal(reconciled.calendarOwner!.operation.requestID, input.requestID)
  assert.equal(reconciled.calendarOwner!.operation.pending, true)
  assert.equal(reconciled.calendarOwner!.error, "native-uncertain")
})

test("pending Resume or reconciliation never restores ENV or admits a lifecycle Start", async t => {
  for (const reconcile of [false, true]) await t.test(String(reconcile), async t => {
    const f = await fixture(t)
    await f.invoke(async () => f.control.lifecycle(await f.prepare("pause")))
    const request = await f.prepare("start", "pending_resume", true)
    if (reconcile) await f.change(next => {
      const owner = next.calendarOwner!
      owner.receipts.push({ ...owner.operation, pending: false })
      owner.operation = { ...owner.operation, action: "reconcile", requestID: "new_reconcile" }
    })
    const count = f.calls.length
    await assert.rejects(f.invoke(() => f.control.lifecycle(request)), /retry the remaining native controls/)
    assert.equal(f.calls.length, count); assert.equal(f.admissions.size, 0)
    const operation = (await f.control.snapshot()).missions[0].control!
    assert.deepEqual(operation.pending, [f.coordinatorID]); assert.equal(operation.receipts?.length ?? 0, 0)
    assert.equal((await f.read()).launchedCount, 1)
  })
})

test("captured pending controls reject request, action, completion or desired-state drift before the first interrupt", async t => {
  for (const drift of ["request", "action", "completion", "state", "stale-receipt"] as const) await t.test(drift, async t => {
    const f = await fixture(t), request = await f.prepare("pause", "captured_pause", true)
    f.state.beforeFetch = async () => {
      f.state.beforeFetch = () => {}
      await f.change(next => {
        const owner = next.calendarOwner!
        if (drift === "request") owner.operation.requestID = "new_pause"
        if (drift === "action") owner.operation.action = "stop"
        if (drift === "completion") owner.operation.pending = false
        if (drift === "state") next.state = "running"
        if (drift === "stale-receipt") {
          owner.receipts.push({ ...owner.operation, pending: false })
          owner.operation = { ...owner.operation, requestID: "new_pause", expectedRevision: owner.operation.expectedRevision + 1 }
        }
      })
    }
    await assert.rejects(f.invoke(() => f.control.lifecycle(request)), /retry the remaining native controls/)
    assert.deepEqual(f.calls, []); assert.equal(f.active.size, 3)
    assert.deepEqual((await f.control.snapshot()).missions[0].control!.pending, [f.coordinatorID])
  })
})

test("post-root children are interrupted, and a stuck descendant remains partial without inventing interrupted:true", async t => {
  const f = await fixture(t); f.state.late = true; f.state.stuck = "ses_grandchild"
  const result = await f.invoke(async () => f.control.lifecycle(await f.prepare("stop")))
  const ack = result.mission.control!.receipts![0].nativeAcknowledgement!
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition !== "interrupt-observed") return
  assert.equal(ack.descendants!.complete, false); assert.ok(ack.descendants!.unconfirmed > 0)
  assert.ok(f.calls.some(call => call.kind === "interrupt" && call.id === "ses_late"))
  assert.ok(f.active.has("ses_grandchild")); assert.equal(ack.descendants!.interrupted, 2)
})

test("explicit Resume uses only the deterministic lifecycle input and never creates/counts another passage", async t => {
  const f = await fixture(t)
  await f.invoke(async () => f.control.lifecycle(await f.prepare("pause")))
  const request = await f.prepare("start")
  const result = await f.invoke(() => f.control.lifecycle(request))
  const ack = result.mission.control!.receipts![0].nativeAcknowledgement!
  assert.equal(ack.disposition, "start-admitted")
  if (ack.disposition !== "start-admitted") return
  assert.equal(ack.admission.id, controlResumeAdmissionID(result.mission.control!.id, f.coordinatorID))
  assert.notEqual(ack.admission.id, f.pending.messageID)
  assert.equal(ack.admission.time.created, at + 5, "official Effect codec preserves the actual native ACK timestamp")
  const metadata = ack.admission.payload.metadata!["codenomad.mission"]
  assert.ok(metadata && typeof metadata === "object" && !Array.isArray(metadata))
  assert.equal(metadata.kind, "lifecycle")
  const count = f.calls.length
  await f.invoke(() => f.control.lifecycle(request))
  assert.equal(f.calls.length, count); assert.equal(f.admissions.size, 1)
  assert.equal((await f.read()).launchedCount, 1)
  assert.ok(!JSON.stringify(ack).includes("private-memory-only"))
})

test("missing native ACK leaves the same journal target pending under calendar failure; exact retry finishes it", async t => {
  const f = await fixture(t), request = await f.prepare("pause", "pending_ack_pause", true)
  f.state.malformedInterrupt = true
  await assert.rejects(f.invoke(() => f.control.lifecycle(request)), /retry the remaining native controls/)
  const pending = (await f.control.snapshot()).missions[0].control!
  assert.deepEqual(pending.pending, [f.coordinatorID])
  f.state.malformedInterrupt = false
  const result = await f.invoke(() => f.control.lifecycle(request))
  assert.deepEqual(result.mission.control!.pending, []); assert.equal(result.mission.control!.id, pending.id)
})

test("native interrupted:false and an active root remain partial; Stop preserves unrelated inputs and records lost cancellation ACKs honestly", async t => {
  const f = await fixture(t); f.state.stuck = f.coordinatorID; f.state.lostCancel = true
  f.inboxes.set(f.coordinatorID, [
    { id: "inb_owned", type: "synthetic", sessionID: f.coordinatorID, delivery: "queue", time: { created: at },
      payload: { text: "owned", metadata: { "codenomad.mission": { missionID: f.pending.missionID } } } },
    { id: "inb_other", type: "synthetic", sessionID: f.coordinatorID, delivery: "queue", time: { created: at },
      payload: { text: "keep", metadata: { "codenomad.mission": { missionID: "other" } } } },
  ])
  const result = await f.invoke(async () => f.control.lifecycle(await f.prepare("stop")))
  const ack = result.mission.control!.receipts![0].nativeAcknowledgement!
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition !== "interrupt-observed") return
  assert.equal(ack.interrupt.interrupted, false)
  assert.equal(ack.descendants!.complete, false)
  assert.deepEqual(ack.cancellations, [{ inboxID: "inb_owned", disposition: "observed-absent" }])
  assert.deepEqual(f.inboxes.get(f.coordinatorID)!.map(item => item.id), ["inb_other"])
})

test("Stop retains a root reused by another active ordinary mission without interrupting its family", async t => {
  const f = await fixture(t)
  const ordinary = new MissionControl({ project: { id: "project", canonical: f.directory, location: { directory: f.directory } }, storage: f.storage,
    sessions: { get: async ({ sessionID }) => f.sessions.get(sessionID), create: async () => { throw new Error("No create") }, prompt: async () => {}, synthetic: async () => {} } })
  await ordinary.create({ requestID: "ordinary_reuse", template: "custom", objective: "Another run", coordinatorSessionID: f.coordinatorID })
  const result = await f.invoke(async () => f.control.lifecycle(await f.prepare("stop")))
  assert.equal(result.mission.control!.receipts![0].nativeAcknowledgement!.disposition, "target-reused")
  assert.deepEqual(f.calls, [])
})

test("a specialist whose frozen profile changed stays pending while the qualified coordinator can still pause", async t => {
  const f = await fixture(t), id = "ses_specialist", original = structuredClone(f.sessions.get(f.coordinatorID))
  f.sessions.set(id, { ...original, id, metadata: { "codenomad.mission": { ...original.metadata["codenomad.mission"], kind: "actor", role: "specialist" } } })
  f.active.add(id); f.inboxes.set(id, [])
  await f.control.delegate(f.coordinatorID, { missionID: f.pending.missionID, taskKey: "owned", title: "Owned root", brief: "Private fixture",
    role: "specialist", blockedBy: [], delivery: "queue", targetSessionID: id,
    executionMode: { kind: "independent", reason: "existing-root", explanation: "Private owned root fixture" } })
  f.sessions.get(id).model.id = "changed"
  const request = await f.prepare("pause", "pending_profile_pause", true)
  await assert.rejects(f.invoke(() => f.control.lifecycle(request)), /retry the remaining native controls/)
  const operation = (await f.control.snapshot()).missions[0].control!
  assert.deepEqual(operation.pending, [id])
  assert.ok(operation.receipts!.some(receipt => receipt.sessionID === f.coordinatorID))
  assert.ok(f.active.has(id)); assert.ok(!f.calls.some(call => call.kind === "interrupt" && call.id === id))
})

test("a changed desired state, profile or native incarnation blocks every later effect and a retired port cannot execute", async t => {
  const f = await fixture(t), request = await f.prepare("pause")
  const selected = f.sessions.get(f.coordinatorID)
  selected.model.id = "changed"
  await assert.rejects(f.invoke(() => f.control.lifecycle(request)))
  assert.deepEqual(f.calls, [])
  selected.model.id = "model"
  await f.change(next => { next.state = "running" })
  await assert.rejects(f.invoke(() => f.control.lifecycle(request)))
  assert.deepEqual(f.calls, [])
  await f.change(next => { next.state = "paused" })
  await f.invoke(async () => {})
  await assert.rejects(f.port()(f.coordinatorID, { missionID: f.pending.missionID, operationID: "old", sessionID: f.coordinatorID }))
  t.mock.method(Service, "discover", async () => {
    writeFileSync(f.registrationFile, JSON.stringify({ ...f.identity, id: "replacement" }))
    return { url: f.identity.url }
  })
  await assert.rejects(f.invoke(() => f.control.lifecycle(request)))
  assert.deepEqual(f.calls, [])
})
