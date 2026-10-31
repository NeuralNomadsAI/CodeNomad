import assert from "node:assert/strict"
import test from "node:test"
import { MissionDocumentPassageEngine, type DocumentPassagePorts, type DocumentPassageWake } from "./mission-document-passage-engine"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "./mission-document-store"
import { missionDocumentChanges as changes } from "./mission-document-state"
import type { MissionCalendar, MissionDocument, MissionWake } from "./mission-document"
import type { MissionConfiguration } from "./launch-policy"
import type { MissionJsonValue } from "./model"

const current = () => true as const, start = Date.parse("2026-10-01T00:00:00Z")
async function fixture(count = 1, maximum: number | null = null) {
  const values = new Map<string, MissionJsonValue>()
  let transaction = false, now = start + 1000, admitted = 0, complete = true, changed = true, terminal = false, crash = false, mutations = 0
  const storage: MissionDocumentStorage = {
    get: async key => structuredClone(values.get(key)),
    compareAndSet: async (key, value, revision, guard) => {
      transaction = true
      try {
        guard()
        assert.equal((values.get(key) as { revision: number } | undefined)?.revision ?? null, revision)
        values.set(key, structuredClone(value))
        mutations++
      } finally { transaction = false }
    },
  }
  const store = new NativeMissionDocumentStore(storage, "project", "/project")
  const selection = { agent: "worker", model: { providerID: "unit", id: "model" } }
  const config: MissionConfiguration = { title: "Passages", objective: "Do useful work", template: "custom", taskMode: "native",
    profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [],
    profiles: { coordinator: selection, roles: { specialist: selection } },
    launch: { timing: count === 1 ? { kind: "every", intervalMs: 900_000 } : { kind: "multi",
      calendars: Array.from({ length: count }, (_, slot) => ({ expression: `${slot} 9 * * *`, zone: "UTC" })) },
    condition: null, ends: { maxLaunches: maximum, at: null, afterMs: null } } }
  let doc = await store.create("review", config, start, current)
  doc = await store.change(doc.id, doc.revision, current, next => changes.play(next, "first_play", start, []))
  const calendars: MissionCalendar[] = [...Array.from({ length: count }, (_, slot): MissionCalendar => ({ role: "principal", slot,
    timeGeneration: 1, scheduleID: `sch_principal_${slot}`, sessionID: `ses_principal_${slot}`, highWater: 0, pendingWake: null, wakePreparing: null })),
  { role: "reconciliation", slot: 0, timeGeneration: 1, scheduleID: "sch_auxiliary", sessionID: "ses_auxiliary", highWater: 0, pendingWake: null, wakePreparing: null }]
  await store.change(doc.id, doc.revision, current, next => changes.synchronized(next, "first_play", calendars))
  const read = async () => {
    const doc = await store.read("review")
    assert.ok(doc && !("deletedAt" in doc)); return doc
  }
  const mutate = async (use: (doc: MissionDocument) => void) => { const doc = await read(); return store.change(doc.id, doc.revision, current, use) }
  const occurrences: MissionWake[] = []
  const wake = (slot = 0, run = 1, dueAt = now): DocumentPassageWake => {
    const calendar = calendars[slot]
    const value = { scheduleID: calendar.scheduleID, run, messageID: `msg_${calendar.scheduleID}_${run}`, dueAt }
    occurrences.push(value)
    return { ...value, missionID: "review", generation: 1, sessionID: calendar.sessionID }
  }
  const io = () => { assert.equal(transaction, false, "native I/O inside SQL transaction"); return current() }
  const ports: DocumentPassagePorts = {
    incarnation: "process_one", now: () => now, current,
    verifyWake: async (_doc, wake) => { io(); return { wake: { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: wake.dueAt! }, current } },
    coverage: async doc => { io(); return { complete, wakes: occurrences.filter(wake => wake.run > doc.calendars.find(item => item.scheduleID === wake.scheduleID)!.highWater), current } },
    snapshot: async () => { io(); return { changed, checkpoints: [], current } },
    admit: async (doc, locked) => {
      io(); locked.assertActive()
      if (crash) { crash = false; throw new Error("lost ACK") }
      if (doc.pending!.admittedAt === null) admitted++
      return { kind: doc.pending!.admittedAt === null ? "admitted" : "recorded", passageID: doc.pending!.id,
        messageID: doc.pending!.messageID, coordinatorSessionID: doc.pending!.coordinatorSessionID, at: now }
    },
    observe: async () => { io(); return terminal ? { outcome: "completed", current } : undefined },
  }
  return { store, read, mutate, wake, ports, engine: new MissionDocumentPassageEngine(store, ports),
    counts: () => admitted, mutations: () => mutations, tick: () => { now += 1000 }, set complete(value: boolean) { complete = value },
    set changed(value: boolean) { changed = value }, set terminal(value: boolean) { terminal = value }, set crash(value: boolean) { crash = value } }
}

