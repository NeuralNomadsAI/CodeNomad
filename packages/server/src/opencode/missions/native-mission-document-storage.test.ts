import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect } from "effect"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import type { MissionConfiguration } from "../../missions/launch-policy"
import { missionDocumentChanges } from "../../missions/mission-document-state"

test("production document adapter validates exact keys/revisions and rolls back a revoked SQLite CAS", async () => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)")
  const encode = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
  const tag = Context.Service<never, unknown>("@opencode/storage/Database")
  let afterRead: (() => void) | undefined
  const storage = { get: (key: string) => Effect.sync(() => {
    const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encode(key)) as { value: string } | undefined
    const callback = afterRead; afterRead = undefined; callback?.()
    return row ? JSON.parse(row.value) : undefined
  }) }
  const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[]) => ({
    withoutTransform: Effect.sync(() => db.prepare(sql).all(...params as [])),
  }) })
  const graph = Context.make(tag, { db: { $client: client, transaction: (callback: () => Effect.Effect<unknown>) => Effect.promise(async () => {
    db.exec("BEGIN IMMEDIATE")
    try { const result = await Effect.runPromise(Effect.provide(callback(), graph)); db.exec("COMMIT"); return result }
    catch (error) { db.exec("ROLLBACK"); throw error }
  }) } })
  const ctx = { storage, location: { directory: "/project", project: { id: "project", canonical: "/project" } } } as unknown as Parameters<typeof acquireNativeMissionDocumentStore>[0]
  const acquire = () => Effect.runPromise(Effect.provide(acquireNativeMissionDocumentStore(ctx), graph))
  const configuration: MissionConfiguration = { title: "Work", objective: "Work", template: "custom", taskMode: "native",
    profileID: null, executionHost: null, roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [],
    launch: { timing: { kind: "immediate" }, condition: null, ends: { maxLaunches: null, afterMs: null, at: null } } }
  try {
    const a = await acquire(), b = await acquire()
    const doc = await a.create("original", configuration, 1000, () => true)
    assert.deepEqual(await b.read(doc.id), doc)
    const row = db.prepare("SELECT key,value FROM kv").get() as { key: string; value: string }
    assert.ok(row.key.includes("/documents-v1/project/"))
    afterRead = () => db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ ...doc, revision: 1 }), row.key)
    await assert.rejects(a.change(doc.id, doc.revision, () => true, value => { value.everCreatedTask = true }), /revision conflict/)
    assert.equal((await b.read(doc.id))?.revision, 1)
    let guards = 0
    await assert.rejects(a.create("revoked", configuration, 1000, () => {
      if (++guards >= 4) throw new Error("revoked")
      return true
    }), /revoked|policy-unqualified/)
    assert.equal(await a.read("revoked"), undefined)
    assert.equal((db.prepare("SELECT count(*) AS count FROM kv").get() as { count: number }).count, 1)
    await assert.rejects(Effect.runPromise(acquireNativeMissionDocumentStore(ctx)), /database unavailable/)
    const current = (await b.read(doc.id))!
    const stopped = await b.change(doc.id, current.revision, () => true, next => {
      missionDocumentChanges.requestDeletion(next, "delete-sqlite", 2000)
      next.synchronization = null // The fixture has no native mappings or pending effects.
    })
    await b.reserveDeletion(doc.id, stopped.revision, () => true)
    const tombstone = await b.compact(doc.id, stopped.revision, 3000, () => true)
    assert.equal(tombstone.requestID, "delete-sqlite")
    assert.equal(tombstone.expectedRevision, current.revision)
    assert.equal(tombstone.deleteManagedSessions, false)
    assert.deepEqual(await a.read(doc.id), tombstone)
  } finally { db.close() }
})
