import assert from "node:assert/strict"
import test from "node:test"
import { canonicalAuthority } from "./authority-protocol"
import { missionConfigurationSchema, missionLaunchPolicySchema, MISSION_MIN_INTERVAL_MS, type MissionConfiguration } from "./launch-policy"
import { missionDocumentChanges as changes } from "./mission-document-state"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "./mission-document-store"
import { MISSION_DOCUMENT_PREFIX, missionSourceKey, missionTombstoneRegistrySchema, parseMissionDocument, projectMissionDocument,
  type MissionCalendar, type MissionDocument, type MissionSourceCheckpoint, type MissionWake } from "./mission-document"
import type { MissionJsonValue } from "./model"

const now = Date.parse("2026-10-01T00:00:00Z"), current = () => true as const
const selection = { agent: "worker", model: { providerID: "provider", id: "model" } }
function configuration(recurring = false): MissionConfiguration {
  return { title: "Review", objective: "Review selected sources", template: "custom", taskMode: "native",
    profileID: "profile", executionHost: "host", roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [],
    profiles: { coordinator: selection, roles: { specialist: selection } },
    launch: { timing: recurring ? { kind: "every", intervalMs: 90 * 60_000 } : { kind: "immediate" },
      condition: null, ends: { maxLaunches: null, at: null, afterMs: null } } }
}
function fixture() {
  const values = new Map<string, MissionJsonValue>(), keys: string[] = []
  const storage: MissionDocumentStorage = {
    get: async key => { keys.push(key); return structuredClone(values.get(key)) },
    compareAndSet: async (key, value, expected, guard) => {
      guard()
      const existing = values.get(key) as { revision: number } | undefined
      if ((existing?.revision ?? null) !== expected) throw new Error("CAS conflict")
      values.set(key, structuredClone(value))
    },
  }
  const store = new NativeMissionDocumentStore(storage, "project", "/project")
  const key = `${MISSION_DOCUMENT_PREFIX}/project/${store.projectToken}/missions/review`
  const mutate = async (operation: (doc: MissionDocument) => void) => {
    const doc = await store.read("review")
    assert.ok(doc && !("deletedAt" in doc))
    return store.change(doc.id, doc.revision, current, operation)
  }
  return { values, keys, storage, store, key, mutate }
}
function calendars(doc: MissionDocument, suffix = "original"): MissionCalendar[] {
  const count = doc.configuration.launch.timing.kind === "multi" ? doc.configuration.launch.timing.calendars.length : 1
  return [...Array.from({ length: count }, (_, slot): MissionCalendar => ({ role: "principal", slot, scheduleID: `sch_${suffix}_${slot}`,
    sessionID: `ses_${suffix}_${slot}`, timeGeneration: doc.timeGeneration, highWater: 0, pendingWake: null, wakePreparing: null })),
  { role: "reconciliation", slot: 0, scheduleID: `sch_${suffix}_aux`, sessionID: `ses_${suffix}_aux`,
    timeGeneration: doc.timeGeneration, highWater: 0, pendingWake: null, wakePreparing: null }]
}
function wake(doc: MissionDocument, slot = 0, dueAt = now): MissionWake {
  const calendar = doc.calendars.find(item => item.role === "principal" && item.slot === slot)!
  return { scheduleID: calendar.scheduleID, run: calendar.highWater + 1, messageID: `msg_${calendar.scheduleID}_${calendar.highWater + 1}`, dueAt }
}
async function armed(f: ReturnType<typeof fixture>, config = configuration(true)) {
  await f.store.create("review", config, now, current)
  await f.mutate(doc => changes.play(doc, "first_play", now + 1000, []))
  return f.mutate(doc => changes.synchronized(doc, "first_play", calendars(doc)))
}

test("source revalidation runs after the target read and before CAS, under exclusion, and failure publishes nothing", async () => {
  const f = fixture(), doc = await f.store.create("review", configuration(), now, current)
  const get = f.storage.get, cas = f.storage.compareAndSet
  let source = "before", publications = 0
  f.storage.get = async key => { const result = await get(key); source = "changed during target read"; return result }
  f.storage.compareAndSet = async (...args) => { publications++; return cas(...args) }
  await f.store.withExclusion(async locked => {
    await assert.rejects(locked.change(doc.id, doc.revision, current, next => { next.configuration.title = "Updated" }, async () => {
      locked.assertActive()
      await Promise.resolve()
      assert.equal(source, "changed during target read")
      throw new Error("source changed")
    }), /source changed/)
  })
  assert.equal(publications, 0)
  assert.equal((await f.store.read(doc.id))!.revision, doc.revision)
})

