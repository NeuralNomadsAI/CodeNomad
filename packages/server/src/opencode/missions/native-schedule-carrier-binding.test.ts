import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "../../missions/mission-document-store"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import type { MissionJsonValue } from "../../missions/model"
import { assertNativeScheduleCarrierArtifacts, assertOrdinaryMissionScheduleInput, claimNativeScheduleCarrierWake, closeNativeScheduleCarrierClaim,
  nativeScheduleClaimKey, NATIVE_SCHEDULE_CARRIER_MARKER, readNativeScheduleCarrierBinding } from "./native-schedule-carrier-binding"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"

async function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionDocumentStorage = { get: async key => structuredClone(values.get(key)),
    compareAndSet: async (key, value, expected, current) => {
      current()
      assert.equal((values.get(key) as { revision: number } | undefined)?.revision ?? null, expected)
      values.set(key, structuredClone(value))
    } }
  const store = new NativeMissionDocumentStore(storage, "project", "/owned")
  const model: { providerID: string; id: string } = { ...NATIVE_SCHEDULE_CARRIER_MODEL }, selection = { agent: "build", model }
  const initial = await store.create("owned_mission", { title: "Qualification", objective: "Read only", template: "custom", taskMode: "native",
    profileID: "isolated", executionHost: "isolated", profiles: { coordinator: selection, roles: { specialist: selection } },
    roots: [{ mode: "directory-only", directory: "/owned" }], watchedConversationIDs: [],
    launch: { timing: { kind: "every", intervalMs: 90 * 60_000 }, condition: null, ends: { maxLaunches: 3, afterMs: null, at: null } } }, 1, () => true)
  const played = await store.change(initial.id, initial.revision, () => true, doc => missionDocumentChanges.play(doc, "first_play", 2, []))
  await store.change(initial.id, played.revision, () => true, doc => missionDocumentChanges.synchronized(doc, "first_play", [
    { role: "principal", slot: 0, timeGeneration: 1, scheduleID: "sch_main", sessionID: "ses_main", highWater: 0, pendingWake: null, wakePreparing: null },
    { role: "reconciliation", slot: 0, timeGeneration: 1, scheduleID: "sch_aux", sessionID: "ses_aux", highWater: 0, pendingWake: null, wakePreparing: null },
  ]))
  const session = { id: "ses_aux", projectID: "project", location: { directory: "/owned" }, model,
    metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: { missionID: initial.id, timeGeneration: 1, role: "reconciliation", slot: 0 } } }
  const ctx = { location: { directory: "/owned", project: { id: "project", canonical: "/owned" } },
    session: { get: () => Effect.succeed(session) }, storage: {
      get: (key: string) => Effect.sync(() => structuredClone(values.get(key))),
      set: (key: string, value: MissionJsonValue) => Effect.sync(() => { values.set(key, structuredClone(value)) }),
    } } as unknown as Plugin.Context
  const wake = { missionID: initial.id, generation: 1, scheduleID: "sch_aux", run: 1, sessionID: "ses_aux", messageID: "msg_sch_aux_1" }
  const incarnation = { id: "incarnation", pid: process.pid, url: "http://127.0.0.1:1" }
  return { ctx, values, store, session, wake, incarnation }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
