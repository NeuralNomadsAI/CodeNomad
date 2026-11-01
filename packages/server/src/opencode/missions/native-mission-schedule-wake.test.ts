import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { claimNativeScheduleCarrierWake, closeNativeScheduleCarrierClaimLocked, nativeScheduleClaimKey,
  readNativeScheduleCarrierBinding } from "./native-schedule-carrier-binding"
import { readNativeScheduleAuxiliaryWakeBinding } from "./native-schedule-owner-bindings"
import { missionCalendarOwnerReady } from "./native-schedule-owner"
import { nativeSchedulePreflight } from "./native-mission-schedule-preflight"
import { nativeScheduleWakeKey } from "./native-schedule-transport-contract"
import { dispatchNativeMissionScheduleWake, nativeMissionSchedulePriorHeld, parseNativeMissionScheduleClaim } from "./native-mission-schedule-wake-dispatch"
import { receiveNativeMissionScheduleWake, type NativeMissionScheduleWakePorts } from "./native-mission-schedule-wake-rpc"
import type { createNativeScheduleTransport } from "./native-schedule-transport"

async function receiver(t: test.TestContext, role: "principal" | "reconciliation" = "principal", loseAuxiliary = false) {
  const f = await ownerFixture(t)
  if (loseAuxiliary) f.loseCreateACK("reconciliation")
  const doc = await f.control("play"), slot = doc.calendarOwner!.slots.find(item => item.role === role)!
  const info = [...f.calendars.values()].find(item => item.sessionID === slot.sessionID)!
  info.runCount = 1
  const wake = { missionID: doc.id, generation: doc.timeGeneration, sessionID: slot.sessionID, scheduleID: info.id, run: 1, messageID: `msg_${info.id}_1` }
  const incarnation = { id: "native_receiver", pid: process.pid, url: "http://127.0.0.1:1" }
  const input = { wake, incarnation, registrationFile: doc.calendarOwner!.installation.registrationFile,
    preflight: nativeSchedulePreflight(wake, incarnation.id, Date.now()) }
  const calls: string[] = [], signal = new AbortController().signal, entry = { signal, current: f.current }
  const preflight = () => readNativeScheduleAuxiliaryWakeBinding(f.ctx, wake, f.native, Effect.runPromise, f.current)
  const ports: NativeMissionScheduleWakePorts = { store: f.store,
    owner: {
      adoptAuxiliary: async wake => { calls.push("adopt"); return f.owner.adoptAuxiliary(wake) },
      reconcile: async id => { calls.push("owner"); return f.owner.reconcile(id) },
    },
    runtime: {
      preflight: async () => { calls.push("preflight"); return { messagePresent: true, ready: true, cutoff: Date.now() } },
      wake: async () => { calls.push("business-wake"); return "unknown" },
      reconcile: async () => { calls.push("business-reconcile"); return "idle" },
    },
    read: async () => {
      const binding = role === "reconciliation" ? await preflight() : await Effect.runPromise(readNativeScheduleCarrierBinding(f.ctx, slot.sessionID))
      if (!binding) throw new Error("missing native proof")
      return { binding, wake: { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: f.now } }
    },
    claim: async () => parseNativeMissionScheduleClaim(f.values.get(nativeScheduleClaimKey(f.ctx, doc.id)), doc.id),
    close: async locked => { calls.push("close"); return closeNativeScheduleCarrierClaimLocked(f.ctx, doc.id, Effect.runPromise, f.current, locked) },
  }
  const claim = () => claimNativeScheduleCarrierWake(f.ctx, wake, incarnation, Effect.runPromise, f.current, loseAuxiliary ? preflight : undefined)
  return { ...f, doc, slot, info, wake, input, entry, ports, calls, claim }
}

test("receiver status freezes cutoff and native message readiness without any document/claim/native mutation", async t => {
  const f = await receiver(t), revision = (await f.read()).revision, count = f.calls.length, nativeCalls = f.native
  const status = await receiveNativeMissionScheduleWake("status", f.input, f.entry, f.ports)
  assert.equal(status.ready, true); assert.equal(status.messagePresent, true); assert(status.preflight)
  assert.deepEqual(f.calls.slice(count), ["preflight"])
  assert.equal((await f.read()).revision, revision); assert.equal(await f.ports.claim(), undefined)
  assert.equal(f.native, nativeCalls)
})

