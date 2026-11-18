import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { SessionPrompt } from "@opencode/plugin/effect/session"
import { Effect, Exit, Queue, Scope, Stream } from "effect"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { prepareNativeMissionSchedulePrincipalPrompt } from "./native-mission-schedule-wake-prepare"
import { registerNativeMissionScheduleIdleHints } from "./native-mission-schedule-wake-idle"
import { reconcileNativeMissionScheduleMaintenance, sendNativeMissionScheduleMaintenance, NativeMissionScheduleMaintenanceRpc, type NativeMissionScheduleIdleHint } from "./native-mission-schedule-wake-maintenance"
import { NATIVE_SCHEDULE_CARRIER_SIGNAL, readNativeScheduleCarrierOwnership, nativeScheduleCarrierLookupKey } from "./native-schedule-carrier-binding"
import { missionDocumentChanges } from "../../missions/mission-document-state"

test("native principal prompt commits preparation before inbox/ACK, survives a crash, and blocks structural edits", async t => {
  const f = await ownerFixture(t), doc = await f.control("play"), principal = doc.calendars.find(item => item.role === "principal")!
  const event = { sessionID: principal.sessionID, messageID: `msg_${principal.scheduleID}_1`, delivery: "queue", prompt: { text: NATIVE_SCHEDULE_CARRIER_SIGNAL },
    metadata: { schedule: { id: principal.scheduleID, run: 1, dueAt: f.now, late: false } } } as unknown as SessionPrompt
  const prepared = await prepareNativeMissionSchedulePrincipalPrompt(f.ctx, event, f.store, Effect.runPromise, f.current)
  const calendar = prepared.calendars.find(item => item.role === "principal")!
  assert.equal(calendar.wakePreparing?.messageID, event.messageID); assert.equal(calendar.highWater, 0)
  assert.equal(prepared.launchedCount, 0); assert.equal(prepared.pending, null)
  assert.equal(f.calendars.get(principal.scheduleID)!.runCount, 0)
  assert.deepEqual(await prepareNativeMissionSchedulePrincipalPrompt(f.ctx, event, f.store, Effect.runPromise, f.current), prepared)
  await assert.rejects(f.store.change(prepared.id, prepared.revision, f.current, value => missionDocumentChanges.configure(value,
    { ...value.configuration, launch: { ...value.configuration.launch, timing: { kind: "every", intervalMs: 1_800_000 } } }, f.now)), /configuration locked|wake unresolved/)
  assert.deepEqual(await f.read(), prepared)
})

test("Pause or temporal-edit winner rejects a principal before native prompt returns, with no preparation/count", async t => {
  for (const winner of ["pause", "configure"] as const) {
    const f = await ownerFixture(t), doc = await f.control("play"), principal = doc.calendars.find(item => item.role === "principal")!
    const event = { sessionID: principal.sessionID, messageID: `msg_${principal.scheduleID}_1`, delivery: "queue", prompt: { text: NATIVE_SCHEDULE_CARRIER_SIGNAL },
      metadata: { schedule: { id: principal.scheduleID, run: 1, dueAt: f.now, late: false } } } as unknown as SessionPrompt
    if (winner === "pause") await f.control("pause")
    else {
      f.blocked.add(doc.calendars.find(item => item.role === "reconciliation")!.sessionID)
      await f.control("configure", "edit_winner", { ...doc.configuration, launch: { ...doc.configuration.launch, timing: { kind: "every", intervalMs: 1_800_000 } } })
    }
    const before = await f.read()
    await assert.rejects(prepareNativeMissionSchedulePrincipalPrompt(f.ctx, event, f.store, Effect.runPromise, f.current), /schedule-prompt-/)
    assert.deepEqual(await f.read(), before)
    assert.equal(before.launchedCount, 0); assert(before.calendars.every(item => !item.wakePreparing))
  }
})

test("after-idle maintenance refuses a self-active carrier, then removes exact retired wake/index after positive quiet", async t => {
  const f = await ownerFixture(t), armed = await f.control("play"), auxiliary = armed.calendars.find(item => item.role === "reconciliation")!
  f.blocked.add(auxiliary.sessionID)
  const stopped = await f.control("stop")
  const quiet = (descriptor: Parameters<typeof f.native.carrierQuiet>[0]["descriptor"]) => f.native.carrierQuiet({ missionID: stopped.id, descriptor }, f.current)
  assert.deepEqual(await reconcileNativeMissionScheduleMaintenance(stopped, auxiliary.sessionID, quiet, () => f.owner.reconcile(stopped.id)), { complete: false })
  assert(f.values.has(nativeScheduleCarrierLookupKey(f.ctx, auxiliary.sessionID)))
  f.blocked.clear()
  assert.deepEqual(await reconcileNativeMissionScheduleMaintenance(await f.read(), auxiliary.sessionID, quiet, () => f.owner.reconcile(stopped.id)), { complete: true })
  assert.equal(f.sessions.size, 0); assert.equal(f.calendars.size, 0)
  assert.equal(f.values.has(nativeScheduleCarrierLookupKey(f.ctx, auxiliary.sessionID)), false)
})

