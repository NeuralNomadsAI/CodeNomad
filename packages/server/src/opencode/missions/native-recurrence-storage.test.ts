import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect } from "effect"
import Ajv from "ajv"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { RECURRENCE_STORAGE_PREFIX, type RecurrenceConfig } from "../../missions/recurrence-contract"
import { RecurrenceCreateCapacityError } from "../../missions/recurrence-store"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { MISSION_RECURRENCE_CHANGED_EVENT, readRecurrenceScheduleChanged, type RecurrenceScheduleChanged } from "../../missions/recurrence-events"

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
  const busTag = Context.Service<never, unknown>("@opencode/Bus"), locationTag = Context.Service<never, unknown>("@opencode/Location")
  const events: RecurrenceScheduleChanged[] = []
  let insideTransaction = false, failedEmit = false
  const validateEvent = new Ajv({ allErrors: true, strictKeywords: true }).compile(CODENOMAD_MISSIONS_RPC.events.scheduleChanged.schema)
  const bus = { publish: (definition: { type: string }, data: RecurrenceScheduleChanged, options: unknown) => Effect.sync(() => {
    assert.equal(insideTransaction, false, "never publish an uncommitted or rolled-back calendar revision")
    assert.equal(definition.type, MISSION_RECURRENCE_CHANGED_EVENT)
    assert.ok([location.directory, "/project/sibling"].includes((options as { location: { directory: string } }).location.directory))
    assert.equal(validateEvent(data), true, JSON.stringify(validateEvent.errors))
    assert.deepEqual(Object.keys(data).sort(), ["revision", "scheduleID"])
    const rows = db.prepare("SELECT value FROM kv").all() as { value: string }[]
    assert.ok(rows.some(row => { const value = JSON.parse(row.value); return value.id === data.scheduleID && value.revision === data.revision }))
    if (failedEmit) throw new Error("Volatile Bus unavailable")
    events.push(data)
  }) }
  const client = Object.assign(() => {}, {
    unsafe: (sql: string, parameters: readonly unknown[]) => {
      const effect = Effect.sync(() => db.prepare(sql).all(...parameters as []))
      return { withoutTransform: effect }
    },
  })
  const graph = Context.make(tag, { db: { $client: client, transaction: (callback: () => Effect.Effect<unknown>) =>
    Effect.promise(async () => {
      db.exec("BEGIN IMMEDIATE")
      insideTransaction = true
      try {
        const result = await Effect.runPromise(Effect.provide(callback(), graph))
        db.exec("COMMIT")
        insideTransaction = false
        return result
      } catch (error) { db.exec("ROLLBACK"); insideTransaction = false; throw error }
    }) } }).pipe(Context.add(busTag, bus), Context.add(locationTag, location))
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
  const ctx = { storage, location, get rpc() { return assert.fail("calendar commits must not retain/use an origin RPC registration") } } as unknown as Parameters<typeof acquireNativeRecurrenceStore>[0]
  const acquire = (at = ctx) => Effect.runPromise(Effect.provide(acquireNativeRecurrenceStore(at),
    Context.add(graph, locationTag, at.location)))
  try {
    const sibling = { storage, location: { ...location, directory: "/project/sibling" } } as unknown as typeof ctx
    const a = await acquire(), b = await acquire(sibling), current = () => true as const
    let doc = await a.create("schedule_0", config, 100, current)
    assert.deepEqual(events, [{ scheduleID: doc.id, revision: 0 }])
    assert.deepEqual(await b.read(doc.id), doc)
    const old = doc.revision
    doc = await b.setState(doc.id, old, "running", current)
    await assert.rejects(a.setState(doc.id, old, "paused", current), /revision conflict/)
    assert.deepEqual(events, [{ scheduleID: doc.id, revision: 0 }, { scheduleID: doc.id, revision: 1 }], "conflicting CAS emits nothing")
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
    assert.equal(events.some(event => event.scheduleID === "schedule_revoked"), false)
    doc = (await b.read(doc.id))!
    doc = await a.reserve(doc.id, doc.revision, { kind: "manual", expectedRevision: doc.revision, requestID: "due_fixture", at: 200 }, 200, current)
    const pending = doc.pending!.passage
    doc = await b.recordAdmission(doc.id, { kind: "accepted", passageID: pending.id, messageID: pending.messageID,
      missionID: "msn_passage", conversationID: "ses_passage" }, 200, current)
    doc = await b.finish(doc.id, { passageID: pending.id, messageID: pending.messageID, missionID: "msn_passage", conversationID: "ses_passage",
      outcome: "completed", artifactMessageIDs: ["msg_result"], cursors: [] }, 201, current)
    assert.equal(doc.history.at(-1)?.result.passageID, pending.id)
    assert.deepEqual(events.at(-1), { scheduleID: doc.id, revision: doc.revision }, "archive commit uses the same privacy-bounded emitter as Create/reservation")
    const beforeLostEvent = events.length
    failedEmit = true
    doc = await b.setState(doc.id, doc.revision, "paused", current)
    assert.equal(events.length, beforeLostEvent)
    assert.equal((await a.read(doc.id))?.revision, doc.revision, "a lost volatile event does not roll back, retry or mislabel the committed CAS")
    failedEmit = false
    let freshPublishes = 0
    const freshBus = { publish: (definition: { type: string }, data: RecurrenceScheduleChanged, options: unknown) =>
      Effect.sync(() => { freshPublishes++ }).pipe(Effect.andThen(bus.publish(definition, data, options))) }
    const freshStore = await Effect.runPromise(Effect.provide(acquireNativeRecurrenceStore(ctx), Context.add(graph, busTag, freshBus)))
    doc = await freshStore.setState(doc.id, doc.revision, "running", current)
    assert.equal(freshPublishes, 1, "post-commit invalidation resolves the committing fresh graph's app Bus, not an origin registration")
    for (let i = 1; i < 64; i++) await (i % 2 ? a : b).create(`schedule_${i}`, config, 100, current)
    assert.equal((await b.list()).length, 64)
    await assert.rejects(a.create("schedule_64", config, 100, current), RecurrenceCreateCapacityError)
    assert.equal(await a.read("schedule_64"), undefined)
    assert.equal((db.prepare("SELECT count(*) AS count FROM kv").get() as { count: number }).count, 64)
    assert.equal(validateEvent({ ...events[0], prompt: "private model bytes" }), false)
    assert.equal(readRecurrenceScheduleChanged({ type: MISSION_RECURRENCE_CHANGED_EVENT, data: { ...events[0], consigne: "private" } }), undefined)
    assert.equal(readRecurrenceScheduleChanged({ type: MISSION_RECURRENCE_CHANGED_EVENT,
      data: Object.assign(Object.create({ scheduleID: "inherited_schedule" }), { revision: 0, model: "private" }) }), undefined)
  } finally { db.close() }
})