test("editing or re-adding a source preserves its consumed checkpoint; only genuinely new sources receive a baseline", async () => {
  const f = fixture(), config = configuration(true), condition = { kind: "files-changed" as const, paths: ["included"] }
  config.launch.condition = condition
  await f.store.create("review", config, now, current)
  const checkpoint = { key: missionSourceKey(condition), kind: condition.kind, placementDigest: "a".repeat(64), value: { digest: "consumed" } }
  await f.mutate(doc => { changes.play(doc, "play_source", now, [checkpoint]); changes.synchronized(doc, "play_source", calendars(doc)) })
  const removed = configuration(true)
  await f.mutate(doc => changes.configure(doc, removed, now + 1000, []))
  await f.mutate(doc => changes.configure(doc, config, now + 2000, [{ ...checkpoint, value: { digest: "new unconsumed" } }]))
  assert.deepEqual((await f.store.read("review") as MissionDocument).checkpoints, [checkpoint])
})

test("strict launch policy accepts six timings, five single conditions and combined ends", () => {
  const base = configuration().launch
  const timings = [{ kind: "immediate" }, { kind: "at", at: now, zone: "Europe/Paris" }, { kind: "in", delayMs: 60_000 },
    { kind: "every", intervalMs: MISSION_MIN_INTERVAL_MS }, { kind: "cron", expression: "15 9 * * 1,3,5", zone: "UTC" },
    { kind: "multi", calendars: [{ expression: "15 9 * * *", zone: "UTC" }, { expression: "45 17 * * *", zone: "UTC" }] }]
  for (const timing of timings) assert.ok(missionLaunchPolicySchema.safeParse({ ...base, timing }).success)
  for (const condition of [{ kind: "schedule-success", missionID: "source" }, { kind: "mission-completed", missionID: "source" },
    { kind: "branch-commits", directory: "/project", ref: "refs/heads/main" }, { kind: "conversation-message", conversationID: "ses_source" },
    { kind: "files-changed", paths: ["src/app.ts"] }]) assert.ok(missionLaunchPolicySchema.safeParse({ ...base, condition }).success)
  assert.ok(missionLaunchPolicySchema.safeParse({ ...base, ends: { maxLaunches: 3, afterMs: 60_000, at: now } }).success)
  for (const timing of [{ kind: "every", intervalMs: 14 * 60_000 }, { kind: "in", delayMs: 0 }, { kind: "in", delayMs: -1 },
    { kind: "cron", expression: "* * * * * *", zone: "UTC" }, { kind: "cron", expression: "not cron", zone: "UTC" },
    { kind: "cron", expression: "0 9 * * *", zone: "Mars/Base" }, { expression: "0 9 * * *", zone: "UTC" }])
    assert.equal(missionLaunchPolicySchema.safeParse({ ...base, timing }).success, false)
  assert.equal(missionLaunchPolicySchema.safeParse({ ...base, condition: [{ kind: "files-changed", paths: ["foo"] }] }).success, false)
  for (const path of ["../secret", "/root", "a/../b", "a\\b", "C:/root", "a//b"])
    assert.equal(missionLaunchPolicySchema.safeParse({ ...base, condition: { kind: "files-changed", paths: [path] } }).success, false)
})

test("multi calendars normalize duplicate entries, preserve arbitrary pairs and refuse a ninth", () => {
  const config = configuration(true), a = { expression: "15 9 * * *", zone: "UTC" }, b = { expression: "45 17 * * *", zone: "UTC" }
  const parsed = missionLaunchPolicySchema.parse({ ...config.launch, timing: { kind: "multi", calendars: [b, a, a] } })
  assert.equal(parsed.timing.kind, "multi")
  if (parsed.timing.kind === "multi") assert.deepEqual(parsed.timing.calendars, [a, b])
  assert.equal(missionLaunchPolicySchema.safeParse({ ...config.launch, timing: { kind: "multi", calendars: Array(9).fill(a) } }).success, false)
  assert.equal(missionConfigurationSchema.safeParse({ ...config, profiles: {} }).success, false)
})