async function document(f: Fixture) {
  const doc = await f.store.read(f.wake.missionID)
  assert(doc && !("deletedAt" in doc))
  return doc
}
async function settle(f: Fixture) {
  const doc = await document(f)
  return f.store.change(doc.id, doc.revision, () => true, value => missionDocumentChanges.processWake(value,
    { scheduleID: f.wake.scheduleID, run: f.wake.run, messageID: f.wake.messageID, dueAt: 3 }))
}
async function configureReplacement(f: Fixture) {
  const doc = await document(f)
  return f.store.change(doc.id, doc.revision, () => true, value => missionDocumentChanges.configure(value,
    { ...value.configuration, launch: { ...value.configuration.launch, timing: { kind: "every", intervalMs: 60 * 60_000 } } }, 4))
}
async function finishReplacement(f: Fixture) {
  const doc = await document(f)
  assert(doc.synchronization)
  await f.store.change(doc.id, doc.revision, () => true, value => missionDocumentChanges.synchronized(value,
    doc.synchronization!.requestID, [
      { role: "principal", slot: 0, timeGeneration: doc.timeGeneration, scheduleID: "sch_main_new", sessionID: "ses_main_new", highWater: 0, pendingWake: null, wakePreparing: null },
      { role: "reconciliation", slot: 0, timeGeneration: doc.timeGeneration, scheduleID: "sch_aux_new", sessionID: "ses_aux_new", highWater: 0, pendingWake: null, wakePreparing: null },
    ]))
  f.session.id = "ses_aux_new"
  f.session.metadata[NATIVE_SCHEDULE_CARRIER_MARKER].timeGeneration = doc.timeGeneration
  return { ...f.wake, generation: doc.timeGeneration, scheduleID: "sch_aux_new", sessionID: "ses_aux_new", messageID: "msg_sch_aux_new_1" }
}

test("exact durable mapping and a persisted per-Mission claim survive a fresh caller and hold newer wakes", async () => {
  const f = await fixture()
  assert.equal((await Effect.runPromise(readNativeScheduleCarrierBinding(f.ctx, f.wake.sessionID)))?.calendar.role, "reconciliation")
  const claim = () => claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, () => true)
  assert.equal(await claim(), true)
  assert(f.values.has(nativeScheduleClaimKey(f.ctx, f.wake.missionID)))
  assert.equal(await claim(), false)
  const next = { ...f.wake, run: 2, messageID: "msg_sch_aux_2" }
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, next, f.incarnation, Effect.runPromise, () => true), false)
  const doc = await f.store.read(f.wake.missionID)
  assert(doc && !("deletedAt" in doc))
  await f.store.change(doc.id, doc.revision, () => true, value => missionDocumentChanges.processWake(value,
    { scheduleID: f.wake.scheduleID, run: 1, messageID: f.wake.messageID, dueAt: 3 }))
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, next, f.incarnation, Effect.runPromise, () => true), true)
  assert.equal(await claim(), false)
})

test("wrong root, local model, calendar generation or forged marker cannot acquire a carrier binding", async () => {
  const f = await fixture()
  f.session.model.providerID = "remote"
  await assert.rejects(Effect.runPromise(readNativeScheduleCarrierBinding(f.ctx, f.wake.sessionID)), /ownership/)
  f.session.model.providerID = NATIVE_SCHEDULE_CARRIER_MODEL.providerID
  f.session.metadata[NATIVE_SCHEDULE_CARRIER_MARKER].timeGeneration = 2
  await assert.rejects(Effect.runPromise(readNativeScheduleCarrierBinding(f.ctx, f.wake.sessionID)), /ownership/)
  f.session.metadata[NATIVE_SCHEDULE_CARRIER_MARKER].timeGeneration = 1
  f.session.location.directory = "/foreign"
  await assert.rejects(Effect.runPromise(readNativeScheduleCarrierBinding(f.ctx, f.wake.sessionID)), /ownership/)
})

test("a lost public-KV claim acknowledgement keeps the same durable hold", async () => {
  const f = await fixture(), set = f.ctx.storage.set
  const broken = { ...f.ctx, storage: { ...f.ctx.storage,
    set: ((...args: Parameters<typeof set>) => set(...args).pipe(Effect.andThen(Effect.die(new Error("claim ACK lost"))))) as typeof set,
  } }
  await assert.rejects(claimNativeScheduleCarrierWake(broken, f.wake, f.incarnation, Effect.runPromise, () => true), /claim ACK lost/)
  assert(f.values.has(nativeScheduleClaimKey(f.ctx, f.wake.missionID)))
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, () => true), false)
})

