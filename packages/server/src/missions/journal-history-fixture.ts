import { MissionControl } from "./control"
import type { MissionDeleteInput, MissionInputTransport, NativeMissionSession } from "./control-types"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, missionDeletionRecordKey, stableToken, type MissionStorage } from "./journal"
import { MissionJournalIndex } from "./journal-index"
import type { MissionEvent, MissionJsonValue, MissionSnapshot } from "./model"
import { controlResumeAdmissionID } from "./receipt-identity"

// Random MissionControl histories shared by the journal range and index equivalence tests.

// Deterministic, so a failing seed replays exactly.
export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** `before`: refused before any byte lands; `after`: landed, then reported as failed (an unconfirmed write). */
export type UncertainWrite = "before" | "after"

export function fixture(seed: number) {
  const random = mulberry32(seed)
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)]
  const values = new Map<string, MissionJsonValue>()
  let failRemovalAfter = Infinity, removals = 0, fullScans = 0, tampered = false, unconfirmed = 0
  let failSet: UncertainWrite | undefined, failRemove: UncertainWrite | undefined, failRecordReads = 0
  let firstPageHook: (() => Promise<void>) | undefined
  const project = { id: "project-1", canonical: "/repo", location: { directory: "/repo" } }
  const prefix = `${MISSION_JOURNAL_STORAGE_PREFIX}/${stableToken(`${project.id}\0${project.canonical}`, 24)}`
  const records = `${MISSION_JOURNAL_STORAGE_PREFIX}/deleted/`
  // Native KV semantics: binary key order, exclusive cursor, `next` is the last key of a full page.
  const storage: MissionStorage = {
    get: async key => {
      if (failRecordReads && key.startsWith(records)) { failRecordReads--; throw new Error("Storage unavailable") }
      return structuredClone(values.get(key))
    },
    set: async (key, value) => {
      const mode = failSet
      failSet = undefined
      if (mode === "before") throw new Error("Storage refused the write")
      values.set(key, structuredClone(value))
      if (mode === "after") { unconfirmed++; throw new Error("Write acknowledgement lost") }
    },
    scan: async ({ prefix: scanned, after, limit = 100 }) => {
      if (scanned === prefix) fullScans++
      const keys = [...values.keys()].filter(key => key.startsWith(scanned) && (!after || key > after)).sort().slice(0, limit)
      const hook = after ? undefined : firstPageHook
      if (hook) { firstPageHook = undefined; await hook() }
      return { entries: keys.map(key => ({ key, value: structuredClone(values.get(key)!) })), next: keys.length === limit ? keys.at(-1) : undefined }
    },
    remove: async key => {
      if (removals >= failRemovalAfter) throw new Error("Process killed")
      const mode = failRemove
      failRemove = undefined
      if (mode === "before") throw new Error("Storage refused the removal")
      removals++
      values.delete(key)
      if (mode === "after") { unconfirmed++; throw new Error("Removal acknowledgement lost") }
    },
  }
  let now = 1_000, failNotifications = false
  let index!: MissionJournalIndex, journal!: MissionJournal
  const activate = () => {
    index = new MissionJournalIndex()
    journal = new MissionJournal(storage, project.id, project.canonical, () => now, index)
  }
  activate()
  const native = new Map<string, NativeMissionSession>()
  const failing = new Set<string>()
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
  // Some steps leave the clock still, so events, missions and deletions tie on time.
  // Every MissionControl belongs to the current activation and shares its index.
  const control = (journalIndex: MissionJournalIndex = index) => new MissionControl({ project, storage, transport, journalIndex,
    now: () => (now += Math.floor(random() * 2)), sessions: {
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
  return { random, pick, values, storage, native, failing, control, prefix, project,
    get journal() { return journal },
    get index() { return index },
    /** A new plugin activation: a fresh index over the same storage. */
    activate,
    /** Bytes no journal writes (earlier builds, crashes, other processes). */
    tamper: (key: string, value: MissionJsonValue) => { tampered = true; values.set(key, value) },
    takeTampered: () => { const value = tampered; tampered = false; return value },
    fullScans: () => fullScans,
    /** Writes that landed but reported failure. */
    unconfirmed: () => unconfirmed,
    failRemovalsAfter: (count: number) => { failRemovalAfter = removals + count },
    failNextSet: (mode: UncertainWrite) => { failSet = mode },
    failNextRemove: (mode: UncertainWrite) => { failRemove = mode },
    failRecordReads: (count: number) => { failRecordReads = count },
    failNotifications: (fail: boolean) => { failNotifications = fail },
    pauseFirstPage: (hook: () => Promise<void>) => { firstPageHook = hook } }
}

export type HistoryFixture = ReturnType<typeof fixture>

/** Deterministic cross-mission edges: a session shared by two maps, parseable receipts
 * orphaned in one range, 22 settled deletions plus an older pending one, and maps
 * tied on time and event ID. Every event goes through the journal. */
export async function seedCrossMission(f: HistoryFixture) {
  const location = { directory: "/repo" }
  const seed = (event: MissionEvent) => f.journal.append(event)
  const base = (missionID: string, createdAt: number) => ({ version: 1 as const, projectID: "project-1", missionID, createdAt })
  const created = (missionID: string, createdAt: number, id = "evt_created"): MissionEvent => ({ ...base(missionID, createdAt), id,
    type: "mission.created", projectCanonical: "/repo", objective: `Objective ${missionID}`, template: "custom",
    coordinator: { sessionID: `ses_${missionID}`, title: "Coordinator", location } })
  // A finished mission's specialist joins a second mission: one session, two maps.
  const first = (await f.control().delegate((await f.control().create({ requestID: "first", objective: "First", template: "custom" })).mission.coordinatorSessionId,
    { taskKey: "worker", title: "Worker", brief: "Bounded", role: "specialist", blockedBy: [], delivery: "queue" })).mission
  const shared = first.actors.find(actor => actor.kind === "specialist")!.sessionId
  await f.control().report(first.coordinatorSessionId, { missionID: first.id, outcome: "failed", summary: "Done", evidence: [], next: [], final: true })
  const second = (await f.control().create({ requestID: "second", objective: "Second", template: "custom" })).mission
  await f.control().delegate(second.coordinatorSessionId, { missionID: second.id, taskKey: "reuse", title: "Reuse", brief: "Bounded",
    role: "specialist", blockedBy: [], delivery: "queue", targetSessionID: shared })
  // 22 settled deletion groups plus an older pending one: the project keeps the pending one and the 20 newest settled.
  for (let index = 0; index < 22; index++) {
    const missionID = `msn_gone_${String(index).padStart(2, "0")}`
    await seed(created(missionID, 100 + index))
    await seed({ ...base(missionID, 200 + index), id: "evt_deleted", type: "mission.deleted", requestID: "delete", expectedRevision: 1 })
  }
  await seed(created("msn_pending", 10))
  await seed({ ...base("msn_pending", 11), id: "evt_deleted", type: "mission.deleted", requestID: "delete", expectedRevision: 1,
    deleteManagedSessions: true, cleanupTargets: [{ sessionID: "ses_kept", location }] })
  // Equal times and equal event IDs: binary key order (`-` < `/` < `_`, upper before lower case) breaks the tie,
  // neither mission-ID order nor locale order.
  const tied = ["msn_TieB-1", "msn_TieB", "msn_tiea"]
  for (const missionID of tied) await seed(created(missionID, 50_000, "evt_same"))
  // Equally updated maps order by their first event, against key order.
  const updatedTie = ["msn_order_b", "msn_order_a"]
  await seed(created("msn_order_a", 60_000))
  await seed(created("msn_order_b", 59_000))
  await seed({ ...base("msn_order_b", 60_000), id: "evt_updated", type: "mission.updated", requestID: "update", expectedRevision: 1,
    notesSpecified: false, objective: "Updated" })
  // Parseable receipts without their intent, only in the first mission's range.
  await seed({ ...base(first.id, 900), id: "evt_orphan_control", type: "mission.control-applied", operationID: "evt_missing_operation", sessionID: first.coordinatorSessionId })
  await seed({ ...base(first.id, 901), id: "evt_orphan_notified", type: "report.notified", reportID: "rpt_missing", admissionID: "msg_missing" })
  await seed({ ...base(first.id, 902), id: "evt_orphan_cleaned", type: "mission.session-cleaned", deletionID: "evt_missing_deletion", sessionID: shared, outcome: "removed" })
  return { first, second, shared, tied, updatedTie }
}

/** One random MissionControl operation, purge, or (with `damage`) injected damage,
 * remnants and ties. `uncertain` also fails some writes before or after they land. */
export async function step(f: HistoryFixture, n: number, snapshot: MissionSnapshot, deletions: MissionDeleteInput[], damage: boolean,
  counters: { purged: number; interrupted: number }, uncertain = false) {
  const { random, pick } = f
  const mission = pick(snapshot.missions)
  const location = { directory: "/repo" }
  const base = { version: 1 as const, projectID: "project-1", createdAt: 1_000 + n }
  const operation = random()
  f.failNotifications(random() < 0.2)
  if (uncertain && random() < 0.15) f.failNextSet(random() < 0.5 ? "before" : "after")
  if (uncertain && random() < 0.15) f.failNextRemove(random() < 0.5 ? "before" : "after")
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
    try { counters.purged += await f.journal.purgeDeleted({ all: random() < 0.6 }) }
    catch { counters.interrupted++ }
    finally { f.failRemovalsAfter(Infinity) }
  } else {
    // Damage, remnants and ties as earlier builds, crashes or other writers leave them.
    const kind = Math.floor(random() * 6)
    // Extends a live ID, so a range read without its closing slash would overlap that mission.
    const orphan = `${mission.id}_${n}`
    if (kind === 0) f.tamper(`${f.prefix}/${mission.id}/evt_garbage_${n}`, { damaged: true })
    else if (kind === 1) f.tamper(random() < 0.5 ? `${f.prefix}/stray_${n}` : `${f.prefix}/bad!id/evt_${n}`, { damaged: true })
    else if (kind === 2) await f.journal.append({ ...base, id: `evt_orphan_${n}`, missionID: orphan, type: "task.dispatched", taskKey: "orphan" })
    else if (kind === 3) {
      // A remnant whose record is valid leaves the observation; a damaged record keeps it as damage.
      await f.journal.append({ ...base, id: `evt_remnant_${n}`, missionID: orphan, type: "task.dispatched", taskKey: "remnant" })
      f.tamper(missionDeletionRecordKey(f.journal.projectToken, orphan), random() < 0.7 ? { version: 1, projectID: "project-1", missionID: orphan,
        deletionID: "evt_deleted", requestID: "delete", expectedRevision: 1, deleteManagedSessions: false, objective: "Purged", createdAt: 5,
        removed: 0, retained: 0, reasons: [] } : { version: 1 })
    } else if (kind === 4) {
      // Mission A's valid event stored under mission B's key.
      const [event] = (await f.journal.missionEvents(mission.id)).events
      if (event) f.tamper(`${f.prefix}/msn_misplaced_${n}/${event.id}`, structuredClone(event) as unknown as MissionJsonValue)
    } else {
      for (const suffix of ["a", "b"]) await f.journal.append({ ...base, createdAt: 777, id: `evt_tie_${n}${suffix}`, missionID: `msn_tie_${n}${suffix}`,
        type: "mission.created", projectCanonical: "/repo", objective: "Tie", template: "custom", coordinator: { sessionID: `ses_tie_${n}${suffix}`, title: "Tie", location } })
    }
  }
}
