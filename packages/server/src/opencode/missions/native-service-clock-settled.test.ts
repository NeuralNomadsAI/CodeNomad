import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import test from "node:test"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Exit, Fiber, RcMap, Schema, Scope } from "effect"
import { startNativeRecurrenceClock } from "./native-service-clock"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import type { RecurrenceConfig } from "../../missions/recurrence-contract"

const tag = (name: string) => Context.Service<never, unknown>(name)

/** Pending passage whose family becomes quiescent after the first wake. Returns the
 * sleeps the Job actually completed before archiving, with or without a native Bus. */
async function pendingSettlement(withBus: boolean) {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)")
  const scope = await Effect.runPromise(Scope.make())
  const directory = path.resolve("recurrence-settled-wake-fixture")
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
  const encode = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
  let graph!: Context.Context<never>
  const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[]) => ({
    withoutTransform: Effect.sync(() => db.prepare(sql).all(...params as [])) }) })
  const storage = {
    get: (key: string) => Effect.sync(() => {
      const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encode(key)) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined
    }), set: () => Effect.fail(new Error("not used")),
    scan: ({ prefix, after, limit }: { prefix: string; after?: string; limit: number }) => Effect.sync(() => {
      const rows = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
        .all(encode(prefix).length, encode(prefix), encode(after ?? prefix), limit + 1) as { key: string; value: string }[]
      const entries = rows.slice(0, limit).map(row => ({ key: row.key.slice(encode("").length), value: JSON.parse(row.value) }))
      return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.key } : {}) }
    }),
  }
  const ctx = { storage, location } as unknown as Parameters<typeof acquireNativeRecurrenceStore>[0]
  let started: { run: Effect.Effect<string, unknown> } | undefined
  const job = { get: () => Effect.succeed(undefined), cancel: () => Effect.void,
    start: (input: { metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }) =>
      Effect.sync(() => { started = input; return { ...input, status: "running" } }) }
  const listeners: Array<(event: unknown) => Effect.Effect<void>> = []
  const bus = { listen: (listener: (event: unknown) => Effect.Effect<void>) => Effect.sync(() => {
    listeners.push(listener)
    return Effect.sync(() => { listeners.splice(listeners.indexOf(listener), 1) })
  }) }
  try {
    const dbService = { db: { $client: client, transaction: (callback: () => Effect.Effect<unknown, unknown>) => Effect.promise(async () => {
      db.exec("BEGIN IMMEDIATE")
      try { const value = await Effect.runPromise(callback().pipe(Effect.provide(graph))); db.exec("COMMIT"); return value }
      catch (error) { db.exec("ROLLBACK"); throw error }
    }) } }
    const borrowed = Context.make(tag("@opencode/Location"), location)
    const map = await Effect.runPromise(RcMap.make({ idleTimeToLive: Infinity, lookup: () => Effect.succeed(borrowed) })
      .pipe(Effect.provideService(Scope.Scope, scope)))
    const locations = { rcMap: map, contextEffect: (ref: Location.Ref) => RcMap.get(map, ref) }
    graph = borrowed.pipe(Context.add(tag("@opencode/storage/Database"), dbService), Context.add(tag("@opencode/Job"), job),
      Context.add(tag("@opencode/example/LocationServiceMap"), locations), Context.add(tag("@opencode/Session"), {}))
    if (withBus) graph = Context.add(graph, tag("@opencode/Bus"), bus)
    const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
    await run(Effect.scoped(RcMap.get(map, Schema.decodeUnknownSync(Location.Ref)({ directory }))))
    const store = await run(acquireNativeRecurrenceStore(ctx)), current = () => true as const
    const config: RecurrenceConfig = { title: "Daily review", consigne: "Review", template: "custom", taskMode: "native",
      clock: { time: "07:15", zone: "UTC" }, profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory }],
      watchedConversationIDs: [], profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
        roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } } }
    const now = Date.parse("2026-10-08T10:00:00Z")
    let doc = await store.create("schedule_one", config, now, current)
    doc = await store.setState(doc.id, doc.revision, "running", current)
    doc = await store.reserve(doc.id, doc.revision, { kind: "manual", requestID: "manual_one", expectedRevision: doc.revision, at: now }, now, current)
    const passage = doc.pending!.passage
    await store.recordAdmission(doc.id, { kind: "accepted", passageID: passage.id, messageID: passage.messageID,
      missionID: "mission_one", conversationID: "session_one" }, now, current)
    let wakes = 0, quiescent = false
    const due = () => Effect.tryPromise(async () => {
      wakes++
      if (!quiescent) return "pending" as const
      const fresh = (await store.read(doc.id))!
      await store.finish(doc.id, { passageID: passage.id, messageID: passage.messageID, missionID: "mission_one",
        conversationID: "session_one", outcome: "completed", artifactMessageIDs: [], cursors: [] }, now, current, fresh.revision)
      // Settled: stop the loop after the archive so the Job returns.
      const archived = (await store.read(doc.id))!
      await store.setState(doc.id, archived.revision, "paused", current)
      return "settled" as const
    })
    const sleeps: number[] = []
    const clock = { now: () => now, sleep: (ms: number) => Effect.suspend(() => {
      // Hourly wakes never elapse here: only the event path or bounded fallback can settle.
      if (ms >= 3_600_000 || ms > 300_000) return Effect.never
      sleeps.push(ms)
      if (ms >= 30_000 && sleeps.filter(value => value >= 30_000).length >= 3) quiescent = true
      return Effect.void
    }) }
    const placement = { projectID: "project", projectCanonical: directory, directory, scheduleID: doc.id, profileID: "profile", executionHost: "local" }
    await run(startNativeRecurrenceClock(placement, due, ctx, clock))
    const fiber = Effect.runFork(started!.run)
    for (let i = 0; i < 50 && wakes < 1; i++) await new Promise(resolve => setTimeout(resolve, 5))
    if (withBus) {
      assert.equal(wakes, 1)
      assert.equal(listeners.length, 1)
      quiescent = true
      // Unrelated events never wake; a native execution terminal does.
      await Effect.runPromise(listeners[0]!({ type: "session.next.prompt" }))
      await Effect.runPromise(listeners[0]!({ type: "session.execution.succeeded" }))
    }
    const outcome = await Effect.runPromise(Fiber.await(fiber))
    assert.equal(Exit.isSuccess(outcome), true)
    assert.equal((await store.read(doc.id))!.history.length, 1)
    return { sleeps, wakes, listeners: listeners.length }
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); db.close() }
}

test("pending passage settlement wakes on a native execution terminal, not the hourly wake", async () => {
  const observed = await pendingSettlement(true)
  assert.deepEqual(observed.sleeps, [3_000], "only the post-event debounce elapsed")
  assert.equal(observed.wakes, 2)
  assert.equal(observed.listeners, 0, "the Bus listener is released with the Job")
})

test("without a native Bus listener, pending settlement uses a bounded backoff, never minute polling", async () => {
  const observed = await pendingSettlement(false)
  assert.deepEqual(observed.sleeps, [30_000, 120_000, 300_000])
  assert.equal(observed.wakes, 4)
})