test("creation stays paused; relative dates/fins start at first Play and never read other namespaces", async () => {
  const f = fixture(), config = configuration()
  config.launch.timing = { kind: "in", delayMs: 60_000 }
  config.launch.ends = { maxLaunches: 2, afterMs: 180_000, at: now + 1_000_000 }
  const created = await f.store.create("review", config, now, current)
  assert.equal(created.state, "paused")
  assert.equal(created.firstPlayedAt, null)
  assert.deepEqual(created.calendars, [])
  assert.equal(created.pending, null)
  const played = await f.mutate(doc => changes.play(doc, "first_play", now + 120_000, []))
  assert.equal(played.oneShotAt, now + 180_000)
  assert.equal(played.slotEndsAt, now + 300_000)
  assert.equal(projectMissionDocument(played).remaining, 1)
  assert.ok(f.keys.every(key => key.startsWith(MISSION_DOCUMENT_PREFIX)))
  await assert.rejects(f.mutate(doc => changes.play(doc, "again_play", now + 500_000, [])))
  const past = configuration(); past.launch.timing = { kind: "at", at: now, zone: "UTC" }
  await f.store.create("past_mission", past, now, current)
  await assert.rejects(f.store.change("past_mission", 0, current, doc => changes.play(doc, "first_play", now + 1000, [])), /date has passed/)
})

test("CAS across instances, synchronous guards, corrupt reads and missing CAS all fail closed", async () => {
  const f = fixture()
  await f.store.create("review", configuration(), now, current)
  const other = new NativeMissionDocumentStore(f.storage, "project", "/project")
  const results = await Promise.allSettled([f.store.change("review", 0, current, doc => { doc.everCreatedTask = true }),
    other.change("review", 0, current, doc => { doc.everCreatedTask = true })])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  const before = canonicalAuthority(f.values.get(f.key))
  await assert.rejects(f.mutate(doc => { doc.everCreatedTask = false }), /monotone/)
  assert.equal(canonicalAuthority(f.values.get(f.key)), before)
  await assert.rejects(f.store.change("review", 1, () => { throw new Error("owner changed") }, doc => { doc.blocked = "unknown" }), /policy-unqualified/)
  await assert.rejects(f.mutate(async () => {}), /synchronous/)
  const noCAS = new NativeMissionDocumentStore({ get: f.storage.get } as MissionDocumentStorage, "project", "/project")
  await assert.rejects(noCAS.create("no_cas", configuration(), now, current), /compareAndSet/)
  f.values.set(f.key, { malformed: true })
  await assert.rejects(f.store.read("review"))
})

test("reserved identity holds one budget place; exact admission readback increments once across manual and native wakes", async () => {
  const f = fixture(), config = configuration(true)
  config.launch.ends.maxLaunches = 3
  let doc = await armed(f, config)
  const first = wake(doc)
  await f.mutate(value => changes.prepareWake(value, first))
  doc = await f.mutate(value => changes.reserve(value, { kind: "wake", wakes: [first] }, now + 2000, []))
  const identity = structuredClone(doc.pending!)
  assert.equal(doc.launchedCount, 0)
  assert.equal(projectMissionDocument(doc).reserved, true)
  await assert.rejects(f.mutate(value => changes.reserve(value, { kind: "manual", requestID: "manual_run" }, now + 3000, [])), /pending/)
  doc = await f.mutate(value => changes.admitted(value, identity.id, now + 3000))
  doc = await f.mutate(value => changes.admitted(value, identity.id, now + 4000))
  assert.equal(doc.launchedCount, 1)
  assert.equal(doc.pending!.messageID, identity.messageID)
  await f.mutate(value => changes.settle(value, identity.id, "completed", now + 4000))
  for (const requestID of ["manual_two", "manual_three"]) {
    doc = await f.mutate(value => changes.reserve(value, { kind: "manual", requestID }, now + 5000, []))
    await f.mutate(value => changes.admitted(value, doc.pending!.id, now + 5000))
    doc = await f.mutate(value => changes.settle(value, doc.pending!.id, "completed", now + 5000))
  }
  assert.equal(doc.launchedCount, 3)
  assert.equal(doc.state, "finished")
  assert.equal(projectMissionDocument(doc).remaining, 0)
  await assert.rejects(f.mutate(value => changes.reserve(value, { kind: "manual", requestID: "fourth_run" }, now + 6000, [])))
})