test("receiver refuses a missing claim and an invalid cutoff receipt before business/owner effects", async t => {
  const f = await receiver(t), before = (await f.read()).revision
  assert.equal((await receiveNativeMissionScheduleWake("wake", f.input, f.entry, f.ports)).state, "unknown")
  assert.deepEqual(f.calls, []); assert.equal((await f.read()).revision, before)
  await f.claim()
  await assert.rejects(receiveNativeMissionScheduleWake("wake", { ...f.input, preflight: { ...f.input.preflight, signature: "0".repeat(64) } }, f.entry, f.ports), /preflight/)
  assert.deepEqual(f.calls, []); assert.equal((await f.read()).revision, before)
})

test("principal technical claim closes with its reservation while business is still pending, admitting the auxiliary claim", async t => {
  const f = await receiver(t)
  f.ports.runtime.wake = async () => {
    f.calls.push("business-wake")
    const doc = await f.read()
    await f.store.change(doc.id, doc.revision, f.current, value => {
      const wake = { scheduleID: f.wake.scheduleID, run: 1, messageID: f.wake.messageID, dueAt: f.now }
      missionDocumentChanges.prepareWake(value, wake)
      missionDocumentChanges.reserve(value, { kind: "wake", wakes: [wake] }, f.now, [])
    })
    return "started"
  }
  await f.claim()
  const reply = await receiveNativeMissionScheduleWake("wake", f.input, f.entry, f.ports)
  assert.equal(reply.state, "applied"); assert.deepEqual(f.calls, ["business-wake", "close", "owner"])
  const doc = await f.read()
  assert(doc.pending); assert.equal(doc.pending.admittedAt, null); assert.equal(doc.launchedCount, 0)
  assert.equal((await f.ports.claim())!.settled!.highWater, 1)
  const auxiliary = doc.calendars.find(item => item.role === "reconciliation")!
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, { ...f.wake, scheduleID: auxiliary.scheduleID, sessionID: auxiliary.sessionID,
    messageID: `msg_${auxiliary.scheduleID}_1` }, f.input.incarnation, Effect.runPromise, f.current), true)
})

test("cold auxiliary lost-ACK wake adopts only its row, consumes/closes before owner recovery and never reserves business", async t => {
  const f = await receiver(t, "reconciliation", true)
  const before = await f.read()
  const status = await receiveNativeMissionScheduleWake("status", f.input, f.entry, f.ports)
  assert.equal(status.ready, true); assert.equal((await f.read()).revision, before.revision)
  await f.claim()
  const reply = await receiveNativeMissionScheduleWake("wake", { ...f.input, preflight: status.preflight! }, f.entry, f.ports)
  assert.equal(reply.state, "applied"); assert.deepEqual(f.calls, ["adopt", "close", "owner", "business-reconcile", "owner"])
  const doc = await f.read()
  assert.equal(missionCalendarOwnerReady(doc), true); assert.equal(doc.pending, null); assert.equal(doc.launchedCount, 0)
  assert.equal(doc.calendars.find(item => item.role === "reconciliation")!.highWater, 1)
})

test("auxiliary business settlement reapplies terminal owner cleanup before replying from the same invocation", async t => {
  const f = await receiver(t, "reconciliation")
  let doc = await f.read()
  doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    value.configuration.launch.ends.maxLaunches = 1
    missionDocumentChanges.reserve(value, { kind: "manual", requestID: "last_original" }, f.now, [])
    missionDocumentChanges.admitted(value, value.pending!.id, f.now)
  })
  assert.equal(doc.state, "finished")
  f.ports.runtime.reconcile = async () => {
    f.calls.push("business-reconcile")
    const doc = await f.read()
    await f.store.change(doc.id, doc.revision, f.current, value => missionDocumentChanges.settle(value, value.pending!.id, "completed", f.now))
    return "settled"
  }
  await f.claim()
  const reply = await receiveNativeMissionScheduleWake("wake", f.input, f.entry, f.ports)
  assert.equal(reply.state, "applied")
  assert.deepEqual(f.calls, ["close", "owner", "business-reconcile", "owner"])
  doc = await f.read()
  assert.equal(doc.pending, null); assert.equal(doc.launchedCount, 1); assert.equal(doc.calendars.length, 0)
  assert.equal(f.calendars.size, 0); assert.equal((await f.ports.claim())!.settled!.highWater, 1)
})

