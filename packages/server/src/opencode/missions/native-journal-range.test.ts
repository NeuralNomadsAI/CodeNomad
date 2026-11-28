import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Context, Effect } from "effect"
import { compareEvents } from "../../missions/model"
import { projectMissionCleanups } from "../../missions/cleanup-projection"
import { foldJournalRange } from "../../missions/journal-range-view"
import { stableToken } from "../../missions/receipt-identity"
import { acquireNativeJournalRange } from "./native-journal-range"

const tag = Context.Service<never, unknown>("@opencode/storage/Database")
const project = { id: "project", canonical: "/fixture" }
const missionID = "msn_long"
const encode = (key: string) => `plugin:${Buffer.from("codenomad.missions", "utf16le").swap16().toString("hex")}:${key}`
const prefix = encode(`codenomad-missions/v2/${stableToken(`${project.id}\0${project.canonical}`, 24)}/${missionID}/`)

function fixture(db: DatabaseSync, scope = project, beforeSQL?: (sql: string) => void) {
  let readBytes = 0, maxBatchBytes = 0
  const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[]) => ({
    withoutTransform: Effect.sync(() => {
      beforeSQL?.(sql)
      const rows = db.prepare(sql).all(...params as [])
      const bytes = rows.reduce((n, row) => n + (typeof row.value === "string" ? Buffer.byteLength(row.value) : 0), 0)
      maxBatchBytes = Math.max(maxBatchBytes, bytes)
      readBytes += bytes
      return rows
    }),
  }) })
  // The fixture serializes operations just like one SQLite transaction connection.
  let pending: Promise<unknown> = Promise.resolve()
  const graph = Context.make(tag, { db: { $client: client, transaction: (
    callback: () => Effect.Effect<unknown>, { behavior }: { behavior: "deferred" | "immediate" },
  ) => Effect.tryPromise({ try: () => {
    const result = pending.then(async () => {
      db.exec(behavior === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN")
      let value: unknown
      try {
        value = await Effect.runPromise(Effect.provide(callback(), graph))
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
      return value
    })
    pending = result.catch(() => undefined)
    return result
  }, catch: error => error }) } })
  const ctx = { location: { project: scope } } as unknown as Parameters<typeof acquireNativeJournalRange>[0]
  return { acquire: () => Effect.runPromise(Effect.provide(acquireNativeJournalRange(ctx), graph)),
    bytes: () => ({ readBytes, maxBatchBytes }) }
}

function createKV(db: DatabaseSync) {
  db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)")
}

const makeEvent = (id: string, createdAt: number, objective = "Prepare") => ({
  version: 1 as const, id, createdAt, missionID, projectID: project.id, type: "mission.updated" as const, objective,
  requestID: id, expectedRevision: 1, notesSpecified: false,
})

test("cleanup projections keep complete emoji within the UTF-16 budget", async () => {
  const db = new DatabaseSync(":memory:")
  try {
    createKV(db)
    const ascii = "a".repeat(239), emoji = "\u{1f600}"
    const base = { version: 1 as const, missionID, projectID: project.id }
    const creation = { ...base, id: "evt_create", createdAt: 1, type: "mission.created" as const,
      projectCanonical: project.canonical, coordinator: { sessionID: "ses_coordinator", title: "Coordinator", location: { directory: project.canonical } },
      template: "custom" as const, objective: ascii + emoji }
    const deletion = { ...base, id: "evt_delete", createdAt: 3, type: "mission.deleted" as const,
      requestID: "delete", expectedRevision: 2 }
    const insert = db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?, 1, 1)")
    const range = await fixture(db).acquire()
    const history = [creation, deletion]
    for (const event of history) insert.run(prefix + event.id, JSON.stringify(event))
    const check = async (expected: string, update?: ReturnType<typeof makeEvent>) => {
      if (update) insert.run(prefix + update.id, JSON.stringify(update))
      const folded = await foldJournalRange(range, missionID)
      assert.ok(!folded.unchanged && !folded.advanced)
      for (const [cleanup] of [folded.cleanups, projectMissionCleanups(update ? [...history, update] : history)]) {
        assert.equal(cleanup?.objective, expected)
        assert.doesNotMatch(JSON.stringify(cleanup), /\\ud83d/i)
      }
    }
    await check(ascii)
    await check(ascii, makeEvent("evt_update", 2, ascii + emoji))
    const fits = ascii.slice(1) + emoji
    await check(fits, makeEvent("evt_update", 2, fits + "!"))
  } finally { db.close() }
})

