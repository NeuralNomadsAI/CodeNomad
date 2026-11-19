import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { Context, Effect } from "effect"
import { cleanupReceiptID } from "../packages/server/src/missions/cleanup-projection"
import { MissionControl } from "../packages/server/src/missions/control"
import type { NativeMissionSession } from "../packages/server/src/missions/control-types"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, parseMissionEvent, type MissionStorage } from "../packages/server/src/missions/journal"
import { MissionJournalIndex } from "../packages/server/src/missions/journal-index"
import { controlOperationID, controlReceiptID, controlResumeAdmissionID } from "../packages/server/src/missions/receipt-identity"
import type { MissionEvent, MissionMap } from "../packages/server/src/missions/model"
import { isMissionTaskSession } from "../packages/server/src/missions/session-identity"
import { acquireNativeJournalRange } from "../packages/server/src/opencode/missions/native-journal-range"

const project = { id: "bench-project", canonical: "/synthetic", location: { directory: "/synthetic" } }
const missionID = "msn_benchmark", coordinator = "ses_benchmark"
const base = { version: 1 as const, projectID: project.id, missionID }
const activeOps = ["open", "state", "declare", "brief", "body"] as const
type Op = (typeof activeOps)[number] | "resume" | "continue" | "accept" | "accept-restart" | "accept-capacity" | "accept-delete-replay"
const revisionDelta: Partial<Record<Op | "pause", number>> = { declare: 1, brief: 1, pause: 1, resume: 3, continue: 4 }
type Profile = "small" | "heavy" | "no-briefings"
type Fixture = { count: number; profile: Profile; neighbours?: number; longNeighbour?: number }
type Row = { key: string; value: string }
const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = fileURLToPath(import.meta.url)
const size = Buffer.byteLength
const empty = { achieved: [], ongoing: [], obstacles: [], next: [] }
const pauseRequest = "bench-pause"
const stopRequest = "stop-after-restart"
const longCases = [9_980, 9_996, 10_020]
const historicPause = controlOperationID(missionID, "historic-pause")
const historicStart = controlOperationID(missionID, "historic-start")
const namespace = `plugin:${Buffer.from("codenomad.missions", "utf16le").swap16().toString("hex")}:`
const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")

function fingerprint(db: DatabaseSync, source = "SELECT key, value FROM kv") {
  const hash = createHash("sha256")
  let rows = 0
  const sql = `SELECT CAST(key AS BLOB) AS key, CAST(value AS BLOB) AS value FROM (${source}) ORDER BY key`
  for (const { key, value } of db.prepare(sql).iterate() as Iterable<{ key: Uint8Array; value: Uint8Array }>) {
    rows++
    // Frame fields separately and hash stored bytes, not parsed/re-serialized events.
    hash.update(`${key.length}:`).update(key).update(`${value.length}:`).update(value)
  }
  return { rows, sha256: hash.digest("hex") }
}

function startAcknowledgement(operationID: string, sessionID: string, createdAt: number) {
  return { missionID, operationID, sessionID, action: "start" as const, disposition: "start-admitted" as const, admission: {
    id: controlResumeAdmissionID(operationID, sessionID), sessionID, type: "synthetic" as const, delivery: "queue" as const,
    time: { created: createdAt }, payload: { text: "Continue existing work",
      metadata: { "codenomad.mission": { version: 1, missionID, operationID, kind: "lifecycle" } } },
  } }
}

function makeStorage(db: DatabaseSync) {
  const first = db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ?")
  const next = db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?")
  const get = db.prepare("SELECT value FROM kv WHERE key = ?")
  const set = db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?, 1, 1)")
  const remove = db.prepare("DELETE FROM kv WHERE key = ?")
  let c: ReturnType<typeof reset>
  let sample = () => {}
  let loseAck = false
  function reset() {
    return c = { scanPages: 0, projectPages: 0, scanRows: 0, scanValueBytes: 0, scanKeyBytes: 0,
      peakScanPageBytes: 0, gets: 0, getHits: 0, getValueBytes: 0, sets: 0, setValueBytes: 0, removals: 0, nativeEffects: 0,
      sqlQueries: 0, sqlRows: 0, sqlBodyRows: 0, sqlValueBytes: 0, peakSqlValueBytes: 0, neighbourValueBytes: 0 }
  }
  reset()
  const storage: MissionStorage = {
    async scan({ prefix, after, limit = 100 }) {
      // Journal prefixes and event keys are ASCII; the upper bound excludes unrelated keys.
      const lower = namespace + prefix, upper = lower + "\uffff"
      const rows = (after ? next.all(lower, upper, namespace + after, limit) : first.all(lower, upper, limit)) as Row[]
      c.scanPages++; c.scanRows += rows.length
      if (prefix === root) c.projectPages++
      let pageBytes = 0
      const entries = rows.map(({ key, value }) => {
        c.scanKeyBytes += size(key) - size(namespace)
        pageBytes += size(value)
        if (key.startsWith(neighbourPrefix)) c.neighbourValueBytes += size(value)
        return { key: key.slice(namespace.length), value: JSON.parse(value) }
      })
      c.scanValueBytes += pageBytes
      c.peakScanPageBytes = Math.max(c.peakScanPageBytes, pageBytes)
      sample()
      return { entries, ...(entries.length === limit ? { next: entries.at(-1)?.key } : {}) }
    },
    async get(key) {
      c.gets++
      const row = get.get(namespace + key) as Pick<Row, "value"> | undefined
      if (!row) return undefined
      c.getHits++; c.getValueBytes += size(row.value)
      const value = JSON.parse(row.value)
      sample()
      return value
    },
    async set(key, value, current) {
      const bytes = JSON.stringify(value)
      current?.()
      set.run(namespace + key, bytes)
      c.sets++; c.setValueBytes += size(bytes)
      sample()
      if (loseAck) { loseAck = false; throw new Error("Synthetic lost write acknowledgement") }
    },
    async remove(key) { remove.run(namespace + key); c.removals++ },
  }
  const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly import("node:sqlite").SQLInputValue[]) => ({
    withoutTransform: Effect.sync(() => {
      const rows = db.prepare(sql).all(...params)
      let bytes = 0
      for (const row of rows) {
        if (typeof row.value !== "string") continue
        c.sqlBodyRows++
        const length = size(row.value)
        bytes += length
        if (typeof row.key === "string" && row.key.startsWith(neighbourPrefix)) c.neighbourValueBytes += length
      }
      c.sqlQueries++; c.sqlRows += rows.length; c.sqlValueBytes += bytes
      c.peakSqlValueBytes = Math.max(c.peakSqlValueBytes, bytes)
      if (/^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE)\s+(?:main\.)?kv\b/i.test(sql)) {
        c.sets++
        if (typeof params[1] === "string") c.setValueBytes += size(params[1])
      }
      sample()
      return rows
    }),
  }) })
  let pending: Promise<unknown> = Promise.resolve()
  const graph = Context.make(databaseTag, { db: { $client: client, transaction: (
    callback: () => Effect.Effect<unknown>, { behavior }: { behavior: "immediate" | "deferred" },
  ) => Effect.tryPromise({ try: () => {
    const result = pending.then(async () => {
      db.exec(behavior === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN")
      try {
        const value = await Effect.runPromise(Effect.provide(callback(), graph))
        db.exec("COMMIT")
        return value
      } catch (error) { db.exec("ROLLBACK"); throw error }
    })
    pending = result.catch(() => undefined)
    return result
  }, catch: error => error }) } })
  const root = `${MISSION_JOURNAL_STORAGE_PREFIX}/${new MissionJournal(storage, project.id, project.canonical).projectToken}`
  const neighbourPrefix = `${namespace}${root}/msn_neighbour_`
  const acquire = () => Effect.runPromise(Effect.provide(acquireNativeJournalRange(
    { location: { project } } as unknown as Parameters<typeof acquireNativeJournalRange>[0]), graph))
  return { storage, root, acquire, reset, counters: () => c, onSample: (callback: () => void) => { sample = callback },
    loseNextWriteAck: () => { loseAck = true },
    nativeEffect: () => { c.nativeEffects++ } }
}

