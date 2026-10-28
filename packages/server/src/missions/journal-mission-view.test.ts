import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import type { MissionDeleteInput, MissionInputTransport, NativeMissionSession } from "./control-types"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, missionDeletionRecordKey, type MissionStorage, type MissionView } from "./journal"
import { compareEvents, MISSION_MAX_STORED_EVENTS, type MissionCleanup, type MissionEvent, type MissionJsonValue, type MissionMap, type MissionSnapshot } from "./model"
import { SETTLED_CLEANUP_HISTORY } from "./cleanup-projection"
import { controlResumeAdmissionID } from "./receipt-identity"

// Deterministic, so a failing seed replays exactly.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function fixture(seed: number) {
  const random = mulberry32(seed)
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)]
  const values = new Map<string, MissionJsonValue>()
  let failRemovalAfter = Infinity, removals = 0
  let firstPageHook: (() => Promise<void>) | undefined
  // Native KV semantics: binary key order, exclusive cursor, `next` is the last key of a full page.
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort().slice(0, limit)
      const hook = after ? undefined : firstPageHook
      if (hook) { firstPageHook = undefined; await hook() }
      return { entries: keys.map(key => ({ key, value: structuredClone(values.get(key)!) })), next: keys.length === limit ? keys.at(-1) : undefined }
    },
    remove: async key => {
      if (removals >= failRemovalAfter) throw new Error("Process killed")
      removals++
      values.delete(key)
    },
  }
  const native = new Map<string, NativeMissionSession>()
  const failing = new Set<string>()
  let now = 1_000, failNotifications = false
  const transport: MissionInputTransport = {
    prompt: async () => {},
    synthetic: async () => { if (failNotifications) throw new Error("Coordinator unavailable") },
    lifecycle: async (_, input) => {
      const mission = (await control().snapshot()).missions.find(mission => mission.id === input.missionID)!
      if (failing.has(input.sessionID)) throw new Error("Native unavailable")
      const identity = { ...input, action: mission.control!.action }
      return { nativeAcknowledgement: identity.action === "start" ? { ...identity, disposition: "start-admitted", admission: {
        id: controlResumeAdmissionID(input.operationID, input.sessionID), sessionID: input.sessionID, type: "synthetic", delivery: "queue", time: { created: 100 },
        payload: { text: "Continue existing work", metadata: { "codenomad.mission": { version: 1, missionID: input.missionID, operationID: input.operationID, kind: "lifecycle" } } },
      } } : { ...identity, disposition: "interrupt-observed", interrupt: { interrupted: true }, cancellations: [] } }
    },
  }
  const project = { id: "project-1", canonical: "/repo", location: { directory: "/repo" } }
  // Some steps leave the clock still, so events, missions and deletions tie on time.
  const control = () => new MissionControl({ project, storage, transport, now: () => (now += Math.floor(random() * 2)), sessions: {
    get: async ({ sessionID }) => {
      const session = native.get(sessionID)
      if (!session) throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError", sessionID })
      return structuredClone(session)
    },
    create: async input => { const session = { ...input, projectID: project.id }; native.set(input.id, session); return structuredClone(session) },
    list: async () => ({ data: [] }),
    remove: async ({ sessionID }) => { if (failing.has(sessionID)) throw new Error("Native removal unavailable"); native.delete(sessionID) },
    prompt: async () => {}, synthetic: async () => {},
  } })
  const journal = new MissionJournal(storage, project.id, project.canonical, () => now)
  const prefix = `${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}`
  return { random, pick, values, storage, native, failing, control, journal, prefix,
    failRemovalsAfter: (count: number) => { failRemovalAfter = removals + count },
    failNotifications: (fail: boolean) => { failNotifications = fail },
    pauseFirstPage: (hook: () => Promise<void>) => { firstPageHook = hook } }
}

type Fixture = ReturnType<typeof fixture>
const coverage = { types: new Set<string>(), damagedViews: 0, remnants: 0, purged: 0, interrupted: 0, ties: 0 }