test("reads over 10,000 legacy events in replay order without transferring a full range's values at once", async () => {
  const db = new DatabaseSync(":memory:")
  try {
    createKV(db)
    const events = Array.from({ length: 10_020 }, (_, i) =>
      makeEvent(`evt_${String(i).padStart(5, "0")}`, 10_020 - i, "é".repeat(4_000)))
    // Both punctuation and case have different tie-breaking from SQLite BINARY.
    events.push(...["evt_a", "evt_A", "evt_-a", "evt__a"].map(id => makeEvent(id, 1)))
    const insert = db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)")
    db.exec("BEGIN")
    for (const event of events) insert.run(prefix + event.id, JSON.stringify(event))
    insert.run(prefix + "evt_broken", "{")
    insert.run(prefix + "evt_wrong", JSON.stringify(makeEvent("evt_elsewhere", 0)))
    insert.run(prefix.slice(0, -1) + "0/evt_other", "{")
    insert.run(prefix.slice(0, -1) + "-next/evt_other", "{")
    insert.run(prefix.slice(0, -missionID.length - 1) + "bad-💡", "{")
    db.exec("COMMIT")
    const f = fixture(db), adapter = await f.acquire()
    const observed: string[] = []
    const result = await adapter.readOrdered(missionID, batch => { observed.push(...batch.map(event => event.id)) })
    const expected = events.slice().sort(compareEvents).map(event => event.id)
    assert.equal(observed.length, expected.length)
    const mismatch = observed.findIndex((id, i) => id !== expected[i])
    assert.equal(mismatch, -1, `replay order differs at ${mismatch}: ${observed[mismatch]} vs ${expected[mismatch]}`)
    assert.equal(result.discardedEvents, 2)
    const validBytes = events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0)
    assert.equal(result.bytes, validBytes + 1 + Buffer.byteLength(JSON.stringify(makeEvent("evt_elsewhere", 0))))
    assert.equal(f.bytes().readBytes, result.bytes + validBytes)
    assert.ok(f.bytes().maxBatchBytes <= 1024 * 1024, `${f.bytes().maxBatchBytes} bytes in one SQL response`)
    assert.deepEqual(await adapter.listRanges(), { missionIDs: [`${missionID}-next`, missionID, `${missionID}0`], stray: 1 })
    assert.equal(f.bytes().readBytes, result.bytes + validBytes, "range inventory transfers keys only")
  } finally { db.close() }
})