function seed(file: string, { count, profile, neighbours = 0, longNeighbour }: Fixture) {
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY COLLATE BINARY, value TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL) WITHOUT ROWID; BEGIN")
  const { root } = makeStorage(db)
  const insert = db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)")
  const breakdown: Record<string, { entries: number; valueBytes: number; keyBytes: number; bodyFieldBytes: number }> = {}
  const heavy = profile === "heavy"
  const text = (label: string, n: number) => heavy ? `${label} — Rapport de synthèse 🧪\n`.repeat(n) : label
  const notes = text("Consignes et notes communes", 200)
  const reportSummary = text("Résultat et limites", 200)
  const evidence = heavy ? Array(4).fill(text("Preuve synthétique", 24)) : ["preuve"]
  function put(input: MissionEvent, body: unknown[] = []) {
    const event = parseMissionEvent(input)
    assert(event, `unparseable synthetic event: ${input.id}`)
    const value = JSON.stringify(event)
    const key = `${root}/${event.missionID}/${event.id}`
    insert.run(namespace + key, value)
    if (event.missionID !== missionID) return
    const row = breakdown[event.type] ??= { entries: 0, valueBytes: 0, keyBytes: 0, bodyFieldBytes: 0 }
    row.entries++; row.valueBytes += size(value); row.keyBytes += size(key)
    for (const field of body) row.bodyFieldBytes += size(JSON.stringify(field))
  }
  const created = { ...base, id: "evt_00000", createdAt: 1, type: "mission.created" as const,
    projectCanonical: project.canonical, objective: "Mission synthétique", notes, template: "custom" as const,
    coordinator: { sessionID: coordinator, title: "Coordination", location: project.location } }
  put(created, [created.objective, notes])
  for (let i = 1; i < count; i++) {
    const stamp = { ...base, id: `evt_${String(i).padStart(5, "0")}`, createdAt: i + 1 }
    const key = `work-${Math.floor(i / 8)}`
    if (longCases.includes(count) && i === 4) {
      put({ ...stamp, id: historicPause, type: "mission.control-requested", requestID: "historic-pause", expectedRevision: i,
        action: "pause", graceful: true, targets: [] })
    } else if (longCases.includes(count) && i === 5) {
      put({ ...stamp, id: historicStart, type: "mission.control-requested", requestID: "historic-start", expectedRevision: i,
        action: "start", targets: [{ sessionID: coordinator, location: project.location }] })
    } else if (longCases.includes(count) && i === 6) {
      put({ ...stamp, id: controlReceiptID(historicStart, coordinator), type: "mission.control-applied",
        operationID: historicStart, sessionID: coordinator, nativeAcknowledgement: startAcknowledgement(historicStart, coordinator, i + 1) })
    } else if (longCases.includes(count) && i === count - 1) {
      // Deliberately sorts before the earlier events on disk. Legacy keys name
      // event identity, not its position in the reducer's chronological order.
      put({ ...stamp, id: "evt_000_active", type: "task.created", task: {
        id: "tsk_in_progress", key: "in-progress", title: "Work to preserve", brief: "Still open",
        role: "specialist", executionMode: { kind: "native", parentTaskKey: null }, blockedBy: [],
      } })
    } else if (i % 8 === 1) {
      const brief = text("Consigne pour cette tâche", 200)
      put({ ...stamp, type: "task.created", task: { id: `tsk_${key}`, key, title: key, brief,
        role: "specialist", executionMode: { kind: "native", parentTaskKey: null }, blockedBy: [] } }, [brief])
    } else if (i % 8 === 2) {
      put({ ...stamp, type: "task.reported", report: { id: `rpt_${key}`, taskKey: key, sessionId: coordinator,
        delivery: "coordinator-readout", outcome: "completed", summary: reportSummary, evidence, next: [], createdAt: stamp.createdAt } },
        [reportSummary, evidence])
    } else if (i % 32 === 3 && profile !== "no-briefings") {
      const summary = text("Point d’étape", 12)
      put({ ...stamp, type: "mission.briefed", actorSessionID: coordinator, briefing: { ...empty, summary, id: stamp.id,
        requestID: `auto:${i}`, basedOnRevision: i, basedOnUpdatedAt: i, createdAt: stamp.createdAt } }, [summary])
    } else {
      const objective = text(`Révision ${i}`, i % 8 === 4 ? 150 : 1)
      // Real update writes existing notes even when the edit did not change them.
      put({ ...stamp, type: "mission.updated", requestID: `edit-${i}`, expectedRevision: i, notesSpecified: false, objective, notes },
        [objective, notes])
    }
  }
  for (let i = 0; i < neighbours; i++) {
    const length = i === 0 ? longNeighbour ?? 50 : 50
    const other = { ...created, missionID: `msn_neighbour_${i}`, notes: undefined,
      coordinator: { ...created.coordinator, sessionID: `ses_neighbour_${i}` } }
    put(other)
    for (let j = 1; j < length - 1; j++) {
      put({ ...base, missionID: other.missionID, id: `evt_${j}`, createdAt: j + 1, type: "mission.updated",
        requestID: `neighbor-edit-${j}`, expectedRevision: j, notesSpecified: false,
        objective: length > 50 ? text(`Historique ${j}`, 12) : `Historique ${j}` })
    }
    put({ ...base, missionID: other.missionID, id: "evt_end", createdAt: length, type: "mission.finished", outcome: "failed", summary: "Terminé" })
  }
  db.exec("COMMIT")
  db.close()
  return breakdown
}