test("eight simultaneous principal wakes fan in once, including instant settlement and concurrent duplicate entry", async () => {
  const f = await fixture(8)
  const wakes = Array.from({ length: 8 }, (_, slot) => f.wake(slot))
  f.terminal = true
  const results = await Promise.all(wakes.map(wake => f.engine.wake({ missionID: "review", wake })))
  assert.equal(results.filter(result => result === "settled").length, 1)
  const doc = await f.read()
  assert.equal(doc.launchedCount, 1); assert.equal(doc.history.length, 1); assert.equal(f.counts(), 1)
  assert.ok(doc.calendars.filter(item => item.role === "principal").every(item => item.highWater === 1))
})

test("incomplete native fan-in survives restart with its original cutoff and no reservation", async () => {
  const f = await fixture(2), first = f.wake()
  f.complete = false
  assert.equal(await f.engine.wake({ missionID: "review", wake: first }), "unknown")
  const cutoff = (await f.read()).fanIn!.cutoff
  f.tick(); f.ports.incarnation = "process_two"; f.complete = true; f.wake(1, 1, cutoff)
  await new MissionDocumentPassageEngine(f.store, f.ports).wake({ missionID: "review", wake: first })
  const doc = await f.read()
  assert.equal(doc.fanIn!.cutoff, cutoff); assert.equal(doc.launchedCount, 1)
})

test("100 condition-false checks cost zero launches and advance high-water beyond retained history", async () => {
  const f = await fixture(); f.changed = false
  for (let run = 1; run <= 100; run++) {
    const wake = f.wake(0, run)
    assert.equal(await f.engine.wake({ missionID: "review", wake }), "ignored")
    f.tick()
  }
  const doc = await f.read()
  assert.equal(doc.launchedCount, 0); assert.equal(doc.calendars[0].highWater, 100); assert.equal(doc.pending, null)
})

test("reservation crash blocks its place without counting; retry keeps exact IDs and shared manual/native quota", async () => {
  const f = await fixture(1, 3), wake = f.wake()
  f.crash = true
  assert.equal(await f.engine.wake({ missionID: "review", wake }), "unknown")
  const reserved = (await f.read()).pending!
  assert.equal((await f.read()).launchedCount, 0)
  await assert.rejects(f.engine.runNow({ missionID: "review", requestID: "blocked_manual", expectedRevision: (await f.read()).revision }))
  f.terminal = true
  assert.equal(await f.engine.reconcile({ missionID: "review" }), "settled")
  assert.equal((await f.read()).history[0].id, reserved.id)
  for (const requestID of ["manual_two", "manual_three"])
    assert.equal(await f.engine.runNow({ missionID: "review", requestID, expectedRevision: (await f.read()).revision }), "settled")
  const doc = await f.read()
  assert.equal(doc.launchedCount, 3); assert.equal(doc.state, "finished")
  await assert.rejects(f.engine.runNow({ missionID: "review", requestID: "fourth_launch", expectedRevision: doc.revision }))
  await assert.rejects(f.engine.runNow({ missionID: "review", requestID: "manual_three", expectedRevision: 0 }), /request conflict/)
  assert.equal(await f.engine.runNow({ missionID: "review", requestID: "manual_three", expectedRevision: doc.history.at(-1)!.manualExpectedRevision! }), "settled")
})

test("suppression survives fast settlement: remaining old principal wakes cannot launch after restart", async () => {
  const f = await fixture(2)
  await f.engine.wake({ missionID: "review", wake: f.wake(0) })
  f.complete = false; f.terminal = true; f.ports.incarnation = "process_two"
  await f.engine.reconcile({ missionID: "review" })
  assert.equal((await f.read()).fanIn!.suppress, true)
  f.complete = true
  await f.engine.wake({ missionID: "review", wake: f.wake(1) })
  assert.equal((await f.read()).launchedCount, 1)
})