test("an unconsumed uncertain original remains held across a fresh caller; a closed different occurrence can advance", async t => {
  const f = await receiver(t)
  await f.claim()
  const claim = await f.ports.claim(), doc = await f.read()
  assert.equal(nativeMissionSchedulePriorHeld(claim, doc, f.wake), true)
  const next = { ...f.wake, run: 2, messageID: `msg_${f.wake.scheduleID}_2` }
  assert.equal(nativeMissionSchedulePriorHeld(claim, doc, next), true)
  const closed = { ...claim!, settled: { revision: doc.revision, highWater: 1 } }
  assert.equal(nativeMissionSchedulePriorHeld(closed, doc, next), false)
  assert.equal(nativeMissionSchedulePriorHeld(closed, doc, f.wake), true)
})

test("dispatch is status-only when fan-in is incomplete or the exact original already has a durable claim", async () => {
  const wake = { missionID: "mission", generation: 1, scheduleID: "sch_main", sessionID: "ses_main", run: 1, messageID: "msg_sch_main_1" }
  for (const [ready, held] of [[false, false], [true, true]]) {
    const calls: string[] = []
    const transport: ReturnType<typeof createNativeScheduleTransport> = {
      status: async () => { calls.push("status"); return { state: "received", reply: { key: nativeScheduleWakeKey(wake), state: "unknown", ready,
        messagePresent: true, preflight: nativeSchedulePreflight(wake, "native", Date.now()) } } },
      wake: async () => { calls.push("wake"); throw new Error("must remain read-only") },
    }
    await dispatchNativeMissionScheduleWake({ wake, registrationFile: "/owned/service.json", directory: "/owned" }, {
      transport, current: () => true, held: async () => held, claim: async () => { calls.push("claim"); return true },
    })
    assert.deepEqual(calls, ["status"])
  }
})

test("dispatch forwards the frozen receipt and shares one cancellation signal across status and wake", async () => {
  const wake = { missionID: "mission", generation: 1, scheduleID: "sch_main", sessionID: "ses_main", run: 1, messageID: "msg_sch_main_1" }
  const preflight = nativeSchedulePreflight(wake, "native", Date.now()), signals: AbortSignal[] = []
  const transport: ReturnType<typeof createNativeScheduleTransport> = {
    status: async input => { signals.push(input.signal!); return { state: "received", reply: { key: nativeScheduleWakeKey(wake), state: "unknown", messagePresent: true, ready: true, preflight } } },
    wake: async input => {
      signals.push(input.signal!); assert.deepEqual(input.preflight, preflight)
      assert.equal(await input.claim({ id: "native", pid: process.pid, url: "http://127.0.0.1:1" }), true)
      return { state: "received", reply: { key: nativeScheduleWakeKey(wake), state: "applied" } }
    },
  }
  const result = await dispatchNativeMissionScheduleWake({ wake, registrationFile: "/owned/service.json", directory: "/owned" }, {
    transport, current: () => true, held: async () => false, claim: async (_inc, value) => { assert.deepEqual(value, preflight); return true },
  })
  assert.equal(result.state, "received"); assert.equal(signals.length, 2); assert.equal(signals[0], signals[1])
})

test("cancellation after preflight cannot publish a claim or dispatch a mutation", async () => {
  const wake = { missionID: "mission", generation: 1, scheduleID: "sch_main", sessionID: "ses_main", run: 1, messageID: "msg_sch_main_1" }
  const abort = new AbortController(), calls: string[] = []
  const transport: ReturnType<typeof createNativeScheduleTransport> = {
    status: async () => { abort.abort(); return { state: "received", reply: { key: nativeScheduleWakeKey(wake), state: "unknown", messagePresent: true, ready: true,
      preflight: nativeSchedulePreflight(wake, "native", Date.now()) } } },
    wake: async () => { calls.push("wake"); throw new Error("cancelled") },
  }
  const result = await dispatchNativeMissionScheduleWake({ wake, registrationFile: "/owned/service.json", directory: "/owned", signal: abort.signal }, {
    transport, current: () => true, held: async () => false, claim: async () => { calls.push("claim"); return true },
  })
  assert.equal(result.state, "not-dispatched"); assert.deepEqual(calls, [])
})
