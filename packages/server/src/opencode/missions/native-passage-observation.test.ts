import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect } from "effect"
import { acquireNativePassageObservation } from "./native-passage-observation"
import { passageFixture } from "./native-passage-test-fixture"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"
import { RECURRENCE_STORAGE_PREFIX } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"

test("a claim cut by a service restart settles ended-without-report/interrupted; a live-process claim stays pending", async () => {
  const f = await passageFixture(), db = new DatabaseSync(":memory:")
  try {
    await f.start() // admitted, no report: the hard kill cut the coordinator mid-turn
    db.exec(`CREATE TABLE session_v2(id TEXT,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,time_suspended INTEGER);
      CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,data TEXT);
      CREATE TABLE session_inbox(id TEXT,session_id TEXT);
      CREATE TABLE session_pending(session_id TEXT);
      CREATE TABLE event(aggregate_id TEXT,type TEXT,seq INTEGER);`)
    // Observed natively (f60TKB): time_suspended kept, no execution terminal event.
    db.prepare("INSERT INTO session_v2 VALUES(?,NULL,'project',?,NULL,1000)").run(f.passage.coordinatorSessionID, f.root)
    db.prepare("INSERT INTO session_message VALUES(?,?,'synthetic','{}')").run(f.passage.messageID, f.passage.coordinatorSessionID)
    const tag = (name: string) => Context.Service<never, unknown>(name)
    const running = new Set<string>()
    let graph = Context.empty() as Context.Context<never>
    for (const [name, value] of [
      ["@opencode/storage/Database", { db: { $client: { unsafe: (sql: string, params: readonly unknown[]) => ({
        withoutTransform: Effect.promise(async () => db.prepare(sql).all(...params as [])) }) } } }],
      ["@opencode/Location", {}], ["@opencode/Session", { active: Effect.sync(() => new Set(running)) }],
      ["@opencode/Form", { list: () => Effect.succeed([]) }], ["@opencode/Permission", { list: () => Effect.succeed([]) }],
      ["@opencode/Shell", { list: () => Effect.succeed([]) }],
    ] as const) graph = Context.add(graph, tag(name), value)
    const observe = async (serviceStartedAt: number) => observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!,
      storage: f.storage, native: await Effect.runPromise(acquireNativePassageObservation(serviceStartedAt).pipe(Effect.provide(graph))),
      directory: f.root, current: () => true, signal: new AbortController().signal })
    assert.equal(await observe(500), undefined, "a claim written by this service process may still be running")
    running.add(f.passage.coordinatorSessionID)
    assert.equal(await observe(2000), undefined, "a resumed (live) execution is not interrupted")
    running.clear()
    const settled = (await observe(2000))!
    assert.equal(settled.result.outcome, "ended-without-report")
    assert.equal(settled.result.reason, "interrupted")
    const archived = await f.calendar.finish("schedule", settled.result, 30, () => true, settled.expectedRevision)
    assert.equal(archived.history.at(-1)?.result.reason, "interrupted")
    assert.deepEqual(f.counts().sends, 1, "settlement never sends a continuation")
  } finally { db.close(); await f.dispose() }
})