/** Every mission range's view, recomposed, is exactly today's project snapshot. */
async function assertEquivalent(f: Fixture, label: string) {
  const snapshot = await f.journal.snapshot(), observed = await f.journal.events()
  const ranges = new Map<string, number>()
  let stray = 0
  for (const key of f.values.keys()) {
    if (!key.startsWith(f.prefix)) continue
    const missionID = /^\/([A-Za-z0-9_-]{3,100})\//.exec(key.slice(f.prefix.length))?.[1]
    if (missionID) ranges.set(missionID, (ranges.get(missionID) ?? 0) + 1)
    else stray++
  }
  // Every range, every listed mission, plus an unknown and an unsafe ID that own nothing.
  const ids = [...new Set([...ranges.keys(), ...snapshot.missions.map(mission => mission.id), "msn_unknown", "../escape"])]
    .sort((left, right) => `${left}/` < `${right}/` ? -1 : 1)
  const views: MissionView[] = []
  let rawDiscarded = 0
  for (const id of ids) {
    const view = await f.journal.missionView(id), events = await f.journal.missionEvents(id)
    assert.equal(view.missionID, id)
    assert.equal(view.projectID, snapshot.projectID, label)
    assert.deepEqual(events.events, view.events, `${label}: ${id} events`)
    if (!ranges.has(id)) assert.deepEqual([view.events, view.discardedEvents, view.mission], [[], 0, undefined], `${label}: ${id} owns no range`)
    if (ranges.get(id) && !view.events.length && !events.discardedEvents) coverage.remnants++
    if (view.controlUnavailable || view.notificationUnavailable || view.cleanupUnavailable || view.discardedEvents) coverage.damagedViews++
    rawDiscarded += events.discardedEvents
    views.push(view)
  }
  // Maps: identical once the project-wide damage is stamped on them.
  const stamp = (mission: MissionMap) => ({ ...mission, ...(snapshot.controlUnavailable ? { controlUnavailable: true } : {}),
    ...(snapshot.notificationUnavailable ? { notificationUnavailable: true } : {}) })
  const live = views.filter(view => view.mission)
  assert.deepEqual(snapshot.missions.map(mission => mission.id).sort(), live.map(view => view.missionID).sort(), `${label}: listed missions`)
  for (const view of live) assert.deepEqual(stamp(view.mission!), snapshot.missions.find(mission => mission.id === view.missionID), `${label}: ${view.missionID}`)
  // Order: newest update first, ties in the order of each group's first event.
  const first = (view: MissionView) => [...view.events].sort(compareEvents)[0]
  const ordered = [...live].sort((left, right) => right.mission!.updatedAt - left.mission!.updatedAt || compareEvents(first(left), first(right)))
  assert.deepEqual(ordered.map(view => view.missionID), snapshot.missions.map(mission => mission.id), `${label}: order`)
  for (let index = 1; index < live.length; index++) if (ordered[index].mission!.updatedAt === ordered[index - 1].mission!.updatedAt) coverage.ties++
  // Project aggregates: per-range values plus damage outside every range.
  assert.deepEqual(views.flatMap(view => view.events), observed.events, `${label}: events in key order`)
  assert.equal(rawDiscarded + stray, observed.discardedEvents, `${label}: raw discarded`)
  assert.equal(views.reduce((sum, view) => sum + view.discardedEvents, 0) + stray, snapshot.discardedEvents, `${label}: discarded`)
  for (const flag of ["controlUnavailable", "notificationUnavailable", "cleanupUnavailable"] as const) {
    assert.equal(Boolean(snapshot[flag]), stray > 0 || views.some(view => view[flag]), `${label}: ${flag}`)
  }
  assert.deepEqual(mergeCleanups(views.flatMap(view => view.cleanups ?? [])), snapshot.cleanups, `${label}: cleanups`)
  for (const event of observed.events) coverage.types.add(event.type)
  return snapshot
}

function mergeCleanups(items: MissionCleanup[]) {
  const ordered = items.sort((a, b) => b.createdAt - a.createdAt || a.deletionID.localeCompare(b.deletionID))
  return [...ordered.filter(item => item.pending > 0), ...ordered.filter(item => item.pending === 0).slice(0, SETTLED_CLEANUP_HISTORY)]
}