test("terminal public hints use learned pure data, coalesce one Mission lane and dispose the subscription", async t => {
  const f = await ownerFixture(t), doc = await f.control("play"), sessionID = doc.calendars.find(item => item.role === "reconciliation")!.sessionID
  const ownership = await Effect.runPromise(readNativeScheduleCarrierOwnership(f.ctx, sessionID))
  assert(ownership?.verified)
  const queue = await Effect.runPromise(Queue.unbounded<any>())
  const scope = await Effect.runPromise(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  let disposed = false, sends = 0, release!: () => void, enter!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  const ctx = { ...f.ctx, event: { subscribe: () => Stream.fromQueue(queue).pipe(Stream.ensuring(Effect.sync(() => { disposed = true }))) } } as Plugin.Context
  const idle = await Effect.runPromise(registerNativeMissionScheduleIdleHints(ctx, async (hint: NativeMissionScheduleIdleHint) => {
    assert.equal(hint.registrationFile, doc.calendarOwner!.installation.registrationFile)
    assert.equal(hint.sessionID, sessionID); assert.equal(Object.keys(hint).length, 5)
    sends++; enter(); await gate; return true
  }, Effect.void).pipe(Effect.provideService(Scope.Scope, scope)))
  idle.remember(sessionID, ownership)
  const event = { type: "session.execution.succeeded", data: { sessionID }, location: f.ctx.location }
  await Effect.runPromise(Queue.offerAll(queue, [event, event, event]))
  await Promise.race([entered, new Promise<void>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hint not received; disposed=${disposed}`)), 1000)
    void entered.finally(() => clearTimeout(timer))
  })])
  assert.equal(sends, 1)
  release(); await new Promise<void>(resolve => setImmediate(resolve))
  await Effect.runPromise(Scope.close(scope, Exit.void))
  assert.equal(disposed, true)
  await Effect.runPromise(Queue.offer(queue, event))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(sends, 1)
})

test("a broken public subscription cannot fail ordinary Missions setup", async t => {
  const f = await ownerFixture(t), scope = await Effect.runPromise(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const ctx = { ...f.ctx, event: { subscribe: () => Stream.fail(new Error("public event unavailable")) } } as Plugin.Context
  const idle = await Effect.runPromise(registerNativeMissionScheduleIdleHints(ctx).pipe(Effect.provideService(Scope.Scope, scope)))
  assert.equal(typeof idle.remember, "function")
})

test("learned installation can target a fresh receiver when public KV is unavailable in the setup event graph", async t => {
  const f = await ownerFixture(t), doc = await f.control("play"), sessionID = doc.calendars[0].sessionID
  const ownership = await Effect.runPromise(readNativeScheduleCarrierOwnership(f.ctx, sessionID))
  assert(ownership?.verified)
  const scope = await Effect.runPromise(Scope.make()), queue = await Effect.runPromise(Queue.unbounded<any>())
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  let received!: () => void
  const delivered = new Promise<void>(resolve => { received = resolve })
  const ctx = { ...f.ctx, storage: { ...f.ctx.storage, get: () => Effect.fail(new Error("setup KV unavailable")) },
    event: { subscribe: () => Stream.fromQueue(queue) } } as unknown as Plugin.Context
  const idle = await Effect.runPromise(registerNativeMissionScheduleIdleHints(ctx, async (hint: NativeMissionScheduleIdleHint) => {
    assert.equal(hint.sessionID, sessionID); assert.equal(hint.registrationFile, doc.calendarOwner!.installation.registrationFile)
    received(); return false // The receiver, not the hint, decides current ownership/quiescence.
  }, Effect.void).pipe(Effect.provideService(Scope.Scope, scope)))
  idle.remember(sessionID, ownership)
  await Effect.runPromise(Queue.offer(queue, { type: "session.execution.interrupted", data: { sessionID } }))
  await Promise.race([delivered, new Promise<void>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("learned maintenance hint unavailable")), 1000)
    void delivered.finally(() => clearTimeout(timer))
  })])
})

test("maintenance transport uses only the fixed own-process authenticated HTTP method with bounded response", async t => {
  const f = await ownerFixture(t), doc = await f.control("play"), descriptor = doc.calendarOwner!.slots[0]
  const incarnation = { id: "idle_native", pid: process.pid, url: "http://127.0.0.1:1" }
  const registrationFile = doc.calendarOwner!.installation.registrationFile
  writeFileSync(registrationFile, JSON.stringify({ ...incarnation, password: "fixture-only" }))
  let posts = 0
  const result = await sendNativeMissionScheduleMaintenance({ sessionID: descriptor.sessionID, missionID: doc.id, timeGeneration: doc.timeGeneration,
    directory: f.directory, registrationFile }, undefined, {
    discover: async () => ({ url: incarnation.url, auth: undefined }), headers: () => ({ authorization: "fixture-auth" }),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      assert.equal(url.pathname, `/api/rpc/${NativeMissionScheduleMaintenanceRpc.id}/reconcile`)
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error")
      const body = JSON.parse(String(init?.body)).input
      assert.deepEqual(body, { sessionID: descriptor.sessionID, registrationFile, incarnation })
      assert.equal(JSON.stringify(body).includes("fixture-only"), false)
      posts++
      return new Response(JSON.stringify({ output: { complete: true } }), { headers: { "content-type": "application/json" } })
    },
  })
  assert.equal(result, true); assert.equal(posts, 1)
  assert.equal(await sendNativeMissionScheduleMaintenance({ sessionID: descriptor.sessionID, missionID: doc.id, timeGeneration: doc.timeGeneration,
    directory: f.directory, registrationFile }, undefined, {
    discover: async () => ({ url: incarnation.url, auth: undefined }), headers: () => ({ authorization: "fixture-auth" }),
    fetch: async () => new Response(JSON.stringify({ output: { complete: "true" } }), { headers: { "content-type": "application/json" } }),
  }), false)
})