// Native 2.0.26 `serve` leaves the `event` table empty; each execution terminal is
// projected into a durable `idle` message whose `outcome` carries the failure.
async function idleFamily(finish?: "completed") {
  const f = await passageFixture(), db = new DatabaseSync(":memory:")
  await f.start()
  if (finish) await f.finish(finish)
  db.exec(`CREATE TABLE session_v2(id TEXT,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,time_suspended INTEGER);
    CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,data TEXT);
    CREATE TABLE session_inbox(id TEXT,session_id TEXT);
    CREATE TABLE session_pending(session_id TEXT);
    CREATE TABLE event(aggregate_id TEXT,type TEXT,seq INTEGER);`)
  const coordinator = f.passage.coordinatorSessionID, child = "ses_failed_child"
  db.prepare("INSERT INTO session_v2 VALUES(?,NULL,'project',?,NULL,NULL)").run(coordinator, f.root)
  db.prepare("INSERT INTO session_v2 VALUES(?,?,'project',?,NULL,NULL)").run(child, coordinator, f.root)
  db.prepare("INSERT INTO session_message VALUES(?,?,'synthetic','{}')").run(f.passage.messageID, coordinator)
  const idle = (id: string, session: string, outcome: string) => db.prepare("INSERT INTO session_message VALUES(?,?,'idle',?)")
    .run(id, session, JSON.stringify({ time: { created: 1 }, outcome }))
  const tag = (name: string) => Context.Service<never, unknown>(name)
  let graph = Context.empty() as Context.Context<never>
  for (const [name, value] of [
    ["@opencode/storage/Database", { db: { $client: { unsafe: (sql: string, params: readonly unknown[]) => ({
      withoutTransform: Effect.promise(async () => db.prepare(sql).all(...params as [])) }) } } }],
    ["@opencode/Location", {}], ["@opencode/Session", { active: Effect.sync(() => new Set<string>()) }],
    ["@opencode/Form", { list: () => Effect.succeed([]) }], ["@opencode/Permission", { list: () => Effect.succeed([]) }],
    ["@opencode/Shell", { list: () => Effect.succeed([]) }],
  ] as const) graph = Context.add(graph, tag(name), value)
  const native = await Effect.runPromise(acquireNativePassageObservation().pipe(Effect.provide(graph)))
  const observe = async () => (await observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!, storage: f.storage,
    native, directory: f.root, current: () => true, signal: new AbortController().signal }))?.result
  return { f, db, idle, coordinator, child, observe, dispose: async () => { db.close(); await f.dispose() } }
}

test("a native failed turn without a final report archives failed, read from the idle projection", async () => {
  const t = await idleFamily()
  try {
    t.idle("msg_idle_ok", t.coordinator, "succeeded")
    assert.equal((await t.observe())?.outcome, "ended-without-report", "succeeded/interrupted idles are not failures")
    t.idle("msg_idle_child", t.child, "failed")
    const failed = (await t.observe())!
    assert.equal(failed.outcome, "failed", "a descendant's native failure counts for the family")
    assert.equal(failed.reason, undefined)
    assert.deepEqual(failed.cursors, [], "failed passages never advance watched cursors")
    assert.equal(t.db.prepare("SELECT count(*) AS count FROM event").get()!.count, 0)
    assert.equal(t.f.counts().sends, 1, "classification never retries or replays")
  } finally { await t.dispose() }
})

test("a completed final report wins over a later native failure during wrap-up", async () => {
  const t = await idleFamily("completed")
  try {
    t.idle("msg_idle_fail", t.coordinator, "failed")
    assert.equal((await t.observe())?.outcome, "completed")
  } finally { await t.dispose() }
})

