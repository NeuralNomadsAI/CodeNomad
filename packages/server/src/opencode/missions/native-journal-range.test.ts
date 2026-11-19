import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { Context, Effect } from "effect"
import { compareEvents } from "../../missions/model"
import { stableToken } from "../../missions/receipt-identity"
import { acquireNativeJournalRange } from "./native-journal-range"

const tag = Context.Service<never, unknown>("@opencode/storage/Database")
const project = { id: "project", canonical: "/fixture" }
const missionID = "msn_long"
const encode = (key: string) => `plugin:${Buffer.from("codenomad.missions", "utf16le").swap16().toString("hex")}:${key}`
const prefix = encode(`codenomad-missions/v2/${stableToken(`${project.id}\0${project.canonical}`, 24)}/${missionID}/`)

function fixture(db: DatabaseSync) {
  let readBytes = 0, maxBatchBytes = 0
  const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[]) => ({
    withoutTransform: Effect.sync(() => {
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
    callback: () => Effect.Effect<unknown>, { behavior }: { behavior: "deferred" },
  ) => Effect.tryPromise({ try: () => {
    assert.equal(behavior, "deferred")
    const result = pending.then(async () => {
      db.exec("BEGIN")
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
  const ctx = { location: { project } } as unknown as Parameters<typeof acquireNativeJournalRange>[0]
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
  const db = new DatabaseSync(":memory:")
  try {
    createKV(db)
    const original = makeEvent("evt_one", 1, "alpha")
    db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)").run(prefix + original.id, JSON.stringify(original))
    const a = await fixture(db).acquire()
    const before = await a.readOrdered(missionID, () => {})
    const unchanged = await a.readOrdered(missionID, () => assert.fail("cached projection was replayed"),
      () => assert.fail("cached projection was reset"), before.digest)
    assert.equal(unchanged.digest, before.digest)
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ ...original, objective: "bravo" }), prefix + original.id)
    const rewritten = { ...original, objective: "bravo", notes: undefined }
    const after = await a.readOrdered(missionID, batch => { assert.deepEqual(batch, [rewritten]) }, () => true, before.digest)
    assert.notEqual(after.digest, before.digest)
    assert.deepEqual(await a.readEvent(missionID, original.id), rewritten)
  } finally { db.close() }
})