async function setup(file: string, count: number) {
  const db = new DatabaseSync(file)
  const s = makeStorage(db)
  const storage = process.env.CODENOMAD_BENCH_LEGACY_SCAN === "1" ? s.storage : { ...s.storage, range: await s.acquire() }
  const journalIndex = new MissionJournalIndex({ now: () => 1 }) // Force expiry only in a separate test.
  const native = new Map<string, NativeMissionSession>([[coordinator,
    { id: coordinator, title: "Coordination", projectID: project.id, location: project.location }]])
  const removed: string[] = []
  const stoppedTargets: string[] = []
  const control = new MissionControl({ project, storage, journalIndex, now: () => count + 100,
    sessions: {
      get: async ({ sessionID }) => {
        const session = native.get(sessionID)
        if (!session) throw Object.assign(new Error("Missing fixture session"), { _tag: "SessionNotFoundError", sessionID })
        return session
      },
      create: async input => {
        assert.ok(!native.has(input.id))
        const session = { ...input, projectID: project.id }
        native.set(input.id, session)
        return session
      },
      list: async ({ parentID }) => ({ data: [...native.values()].filter(session => session.parentID === parentID) }),
      remove: async ({ sessionID }) => {
        assert.notEqual(sessionID, coordinator)
        assert.ok(native.delete(sessionID))
        removed.push(sessionID)
        s.nativeEffect()
      },
      prompt: async () => { throw new Error("No prompt in the benchmark") },
      synthetic: async () => { throw new Error("No synthetic delivery in the benchmark") },
    },
    transport: {
      prompt: async (author, input) => {
        assert.equal(author, coordinator)
        assert.notEqual(input.sessionID, coordinator)
        assert.ok(native.has(input.sessionID))
        s.nativeEffect()
      },
      synthetic: async () => { throw new Error("No synthetic delivery in the benchmark") },
      lifecycle: async (_, input) => {
        s.nativeEffect()
        assert.equal(input.missionID, missionID)
        assert.ok(native.has(input.sessionID))
        if (input.operationID === controlOperationID(missionID, stopRequest)) {
          stoppedTargets.push(input.sessionID)
          return { nativeAcknowledgement: { ...input, action: "stop" as const,
            disposition: "interrupt-observed" as const, interrupt: { interrupted: true }, cancellations: [] } }
        }
        return { nativeAcknowledgement: startAcknowledgement(input.operationID, input.sessionID, count + 100) }
      },
    },
  })
  return { ...s, storage, db, control, native, removed, stoppedTargets }
}

function collect(mission: Pick<MissionMap, "id" | "revision" | "runState" | "tasks"> | undefined) {
  assert.equal(mission?.id, missionID)
  return { revision: mission.revision, state: mission.runState ?? "running", tasks: mission.tasks.length }
}