test("overlapping same-calendar occurrences advance HWM while retaining the pending correlation", async () => {
  const f = await fixture(), first = f.wake()
  await f.engine.wake({ missionID: "review", wake: first })
  const pending = (await f.read()).pending!
  f.tick()
  await f.engine.wake({ missionID: "review", wake: f.wake(0, 2) })
  const overlap = await f.read()
  assert.equal(overlap.calendars[0].highWater, 2); assert.equal(overlap.pending!.id, pending.id)
  f.terminal = true
  await f.engine.reconcile({ missionID: "review" })
  assert.equal((await f.read()).calendars[0].highWater, 2)
})

test("35 settled passages retain the total counter and durable old-wake suppression", async () => {
  const f = await fixture(); f.terminal = true
  const first = f.wake()
  await f.engine.wake({ missionID: "review", wake: first })
  for (let run = 2; run <= 35; run++) { f.tick(); await f.engine.wake({ missionID: "review", wake: f.wake(0, run) }) }
  const doc = await f.read()
  assert.equal(doc.launchedCount, 35); assert.equal(doc.history.length, 30); assert.equal(doc.calendars[0].highWater, 35)
  assert.equal(await f.engine.wake({ missionID: "review", wake: first }), "ignored")
})

test("unknown family observation preserves admitted identity, cursors and count", async () => {
  const f = await fixture()
  f.ports.observe = async () => { throw new Error("partial family coverage") }
  assert.equal(await f.engine.wake({ missionID: "review", wake: f.wake() }), "unknown")
  const doc = await f.read()
  assert.ok(doc.pending?.admittedAt); assert.equal(doc.launchedCount, 1); assert.equal(doc.history.length, 0)
  await f.engine.reconcile({ missionID: "review" })
  assert.equal(f.counts(), 1)
})

test("paused manual reservation persists consent without rearming; Pause/Stop revocation is retained", async () => {
  const f = await fixture()
  await f.mutate(doc => { doc.state = "paused" })
  const before = await f.read()
  assert.equal(await f.engine.runNow({ missionID: "review", requestID: "paused_manual", expectedRevision: before.revision }), "pending")
  const admitted = await f.read()
  assert.equal(admitted.state, "paused"); assert.equal(admitted.pending!.manualAllowed, true)
  assert.deepEqual(admitted.calendars, before.calendars); assert.equal(admitted.launchedCount, 1)
  await f.mutate(doc => { doc.pending!.manualAllowed = false; doc.state = "stopped" })
  f.terminal = true
  await f.engine.reconcile({ missionID: "review" })
  assert.equal((await f.read()).state, "stopped")
  await assert.rejects(f.engine.runNow({ missionID: "review", requestID: "after_stop", expectedRevision: (await f.read()).revision }))
})

test("source checkpoints advance only with completed settlement; a failure blocks further admission", async () => {
  for (const outcome of ["completed", "failed", "ended-without-report"] as const) {
    const f = await fixture()
    const checkpoint = { key: "a".repeat(64), kind: "files-changed" as const, placementDigest: "b".repeat(64), value: { hash: "frozen" } }
    f.ports.snapshot = async () => ({ changed: true, checkpoints: [checkpoint], current })
    f.ports.observe = async () => ({ outcome, current })
    await f.engine.runNow({ missionID: "review", requestID: "source_run", expectedRevision: (await f.read()).revision })
    const doc = await f.read()
    assert.deepEqual(doc.checkpoints, outcome === "completed" ? [checkpoint] : [])
    assert.equal(doc.blocked, outcome === "completed" ? null : outcome)
    if (outcome !== "completed") await assert.rejects(f.engine.runNow({ missionID: "review", requestID: "blocked_retry", expectedRevision: doc.revision }))
  }
})

test("auxiliary wakes never create business work and a gapped native inventory cannot reserve", async () => {
  const f = await fixture()
  const before = await f.read(), auxiliary = before.calendars.find(item => item.role === "reconciliation")!
  const wake = { missionID: before.id, generation: 1, scheduleID: auxiliary.scheduleID, sessionID: auxiliary.sessionID,
    run: 1, messageID: `msg_${auxiliary.scheduleID}_1`, dueAt: start + 1000 }
  assert.equal(await f.engine.wake({ missionID: before.id, wake }), "idle")
  assert.equal((await f.read()).launchedCount, 0)
  assert.equal(await f.engine.wake({ missionID: before.id, wake: f.wake(0, 2) }), "unknown")
  assert.equal((await f.read()).pending, null)
})