test("an unchanged digest skips replay; an equally sized external rewrite forces replay even at the same timestamp", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, "journal-head-test-"))
  const file = join(dir, "kv.db")
  const db = new DatabaseSync(file)
  const external = new DatabaseSync(file)
  try {
    createKV(db)
    const original = makeEvent("evt_one", 1, "alpha")
    db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)").run(prefix + original.id, JSON.stringify(original))
    const a = await fixture(db).acquire()
    const before = await a.readOrdered(missionID, () => {})
    const unchanged = await a.readOrdered(missionID, () => assert.fail("cached projection was replayed"),
      () => assert.fail("cached projection was reset"), before.digest)
    assert.equal(unchanged.digest, before.digest)
    external.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?, 1, 1)").run(prefix + original.id,
      JSON.stringify({ ...original, objective: "bravo" }))
    const rewritten = { ...original, objective: "bravo", notes: undefined }
    const after = await a.readOrdered(missionID, batch => { assert.deepEqual(batch, [rewritten]) },
      () => true, before.digest, () => assert.fail("replacement is not an append"))
    assert.notEqual(after.digest, before.digest)
    assert.deepEqual(await a.readEvent(missionID, original.id), rewritten)
    const externalView = await (await fixture(external).acquire()).readOrdered(missionID, () => assert.fail("unchanged second connection"),
      () => assert.fail("unchanged second connection"), after.digest)
    assert.equal(externalView.digest, after.digest)
    const foreign = await (await fixture(db, { ...project, id: "other-project" }).acquire()).readOrdered(missionID,
      () => assert.fail("foreign project has no events"), () => true, after.digest)
    assert.equal(foreign.rows, 0)
    assert.notEqual(foreign.digest, after.digest)
  } finally { external.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("failed installation rolls back; the same client retries on the next read", async () => {
  const db = new DatabaseSync(":memory:")
  try {
    createKV(db)
    const event = makeEvent("evt_one", 1)
    db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)").run(prefix + event.id, JSON.stringify(event))
    db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)").run(prefix + "evt_bad", "{")
    let installs = 0
    const f = fixture(db, project, sql => {
      if (sql.startsWith("CREATE TABLE codenomad_mission_head") && ++installs > 2) assert.fail("unbounded installation")
      if (installs === 1 && sql.startsWith("CREATE TRIGGER")) throw new Error("interrupted installation")
    })
    const a = await f.acquire()
    const first = await a.readOrdered(missionID, () => {})
    assert.equal(installs, 1)
    assert.equal(first.rows, 2)
    assert.equal(first.discardedEvents, 1)
    assert.doesNotMatch(first.digest, /\//)
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'codenomad_mission_head_%'").all(), [])
    const second = await f.acquire()
    const indexed = await second.readOrdered(missionID, () => {}, () => true, first.digest)
    assert.equal(installs, 2)
    assert.match(indexed.digest, /\//)
    assert.equal(indexed.discardedEvents, 1)
    const bytes = f.bytes().readBytes
    assert.deepEqual(await a.readOrdered(missionID, () => assert.fail("warm head replayed"),
      () => assert.fail("warm head reset"), indexed.digest), indexed)
    assert.equal(f.bytes().readBytes, bytes)
  } finally { db.close() }
})

test("missing and wrong definitions use exact replay with stable damage counts until repaired externally", async () => {
  const db = new DatabaseSync(":memory:")
  try {
    createKV(db)
    const event = makeEvent("evt_one", 1)
    const insert = db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)")
    insert.run(prefix + event.id, JSON.stringify(event))
    insert.run(prefix + "evt_bad", "{")
    const f = fixture(db)
    const b = await f.acquire()
    const indexed = await b.readOrdered(missionID, () => {})
    const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='codenomad_mission_head_v1_update'").get()?.sql
    assert.equal(typeof trigger, "string")
    db.exec("DROP TRIGGER codenomad_mission_head_v1_update")
    const missing = await b.readOrdered(missionID, () => {}, () => true, indexed.digest)
    assert.doesNotMatch(missing.digest, /\//)
    db.exec("CREATE TRIGGER codenomad_mission_head_v1_update AFTER UPDATE ON kv BEGIN SELECT 1; END")
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ ...event, objective: "Changed" }), prefix + event.id)
    const after = await b.readOrdered(missionID, batch => {
      assert.equal(batch[0].type === "mission.updated" && batch[0].objective, "Changed")
    }, () => true, missing.digest)
    assert.doesNotMatch(after.digest, /\//)
    assert.equal(after.discardedEvents, 1)
    const bytes = f.bytes().readBytes
    assert.deepEqual(await b.readOrdered(missionID, () => assert.fail("exact cache replayed"),
      () => assert.fail("exact cache reset"), after.digest), after)
    assert.equal(f.bytes().readBytes - bytes, after.bytes, "fallback hashes the source once")
    db.exec("DROP TRIGGER codenomad_mission_head_v1_update")
    db.exec(String(trigger))
    const repaired = await b.readOrdered(missionID, batch => {
      assert.equal(batch[0].type === "mission.updated" && batch[0].objective, "Changed")
    }, () => true, indexed.digest, () => assert.fail("old incarnation accepted as an append base"))
    assert.match(repaired.digest, /\//)
    assert.notEqual(repaired.digest, indexed.digest)
  } finally { db.close() }
})

test("external DDL and VACUUM renew the exact head on the same client", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, "journal-head-test-"))
  const file = join(dir, "kv.db")
  const db = new DatabaseSync(file), external = new DatabaseSync(file)
  try {
    createKV(db)
    const event = makeEvent("evt_one", 1, "alpha")
    db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)").run(prefix + event.id, JSON.stringify(event))
    const f = fixture(db), adapter = await f.acquire()
    const other = await fixture(external).acquire()
    let prior = await adapter.readOrdered(missionID, () => {})
    for (const ddl of ["CREATE TABLE unrelated (value TEXT)", "VACUUM"]) {
      external.exec(ddl)
      let visits = 0
      const refreshed = await adapter.readOrdered(missionID, batch => { visits += batch.length },
        () => true, prior.digest, () => assert.fail("old incarnation accepted as an append base"))
      assert.equal(visits, 1)
      assert.match(refreshed.digest, /\//)
      assert.notEqual(refreshed.digest, prior.digest)
      const bytes = f.bytes().readBytes
      const noReplay = () => assert.fail("replayed a requalified head")
      assert.deepEqual(await other.readOrdered(missionID, noReplay, noReplay, refreshed.digest), refreshed)
      assert.deepEqual(await adapter.readOrdered(missionID, noReplay, noReplay, refreshed.digest), refreshed)
      assert.equal(f.bytes().readBytes, bytes)
      prior = refreshed
    }
  } finally { external.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("an unchanged native snapshot transfers no historical bodies on a cache hit", async () => {
  const db = new DatabaseSync(":memory:")
  try {
    createKV(db)
    const insert = db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)")
    for (let i = 0; i < 128; i++) {
      const event = makeEvent(`evt_${i}`, i, "old objective ".repeat(800))
      insert.run(prefix + event.id, JSON.stringify(event))
    }
    const f = fixture(db)
    const before = await (await f.acquire()).readOrdered(missionID, () => {})
    const bytes = f.bytes().readBytes
    const after = await (await f.acquire()).readOrdered(missionID, () => assert.fail("replayed warm range"),
      () => assert.fail("reprepared warm range"), before.digest)
    assert.equal(after.digest, before.digest)
    assert.equal(f.bytes().readBytes - bytes, 0)
  } finally { db.close() }
})