async function child(file: string, count: number, op: Op | "pause", warm: boolean, profile: Profile) {
  const s = await setup(file, count), { control } = s
  const pause = { missionID, requestID: pauseRequest, expectedRevision: count, action: "pause" as const, graceful: true as const }
  const resume = { missionID, requestID: "bench-resume", expectedRevision: count + 1, action: "start" as const }
  const declare = { missionID, taskKey: "new-work", title: "Continuer", brief: "Déclarer une autre tâche", role: "specialist", blockedBy: [] }
  const display = () => control.mission(missionID).then(({ mission }) => collect(mission))
  const showState = () => control.list({ include: [missionID] }).then(({ missions, discardedEvents }) => ({ ...collect(missions[0]), discardedEvents }))
  const entryCount = () => {
    const prefix = `${namespace}${s.root}/${missionID}/`
    return Number(s.db.prepare("SELECT count(*) AS count FROM kv WHERE key >= ? AND key < ?").get(prefix, prefix + "\uffff")?.count)
  }
  const acceptBrief = { missionID, requestID: `auto:${count + 1}`, basedOnRevision: count + 1,
    summary: "Continue after the previous version", ...empty, ongoing: [{ text: "Work to preserve", taskKeys: ["in-progress", "new-work"] }] }
  const stoppedRevision = count + 10
  const deletion = { missionID, requestID: "delete-after-stop", expectedRevision: stoppedRevision, deleteManagedSessions: true }
  const assertHistory = async (revision: number) => {
    const history = await new MissionJournal(s.storage, project.id, project.canonical).missionEvents(missionID)
    assert.equal(history.discardedEvents, 0)
    assert.equal(history.events.length, revision)
    assert.ok(history.events.some(event => event.id === "evt_00000" && event.type === "mission.created"))
    assert.ok(history.events.some(event => event.type === "task.reported" && event.report.id === "rpt_work-0"))
  }
  const operations = {
    open: display, state: showState, declare: () => control.declare(coordinator, declare).then(({ mission, disposition }) => ({ ...collect(mission), disposition })),
    brief: () => control.briefing(coordinator, { missionID, requestID: `auto:${count}`, basedOnRevision: count, summary: "Bilan mesuré", ...empty })
      .then(({ mission }) => collect(mission)),
    body: () => control.content({ missionID, kind: "mission", field: "notes", offset: 0 }),
    pause: () => control.lifecycle(pause).then(({ mission }) => collect(mission)),
    resume: () => control.lifecycle(resume).then(({ mission }) => collect(mission)),
    accept: async () => {
      assert.equal((await display()).revision, count, "cold open lost the historic revision")
      assert.ok(s.counters().sqlValueBytes > 0, "cold open must use native ordered SQLite reads")
      assert.equal(entryCount(), count)
      const added = await control.declare(coordinator, declare)
      assert.equal(added.disposition, "declared")
      assert.equal(added.mission.revision, count + 1)
      const { mission } = await control.briefing(coordinator, acceptBrief)
      assert.equal(mission.revision, count + 2)
      assert.equal(mission.briefing?.requestID, acceptBrief.requestID)
      assert.equal(s.counters().projectPages, 0, "opening, declaring and briefing must avoid the legacy project body scan")
      assert.ok(s.counters().peakSqlValueBytes <= 1024 * 1024, "a SQL response exceeded 1 MiB of event bodies")
      return collect(mission)
    },
    "accept-restart": async () => {
      const beforeReplay = fingerprint(s.db)
      assert.equal((await display()).revision, count + 2)
      const same = await control.declare(coordinator, declare)
      assert.equal(same.disposition, "existing")
      const { mission } = await control.briefing(coordinator, acceptBrief)
      assert.equal(mission.revision, count + 2)
      assert.equal(mission.coordinatorSessionId, coordinator)
      assert.equal(mission.tasks.find(task => task.key === "in-progress")?.status, "ready")
      assert.ok(mission.reports.some(report => report.id === "rpt_work-0"))
      assert.equal(s.counters().sets, 0)
      assert.equal(s.counters().nativeEffects, 0)
      assert.equal(mission.control?.completedRevision, 7)
      await assert.rejects(control.briefing(coordinator, { ...acceptBrief, requestID: "stale" }), { code: "revision-conflict" })
      assert.deepEqual(fingerprint(s.db), beforeReplay, "exact and stale replays changed existing storage")
      await assertHistory(count + 2)
      assert.equal((await control.declare(coordinator, { ...declare, taskKey: "after-restart" })).mission.revision, count + 3)
      const newBrief = { ...acceptBrief, requestID: `auto:${count + 3}`, basedOnRevision: count + 3,
        summary: "New briefing after restart", ongoing: [{ text: "New work", taskKeys: ["after-restart"] }] }
      const briefed = await control.briefing(coordinator, newBrief)
      assert.equal(briefed.mission.revision, count + 4)
      assert.equal(briefed.mission.briefing?.requestID, newBrief.requestID)
      assert.equal(briefed.mission.briefing?.summary, newBrief.summary)
      const managed = await control.delegate(coordinator, { ...declare, taskKey: "managed-work", delivery: "queue",
        executionMode: { kind: "independent", reason: "lifetime", explanation: "Exercise managed root cleanup" } })
      assert.equal(managed.disposition, "dispatched")
      assert.equal(managed.mission.revision, count + 7)
      const task = managed.mission.tasks.find(task => task.key === "managed-work")
      assert.ok(task?.actorSessionId && isMissionTaskSession(task.actorSessionId, missionID, task.id))
      const target = task.actorSessionId
      assert.equal(managed.mission.actors.find(actor => actor.sessionId === target)?.managed, true)
      const stop = { missionID, requestID: stopRequest, expectedRevision: managed.mission.revision, action: "stop" as const }
      const { mission: stopped } = await control.lifecycle(stop)
      assert.equal(stopped.runState, "stopped")
      assert.deepEqual(stopped.control?.pending, [])
      assert.equal(stopped.revision, stoppedRevision)
      assert.deepEqual([...s.stoppedTargets].sort(), [coordinator, target].sort())
      const operationID = controlOperationID(missionID, stopRequest)
      for (const sessionID of [coordinator, target]) {
        const receipt = stopped.control?.receipts?.find(receipt => receipt.receiptID === controlReceiptID(operationID, sessionID))
        assert.equal(receipt?.nativeAcknowledgement?.disposition, "interrupt-observed")
      }
      const beforeStopReplay = fingerprint(s.db)
      assert.deepEqual((await control.lifecycle(stop)).mission.control, stopped.control)
      assert.deepEqual(fingerprint(s.db), beforeStopReplay)
      assert.equal(s.counters().nativeEffects, 3)
      const first = await control.delete(deletion)
      assert.equal(first.deleted, true)
      assert.equal(first.cleanup?.removed, 1)
      assert.equal(first.cleanup.pending, 0)
      assert.deepEqual(s.removed, [target])
      assert.deepEqual([...s.native.keys()], [coordinator])
      const receiptID = cleanupReceiptID(first.cleanup.deletionID, target)
      const receipt = await new MissionJournal(s.storage, project.id, project.canonical).event(missionID, receiptID)
      assert.ok(receipt?.type === "mission.session-cleaned")
      assert.deepEqual([receipt.deletionID, receipt.sessionID, receipt.outcome], [first.cleanup.deletionID, target, "removed"])
      assert.equal((await control.mission(missionID)).mission, undefined)
      await assertHistory(stoppedRevision + 2)
      return { ...collect(stopped), cleanup: first.cleanup }
    },
    "accept-delete-replay": async () => {
      const before = fingerprint(s.db)
      const result = await control.delete(deletion)
      assert.deepEqual(fingerprint(s.db), before, "cold deletion replay changed storage")
      assert.equal(s.counters().sets + s.counters().removals + s.counters().nativeEffects, 0)
      return result
    },
    "accept-capacity": async () => {
      // The public append preflight reaches storedCapacity without first doing
      // an opening/authority snapshot, which proves the independent write gate.
      await new MissionJournal(s.storage, project.id, project.canonical).assertCanAppend(missionID, 1)
      assert.equal(s.counters().scanRows + s.counters().sqlRows, 0, "capacity preflight reread history")
      return { count: entryCount() }
    },
    continue: async () => {
      const replay = await control.lifecycle(resume)
      assert.equal(s.counters().nativeEffects, 0, "restart replay must not deliver a second native effect")
      assert.equal(s.counters().sets, 0, "restart replay must not write a second control")
      assert.equal(replay.mission.revision, count + 3)
      const declared = await operations.declare()
      assert.equal(declared.disposition, "declared")
      return declared
    },
  }
  if (warm) await (op === "state" ? showState() : display()).catch(error => {
    if (process.env.CODENOMAD_BENCH_COMPARE === "1") throw error
  })
  global.gc?.()
  const initial = process.memoryUsage()
  const rss0 = process.resourceUsage().maxRSS * 1024
  let heap = initial.heapUsed, rss = initial.rss
  const sample = () => { const m = process.memoryUsage(); heap = Math.max(heap, m.heapUsed); rss = Math.max(rss, m.rss) }
  s.reset(); s.onSample(sample)
  const start = performance.now()
  let result: unknown, ok = true
  try {
    result = await operations[op]()
    if (op === "body") {
      const body = result as { content?: { text: string }; refused?: string }
      assert.equal(typeof body.content?.text, "string", body.refused)
      result = { valueBytes: size(body.content!.text) }
    }
  } catch (error) {
    ok = false
    result = { message: (error as Error).message, code: (error as { code?: string }).code }
  }
  const ms = performance.now() - start
  sample()
  const peak = process.resourceUsage().maxRSS * 1024
  const c = s.counters()
  console.log(JSON.stringify({ count, profile, op, warm, ok, result, ms: Number(ms.toFixed(2)), ...c,
    readValueBytes: c.sqlValueBytes + c.scanValueBytes + c.getValueBytes,
    heapBefore: initial.heapUsed, heapSamplePeak: heap, rssBefore: initial.rss, rssSamplePeak: rss,
    processRssHwmBefore: rss0, processRssHwmAfter: peak }))
  s.db.close()
}

function worker(file: string, f: Fixture, op: Op | "pause", warm = false, entry = entrypoint, compare = false) {
  const child = spawnSync(process.execPath, [...process.execArgv, entry,
    "--worker", file, String(f.count), op, String(warm), f.profile], {
    encoding: "utf8", windowsHide: true,
    env: compare ? { ...process.env, CODENOMAD_BENCH_COMPARE: "1" } : process.env,
  })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  return JSON.parse(child.stdout)
}