test("instant manual settlement archives its overlap cutoff before delayed principal hooks can run", async () => {
  const f = await fixture(2)
  const delayed: DocumentPassageWake[] = []
  f.ports.observe = async () => {
    delayed.push(f.wake(0), f.wake(1))
    return { outcome: "completed", current }
  }
  assert.equal(await f.engine.runNow({ missionID: "review", requestID: "instant_manual", expectedRevision: (await f.read()).revision }), "settled")
  for (const wake of delayed) assert.equal(await f.engine.wake({ missionID: "review", wake }), "ignored")
  assert.equal((await f.read()).launchedCount, 1)
  assert.ok((await f.read()).calendars.filter(item => item.role === "principal").every(item => item.highWater === 1))
})

test("Run now before first Play refuses before source I/O and leaves the paused object unchanged", async () => {
  const f = await fixture(), config = (await f.read()).configuration
  const created = await f.store.create("unplayed", config, start, current)
  f.ports.snapshot = async () => { throw new Error("Unexpected source I/O") }
  await assert.rejects(f.engine.runNow({ missionID: created.id, requestID: "too_early", expectedRevision: created.revision }), /first Play/)
  assert.deepEqual(await f.store.read(created.id), created)
})

test("manual replay requires its original expected revision in pending and archive before any native reconciliation", async () => {
  const f = await fixture(), expectedRevision = (await f.read()).revision
  f.crash = true
  const input = { missionID: "review", requestID: "exact_manual", expectedRevision }
  assert.equal(await f.engine.runNow(input), "unknown")
  const pending = await f.read(), writes = f.mutations()
  assert.equal(pending.pending!.manualExpectedRevision, expectedRevision)
  await assert.rejects(f.engine.runNow({ ...input, expectedRevision: expectedRevision + 1 }), /request conflict/)
  assert.deepEqual(await f.read(), pending); assert.equal(f.mutations(), writes); assert.equal(f.counts(), 0)
  await assert.rejects(f.store.change(pending.id, pending.revision, current, doc => { delete doc.pending!.manualExpectedRevision }), /monotone/)
  await assert.rejects(f.store.change(pending.id, pending.revision, current, doc => { doc.pending!.manualExpectedRevision = expectedRevision + 1 }), /monotone/)
  f.terminal = true
  assert.equal(await f.engine.runNow(input), "settled")
  const archived = await f.read(), settledWrites = f.mutations()
  assert.equal(archived.history.at(-1)!.manualExpectedRevision, expectedRevision)
  await assert.rejects(f.engine.runNow({ ...input, expectedRevision: archived.revision }), /request conflict/)
  assert.deepEqual(await f.read(), archived); assert.equal(f.mutations(), settledWrites); assert.equal(f.counts(), 1)
})

test("manual records without a saved revision remain readable but cannot authorize Run now replay", async () => {
  const f = await fixture()
  const doc = await f.mutate(doc => changes.reserve(doc, { kind: "manual", requestID: "legacy_manual" }, start + 1000, []))
  const writes = f.mutations()
  assert.equal(doc.pending!.manualExpectedRevision, undefined)
  await assert.rejects(f.engine.runNow({ missionID: doc.id, requestID: "legacy_manual", expectedRevision: doc.revision }), /identity unknown/)
  assert.deepEqual(await f.read(), doc); assert.equal(f.mutations(), writes); assert.equal(f.counts(), 0)
})

test("durably consumed carrier replays skip pruned native-message reads", async () => {
  const f = await fixture()
  const wake = f.wake()
  await f.mutate(doc => changes.processWake(doc, { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: wake.dueAt! }))
  f.ports.verifyWake = async () => { throw new Error("Pruned carrier message") }
  assert.equal(await f.engine.wake({ missionID: "review", wake }), "ignored")
  assert.equal((await f.read()).launchedCount, 0)
})

test("a published admission attempt cannot be retired as not-started or release its reserved place", async () => {
  const f = await fixture()
  f.ports.admit = async (doc, locked) => {
    await locked.change(doc.id, doc.revision, current, next => { next.pending!.admissionAttempted = true })
    return { kind: "not-started", current }
  }
  assert.equal(await f.engine.runNow({ missionID: "review", requestID: "uncertain_attempt", expectedRevision: (await f.read()).revision }), "unknown")
  const doc = await f.read()
  assert.equal(doc.pending!.admissionAttempted, true); assert.equal(doc.pending!.admittedAt, null)
  assert.equal(doc.launchedCount, 0); assert.equal(doc.history.length, 0)
  await assert.rejects(f.engine.runNow({ missionID: "review", requestID: "second_attempt", expectedRevision: doc.revision }))
})