test("settled old-generation claim closes durably before replacement calendars and admits the new generation once", async () => {
  const f = await fixture(), current = () => true as const
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, current), true)
  const settled = await settle(f)
  assert.equal(await closeNativeScheduleCarrierClaim(f.ctx, f.wake.missionID, Effect.runPromise, current), true)
  const receipt = f.values.get(nativeScheduleClaimKey(f.ctx, f.wake.missionID)) as { settled?: { revision: number; highWater: number } }
  assert.deepEqual(receipt.settled, { revision: settled.revision, highWater: 1 })
  await configureReplacement(f)
  const wake = await finishReplacement(f)
  assert.equal(await closeNativeScheduleCarrierClaim(f.ctx, f.wake.missionID, Effect.runPromise, current), true)
  assert.deepEqual(await Promise.all([1, 2].map(() => claimNativeScheduleCarrierWake(f.ctx, wake, f.incarnation, Effect.runPromise, current))), [true, false])
})

test("a retiring old-generation high-water can close the claim before its mapping proof is dropped", async () => {
  const f = await fixture(), current = () => true as const
  await claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, current)
  await settle(f)
  await configureReplacement(f)
  assert.equal(await closeNativeScheduleCarrierClaim(f.ctx, f.wake.missionID, Effect.runPromise, current), true)
  const wake = await finishReplacement(f)
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, f.incarnation, Effect.runPromise, current), true)
})

test("unsettled and pruned old-generation proof keep the exact claim held after replacement", async () => {
  for (const highWaterWasPruned of [false, true]) {
    const f = await fixture(), current = () => true as const
    await claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, current)
    if (highWaterWasPruned) await settle(f) // No closure receipt was persisted before removal.
    const original = structuredClone(f.values.get(nativeScheduleClaimKey(f.ctx, f.wake.missionID)))
    if (!highWaterWasPruned) assert.equal(await closeNativeScheduleCarrierClaim(f.ctx, f.wake.missionID, Effect.runPromise, current), false)
    await configureReplacement(f)
    const wake = await finishReplacement(f)
    assert.equal(await closeNativeScheduleCarrierClaim(f.ctx, f.wake.missionID, Effect.runPromise, current), false)
    assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, f.incarnation, Effect.runPromise, current), false)
    assert.deepEqual(f.values.get(nativeScheduleClaimKey(f.ctx, f.wake.missionID)), original)
  }
})

test("a lost claim ACK without settlement proof cannot release across a temporal generation change", async () => {
  const f = await fixture(), set = f.ctx.storage.set, current = () => true as const
  const broken = { ...f.ctx, storage: { ...f.ctx.storage,
    set: ((...args: Parameters<typeof set>) => set(...args).pipe(Effect.andThen(Effect.die(new Error("claim ACK lost"))))) as typeof set,
  } }
  await assert.rejects(claimNativeScheduleCarrierWake(broken, f.wake, f.incarnation, Effect.runPromise, current), /claim ACK lost/)
  assert.equal(await closeNativeScheduleCarrierClaim(f.ctx, f.wake.missionID, Effect.runPromise, current), false)
  await configureReplacement(f)
  const wake = await finishReplacement(f)
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, f.incarnation, Effect.runPromise, current), false)
})

test("pending preparation denies replacement and closure without replacing the claim", async () => {
  const f = await fixture(), current = () => true as const
  await claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, current)
  const doc = await document(f)
  await f.store.change(doc.id, doc.revision, current, value => missionDocumentChanges.prepareWake(value,
    { scheduleID: f.wake.scheduleID, run: 1, messageID: f.wake.messageID, dueAt: 3 }))
  assert.equal(await closeNativeScheduleCarrierClaim(f.ctx, f.wake.missionID, Effect.runPromise, current), false)
  const prepared = await document(f)
  await assert.rejects(configureReplacement(f), /Mission configuration locked/)
  assert.deepEqual(await document(f), prepared)
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, current), false)
})