test("high-water and everCreatedTask survive 35 archives; old/gapped/misidentified wakes stay rejected", async () => {
  const f = fixture()
  let doc = await armed(f), original = wake(doc)
  for (let run = 1; run <= 35; run++) {
    const next = wake(doc, 0, now + run * 5000)
    await f.mutate(value => changes.prepareWake(value, next))
    doc = await f.mutate(value => changes.reserve(value, { kind: "wake", wakes: [next] }, now + run * 5000, []))
    doc = await f.mutate(value => changes.admitted(value, doc.pending!.id, now + run * 5000))
    if (run === 1) await f.mutate(value => changes.taskCreated(value, doc.pending!.missionID))
    doc = await f.mutate(value => changes.settle(value, doc.pending!.id, "completed", now + run * 5000))
  }
  assert.equal(doc.history.length, 30)
  assert.equal(doc.launchedCount, 35)
  assert.equal(doc.calendars[0].highWater, 35)
  assert.equal(doc.everCreatedTask, true)
  assert.equal(projectMissionDocument(doc).edit.template, false)
  await assert.rejects(f.mutate(value => changes.prepareWake(value, original)), /stale or gapped/)
  const future = wake(doc); future.run++; future.messageID = `msg_${future.scheduleID}_${future.run}`
  await assert.rejects(f.mutate(value => changes.prepareWake(value, future)), /stale or gapped/)
  await assert.rejects(f.mutate(value => changes.prepareWake(value, { ...wake(doc), messageID: "msg_fake" })))
  assert.equal(parseMissionDocument(doc, doc).launchedCount, 35)
})

test("configuration generation preserves phase, consumed count and end; temporal replacement fences old IDs", async () => {
  const f = fixture(), config = configuration(true)
  config.launch.ends = { maxLaunches: 3, afterMs: 900_000, at: null }
  let doc = await armed(f, config)
  const mappings = structuredClone(doc.calendars), timeGeneration = doc.timeGeneration, end = doc.slotEndsAt
  for (const requestID of ["first_run", "second_run"]) {
    doc = await f.mutate(value => changes.reserve(value, { kind: "manual", requestID }, now + 2000, []))
    await f.mutate(value => changes.admitted(value, doc.pending!.id, now + 2000))
    doc = await f.mutate(value => changes.settle(value, doc.pending!.id, "completed", now + 2000))
  }
  doc = await f.mutate(value => changes.configure(value, { ...value.configuration, objective: "Future instructions" }, now + 3000))
  assert.equal(doc.configurationGeneration, 2)
  assert.equal(doc.timeGeneration, timeGeneration)
  assert.deepEqual(doc.calendars, mappings)
  assert.equal(doc.launchedCount, 2)
  assert.equal(projectMissionDocument(doc).remaining, 1)
  doc = await f.mutate(value => changes.configure(value, { ...value.configuration,
    launch: { ...value.configuration.launch, timing: { kind: "every", intervalMs: 2 * 60 * 60_000 } } }, now + 4000))
  assert.equal(doc.timeGeneration, timeGeneration + 1)
  assert.equal(doc.slotEndsAt, end)
  assert.equal(doc.firstPlayedAt, now + 1000)
  assert.equal(doc.launchedCount, 2)
  assert.equal(projectMissionDocument(doc).remaining, 1)
  assert.equal(projectMissionDocument(doc).edit.reason, "uncertain")
  const requestID = doc.synchronization!.requestID
  await assert.rejects(f.mutate(value => changes.synchronized(value, requestID, calendars(value))), /identity reused/)
  doc = await f.mutate(value => changes.synchronized(value, requestID, calendars(value, "replacement")))
  await assert.rejects(f.mutate(value => changes.prepareWake(value, { scheduleID: mappings[0].scheduleID,
    run: 1, messageID: `msg_${mappings[0].scheduleID}_1`, dueAt: now })), /stale or gapped/)
})