test("preflight waits read-only for eight ACKs, then wake uses its cutoff despite a later slot", async () => {
  const f = await fixture(8), first = f.wake()
  await f.mutate(doc => changes.prepareWake(doc, { scheduleID: first.scheduleID, run: first.run, messageID: first.messageID, dueAt: first.dueAt! }))
  const before = await f.read(), writes = f.mutations()
  f.complete = false
  const waiting = await f.engine.preflight({ missionID: "review", wake: first })
  assert.deepEqual(waiting, { messagePresent: true, ready: false, cutoff: start + 1000 })
  assert.deepEqual(await f.read(), before); assert.equal(f.mutations(), writes); assert.equal(f.counts(), 0)
  f.tick()
  for (let slot = 1; slot < 8; slot++) f.wake(slot, 1, waiting.cutoff)
  f.complete = true
  const ready = await f.engine.preflight({ missionID: "review", wake: first, cutoff: waiting.cutoff })
  assert.deepEqual(ready, { messagePresent: true, ready: true, cutoff: waiting.cutoff })
  assert.deepEqual(await f.read(), before); assert.equal(f.mutations(), writes)
  f.tick(); f.wake(0, 2, waiting.cutoff + 1000)
  assert.equal(await f.engine.wake({ missionID: "review", wake: first, cutoff: ready.cutoff }), "started")
  const doc = await f.read()
  assert.equal(doc.pending!.dueAt, waiting.cutoff); assert.equal(doc.fanIn!.cutoff, waiting.cutoff)
  assert.equal(doc.pending!.origin.kind, "wake")
  if (doc.pending!.origin.kind === "wake") {
    assert.equal(doc.pending!.origin.wakes.length, 8)
    assert.ok(doc.pending!.origin.wakes.every(wake => wake.run === 1 && wake.dueAt === waiting.cutoff))
  }
  assert.equal(doc.calendars[0].highWater, 2); assert.equal(doc.launchedCount, 1)
})

test("preflight keeps an unfinished cutoff and unknown native proof creates no window or technical progress", async () => {
  const f = await fixture(), wake = f.wake()
  f.complete = false
  await f.engine.wake({ missionID: "review", wake })
  const before = await f.read(), writes = f.mutations(), cutoff = before.fanIn!.cutoff
  f.tick(); f.complete = true
  const result = await f.engine.preflight({ missionID: "review", wake, cutoff: cutoff + 1000 })
  assert.equal(result.cutoff, cutoff); assert.equal(result.ready, true)
  f.ports.verifyWake = async () => { throw new Error("Native flag unknown") }
  assert.deepEqual(await f.engine.preflight({ missionID: "review", wake }), { messagePresent: false, ready: false, cutoff })
  assert.deepEqual(await f.read(), before); assert.equal(f.mutations(), writes)
})

test("auxiliary, overlap and paused preflight need only positive contiguous wake proof and never reserve", async () => {
  const f = await fixture()
  f.ports.coverage = async () => { throw new Error("Unexpected business coverage") }
  const paused = await f.mutate(doc => { doc.state = "paused" }), writes = f.mutations(), wake = f.wake()
  assert.equal((await f.engine.preflight({ missionID: "review", wake })).ready, true)
  assert.deepEqual(await f.read(), paused); assert.equal(f.mutations(), writes)
  const auxiliary = paused.calendars.find(item => item.role === "reconciliation")!
  assert.equal((await f.engine.preflight({ missionID: "review", wake: { ...wake, scheduleID: auxiliary.scheduleID,
    sessionID: auxiliary.sessionID, messageID: `msg_${auxiliary.scheduleID}_1` } })).ready, true)
  await f.mutate(doc => { doc.state = "running" })
  await f.engine.runNow({ missionID: "review", requestID: "overlap_manual", expectedRevision: (await f.read()).revision })
  const pending = await f.read(), pendingWrites = f.mutations()
  assert.equal((await f.engine.preflight({ missionID: "review", wake })).ready, true)
  assert.equal((await f.engine.preflight({ missionID: "review", wake: f.wake(0, 3) })).ready, false)
  assert.deepEqual(await f.read(), pending); assert.equal(f.mutations(), pendingWrites)
})