// Snapshot both sources; use the same harness, dependencies and input DB for each pair.
// Cold/hot refer to the process's journal cache, not the OS filesystem cache.
function compare(repetitions: number) {
  const root = dirname(here), baseline = "d33045daf"
  const scratch = join(root, ".codenomad")
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, "mission-journal-compare-"))
  const exec = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    return result.stdout.trim()
  }
  const digest = (file: string) => {
    const db = new DatabaseSync(file, { readOnly: true })
    try { return fingerprint(db) } finally { db.close() }
  }
  try {
    assert.notEqual(process.env.CODENOMAD_BENCH_LEGACY_SCAN, "1", "--compare requires the native range reader")
    const source = "packages/server/src", manifest = "packages/server/package.json"
    const archive = join(dir, "base.tar"), baselineDir = join(dir, "before"), liveDir = join(dir, "live")
    const commit = exec("git", ["rev-parse", `${baseline}^{commit}`])
    mkdirSync(baselineDir)
    exec("git", ["archive", "-o", archive, commit, source, manifest])
    exec("tar", ["-xf", archive, "-C", baselineDir])
    cpSync(join(root, source), join(liveDir, source), { recursive: true })
    copyFileSync(join(root, manifest), join(liveDir, manifest))
    function harness(at: string) {
      mkdirSync(join(at, "scripts"))
      const file = join(at, "scripts", "benchmark-mission-journal.mts")
      copyFileSync(entrypoint, file)
      return file
    }
    const builds = { before: harness(baselineDir), live: harness(liveDir) }
    const sourceHash = createHash("sha256")
    const sourceFiles = readdirSync(join(liveDir, source), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => relative(liveDir, join(entry.parentPath, entry.name)))
    for (const path of [...sourceFiles, manifest, relative(liveDir, builds.live)].sort()) {
      const contents = readFileSync(join(liveDir, path))
      sourceHash.update(path.replaceAll("\\", "/")).update(`\0${contents.length}:`).update(contents)
    }
    console.log(JSON.stringify({ baseline: commit, liveHEAD: exec("git", ["rev-parse", "HEAD"]),
      liveSourceSHA256: sourceHash.digest("hex"), node: process.version, platform: process.platform, arch: process.arch, repetitions }))
    const cases: Fixture[] = [
      { count: 1500, profile: "heavy" },
      { count: 1500, profile: "heavy", neighbours: 30 },
      { count: 1500, profile: "heavy", neighbours: 31, longNeighbour: 10_020 },
      { count: 10_020, profile: "small" },
    ]
    for (const [caseIndex, fixture] of cases.entries()) {
      const src = join(dir, `seed-${caseIndex}.db`), trial = join(dir, "trial.db"), paused = join(dir, "paused.db")
      const breakdown = seed(src, fixture)
      console.log(JSON.stringify({ caseIndex, fixture, input: digest(src), breakdown }))
      for (let iteration = 0; iteration < repetitions; iteration++) {
        function pair(input: string, op: Op | "pause", warm: boolean, check?: (file: string, build: string) => void) {
          let previous: unknown
          const order = iteration % 2 ? ["live", "before"] as const : ["before", "live"] as const
          for (const build of order) {
            copyFileSync(input, trial)
            const row = worker(trial, fixture, op, warm, builds[build], true)
            console.log(JSON.stringify({ caseIndex, build, iteration, ...row }))
            assert.equal(row.ok, true, `${build} ${op}: ${JSON.stringify(row.result)}`)
            if (op !== "body") {
              assert.equal(row.result.revision, fixture.count + (revisionDelta[op] ?? 0), op)
              assert.equal(row.result.state, op === "pause" ? "paused" : "running", op)
            }
            if (op === "state") assert.equal(row.result.discardedEvents, 0)
            assert.equal(row.nativeEffects, op === "resume" ? 1 : 0)
            if (previous !== undefined) assert.deepEqual(row.result, previous, `${op} result differs across builds`)
            previous = row.result
            check?.(trial, build)
          }
        }
        for (const op of activeOps) for (const warm of [false, true]) pair(src, op, warm)
        let pausedDigest: ReturnType<typeof fingerprint> | undefined
        const checkPause = (file: string, build: string) => {
          const current = digest(file)
          assert.equal(current.rows, fixture.count + (fixture.neighbours ?? 0) * 50 + (fixture.longNeighbour ? fixture.longNeighbour - 50 : 0) + 1)
          if (pausedDigest) assert.deepEqual(current, pausedDigest, "pause changed different event bytes")
          pausedDigest = current
          // Use the original storage schema for both builds; no live-only
          // derived tables/triggers on the baseline's restarted copies.
          if (build === "before") copyFileSync(file, paused)
        }
        pair(src, "pause", false, checkPause)
        pair(src, "pause", true, checkPause)
        console.log(JSON.stringify({ caseIndex, iteration, pausedInput: pausedDigest }))
        for (const warm of [false, true]) {
          const resumed = join(dir, "resumed.db")
          let resumedDigest: ReturnType<typeof fingerprint> | undefined
          pair(paused, "resume", warm, (file, build) => {
            const current = digest(file)
            assert.equal(current.rows, pausedDigest!.rows + 2)
            if (resumedDigest) assert.deepEqual(current, resumedDigest, "resume changed different event bytes")
            resumedDigest = current
            if (build === "before") copyFileSync(file, resumed)
          })
          // New worker, fed the exact same persisted resume; no second delivery.
          pair(resumed, "continue", warm)
        }
      }
      rmSync(src)
    }
    console.log(JSON.stringify({ passed: true }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

function run(mode: string, repetitions: number) {
  mkdirSync(here, { recursive: true })
  const dir = mkdtempSync(join(here, "mission-journal-run-"))
  function measure(file: string, f: Fixture, op: Op | "pause", warm = false) {
    const row = worker(file, f, op, warm)
    console.log(JSON.stringify(row))
    return row
  }
  try {
    const cases: Fixture[] = mode === "--accept" ? longCases.map(count => ({ count, profile: "small" }))
      : mode === "--red-clean" ? [{ count: 1995, profile: "small" }, { count: 1996, profile: "small" },
      { count: 1996, profile: "heavy" }, { count: 10020, profile: "small" }]
      : mode === "--red" ? [{ count: 9995, profile: "small" }, { count: 9996, profile: "small" },
      { count: 9996, profile: "heavy" }, { count: 10020, profile: "small" }]
      : mode === "--quick" ? [{ count: 500, profile: "small" }, { count: 1500, profile: "small" },
        { count: 1500, profile: "heavy" }, { count: 1500, profile: "no-briefings" }, { count: 1500, profile: "small", neighbours: 30 }]
      : mode === "--long" ? [{ count: 10_020, profile: "small" }]
      : [{ count: 500, profile: "small" }, { count: 5000, profile: "small" }, { count: 5000, profile: "heavy" },
        { count: 5000, profile: "no-briefings" }, { count: 5000, profile: "small", neighbours: 100 },
        { count: 9980, profile: "heavy" }, { count: 10020, profile: "small" }, { count: 10020, profile: "heavy" }]
    let green = true
    for (const f of cases) {
      const src = join(dir, "seed.db"), copy = join(dir, "trial.db"), paused = join(dir, "paused.db")
      console.log(JSON.stringify({ fixture: f, breakdown: seed(src, f) }))
      for (let iteration = 0; iteration < repetitions; iteration++) {
        if (mode === "--accept") {
          copyFileSync(src, copy)
          const capacity = measure(copy, f, "accept-capacity")
          const accepted = measure(copy, f, "accept")
          const restarted = accepted.ok && measure(copy, f, "accept-restart")
          const replayed = restarted?.ok && measure(copy, f, "accept-delete-replay")
          if (!capacity.ok || !accepted.ok || !restarted?.ok || !replayed?.ok) green = false
          else {
            assert.deepEqual(replayed.result, { deleted: true, cleanup: restarted.result.cleanup })
            const db = new DatabaseSync(copy)
            try {
              db.prepare("ATTACH DATABASE ? AS seed").run(src)
              const original = fingerprint(db, "SELECT key, value FROM seed.kv")
              const retained = fingerprint(db, "SELECT key, value FROM main.kv WHERE key IN (SELECT key FROM seed.kv)")
              assert.deepEqual(retained, original, "preexisting keys or values changed")
              console.log(JSON.stringify({ count: f.count, original, retained }))
            } finally { db.close() }
          }
          continue
        }
        const ops: readonly Op[] = mode.startsWith("--red") ? ["open", "declare", "brief"] : activeOps
        for (const op of ops) {
          for (const warm of mode.startsWith("--red") ? [false] : [false, true]) {
            copyFileSync(src, copy)
            const row = measure(copy, f, op, warm)
            const revision = f.count + (op === "declare" || op === "brief" ? 1 : 0)
            if (!row.ok || op !== "body" && row.result?.revision !== revision || op === "state" && row.result?.discardedEvents !== 0) green = false
          }
        }
        if (!mode.startsWith("--red")) {
          copyFileSync(src, paused)
          const pause = measure(paused, f, "pause")
          if (!pause.ok) green = false
          // Separate processes see exactly the same durable paused state for each sample.
          for (const warm of [false, true]) {
            copyFileSync(paused, copy)
            const resumed = measure(copy, f, "resume", warm)
            const continued = measure(copy, f, "continue")
            if (!resumed.ok || resumed.result.state !== "running" || resumed.result.revision !== f.count + 3 ||
                resumed.nativeEffects !== 1 || !continued.ok) green = false
          }
          rmSync(paused)
        }
      }
      rmSync(src); rmSync(copy)
    }
    console.log(JSON.stringify({ expectedAllOperationsSucceed: true, passed: green }))
    process.exitCode = green ? 0 : 1
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// Two different journal lengths with the same live task/report bodies and
// recent plan history. Padding grows only the superseded objective texts.
async function readBudget(padded: boolean) {
  const dir = mkdtempSync(join(here, "mission-journal-budget-"))
  const file = join(dir, "seed.db"), count = 128
  try {
    seed(file, { count, profile: "small" })
    const db = new DatabaseSync(file)
    try {
      const { root } = makeStorage(db)
      const update = db.prepare("UPDATE kv SET value=? WHERE key=?")
      const insert = db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)")
      const discarded = db.prepare(`SELECT key,value FROM kv WHERE json_extract(value,'$.type')='mission.updated'
        AND json_extract(value,'$.createdAt')<40 ORDER BY key`).all() as Row[]
      if (padded) {
        db.exec("BEGIN")
        for (const { key, value } of discarded) {
          const event = JSON.parse(value)
          update.run(JSON.stringify({ ...event, objective: event.objective.padEnd(12_000, "x") }), key)
        }
        // Before the first subsequent valid briefing, maintain that briefing's
        // exact assessed revision by shifting every suffix revision equally.
        const extra = 10_020
        const rows = db.prepare("SELECT key,value FROM kv").all() as Row[]
        for (const { key, value } of rows) {
          const event = JSON.parse(value)
          if (event.type !== "mission.created") {
            if (event.expectedRevision !== undefined) event.expectedRevision += extra
            if (event.type === "mission.briefed") {
              event.briefing.basedOnRevision += extra
              event.briefing.requestID = `auto:${event.briefing.basedOnRevision}`
            }
            update.run(JSON.stringify(event), key)
          }
        }
        for (let i = 0; i < extra; i++) {
          const id = `evt_padding_${String(i).padStart(5, "0")}`
          // All at the creation timestamp, lexically after creation and before
          // the first later event; contents are superseded before recent history.
          insert.run(`${namespace}${root}/${missionID}/${id}`, JSON.stringify({ ...base, id, createdAt: 1,
            type: "mission.updated", requestID: id, expectedRevision: i + 1, notesSpecified: false,
            objective: "Superseded objective".repeat(64) }))
        }
        db.exec("COMMIT")
      }
      const breakdown = db.prepare(`SELECT json_extract(value,'$.type') AS type,count(*) AS entries,
        sum(length(CAST(value AS BLOB))) AS valueBytes FROM kv GROUP BY type`).all()
      console.log(JSON.stringify({ padded, breakdown }))
    } finally { db.close() }
    const expected = count + (padded ? 10_020 : 0)
    const s = await setup(file, expected)
    try {
      async function measure<T>(op: string, action: () => Promise<T>) {
        global.gc?.()
        const heap = process.memoryUsage().heapUsed
        let peak = heap
        s.reset(); s.onSample(() => { peak = Math.max(peak, process.memoryUsage().heapUsed) })
        const start = performance.now()
        const value = await action()
        const c = s.counters(), bytes = c.sqlValueBytes + c.getValueBytes + c.scanValueBytes
        console.log(JSON.stringify({ revision: expected, op, bytes, ms: Number((performance.now() - start).toFixed(2)),
          bodyRows: c.sqlBodyRows + c.getHits + c.scanRows, heapDelta: peak - heap,
          peakBatchBytes: c.peakSqlValueBytes, queries: c.sqlQueries }))
        return { value, bytes, setValueBytes: c.setValueBytes }
      }
      const initial = await measure("open-cold", () => s.control.snapshot())
      const { mission } = await s.control.mission(missionID)
      assert.equal(mission?.revision, expected)
      assert.equal(initial.value.discardedEvents, 0)
      const state = await measure("state-hot", () => s.control.list({ include: [missionID] }))
      if (padded) {
        const change = 10_020 + 6 // evt_00005 changes the objective set by evt_00004.
        const pair = { before: "Révision 4".padEnd(12_000, "x"), after: "Révision 5".padEnd(12_000, "x") }
        assert.ok(!mission.history.some(entry => entry.revision === change), "fixture must exercise an old change")
        assert.ok(!JSON.stringify(mission).includes("x".repeat(100)), "compact mission leaked historical objective JSON")
        const historical = await measure("change-objective-hot", () =>
          s.control.content({ missionID, kind: "change", field: "objective", change, offset: 0 }))
        assert.equal(historical.value.revision, expected)
        const slice = historical.value.content
        assert.ok(slice?.json)
        assert.equal(slice.next, undefined)
        assert.deepEqual(JSON.parse(slice.text), pair)
        const c = s.counters()
        assert.ok(c.sqlBodyRows + c.scanRows + c.getHits <= 2, "historical objective read more than two original bodies")
      }
      const result = await measure("declare-hot", () => s.control.declare(coordinator, { missionID,
        taskKey: "budget-check", title: "Budget check", brief: "Current work", role: "specialist", blockedBy: [] }))
      assert.equal(result.value.mission.revision, expected + 1)
      const body = await measure("body-hot", () => s.control.content({ missionID, kind: "mission", field: "objective", offset: 0 }))
      assert.equal(body.value.content?.text, initial.value.missions[0].objective)
      const brief = { missionID, requestID: `auto:${expected + 1}`, basedOnRevision: expected + 1,
        summary: "Budget checkpoint", achieved: [], ongoing: [], obstacles: [], next: [] }
      const briefed = await measure("brief-hot", () => s.control.briefing(coordinator, brief))
      assert.equal(briefed.value.mission.revision, expected + 2)
      assert.equal(briefed.value.mission.briefing?.summary, brief.summary)
      const lost = { missionID, taskKey: "lost-ack", title: "Preserve exactly once", brief: "Current work",
        role: "specialist", blockedBy: [] }
      s.loseNextWriteAck()
      await assert.rejects(s.control.declare(coordinator, lost), /Synthetic lost write acknowledgement/)
      const reopened = await setup(file, expected + 3)
      try {
        const before = fingerprint(reopened.db)
        const read = await reopened.control.declare(coordinator, lost)
        assert.equal(read.disposition, "existing")
        assert.equal(read.mission.revision, expected + 3)
        assert.deepEqual(fingerprint(reopened.db), before)
        assert.equal(reopened.counters().sets, 0)
      } finally { reopened.db.close() }
      const external = new DatabaseSync(file)
      try {
        const original = external.prepare("SELECT key,value FROM kv WHERE key=?")
          .get(`${namespace}${s.root}/${missionID}/evt_00000`) as Row
        // Same byte count and time metadata; the cached creation must not
        // authorize a new declaration after another connection damages it.
        external.prepare("UPDATE kv SET value=? WHERE key=?").run("!".repeat(size(original.value)), original.key)
      } finally { external.close() }
      s.reset()
      await assert.rejects(s.control.declare(coordinator, { ...lost, taskKey: "refuse-damage" }), { code: "invalid-journal" })
      assert.equal(s.counters().sets, 0)
      const { objective, notes, tasks, reports, status, runState } = initial.value.missions[0]
      return { live: { objective, notes, tasks, reports, status, runState },
        state: state.bytes, declare: result.bytes - result.setValueBytes, body: body.bytes,
        brief: briefed.bytes - briefed.setValueBytes }
    } finally { s.db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// Exercise the registered HTTP routes with the production control and SQL
// range reader; only workspace ownership and RPC transport are fixture ports.
async function panelIO() {
  const { default: Fastify } = await import("fastify")
  const { registerMissionRoutes } = await import("../packages/server/src/server/routes/missions")
  const dir = mkdtempSync(join(here, "mission-panel-io-"))
  const file = join(dir, "journal.db")
  const length = 10_020
  const app = Fastify()
  let s: Awaited<ReturnType<typeof setup>> | undefined
  const panel = (payload: Parameters<MissionControl["panelPage"]>[0]) =>
    app.inject({ method: "POST", url: "/api/workspaces/fixture/missions/panel-page", payload })
  const read = () => panel({ source: "mission", missionID, header: true })
  const tasks = () => panel({ source: "tasks", task: { missionID, offset: 0 } })
  const content = (query: URLSearchParams) => app.inject({ method: "GET",
    url: `/api/workspaces/fixture/missions/${missionID}/content?${query}` })
  const readBytes = () => {
    const c = s!.counters()
    return c.sqlValueBytes + c.scanValueBytes + c.getValueBytes
  }
  const workspace = {}
  const connection = { assertCurrent() {}, client: {
    location: { get: async () => ({ project }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({
      panelPage: (input: Parameters<MissionControl["panelPage"]>[0]) => s!.control.panelPage(input),
      content: (input: Parameters<MissionControl["content"]>[0]) => s!.control.content(input),
    }),
  } }
  registerMissionRoutes(app, { workspaceManager: {
    get: () => workspace, getServiceLocation: () => project.location, getSharedServiceConnection: async () => connection,
  } as unknown as Parameters<typeof registerMissionRoutes>[1]["workspaceManager"] })
  try {
    seed(file, { count: 448, profile: "heavy" })
    const seedDB = new DatabaseSync(file)
    try {
      const { root } = makeStorage(seedDB), insert = seedDB.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)")
      const previous = seedDB.prepare("SELECT value FROM kv WHERE key=?").get(`${namespace}${root}/${missionID}/evt_00447`) as { value: string }
      seedDB.exec("BEGIN")
      for (let i = 448; i < length; i++) {
        const id = `evt_${i}`
        insert.run(`${namespace}${root}/${missionID}/${id}`, JSON.stringify({ ...base, id, createdAt: i + 1,
          type: "mission.updated", requestID: id, expectedRevision: i, notesSpecified: false,
          objective: "Synthetic revision", notes: i === length - 1 ? JSON.parse(previous.value).notes : "Superseded note" }))
      }
      seedDB.exec("COMMIT")
    } finally { seedDB.close() }
    s = await setup(file, length)
    const first = await read()
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().available, true)
    const catchUp = readBytes()
    assert.ok(catchUp > 1_000_000)
    const originalTasks = await tasks()
    assert.equal(originalTasks.json().available, true)
    const firstHeader = JSON.parse(first.json().page.pieces[0].text)
    assert.ok(firstHeader.tasks.pins.length > 0)
    const pinRequest = { source: "tasks" as const, task: { missionID, ids: firstHeader.tasks.pins, reportIds: firstHeader.tasks.reportPins } }
    const originalPins = (await panel(pinRequest)).json()
    assert.equal(originalPins.available, true)
    s.db.close(); s = await setup(file, length)
    const reopened = await read()
    assert.equal(reopened.statusCode, 200)
    assert.deepEqual(reopened.json(), first.json())
    const reopenedBytes = readBytes()
    const header = JSON.parse(reopened.json().page.pieces[0].text)
    assert.ok(header.root.bodies.notes.characters > 1000)
    assert.ok(reopenedBytes <= 64 * 1024, `qualified restart read ${reopenedBytes} bytes for a compact header`)
    s.reset()
    const window = await tasks()
    assert.equal(window.statusCode, 200)
    assert.deepEqual(window.json(), originalTasks.json())
    let piece = window.json(), text = piece.page.pieces.map((row: { text: string }) => row.text).join("")
    while (piece.page.next) {
      piece = (await panel({ source: "tasks", task: { missionID, offset: 0 }, cursor: piece.page.next })).json()
      text += piece.page.pieces.map((row: { text: string }) => row.text).join("")
    }
    const windowBytes = readBytes()
    s.reset()
    assert.deepEqual((await panel(pinRequest)).json(), originalPins)
    const pinsBytes = readBytes()
    assert.ok(pinsBytes > 0 && pinsBytes <= 96 * 1024)
    const value = JSON.parse(text)
    const task = value.tasks.find((row: { key: string }) => row.key === "work-0")
    const report = value.reports.find((row: { id: string }) => row.id === "rpt_work-0")
    const named = async (selector: Record<string, string>, digest: string, eventID: string, field: "brief" | "summary") => {
      s!.reset()
      const answer = await content(new URLSearchParams({ ...selector, field, digest, offset: "0" }))
      assert.equal(answer.statusCode, 200)
      const raw = s!.db.prepare("SELECT value FROM kv WHERE key=?").get(`${namespace}${s!.root}/${missionID}/${eventID}`) as { value: string }
      const event = JSON.parse(raw.value)
      assert.equal(answer.json().content.text, field === "brief" ? event.task.brief : event.report.summary)
      return { bytes: readBytes(), rows: s!.counters().sqlBodyRows }
    }
    const briefRead = await named({ kind: "task", taskKey: task.key }, task.bodies.brief.digest, "evt_00001", "brief")
    const reportRead = await named({ kind: "report", reportId: report.id }, report.bodies.summary.digest, "evt_00002", "summary")
    s.reset()
    const body = await content(new URLSearchParams({ kind: "mission", field: "notes", offset: "0", digest: header.root.bodies.notes.digest }))
    assert.equal(body.statusCode, 200)
    const expected = s.db.prepare(`SELECT json_extract(value,'$.notes') AS notes FROM kv WHERE key=?`)
      .get(`${namespace}${s.root}/${missionID}/evt_00000`) as { notes: string }
    assert.equal(body.json().content.text, expected.notes)
    const selectedBodyBytes = readBytes()
    assert.ok(selectedBodyBytes > 0 && selectedBodyBytes <= 32 * 1024)
    assert.equal(s.counters().sqlBodyRows, 2)
    console.log(JSON.stringify({ length, catchUp, reopenedBytes, windowBytes, pinsBytes, selectedBodyBytes, briefRead, reportRead }))
    assert.ok(windowBytes > 0 && windowBytes <= 256 * 1024, `qualified task window read ${windowBytes} bytes`)
    for (const read of [briefRead, reportRead]) assert.ok(read.bytes > 0 && read.bytes <= 128 * 1024 && read.rows === 2,
      "named bodies require exactly one compact window and their original event")

    // An equal-size external edit changes the descriptor without changing the
    // task-order digest or the event count. The old cursor and body must refuse.
    const edited = join(dir, "edited.db")
    copyFileSync(file, edited)
    const editor = new DatabaseSync(edited)
    try {
      const key = `${namespace}${s.root}/${missionID}/evt_00001`
      const row = editor.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string }
      const parsed = JSON.parse(row.value)
      parsed.task.brief = "X" + parsed.task.brief.slice(1)
      const changed = JSON.stringify(parsed)
      assert.equal(size(changed), size(row.value))
      editor.prepare("UPDATE kv SET value=? WHERE key=?").run(changed, key)
    } finally { editor.close() }
    s.db.close(); s = await setup(edited, length)
    assert.ok(window.json().page.next)
    const oldCursor = await panel({ source: "tasks", task: { missionID, offset: 0 }, cursor: window.json().page.next })
    assert.deepEqual(oldCursor.json(), { available: false, reason: "changed" })
    const stale = await content(new URLSearchParams({ kind: "task", taskKey: task.key, field: "brief", digest: task.bodies.brief.digest, offset: "0" }))
    assert.equal(stale.json().refused, "content-changed")
    s.reset()
    assert.equal((await tasks()).json().available, true)
    assert.ok(readBytes() <= 96 * 1024, "the edited window should be requalified")

    const derived = join(dir, "derived.db")
    copyFileSync(file, derived)
    const damagedCache = new DatabaseSync(derived)
    try {
      assert.equal(damagedCache.prepare("UPDATE codenomad_mission_head_v1 SET tail='{}' WHERE range LIKE 'display:v1:%'").run().changes, 1)
    } finally { damagedCache.close() }
    s.db.close(); s = await setup(derived, length)
    assert.deepEqual((await read()).json(), first.json(), "damaged derived state must be rebuilt from the original events")
    assert.ok(readBytes() >= catchUp)

    const rollback = join(dir, "rollback.db")
    copyFileSync(file, rollback)
    const restored = new DatabaseSync(rollback)
    try {
      const before = fingerprint(restored)
      restored.exec(`BEGIN;
        DROP TRIGGER codenomad_mission_head_v1_insert;
        DROP TRIGGER codenomad_mission_head_v1_update;
        DROP TRIGGER codenomad_mission_head_v1_delete;
        DROP TABLE codenomad_mission_head_v1;
        COMMIT;`)
      assert.deepEqual(fingerprint(restored), before)
    } finally { restored.close() }
    s.db.close(); s = await setup(rollback, length)
    assert.deepEqual((await read()).json(), first.json())
    const rollbackBytes = readBytes()
    assert.ok(rollbackBytes >= catchUp, "a removed index requires reconstruction")

    const external = new DatabaseSync(rollback)
    try {
      const key = `${namespace}${s.root}/${missionID}/evt_00000`
      external.prepare("UPDATE kv SET value=printf('%.*c',length(CAST(value AS BLOB)),'!') WHERE key=?").run(key)
    } finally { external.close() }
    s.reset()
    const changed = (await read()).json()
    assert.ok(changed.available === false || changed.discardedEvents > 0, "cached clean state hid external damage")
    await assert.rejects(s.control.declare(coordinator, { missionID, taskKey: "damage-check", title: "Refuse damage",
      brief: "Do not write", role: "specialist", blockedBy: [] }), { code: "invalid-journal" })
    console.log(JSON.stringify({ catchUp, reopenedBytes, selectedBodyBytes, rollbackBytes, repairedDerived: true, rejectedDamage: true }))
  } finally { s?.db.close(); await app.close(); rmSync(dir, { recursive: true, force: true }) }
}

const [mode = "--red", first, count, op, warm, profile] = process.argv.slice(2)
if (mode === "--worker") {
  child(first, Number(count), op as Op, warm === "true", profile as Profile).catch(error => { console.error(error); process.exitCode = 2 })
} else if (mode === "--panel-io") {
  await panelIO()
} else if (mode === "--read-budget") {
  const small = await readBudget(false), large = await readBudget(true)
  assert.deepEqual(large.live, small.live)
  for (const key of ["state", "declare", "body", "brief"] as const) assert.equal(large[key], small[key], `${key} historical byte growth`)
} else {
  assert(["--red", "--red-clean", "--quick", "--bench", "--long", "--accept", "--compare"].includes(mode))
  const repetitions = Number(first ?? "1")
  assert(Number.isSafeInteger(repetitions) && repetitions > 0)
  if (mode === "--compare") compare(repetitions)
  else run(mode, repetitions)
}