async function step(f: Fixture, n: number, snapshot: MissionSnapshot, deletions: MissionDeleteInput[], damage: boolean) {
  const { random, pick } = f
  const mission = pick(snapshot.missions)
  const location = { directory: "/repo" }
  const base = { version: 1 as const, projectID: "project-1", createdAt: 1_000 + n }
  const operation = random()
  f.failNotifications(random() < 0.2)
  if (operation < 0.1 || !mission) {
    await f.control().create({ requestID: `create-${n}`, objective: `Objective ${n}`, template: "custom", prepared: random() < 0.3 })
  } else if (operation < 0.16) {
    const human = `ses_human_${n}`
    f.native.set(human, { id: human, projectID: "project-1", title: "Human", location })
    await f.control().inspect(human, { start: { objective: `Started ${n}`, template: random() < 0.5 ? "wayfinder" : "custom" } }, `start-${n}`)
  } else if (operation < 0.28) {
    const shared = random() < 0.25 ? pick(snapshot.missions.flatMap(other => other.actors.filter(actor => actor.kind === "specialist").map(actor => actor.sessionId))) : undefined
    await f.control().delegate(mission.coordinatorSessionId, { missionID: mission.id, taskKey: `task-${n}`, title: `Task ${n}`, brief: "Bounded",
      role: "specialist", blockedBy: [], delivery: "queue", ...(shared ? { targetSessionID: shared } : {}) })
  } else if (operation < 0.34) {
    await f.control().declare(mission.coordinatorSessionId, { missionID: mission.id, taskKey: `declared-${n}`, title: `Declared ${n}`, brief: "Bounded", role: "research", blockedBy: [] })
  } else if (operation < 0.44) {
    const task = pick(mission.tasks.filter(task => task.actorSessionId))
    if (task) await f.control().report(task.actorSessionId!, { missionID: mission.id, taskKey: task.key, outcome: pick(["completed", "blocked", "failed"] as const)!,
      summary: `Report ${n}`, evidence: [], next: [], final: false })
  } else if (operation < 0.48) {
    await f.control().report(mission.coordinatorSessionId, { missionID: mission.id, outcome: random() < 0.5 ? "completed" : "failed",
      summary: `Done ${n}`, evidence: [], next: [], final: true })
  } else if (operation < 0.54) {
    const retired = pick(mission.tasks.filter(task => task.status === "ready"))
    await f.control().revise(mission.coordinatorSessionId, { missionID: mission.id, expectedRevision: mission.revision, requestID: `revise-${n}`, reason: "Replan",
      retireTasks: retired && random() < 0.5 ? [{ taskKey: retired.key }] : [], dependencyUpdates: [],
      addTasks: [{ taskKey: `revised-${n}`, title: `Revised ${n}`, brief: "Bounded", role: "research", blockedBy: [] }] })
  } else if (operation < 0.59) {
    await f.control().briefing(mission.coordinatorSessionId, { missionID: mission.id, requestID: "auto", summary: `Brief ${n}`, achieved: [], ongoing: [], obstacles: [], next: [] })
  } else if (operation < 0.63) {
    await f.control().update({ missionID: mission.id, requestID: `update-${n}`, expectedRevision: mission.revision, objective: `Updated ${n}` })
  } else if (operation < 0.71) {
    f.failing.clear()
    if (random() < 0.25) f.failing.add(mission.coordinatorSessionId)
    await f.control().lifecycle({ missionID: mission.id, requestID: `control-${n}`, expectedRevision: mission.revision, action: pick(["start", "pause", "stop"] as const)! })
  } else if (operation < 0.79) {
    f.failing.clear()
    for (const actor of mission.actors) if (random() < 0.3) f.failing.add(actor.sessionId)
    const request: MissionDeleteInput = { missionID: mission.id, requestID: `delete-${n}`, expectedRevision: mission.revision,
      ...(random() < 0.6 ? { deleteManagedSessions: true } : {}) }
    deletions.push(request)
    await f.control().delete(request)
  } else if (operation < 0.83) {
    f.failing.clear()
    const request = pick(deletions)
    if (request) await f.control().delete(request)
  } else if (operation < 0.86) {
    await f.control().retryPendingNotifications()
  } else if (operation < 0.88) {
    await f.control().recover({ missionID: mission.id, expectedRevision: mission.revision, target: "coordinator" })
  } else if (operation < 0.95 || !damage) {
    const interrupted = random() < 0.4
    if (interrupted) f.failRemovalsAfter(Math.floor(random() * 6))
    try { coverage.purged += await f.journal.purgeDeleted({ all: random() < 0.6 }) }
    catch { coverage.interrupted++ }
    finally { f.failRemovalsAfter(Infinity) }
  } else {
    // Damage, remnants and ties as earlier builds, crashes or other writers leave them.
    const kind = Math.floor(random() * 6)
    // Extends a live ID, so a range read without its closing slash would overlap that mission.
    const orphan = `${mission.id}_${n}`
    if (kind === 0) f.values.set(`${f.prefix}/${mission.id}/evt_garbage_${n}`, { damaged: true })
    else if (kind === 1) f.values.set(random() < 0.5 ? `${f.prefix}/stray_${n}` : `${f.prefix}/bad!id/evt_${n}`, { damaged: true })
    else if (kind === 2) await f.journal.append({ ...base, id: `evt_orphan_${n}`, missionID: orphan, type: "task.dispatched", taskKey: "orphan" })
    else if (kind === 3) {
      // A remnant whose record is valid leaves the observation; a damaged record keeps it as damage.
      await f.journal.append({ ...base, id: `evt_remnant_${n}`, missionID: orphan, type: "task.dispatched", taskKey: "remnant" })
      f.values.set(missionDeletionRecordKey(f.journal.projectToken, orphan), random() < 0.7 ? { version: 1, projectID: "project-1", missionID: orphan,
        deletionID: "evt_deleted", requestID: "delete", expectedRevision: 1, deleteManagedSessions: false, objective: "Purged", createdAt: 5,
        removed: 0, retained: 0, reasons: [] } : { version: 1 })
    } else if (kind === 4) {
      // Mission A's valid event stored under mission B's key.
      const [event] = (await f.journal.missionEvents(mission.id)).events
      if (event) f.values.set(`${f.prefix}/msn_misplaced_${n}/${event.id}`, structuredClone(event) as unknown as MissionJsonValue)
    } else {
      for (const suffix of ["a", "b"]) await f.journal.append({ ...base, createdAt: 777, id: `evt_tie_${n}${suffix}`, missionID: `msn_tie_${n}${suffix}`,
        type: "mission.created", projectCanonical: "/repo", objective: "Tie", template: "custom", coordinator: { sessionID: `ses_tie_${n}${suffix}`, title: "Tie", location } })
    }
  }
}