test("closure publication and temporal replacement share the document exclusion", async () => {
  const f = await fixture(), current = () => true as const
  await claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, current)
  await settle(f)
  let entered!: () => void, release!: () => void
  const enteredWrite = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const set = f.ctx.storage.set
  const delayed = { ...f.ctx, storage: { ...f.ctx.storage, set: ((...args: Parameters<typeof set>) => Effect.promise(async () => {
    entered(); await released; await Effect.runPromise(set(...args))
  })) as typeof set } }
  const closing = closeNativeScheduleCarrierClaim(delayed, f.wake.missionID, Effect.runPromise, current)
  await enteredWrite
  let replaced = false
  const replacing = configureReplacement(f).then(value => { replaced = true; return value })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(replaced, false)
  release()
  assert.equal(await closing, true)
  await replacing
  const wake = await finishReplacement(f)
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, f.incarnation, Effect.runPromise, current), true)
})

test("lost closure acknowledgement retains its positive receipt; a failed closure write fabricates none", async () => {
  for (const written of [false, true]) {
    const f = await fixture(), current = () => true as const, set = f.ctx.storage.set
    await claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, current)
    await settle(f)
    const broken = { ...f.ctx, storage: { ...f.ctx.storage,
      set: ((...args: Parameters<typeof set>) => (written ? set(...args) : Effect.void)
        .pipe(Effect.andThen(Effect.die(new Error("closure publication uncertain"))))) as typeof set,
    } }
    await assert.rejects(closeNativeScheduleCarrierClaim(broken, f.wake.missionID, Effect.runPromise, current), /closure publication uncertain/)
    await configureReplacement(f)
    const wake = await finishReplacement(f)
    assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, f.incarnation, Effect.runPromise, current), written)
  }
})

test("a closure receipt cannot outlive its proven revision or cover a smaller high-water", async () => {
  const f = await fixture(), current = () => true as const
  await claimNativeScheduleCarrierWake(f.ctx, f.wake, f.incarnation, Effect.runPromise, current)
  await settle(f)
  await closeNativeScheduleCarrierClaim(f.ctx, f.wake.missionID, Effect.runPromise, current)
  const key = nativeScheduleClaimKey(f.ctx, f.wake.missionID)
  const receipt = structuredClone(f.values.get(key)) as { settled: { revision: number; highWater: number } }
  await configureReplacement(f)
  const wake = await finishReplacement(f)
  receipt.settled.revision = (await document(f)).revision + 1
  f.values.set(key, receipt as unknown as MissionJsonValue)
  assert.equal(await claimNativeScheduleCarrierWake(f.ctx, wake, f.incarnation, Effect.runPromise, current), false)
  receipt.settled.revision = 0
  receipt.settled.highWater = 0
  f.values.set(key, receipt as unknown as MissionJsonValue)
  await assert.rejects(claimNativeScheduleCarrierWake(f.ctx, wake, f.incarnation, Effect.runPromise, current), /claim-invalid/)
})

test("ordinary entry guard refuses exact carriers and reserved metadata independently", () => {
  assert.equal(assertOrdinaryMissionScheduleInput({ ownedCarrier: false }), true)
  for (const input of [{ ownedCarrier: true }, { ownedCarrier: false, metadata: { schedule: {} } },
    { ownedCarrier: false, metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: {} } },
    { ownedCarrier: false, sessionMetadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: {} } }])
    assert.throws(() => assertOrdinaryMissionScheduleInput(input), /ordinary-input/)
})

test("installed artifact guards fence missing or changed provider/runtime bytes even with a cached model", t => {
  const base = process.env.CODENOMAD_SCHEDULE_TEST_SCRATCH ?? path.join(os.tmpdir(), "codenomad-schedule-carrier")
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(path.join(base, "artifact-unit-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "provider.mjs"), bytes = "export const createLocal = () => ({})"
  writeFileSync(file, bytes)
  const artifact = { file, sha256: createHash("sha256").update(bytes).digest("hex") }
  const installation = { registrationFile: path.join(directory, "registration.json"), provider: artifact, runtime: artifact }
  assert.equal(assertNativeScheduleCarrierArtifacts(installation), true)
  writeFileSync(file, `${bytes}\n`)
  assert.throws(() => assertNativeScheduleCarrierArtifacts(installation), /artifact/)
  rmSync(file)
  assert.throws(() => assertNativeScheduleCarrierArtifacts(installation))
})
