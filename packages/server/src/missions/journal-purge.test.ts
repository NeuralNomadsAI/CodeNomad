import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl, MissionControlError } from "./control"
import type { MissionDeleteInput, MissionInputTransport, MissionSessionAdapter, NativeMissionSession } from "./control-types"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, stableToken, type MissionStorage } from "./journal"
import { MISSION_MAX_EVENTS, missionLifecycleReserve, type MissionEvent, type MissionJsonValue, type MissionMap } from "./model"
import { cleanupReceiptID } from "./cleanup-projection"
import { controlOperationID, controlReceiptID } from "./receipt-identity"

function fixture(options: { removable?: boolean } = {}) {
  const values = new Map<string, MissionJsonValue>()
  const removed: string[] = []
  let failRemovalAfter = Infinity, failRecord = false, created = 0
  let firstPageHook: (() => Promise<void>) | undefined
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => {
      if (failRecord && key.includes("/deleted/")) throw new Error("Record write interrupted")
      values.set(key, structuredClone(value))
    },
    scan: async ({ prefix, after, limit = 100 }) => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      const page = { entries, next: entries.length === limit ? entries.at(-1)?.key : undefined }
      // A first page already read, held before its caller continues to the next one.
      const hook = after ? undefined : firstPageHook
      if (hook) { firstPageHook = undefined; await hook() }
      return page
    },
    ...(options.removable === false ? {} : { remove: async (key: string) => {
      if (removed.length >= failRemovalAfter) throw new Error("Process killed")
      removed.push(key)
      values.delete(key)
    } }),
  }
  const native = new Map<string, NativeMissionSession>()
  const nativeRemoved: string[] = []
  const failing = new Set<string>()
  let now = 1_000
  const sessions: MissionSessionAdapter = {
    get: async ({ sessionID }) => {
      const session = native.get(sessionID)
      if (!session) throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError", sessionID })
      return structuredClone(session)
    },
    create: async input => {
      created++
      const session = { ...input, projectID: "project-1" }
      native.set(input.id, session)
      return structuredClone(session)
    },
    list: async () => ({ data: [] }),
    remove: async ({ sessionID }) => {
      if (failing.has(sessionID)) throw new Error("Native removal unavailable")
      nativeRemoved.push(sessionID)
      native.delete(sessionID)
    },
    prompt: async () => {},
    synthetic: async () => {},
  }
  const project = { id: "project-1", canonical: "/repo", location: { directory: "/repo" } }
  const control = (extra: { storage?: MissionStorage; transport?: MissionInputTransport } = {}) =>
    new MissionControl({ project, storage: extra.storage ?? storage, sessions, now: () => now++, ...(extra.transport ? { transport: extra.transport } : {}) })
  // The same backing store through an adapter that cannot remove entries.
  const { remove: _remove, ...withoutRemoval } = storage
  const journal = new MissionJournal(storage, project.id, project.canonical)
  const prefix = `${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}`
  const create = async (requestID: string) => (await control().create({ requestID, objective: `Objective ${requestID}`, template: "custom" })).mission
  const delegate = async (mission: MissionMap, taskKey: string, targetSessionID?: string) => (await control().delegate(mission.coordinatorSessionId, {
    missionID: mission.id, taskKey, title: taskKey, brief: "Bounded fixture", role: "specialist", blockedBy: [], delivery: "queue", targetSessionID,
  })).mission
  const deletion = (mission: MissionMap, deleteManagedSessions?: boolean): MissionDeleteInput => ({
    missionID: mission.id, requestID: `delete-${mission.id}`, expectedRevision: mission.revision,
    ...(deleteManagedSessions === undefined ? {} : { deleteManagedSessions }),
  })
  const entries = (missionID?: string) => [...values.keys()].filter(key => key.startsWith(`${prefix}/${missionID ? `${missionID}/` : ""}`))
  const records = () => [...values.keys()].filter(key => key.startsWith(`${MISSION_JOURNAL_STORAGE_PREFIX}/deleted/${journal.projectToken}/`))
  // Raw durable entries, as an earlier build or a long history left them.
  const seed = (event: MissionEvent) => values.set(`${prefix}/${event.missionID}/${event.id}`, structuredClone(event) as unknown as MissionJsonValue)
  // Up to the mission's ordinary capacity: the lifecycle reserve of its actors stays free.
  const fill = (missionID: string, actors: number) => {
    for (let index = 0; entries(missionID).length < MISSION_MAX_EVENTS - missionLifecycleReserve(actors); index++) seed({ version: 1, id: `evt_filler_${index}`, type: "mission.updated",
      missionID, projectID: "project-1", requestID: `filler-${index}`, expectedRevision: 1, notesSpecified: false, objective: "Filler", createdAt: 2_000 + index })
  }
  return { values, storage, withoutRemoval, native, nativeRemoved, failing, removed, control, journal, prefix, create, delegate, deletion, entries, records, seed, fill,
    pauseFirstPage: (hook: () => Promise<void>) => { firstPageHook = hook },
    createdSessions: () => created, failRemovalsAfter: (count: number) => { failRemovalAfter = count },
    failRecord: (fail: boolean) => { failRecord = fail } }
}

