import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import test from "node:test"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Equal, Exit, Fiber, Hash, MutableHashMap, Option, RcMap, Schema, Scope } from "effect"
import { startNativeRecurrenceClock, cancelNativeRecurrenceClock, readNativeRecurrenceClock, nativeLocationEntry } from "./native-service-clock"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { readNativeRecurrenceSnapshot } from "./native-recurrence-snapshot"
import { latestDailyDue } from "../../missions/recurrence-clock"
import type { RecurrenceConfig } from "../../missions/recurrence-contract"

test("native Location entries are found by Ref fields when the service hashes keys with its own effect copy", () => {
  const directory = path.resolve("recurrence-native-hash-fixture")
  // Simulates a key inserted by the native service: equal fields, foreign hash.
  const nativeKey = { directory, [Hash.symbol]: () => 1, [Equal.symbol]: (that: unknown) =>
    typeof that === "object" && that !== null && (that as { directory?: unknown }).directory === directory }
  const map = MutableHashMap.empty<Location.Ref, string>()
  MutableHashMap.set(map, nativeKey as unknown as Location.Ref, "native-graph")
  const ref = Schema.decodeUnknownSync(Location.Ref)({ directory })
  assert.equal(Option.isNone(MutableHashMap.get(map, ref)), true, "bundled hashing misses the native key")
  assert.deepEqual(nativeLocationEntry({ _tag: "Open", map }, ref), Option.some("native-graph"))
  assert.equal(Option.isNone(nativeLocationEntry({ _tag: "Open", map }, Schema.decodeUnknownSync(Location.Ref)({ directory, workspaceID: "wrk_other" }))), true)
  assert.equal(Option.isNone(nativeLocationEntry({ _tag: "Closed", map }, ref)), true)
})