test("a mission's range view equals that mission in the project snapshot across random MissionControl histories", async () => {
  for (let seed = 1; seed <= 24; seed++) {
    const f = fixture(seed), deletions: MissionDeleteInput[] = []
    let snapshot = await assertEquivalent(f, `seed ${seed} empty`)
    for (let n = 0; n < 70; n++) {
      // Refusals and injected failures are part of the history: the journal is what is compared.
      await step(f, n, snapshot, deletions, seed % 3 === 0).catch(() => undefined)
      snapshot = await assertEquivalent(f, `seed ${seed} step ${n}`)
    }
  }
  for (const type of ["mission.created", "mission.updated", "mission.reopened", "mission.revised", "mission.briefed", "mission.finished", "mission.deleted",
    "mission.session-cleaned", "mission.control-requested", "mission.control-applied", "task.created", "task.dispatching", "task.dispatched",
    "task.reported", "report.notified"]) assert.ok(coverage.types.has(type), `histories exercised ${type}`)
  for (const [name, count] of Object.entries(coverage)) if (typeof count === "number") assert.ok(count > 0, `histories exercised ${name}`)
})

test("a mission range keeps the journal's read bound", async () => {
  const f = fixture(1)
  const { mission } = await f.control().create({ requestID: "large", objective: "Large", template: "custom" })
  for (let index = 0; index <= MISSION_MAX_STORED_EVENTS; index++) f.values.set(`${f.prefix}/${mission.id}/evt_filler_${index}`, { damaged: true })
  await assert.rejects(f.journal.missionView(mission.id), new RegExp(`${MISSION_MAX_STORED_EVENTS}-event safety limit`))
  await assert.rejects(f.journal.snapshot(), new RegExp(`${MISSION_MAX_STORED_EVENTS}-event safety limit`))
})

test("a mission range read never straddles a purge", async () => {
  const f = fixture(2)
  let mission = (await f.control().create({ requestID: "deleted", objective: "Deleted", template: "custom" })).mission
  for (let index = 0; index < 120; index++) mission = (await f.control().update({ missionID: mission.id, requestID: `update-${index}`,
    expectedRevision: mission.revision, objective: `Deleted ${index}` })).mission
  await f.control().delete({ missionID: mission.id, requestID: "delete", expectedRevision: mission.revision })
  let entered!: () => void, release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve }), resume = new Promise<void>(resolve => { release = resolve })
  f.pauseFirstPage(async () => { entered(); await resume })
  const reading = f.journal.missionView(mission.id)
  await paused
  const purge = f.journal.purgeDeleted({ all: true })
  assert.equal(await Promise.race([purge.then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, 50, false))]), false,
    "the purge waits for the range read already in progress")
  release()
  const view = await reading
  assert.equal(view.discardedEvents, 0)
  assert.equal(view.cleanups?.[0]?.missionID, mission.id, "the read saw the whole tombstoned range")
  assert.equal(await purge, 122)
  assert.deepEqual([(await f.journal.missionView(mission.id)).events, (await f.journal.missionView(mission.id)).cleanups], [[], []])
})