const code = (expected: string) => (error: unknown) => error instanceof MissionControlError && error.code === expected
const specialist = (mission: MissionMap) => mission.actors.find(actor => actor.kind === "specialist")!.sessionId

async function assertHealthy(f: ReturnType<typeof fixture>) {
  const snapshot = await f.journal.snapshot()
  assert.equal(snapshot.discardedEvents, 0)
  assert.equal(snapshot.cleanupUnavailable, undefined)
  assert.equal(snapshot.controlUnavailable, undefined)
  assert.equal(snapshot.notificationUnavailable, undefined)
  assert.ok((snapshot.cleanups ?? []).every(item => item.pending === 0 && item.documentPending !== true), "a purge never reopens settled cleanup")
  for (const mission of snapshot.missions) await f.journal.assertCanAppend(mission.id, 0)
  return snapshot
}

test("create/delete cycles free journal storage instead of accumulating tombstones", async () => {
  const f = fixture()
  for (let index = 0; index < 200; index++) {
    const mission = await f.delegate(await f.create(`cycle-${index}`), "worker")
    await f.control().delete(f.deletion(mission, index % 2 === 0))
    assert.ok(f.entries().length <= 21 * 8, `cycle ${index} keeps only the recent cleanup history`)
  }
  const snapshot = await assertHealthy(f)
  assert.deepEqual(snapshot.missions, [])
  assert.equal(snapshot.cleanups?.length, 20, "the newest settled cleanups stay visible")
  assert.equal(f.records().length, 180)
  // An explicit full purge clears the retained history too.
  assert.equal(await f.journal.purgeDeleted({ all: true }) > 0, true)
  assert.deepEqual(f.entries(), [])
  assert.equal(f.records().length, 200)
})

test("a purged mission's record refuses recreation and answers exact deletion replays", async () => {
  const f = fixture()
  const mission = await f.delegate(await f.create("original"), "worker")
  const request = f.deletion(mission, true)
  const first = await f.control().delete(request)
  await f.journal.purgeDeleted({ all: true })
  assert.deepEqual(f.entries(mission.id), [])
  assert.equal(f.records().length, 1)
  const sessions = f.createdSessions()
  await assert.rejects(f.control().create({ requestID: "original", objective: "Objective original", template: "custom" }), code("mission-deleted"))
  await assert.rejects(f.control().create({ requestID: "original", objective: "Changed", template: "custom" }), code("mission-deleted"))
  assert.equal(f.createdSessions(), sessions, "no coordinator is created for a refused recreation")
  assert.deepEqual(f.entries(mission.id), [])
  const replay = await f.control().delete(request)
  assert.equal(replay.deleted, true)
  assert.deepEqual(replay, first, "an exact replay answers the same cleanup summary")
  await assert.rejects(f.control().delete({ ...request, expectedRevision: request.expectedRevision + 1 }), code("request-conflict"))
  await assert.rejects(f.control().delete({ ...request, deleteManagedSessions: false }), code("request-conflict"))
  await assert.rejects(f.control().delete({ ...request, requestID: "another" }), code("mission-not-found"))
  assert.deepEqual(f.nativeRemoved, [specialist(mission)])
})

test("pending cleanup is never purged; it purges once settled", async () => {
  const f = fixture()
  const mission = await f.delegate(await f.create("pending"), "worker")
  const request = f.deletion(mission, true)
  f.failing.add(specialist(mission))
  await assert.rejects(f.control().delete(request), code("cleanup-pending"))
  const before = f.entries(mission.id)
  assert.equal(await f.journal.purgeDeleted({ all: true }), 0)
  assert.deepEqual(f.entries(mission.id), before)
  assert.equal((await f.journal.snapshot()).cleanups?.[0].pending, 1)
  f.failing.clear()
  const settled = await f.control().delete(request)
  assert.equal(settled.cleanup?.removed, 1)
  assert.ok(f.entries(mission.id).length, "the newest settled deletion stays as cleanup history")
  await f.journal.purgeDeleted({ all: true })
  assert.deepEqual(f.entries(mission.id), [])
  assert.deepEqual((await f.control().delete(request)).cleanup?.removed, 1)
})