test("native Job sleeps until due: <=25 daily wakes, one exact passage, restart interrupted, pending resume reconcile-only", async () => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)")
  const scope = await Effect.runPromise(Scope.make())
  const directory = path.resolve("recurrence-clock-memory-fixture")
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
  const locationTag = Context.Service<never, Location.Info>("@opencode/Location")
  const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
  const jobTag = Context.Service<never, unknown>("@opencode/Job")
  const mapTag = Context.Service<never, unknown>("@opencode/example/LocationServiceMap")
  const sessionTag = Context.Service<never, unknown>("@opencode/Session")
  const encode = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
  let graph!: Context.Context<never>, now = Date.parse("2026-10-08T00:00:00Z"), wakes = 0, starts = 0, reconciles = 0
  const origin = now
  const statusWrites = new Map<string, unknown>() // Display-only wake warnings, outside the schedule document.
  const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[]) => ({
    withoutTransform: Effect.sync(() => db.prepare(sql).all(...params as [])),
  }) })
  const storage = {
    get: (key: string) => Effect.sync(() => {
      const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encode(key)) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined
    }), set: (key: string, value: unknown) => Effect.sync(() => { statusWrites.set(key, value) }),
    remove: (key: string) => Effect.sync(() => { statusWrites.delete(key) }),
    scan: ({ prefix, after, limit }: { prefix: string; after?: string; limit: number }) => Effect.sync(() => {
      const rows = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
        .all(encode(prefix).length, encode(prefix), encode(after ?? prefix), limit + 1) as { key: string; value: string }[]
      const entries = rows.slice(0, limit).map(row => ({ key: row.key.slice(encode("").length), value: JSON.parse(row.value) }))
      return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.key } : {}) }
    }),
  }
  const ctx = { storage, location } as unknown as Parameters<typeof acquireNativeRecurrenceStore>[0]
  const jobs = new Map<string, { id: string; type: string; status: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown>; fiber?: Fiber.Fiber<string, unknown> }>()
  const job = { get: (id: string) => Effect.succeed(jobs.get(id)),
    start: (input: { id: string; type: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }) => Effect.sync(() => {
      const existing = jobs.get(input.id)
      if (existing?.status === "running") return existing
      const entry = { ...input, status: "running" }; jobs.set(input.id, entry); return entry
    }), cancel: (id: string) => Effect.gen(function* () { const entry = jobs.get(id)
      if (entry?.fiber) yield* Fiber.interrupt(entry.fiber)
      if (entry) entry.status = "cancelled"
    }) }
  try {
    const dbService = { db: { $client: client, transaction: (callback: () => Effect.Effect<unknown, unknown>) => Effect.promise(async () => {
      db.exec("BEGIN IMMEDIATE")
      try { const value = await Effect.runPromise(callback().pipe(Effect.provide(graph))); db.exec("COMMIT"); return value }
      catch (error) { db.exec("ROLLBACK"); throw error }
    }) } }
    // Native graphs carry a foreign Location class with an explicit `workspaceID: undefined` (2.0.26).
    const nativeLocation = { ...location, workspaceID: undefined } as unknown as Location.Info
    // A borrowed native Location graph has Location services only; Database, Session and Job
    // are process-global and exist only in the Play-time plugin context (observed in 2.0.26).
    const borrowed = Context.make(locationTag, nativeLocation)
    const map = await Effect.runPromise(RcMap.make({ idleTimeToLive: Infinity, lookup: () => Effect.succeed(borrowed) })
      .pipe(Effect.provideService(Scope.Scope, scope)))
    const locations = { rcMap: map, contextEffect: (ref: Location.Ref) => RcMap.get(map, ref), contextEffectOption: (ref: Location.Ref) => RcMap.getOption(map, ref) }
    graph = borrowed.pipe(Context.add(databaseTag, dbService), Context.add(jobTag, job), Context.add(mapTag, locations), Context.add(sessionTag, {}))
    const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
    await run(Effect.scoped(RcMap.get(map, Schema.decodeUnknownSync(Location.Ref)({ directory }))))
    const store = await run(acquireNativeRecurrenceStore(ctx)), current = () => true as const
    const config: RecurrenceConfig = { title: "Daily review", consigne: "Review", template: "custom", taskMode: "native",
      clock: { time: "07:15", zone: "UTC" }, profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory }],
      watchedConversationIDs: [], profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
        roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } } }
    let doc = await store.create("schedule_one", config, now, current)
    doc = await store.setState(doc.id, doc.revision, "running", current)
    const placement = { projectID: "project", projectCanonical: directory, directory, scheduleID: doc.id, profileID: "profile", executionHost: "local" }
    const due = () => Effect.tryPromise(async () => {
      let fresh = (await store.read(doc.id))!
      if (fresh.pending) { reconciles++; return "pending" as const }
      starts++; assert.equal(now, origin + (7 * 60 + 15) * 60_000)
      const latest = latestDailyDue(config.clock, now)
      fresh = await store.reserve(doc.id, fresh.revision, { kind: "daily", clock: config.clock, ...latest }, now, current)
      const passage = fresh.pending!.passage
      fresh = await store.recordAdmission(doc.id, { kind: "accepted", passageID: passage.id, messageID: passage.messageID, missionID: "mission_one", conversationID: "session_one" }, now, current)
      await store.finish(doc.id, { passageID: passage.id, messageID: passage.messageID, missionID: "mission_one", conversationID: "session_one", outcome: "completed", artifactMessageIDs: [], cursors: [] }, now, current)
      return "started" as const
    })
    const clock = { now: () => now, sleep: (ms: number) => Effect.promise(async () => {
      wakes++; now += ms
      if (now >= origin + 86_400_000) { const fresh = (await store.read(doc.id))!; await store.setState(doc.id, fresh.revision, "paused", current) }
    }) }
    await run(startNativeRecurrenceClock(placement, due, ctx, clock))
    await Effect.runPromise([...jobs.values()][0]!.run)
    assert.equal(starts, 1); assert(wakes <= 25, `${wakes} wakeups`)
    await run(cancelNativeRecurrenceClock(placement))
    assert.equal(await run(readNativeRecurrenceClock(placement)), false)
    doc = (await store.read(doc.id))!; doc = await store.setState(doc.id, doc.revision, "running", current)
    jobs.clear()
    const restarted = await run(readNativeRecurrenceSnapshot(ctx))
    assert.equal(restarted.schedules[0].state, "interrupted")
    assert.equal(restarted.schedules[0].interruptionReason, "service-restart")
    assert.equal(restarted.schedules[0].nextDueAt, null); assert.equal(jobs.size, 0)
    doc = await store.reserve(doc.id, doc.revision, { kind: "manual", requestID: "manual_one", expectedRevision: doc.revision, at: now }, now, current)
    const resumeClock = { now: () => now, sleep: (_ms: number) => Effect.promise(async () => {
      const fresh = (await store.read(doc.id))!; await store.setState(doc.id, fresh.revision, "paused", current)
    }) }
    await run(startNativeRecurrenceClock(placement, due, ctx, resumeClock))
    await Effect.runPromise([...jobs.values()][0]!.run)
    assert.equal(reconciles, 1); assert.equal(starts, 1, "pending Resume never starts a second passage")
    await run(cancelNativeRecurrenceClock(placement))
    doc = (await store.read(doc.id))!; await store.setState(doc.id, doc.revision, "running", current)
    // A transient wake failure records a display warning and retries; it does not end the Job.
    let retried = 0, warning: unknown
    const backoff = { now: () => now, sleep: (ms: number) => Effect.promise(async () => {
      retried++; warning = [...statusWrites.values()][0]; assert.equal(ms, 30_000, "first retry uses the capped backoff, not a tight loop")
      const fresh = (await store.read(doc.id))!; await store.setState(doc.id, fresh.revision, "paused", current)
    }) }
    await run(startNativeRecurrenceClock(placement, () => Effect.fail(new Error("private error details")), ctx, backoff))
    assert.equal(await Effect.runPromise([...jobs.values()][0]!.run), "inactive")
    assert.equal(retried, 1)
    assert.deepEqual(warning, { code: "admission-failed", at: now })
    assert.equal(statusWrites.size, 0, "the next successful wake clears the warning")
    assert.equal((await store.read(doc.id))!.interruptionReason, undefined, "a transient failure is not an interruption")
    await run(cancelNativeRecurrenceClock(placement)); jobs.clear()
    doc = (await store.read(doc.id))!; await store.setState(doc.id, doc.revision, "running", current)
    // Only a definitively fatal cause (Location/Job binding gone) ends the Job as Interrupted(error).
    await run(startNativeRecurrenceClock(placement, () => Effect.fail(new Error("Recurrence Job Location changed")), ctx, resumeClock))
    await assert.rejects(Effect.runPromise([...jobs.values()][0]!.run))
    const failed = [...jobs.values()][0]!
    failed.status = "error"
    assert.equal((await run(readNativeRecurrenceSnapshot(ctx))).schedules[0].interruptionReason, "error")
    doc = (await store.read(doc.id))!
    doc = await store.beginControl(doc.id, { requestID: "resume_cancel_fixture", expectedRevision: doc.revision, action: "resume" }, current)
    let entered!: () => void, aborted = false
    const waiting = new Promise<void>(resolve => { entered = resolve })
    await run(startNativeRecurrenceClock(placement, (_id, assertCurrent, signal) => Effect.promise(() => new Promise<"pending">(resolve => {
      entered()
      signal.addEventListener("abort", () => { aborted = true; assert.equal(assertCurrent(), true); resolve("pending") }, { once: true })
    })), ctx, resumeClock))
    const cancellable = [...jobs.values()][0]!
    cancellable.fiber = Effect.runFork(cancellable.run)
    await waiting
    await run(cancelNativeRecurrenceClock(placement))
    assert.equal(aborted, true, "native cancellation aborts the original passage callback while its borrowed graph is retained")
    assert.equal((await store.read(doc.id))!.interruptionReason, undefined, "normal cancellation is not an error interruption")
    assert.equal(await run(readNativeRecurrenceClock(placement)), false)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); db.close() }
})
