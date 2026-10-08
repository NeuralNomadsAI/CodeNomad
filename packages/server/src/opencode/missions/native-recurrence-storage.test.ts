import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect } from "effect"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { RECURRENCE_STORAGE_PREFIX, type RecurrenceConfig } from "../../missions/recurrence-contract"
import { RecurrenceCreateCapacityError } from "../../missions/recurrence-store"

const config: RecurrenceConfig = {
  template: "custom", consigne: "Review", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
  profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
    roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
  taskMode: "native", roots: [{ mode: "directory-only", directory: "/project" }],
  watchedConversationIDs: [], publication: { policy: "draft-only", conversationIDs: [] },
}
const location = { directory: "/project", project: { id: "project", canonical: "/project", directory: "/project" } }
const encode = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`

test("native recurrence metadata is bounded and exact revision CAS across Location incarnations", async () => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)")
  const tag = Context.Service<never, unknown>("@opencode/storage/Database")
  const client = Object.assign(() => {}, {
    unsafe: (sql: string, parameters: readonly unknown[]) => {
      const effect = Effect.sync(() => db.prepare(sql).all(...parameters as []))
      return { withoutTransform: effect }
    },
  })
  const graph = Context.make(tag, { db: { $client: client, transaction: (callback: () => Effect.Effect<unknown>) =>
    Effect.promise(async () => {
      db.exec("BEGIN IMMEDIATE")
      try {
        const result = await Effect.runPromise(Effect.provide(callback(), graph))
        db.exec("COMMIT")
        return result
      } catch (error) { db.exec("ROLLBACK"); throw error }
    }) } })
  let afterRead: (() => void) | undefined
  const storage = {
    get: (key: string) => Effect.sync(() => {
      const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encode(key)) as { value: string } | undefined
      const callback = afterRead; afterRead = undefined; callback?.()
      return row ? JSON.parse(row.value) : undefined
    }),
    set: () => Effect.fail(new Error("not used")),
    scan: ({ prefix, after, limit }: { prefix: string; after?: string; limit: number }) => Effect.sync(() => {
      const keys = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
        .all(encode(prefix).length, encode(prefix), encode(after ?? prefix), limit + 1) as { key: string; value: string }[]
      const entries = keys.slice(0, limit).map(row => ({ key: row.key.slice(encode("").length), value: JSON.parse(row.value) }))
      return { entries, ...(keys.length > limit ? { next: entries.at(-1)!.key } : {}) }
    }),
  }
  const ctx = { storage, location } as unknown as Parameters<typeof acquireNativeRecurrenceStore>[0]
  const acquire = (at = ctx) => Effect.runPromise(Effect.provide(acquireNativeRecurrenceStore(at), graph))
  try {
    const sibling = { storage, location: { ...location, directory: "/project/sibling" } } as unknown as typeof ctx
    const a = await acquire(), b = await acquire(sibling), current = () => true as const
    let doc = await a.create("schedule_0", config, 100, current)
    assert.deepEqual(await b.read(doc.id), doc)
    const old = doc.revision
    doc = await b.setState(doc.id, old, "running", current)
    await assert.rejects(a.setState(doc.id, old, "paused", current), /revision conflict/)
    assert.deepEqual(await a.read(doc.id), doc)
    const key = `${RECURRENCE_STORAGE_PREFIX}/project/${a.projectToken}/${doc.id}`
    const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encode(key)) as { value: string }
    assert.equal(JSON.parse(row.value).revision, 1)
    afterRead = () => db.prepare("UPDATE kv SET value=? WHERE key=?")
      .run(JSON.stringify({ ...doc, revision: doc.revision + 1 }), encode(key))
    await assert.rejects(a.setState(doc.id, doc.revision, "paused", current), /revision conflict/)
    assert.equal((await b.read(doc.id))?.revision, 2, "a different Location's committed revision wins")
    await assert.rejects(a.create(doc.id, config, 100, current), /already exists/)
    let guards = 0
    await assert.rejects(a.create("schedule_revoked", config, 100, () => {
      if (++guards >= 4) throw new Error("revoked after SQL write")
      return true as const
    }), /revoked after SQL write|policy-unqualified/)
    assert.ok(guards >= 4, "the revoked guard reached the final transaction boundary")
    assert.equal(await a.read("schedule_revoked"), undefined)
    for (let i = 1; i < 64; i++) await (i % 2 ? a : b).create(`schedule_${i}`, config, 100, current)
    assert.equal((await b.list()).length, 64)
    await assert.rejects(a.create("schedule_64", config, 100, current), RecurrenceCreateCapacityError)
    assert.equal(await a.read("schedule_64"), undefined)
    assert.equal((db.prepare("SELECT count(*) AS count FROM kv").get() as { count: number }).count, 64)
  } finally { db.close() }
})