test("an interrupted purge leaves a valid journal at every step and resumes", async () => {
  // Raw lifecycle and cleanup receipts exercise intent/receipt removal order.
  const seed = async (f: ReturnType<typeof fixture>) => {
    // The deterministic identity a retried creation request "fixture" resolves to.
    const missionID = `msn_${stableToken("project-1\0fixture", 24)}`
    const base = { version: 1 as const, projectID: "project-1", missionID }
    const location = { directory: "/repo" }
    const operation = controlOperationID(base.missionID, "stop")
    const events: MissionEvent[] = [
      { ...base, id: `evt_${stableToken(`${missionID}\0created`, 28)}`, type: "mission.created", projectCanonical: "/repo", objective: "Fixture", template: "custom",
        requestID: "fixture", coordinator: { sessionID: "ses_coordinator", title: "Coordinator", location }, createdAt: 10 },
      { ...base, id: operation, type: "mission.control-requested", requestID: "stop", expectedRevision: 1, action: "stop",
        targets: [{ sessionID: "ses_coordinator", location }], createdAt: 11 },
      { ...base, id: controlReceiptID(operation, "ses_coordinator"), type: "mission.control-applied", operationID: operation,
        sessionID: "ses_coordinator", createdAt: 12 },
      { ...base, id: "evt_deleted", type: "mission.deleted", requestID: "delete", expectedRevision: 3, deleteManagedSessions: true,
        cleanupTargets: [{ sessionID: "ses_worker", location }], createdAt: 13 },
      { ...base, id: cleanupReceiptID("evt_deleted", "ses_worker"), type: "mission.session-cleaned", deletionID: "evt_deleted",
        sessionID: "ses_worker", outcome: "retained", reason: "children", createdAt: 14 },
    ]
    for (const event of events) await f.journal.append(event)
    return { missionID: base.missionID, count: events.length }
  }
  const total = (await seed(fixture())).count
  for (let crash = -1; crash < total; crash++) {
    const f = fixture()
    const live = await f.create("live")
    const { missionID } = await seed(f)
    const capacity = f.entries().length
    if (crash < 0) f.failRecord(true)
    else f.failRemovalsAfter(crash)
    await assert.rejects(f.journal.purgeDeleted({ all: true }), /interrupted|killed/)
    assert.equal(f.records().length, crash < 0 ? 0 : 1, "the record is written before any removal")
    assert.equal(f.entries(missionID).length, crash < 0 ? total : total - crash)
    const snapshot = await assertHealthy(f)
    assert.deepEqual(snapshot.missions.map(mission => mission.id), [live.id], `crash ${crash}`)
    await assert.rejects(f.control().create({ requestID: "fixture", objective: "Fixture", template: "custom" }), code("mission-deleted"), `crash ${crash}`)
    f.failRecord(false); f.failRemovalsAfter(Infinity)
    await f.journal.purgeDeleted({ all: true })
    assert.deepEqual(f.entries(missionID), [], `crash ${crash} resumes`)
    assert.equal(f.entries().length, capacity - total)
    await assertHealthy(f)
    await assert.rejects(f.control().create({ requestID: "fixture", objective: "Fixture", template: "custom" }), code("mission-deleted"))
  }
})

test("a late write to a purged mission is absorbed and removed by the next purge", async () => {
  const f = fixture()
  const mission = await f.create("late")
  await f.control().delete(f.deletion(mission))
  await f.journal.purgeDeleted({ all: true })
  await f.journal.append({ version: 1, id: "evt_late", type: "task.dispatched", missionID: mission.id, projectID: "project-1", taskKey: "late", createdAt: 5_000 })
  assert.equal(f.entries(mission.id).length, 1)
  await assertHealthy(f)
  await f.journal.purgeDeleted()
  assert.deepEqual(f.entries(mission.id), [])
})