test("condition baseline required; pending freezes evidence, consumes on success only; failure blocks another admission", async () => {
  const f = fixture(), config = configuration(true), condition = { kind: "files-changed" as const, paths: ["input.txt"] }
  config.launch.condition = condition
  await f.store.create("review", config, now, current)
  await assert.rejects(f.mutate(doc => changes.play(doc, "first_play", now + 1000, [])), /baseline/)
  const initial: MissionSourceCheckpoint = { key: missionSourceKey(condition), kind: condition.kind, placementDigest: "a".repeat(64), value: { hash: "old" } }
  await f.mutate(doc => changes.play(doc, "first_play", now + 1000, [initial]))
  await f.mutate(doc => changes.synchronized(doc, "first_play", calendars(doc)))
  const frozen = { ...initial, value: { hash: "new" } }
  let doc = await f.mutate(value => changes.reserve(value, { kind: "manual", requestID: "first_run" }, now + 2000, [frozen]))
  frozen.value.hash = "later"
  assert.deepEqual(doc.pending!.checkpoints[0].value, { hash: "new" })
  await f.mutate(value => changes.admitted(value, doc.pending!.id, now + 2000))
  doc = await f.mutate(value => changes.settle(value, doc.pending!.id, "completed", now + 3000))
  assert.deepEqual(doc.checkpoints[0].value, { hash: "new" })
  doc = await f.mutate(value => changes.reserve(value, { kind: "manual", requestID: "next_run" }, now + 4000, [frozen]))
  await f.mutate(value => changes.admitted(value, doc.pending!.id, now + 4000))
  doc = await f.mutate(value => changes.settle(value, doc.pending!.id, "failed", now + 5000))
  assert.deepEqual(doc.checkpoints[0].value, { hash: "new" })
  assert.equal(doc.launchedCount, 2)
  await assert.rejects(f.mutate(value => changes.reserve(value, { kind: "manual", requestID: "after_failure" }, now + 6000, [frozen])), /blocked/)
})

test("eligible late slot remains admissible after end; native preparations block editing; auxiliary has its own high-water", async () => {
  const f = fixture(), config = configuration(true)
  config.launch.ends.at = now + 60_000
  let doc = await armed(f, config)
  const next = wake(doc, 0, now + 50_000)
  await f.mutate(value => changes.prepareWake(value, next))
  await assert.rejects(f.mutate(value => changes.configure(value, { ...value.configuration, title: "New title" }, now + 70_000)), /wake unresolved/)
  doc = await f.mutate(value => changes.reserve(value, { kind: "wake", wakes: [next] }, now + 100_000, []))
  assert.equal(doc.pending!.dueAt, now + 50_000)
  assert.equal(doc.calendars.find(item => item.role === "reconciliation")!.highWater, 0)
})

test("deletion retains full document until reconciled; durable bounded tombstones refuse recreation", async () => {
  const f = fixture()
  await armed(f)
  let doc = await f.mutate(value => changes.requestDeletion(value, "delete_request", now + 2000))
  await assert.rejects(f.store.compact(doc.id, doc.revision, now + 3000, current), /reconciliation pending/)
  doc = await f.mutate(value => changes.synchronized(value, doc.synchronization!.requestID, []))
  const tombstone = await f.store.compact(doc.id, doc.revision, now + 4000, current)
  assert.equal(tombstone.requestID, "delete_request")
  assert.deepEqual(await f.store.read("review"), tombstone)
  assert.deepEqual(await f.store.compact(doc.id, doc.revision, now + 5000, current), tombstone)
  await assert.rejects(f.store.create("review", configuration(), now + 5000, current), /exists or deleted/)
  const entries = Array.from({ length: 4096 }, (_, index) => ({ id: `deleted_${index}`, requestID: "delete_request", deletedAt: now }))
  assert.ok(missionTombstoneRegistrySchema.safeParse({ version: 1, revision: 4096, entries }).success)
  assert.equal(missionTombstoneRegistrySchema.safeParse({ version: 1, revision: 4097, entries: [...entries, { id: "extra", requestID: "delete_request", deletedAt: now }] }).success, false)
  const largest = missionTombstoneRegistrySchema.parse({ version: 1, revision: 4096,
    entries: entries.map((entry, index) => ({ ...entry, id: `${index}`.padEnd(100, "x"), requestID: "r".repeat(100),
      deletedAt: Date.parse("9999-12-28T00:00:00Z") })) })
  assert.ok(Buffer.byteLength(canonicalAuthority(largest, 1024 * 1024)) <= 1024 * 1024)
})