test("read/grep/edit/webfetch/shell completed calls do not block real passage settlement", async () => {
  const f = await passageFixture(), db = new DatabaseSync(":memory:")
  try {
    await f.start()
    await f.finish()
    db.exec(`CREATE TABLE session_v2(id TEXT,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,time_suspended INTEGER);
      CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,data TEXT);
      CREATE TABLE session_inbox(id TEXT,session_id TEXT);
      CREATE TABLE session_pending(session_id TEXT);
      CREATE TABLE event(aggregate_id TEXT,type TEXT,seq INTEGER);
      CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);`)
    // Real Windows native SQL uses `/` while Location/schedule paths use `\`.
    db.prepare("INSERT INTO session_v2 VALUES(?,NULL,'project',?,NULL,NULL)").run(f.passage.coordinatorSessionID, f.root.replaceAll("\\", "/"))
    db.prepare("INSERT INTO session_message VALUES(?,?,'synthetic','{}')").run(f.passage.messageID, f.passage.coordinatorSessionID)
    const content = ["read", "grep", "edit", "webfetch", "shell"].map(name => ({ type: "tool", name, state: { status: "completed" } }))
    db.prepare("INSERT INTO session_message VALUES('msg_tools',?,'assistant',?)").run(f.passage.coordinatorSessionID, JSON.stringify({ content }))
    db.prepare("INSERT INTO event VALUES(?,'session.execution.succeeded.1',1)").run(f.passage.coordinatorSessionID)
    const tag = (name: string) => Context.Service<never, unknown>(name)
    let graph = Context.empty() as Context.Context<never>
    const running = new Set<string>()
    // Natively the SQL client is asynchronous while a transaction holds the connection;
    // Effect.runSync then fails with AsyncFiberError. Settlement must only await it.
    let asyncSQL = false
    for (const [name, value] of [
      ["@opencode/storage/Database", { db: { $client: { unsafe: (sql: string, params: readonly unknown[]) => ({
        withoutTransform: asyncSQL ? Effect.promise(async () => db.prepare(sql).all(...params as []))
          : Effect.sync(() => db.prepare(sql).all(...params as [])) }) } } }],
      // Native shape (2.0.26): Session.active is an Effect of running IDs; SessionExecution is not exposed.
      ["@opencode/Location", {}], ["@opencode/Session", { active: Effect.sync(() => new Set(running)) }],
      ["@opencode/Form", { list: () => Effect.succeed([]) }], ["@opencode/Permission", { list: () => Effect.succeed([]) }],
      ["@opencode/Shell", { list: () => Effect.succeed([]) }],
    ] as const) graph = Context.add(graph, tag(name), value)
    const native = await Effect.runPromise(acquireNativePassageObservation().pipe(Effect.provide(graph)))
    const doc = (await f.calendar.read("schedule"))!
    const prefix = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
    const key = `${prefix}${RECURRENCE_STORAGE_PREFIX}/project/${stableToken(`${doc.projectID}\0${doc.projectCanonical}`, 24)}/${doc.id}`
    db.prepare("INSERT INTO kv VALUES(?,?)").run(key, JSON.stringify(doc))
    native.assertScheduleCurrent(doc, true)
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ ...doc, state: "paused" }), key)
    assert.throws(() => native.assertScheduleCurrent(doc, true), /schedule changed/)
    native.assertScheduleCurrent(doc, false)
    asyncSQL = true
    const observe = async () => observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!, storage: f.storage,
      native, directory: f.root, current: () => true, signal: new AbortController().signal })
    const settled = (await observe())!
    assert.equal(settled.result.outcome, "completed")
    running.add(f.passage.coordinatorSessionID)
    assert.equal(await observe(), undefined, "a natively running coordinator blocks settlement")
    running.clear()
    content[4].state.status = "running"
    db.prepare("UPDATE session_message SET data=? WHERE id='msg_tools'").run(JSON.stringify({ content }))
    assert.equal(await observe(), undefined)
    content[4].state.status = "completed"
    db.prepare("UPDATE session_message SET data=? WHERE id='msg_tools'").run(JSON.stringify({ content }))
    assert.equal((await observe())?.result.outcome, "completed")
    db.prepare("INSERT INTO session_inbox VALUES('msg_pending',?)").run(f.passage.coordinatorSessionID)
    assert.equal(await observe(), undefined, "an inbox item blocks quiescence")
    db.prepare("DELETE FROM session_inbox").run()
    // A control committed after the observation is a revision CAS conflict, never a lost archive.
    const stale = (await observe())!
    const current = (await f.calendar.read("schedule"))!
    await f.calendar.setState("schedule", current.revision, "paused", () => true)
    await assert.rejects(f.calendar.finish("schedule", stale.result, 30, () => true, stale.expectedRevision), /revision conflict/)
    assert.ok((await f.calendar.read("schedule"))!.pending, "conflict leaves the exact passage pending")
    const fresh = (await observe())!
    const archived = await f.calendar.finish("schedule", fresh.result, 30, () => true, fresh.expectedRevision)
    assert.equal(archived.pending, null)
    assert.equal(archived.history.at(-1)?.result.outcome, "completed")
  } finally { db.close(); await f.dispose() }
})