test("tombstones written without removal support are purged by the next deletion with it", async () => {
  const kept = fixture({ removable: false })
  for (let index = 0; index < 30; index++) await kept.control().delete(kept.deletion(await kept.create(`kept-${index}`)))
  assert.equal(kept.entries().length, 60, "no purge without native removal")
  assert.equal(await kept.journal.purgeDeleted({ all: true }), 0)
  // The same storage with removal: an ordinary deletion purges beyond the recent history.
  const f = fixture()
  for (const [key, value] of kept.values) f.values.set(key, value)
  await f.control().delete(f.deletion(await f.create("next")))
  assert.equal(f.entries().length, 2 * 20)
})

for (const removable of [true, false]) {
  test(`a full mission still deletes through its own reserve; the rest of the project stays writable (removal ${removable})`, async () => {
    const f = fixture({ removable })
    const crowded = await f.delegate(await f.create("crowded"), "worker")
    const other = await f.create("other")
    f.fill(crowded.id, crowded.actors.length)
    const current = (await f.control().snapshot()).missions.find(mission => mission.id === crowded.id)!
    await assert.rejects(f.control().update({ missionID: crowded.id, requestID: "refused", expectedRevision: current.revision, objective: "Refused" }),
      /2000-event safety limit of this mission/)
    // No project cap: new missions and other missions' events still land.
    const next = await f.create("beside-full")
    await f.control().update({ missionID: other.id, requestID: "other-update", expectedRevision: other.revision, objective: "Other" })
    await f.control().delete(f.deletion(current, true))
    const own = f.entries(crowded.id).length
    assert.ok(own > MISSION_MAX_EVENTS - missionLifecycleReserve(crowded.actors.length) && own <= MISSION_MAX_EVENTS, `${own}`)
    assert.deepEqual(f.nativeRemoved, [specialist(crowded)])
    // The settled deletion stays as recent cleanup history: purging is retention, never room-making.
    assert.equal(f.records().length, 0)
    assert.deepEqual((await assertHealthy(f)).missions.map(mission => mission.id).sort(), [other.id, next.id].sort())
  })
}

test("a deleted mission sharing a session another mission can still clean up keeps its membership evidence", async () => {
  for (const membership of ["coordinator", "specialist"] as const) {
    const f = fixture()
    const original = await f.delegate(await f.create("original"), "worker")
    const id = specialist(original)
    await f.control().report(original.coordinatorSessionId, { missionID: original.id, outcome: "failed", summary: "Done", evidence: [], next: [], final: true })
    const other = membership === "coordinator"
      ? (await f.control().create({ requestID: "other", objective: "Other", template: "custom", coordinatorSessionID: id })).mission
      : await f.delegate(await f.create("other"), "reuse-worker", id)
    await f.control().delete(f.deletion(other))
    await f.journal.purgeDeleted({ all: true })
    assert.ok(f.entries(other.id).length, `${membership}: evidence stays while the original can clean up ${id}`)
    const current = (await f.control().snapshot()).missions.find(mission => mission.id === original.id)!
    const result = await f.control().delete(f.deletion(current, true))
    assert.deepEqual(result.cleanup?.reasons, ["shared"])
    assert.ok(f.native.has(id))
    await f.journal.purgeDeleted({ all: true })
    assert.deepEqual(f.entries(), [], `${membership}: both purge once no cleanup can follow`)
  }
})

test("damaged journals are never purged", async () => {
  const f = fixture()
  const mission = await f.create("damaged")
  await f.control().delete(f.deletion(mission))
  f.values.set(`${f.prefix}/msn_bad/evt_bad`, { damaged: true })
  assert.equal(await f.journal.purgeDeleted({ all: true }), 0)
  assert.equal(f.entries(mission.id).length, 2)
  // A record that is not a valid deletion record never proves a purge.
  f.values.delete(`${f.prefix}/msn_bad/evt_bad`)
  f.values.set(`${MISSION_JOURNAL_STORAGE_PREFIX}/deleted/${f.journal.projectToken}/msn_orphan`, { version: 1 })
  await f.journal.append({ version: 1, id: "evt_orphan", type: "task.dispatched", missionID: "msn_orphan", projectID: "project-1", taskKey: "x", createdAt: 9 })
  assert.equal((await f.journal.snapshot()).discardedEvents, 1)
  await assert.rejects(f.control().create({ requestID: "irrelevant", objective: "x", template: "custom" }), code("invalid-journal"))
})