test("eight exact calendar occurrences share one pending and budget; ignored checks advance only their own high-water", async () => {
  const f = fixture(), config = configuration(true)
  config.launch.timing = { kind: "multi", calendars: Array.from({ length: 8 }, (_, index) => ({ expression: `${index} 9 * * *`, zone: "UTC" })) }
  let doc = await armed(f, config)
  const wakes = Array.from({ length: 8 }, (_, slot) => wake(doc, slot, now + slot * 1000))
  for (const next of wakes) await f.mutate(value => changes.prepareWake(value, next))
  doc = await f.mutate(value => changes.reserve(value, { kind: "wake", wakes }, now + 10_000, []))
  assert.equal(doc.pending!.dueAt, now + 7000)
  await assert.rejects(f.mutate(value => changes.settle(value, doc.pending!.id, "completed", now + 11_000)), /admission proof/)
  await f.mutate(value => changes.admitted(value, doc.pending!.id, now + 11_000))
  doc = await f.mutate(value => changes.settle(value, doc.pending!.id, "completed", now + 12_000))
  assert.equal(doc.launchedCount, 1)
  assert.equal(doc.calendars.filter(item => item.role === "principal" && item.highWater === 1).length, 8)
  const ignored = wake(doc)
  doc = await f.mutate(value => changes.processWake(value, ignored))
  assert.equal(doc.launchedCount, 1)
  assert.equal(doc.calendars[0].highWater, 2)
  assert.equal(doc.calendars[1].highWater, 1)
})

test("full tombstone registry keeps a stopped full document; uncertain and oversized inputs publish nothing", async () => {
  const f = fixture()
  let doc = await f.store.create("review", configuration(), now, current)
  const bytes = canonicalAuthority(f.values.get(f.key))
  await assert.rejects(f.mutate(value => { value.configuration.objective = "x".repeat(20_001) }))
  assert.equal(canonicalAuthority(f.values.get(f.key)), bytes)
  doc = await f.mutate(value => changes.requestDeletion(value, "delete_request", now + 1000))
  doc = await f.mutate(value => changes.synchronized(value, doc.synchronization!.requestID, []))
  f.values.set(`${MISSION_DOCUMENT_PREFIX}/project/${f.store.projectToken}/tombstones`, { version: 1, revision: 4096,
    entries: Array.from({ length: 4096 }, (_, index) => ({ id: `deleted_${index}`, requestID: "delete_request", deletedAt: now })) })
  await assert.rejects(f.store.compact(doc.id, doc.revision, now + 2000, current))
  const saved = await f.store.read(doc.id)
  assert.ok(saved && !("deletedAt" in saved))
  assert.equal(saved.state, "stopped")
  assert.equal(saved.deletion!.requestID, "delete_request")
})

test("last-budget passage keeps its frozen configuration while objective/notes remain editable", async () => {
  const f = fixture()
  await f.store.create("review", configuration(), now, current)
  await f.mutate(value => changes.play(value, "first_play", now + 1000, []))
  let doc = await f.mutate(value => changes.reserve(value, { kind: "immediate", requestID: "first_play" }, now + 1000, []))
  const frozen = structuredClone(doc.pending!.configuration)
  doc = await f.mutate(value => changes.admitted(value, doc.pending!.id, now + 1000))
  assert.equal(doc.state, "finished")
  assert.equal(projectMissionDocument(doc).edit.reason, "passage")
  doc = await f.mutate(value => changes.configure(value, { ...value.configuration, objective: "Clarification", notes: "User note" }, now + 2000))
  assert.equal(doc.configuration.objective, "Clarification")
  assert.deepEqual(doc.pending!.configuration, frozen)
  await assert.rejects(f.mutate(value => changes.configure(value, { ...value.configuration, title: "Reconfigured" }, now + 2000)), /locked/)
})

test("definitive not-started settlement releases the reserved place without incrementing launchedCount", async () => {
  const f = fixture()
  await armed(f)
  let doc = await f.mutate(value => changes.reserve(value, { kind: "manual", requestID: "manual_run" }, now + 2000, []))
  const passageID = doc.pending!.id
  await assert.rejects(f.mutate(value => changes.settle(value, passageID, "failed", now + 3000)), /admission proof/)
  doc = await f.mutate(value => changes.settle(value, passageID, "failed", now + 3000, true))
  assert.equal(doc.launchedCount, 0)
  assert.equal(projectMissionDocument(doc).reserved, false)
  assert.equal(doc.history[0].reason, "not-started")
  assert.equal(doc.blocked, "failed")
})
