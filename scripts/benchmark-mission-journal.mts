import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
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
type Profile = "small" | "heavy" | "no-briefings"
type Fixture = { count: number; profile: Profile; neighbours?: number }
type Row = { key: string; value: string }
const here = dirname(fileURLToPath(import.meta.url))
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
  function reset() {
    return c = { scanPages: 0, projectPages: 0, scanRows: 0, scanValueBytes: 0, scanKeyBytes: 0,
      peakScanPageBytes: 0, gets: 0, getHits: 0, getValueBytes: 0, sets: 0, setValueBytes: 0, removals: 0, nativeEffects: 0,
      sqlQueries: 0, sqlRows: 0, sqlValueBytes: 0, peakSqlValueBytes: 0 }
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
    },
    async remove(key) { remove.run(namespace + key); c.removals++ },
  }
  const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly import("node:sqlite").SQLInputValue[]) => ({
    withoutTransform: Effect.sync(() => {
      const rows = db.prepare(sql).all(...params)
      const bytes = rows.reduce((total, row) => total + (typeof row.value === "string" ? size(row.value) : 0), 0)
      c.sqlQueries++; c.sqlRows += rows.length; c.sqlValueBytes += bytes
      c.peakSqlValueBytes = Math.max(c.peakSqlValueBytes, bytes)
      if (sql.startsWith("INSERT") || sql.startsWith("UPDATE")) {
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
  const acquire = () => Effect.runPromise(Effect.provide(acquireNativeJournalRange(
    { location: { project } } as unknown as Parameters<typeof acquireNativeJournalRange>[0]), graph))
  return { storage, root, acquire, reset, counters: () => c, onSample: (callback: () => void) => { sample = callback },
    nativeEffect: () => { c.nativeEffects++ } }
}

function seed(file: string, { count, profile, neighbours = 0 }: Fixture) {
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
    const other = { ...created, missionID: `msn_neighbour_${i}`, notes: undefined,
      coordinator: { ...created.coordinator, sessionID: `ses_neighbour_${i}` } }
    put(other)
    for (let j = 1; j < 49; j++) {
      put({ ...base, missionID: other.missionID, id: `evt_${j}`, createdAt: j + 1, type: "mission.updated",
        requestID: `neighbor-edit-${j}`, expectedRevision: j, notesSpecified: false, objective: `Historique ${j}` })
    }
    put({ ...base, missionID: other.missionID, id: "evt_end", createdAt: 50, type: "mission.finished", outcome: "failed", summary: "Terminé" })
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
  if (warm) await (op === "state" ? showState() : display()).catch(() => {})
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
  console.log(JSON.stringify({ count, profile, op, warm, ok, result, ms: Number(ms.toFixed(2)), ...s.counters(),
    heapBefore: initial.heapUsed, heapSamplePeak: heap, rssBefore: initial.rss, rssSamplePeak: rss,
    processRssHwmBefore: rss0, processRssHwmAfter: peak }))
  s.db.close()
}

function run(mode: string, repetitions: number) {
  mkdirSync(here, { recursive: true })
  const dir = mkdtempSync(join(here, "mission-journal-run-"))
  function worker(file: string, f: Fixture, op: Op | "pause", warm = false) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url),
      "--worker", file, String(f.count), op, String(warm), f.profile], { encoding: "utf8", windowsHide: true })
    assert.equal(child.status, 0, child.stderr || child.error?.message)
    const row = JSON.parse(child.stdout)
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
          const capacity = worker(copy, f, "accept-capacity")
          const accepted = worker(copy, f, "accept")
          const restarted = accepted.ok && worker(copy, f, "accept-restart")
          const replayed = restarted?.ok && worker(copy, f, "accept-delete-replay")
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
            const row = worker(copy, f, op, warm)
            const revision = f.count + (op === "declare" || op === "brief" ? 1 : 0)
            if (!row.ok || op !== "body" && row.result?.revision !== revision || op === "state" && row.result?.discardedEvents !== 0) green = false
          }
        }
        if (!mode.startsWith("--red")) {
          copyFileSync(src, paused)
          const pause = worker(paused, f, "pause")
          if (!pause.ok) green = false
          // Separate processes see exactly the same durable paused state for each sample.
          for (const warm of [false, true]) {
            copyFileSync(paused, copy)
            const resumed = worker(copy, f, "resume", warm)
            const continued = worker(copy, f, "continue")
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

const [mode = "--red", first, count, op, warm, profile] = process.argv.slice(2)
if (mode === "--worker") {
  child(first, Number(count), op as Op, warm === "true", profile as Profile).catch(error => { console.error(error); process.exitCode = 2 })
} else {
  assert(["--red", "--red-clean", "--quick", "--bench", "--long", "--accept"].includes(mode))
  const repetitions = Number(first ?? "1")
  assert(Number.isSafeInteger(repetitions) && repetitions > 0)
  run(mode, repetitions)
}