test("an observation never straddles a purge across a scan page boundary", async () => {
  const f = fixture()
  // Real MissionControl identities: the creation event lands on the first scan page, the tombstone past it.
  let requestID = "", missionID = ""
  for (let index = 0; ; index++) {
    requestID = `race-${index}`; missionID = `msn_${stableToken(`project-1\0${requestID}`, 24)}`
    if (stableToken(`${missionID}\0created`, 28) < "8") break
  }
  let mission = (await f.control().create({ requestID, objective: "Deleted mission", template: "custom" })).mission
  for (let index = 0; index < 100; index++) mission = (await f.control().update({ missionID, requestID: `update-${index}`,
    expectedRevision: mission.revision, objective: `Deleted mission ${index}` })).mission
  let deleteRequestID = ""
  for (let index = 0; ; index++) {
    deleteRequestID = `delete-${index}`
    if (stableToken(`${missionID}\0deleted-${deleteRequestID}`, 28).startsWith("fff")) break
  }
  await f.control().delete({ missionID, requestID: deleteRequestID, expectedRevision: mission.revision })
  const firstPage = (await f.storage.scan({ prefix: f.prefix, limit: 100 })).entries.map(entry => (entry.value as { type?: string }).type)
  assert.ok(firstPage.includes("mission.created") && !firstPage.includes("mission.deleted"))
  let entered!: () => void, release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve }), resume = new Promise<void>(resolve => { release = resolve })
  f.pauseFirstPage(async () => { entered(); await resume })
  const reading = f.journal.snapshot()
  await paused
  const purge = f.journal.purgeDeleted({ all: true })
  const finished = await Promise.race([purge.then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, 50, false))])
  assert.equal(finished, false, "the purge waits for the observation already reading")
  release()
  const snapshot = await reading
  assert.deepEqual(snapshot.missions, [], "the deleted mission never reads as active")
  assert.equal(snapshot.discardedEvents, 0)
  assert.equal(await purge, 102)
  assert.deepEqual((await f.journal.snapshot()).missions, [])
})

test("deletion records refuse recreation and answer replays through storage without removal", async () => {
  const f = fixture()
  const handoffs: string[] = []
  const transport: MissionInputTransport = { prompt: async () => {}, synthetic: async () => {},
    prepare: async (coordinatorID, input) => {
      handoffs.push(input.requestID)
      return f.control().create({ requestID: input.requestID, objective: input.objective, template: input.template, prepared: true,
        preparedBy: { missionID: input.missionID, coordinatorSessionID: coordinatorID } })
    } }
  const source = await f.create("source")
  const handoff = { requestID: "handoff", objective: "Hand-off", template: "custom" as const }
  const prepared = (await f.control({ transport }).prepare(source.coordinatorSessionId, handoff)).mission
  f.native.set("ses_starter", { id: "ses_starter", projectID: "project-1", title: "Starter", location: { directory: "/repo" } } as NativeMissionSession)
  const start = { start: { objective: "Started", template: "custom" as const } }
  const started = (await f.control().inspect("ses_starter", start, "call-start")).mission!
  const original = await f.create("original")
  const deletions = [prepared, started, original].map(mission => f.deletion(mission))
  for (const deletion of deletions) await f.control().delete(deletion)
  await f.journal.purgeDeleted({ all: true })
  assert.equal(f.records().length, 3)
  assert.deepEqual(f.entries().filter(key => !key.includes(source.id)), [])
  const reduced = (extra: { transport?: MissionInputTransport } = {}) => f.control({ storage: f.withoutRemoval, ...extra })
  const sessions = f.createdSessions()
  await assert.rejects(reduced().create({ requestID: "original", objective: "Recreated", template: "custom" }), code("mission-deleted"))
  await assert.rejects(reduced().inspect("ses_starter", start, "call-start"), code("mission-deleted"))
  await assert.rejects(reduced({ transport }).prepare(source.coordinatorSessionId, handoff), code("mission-deleted"))
  assert.deepEqual(handoffs.length, 1, "a refused hand-off never reaches the backend")
  assert.equal(f.createdSessions(), sessions, "no coordinator is created for a refused recreation")
  for (const deletion of deletions) {
    assert.deepEqual(await reduced().delete(deletion), { deleted: true })
    await assert.rejects(reduced().delete({ ...deletion, requestID: "another" }), code("mission-not-found"))
    await assert.rejects(reduced().delete({ ...deletion, expectedRevision: deletion.expectedRevision + 1 }), code("request-conflict"))
  }
  assert.deepEqual((await reduced().snapshot()).missions.map(mission => mission.id), [source.id])
})
