import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect } from "effect"
import { acquireNativePassageObservation, qualifyNativePassageStorage } from "./native-passage-observation"
import { passageFixture } from "./native-passage-test-fixture"
import { observeNativePassageSettlement, observePassageFamilySettlement } from "./native-recurrence-settlement"
import type { CoordinatorBaseline } from "../../missions/mission-coordinator-baseline"
import { RECURRENCE_STORAGE_PREFIX } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"

test("terminal storage capability checks real columns and JSON projections without rows or effects", async () => {
  const db = new DatabaseSync(":memory:")
  try {
    db.exec(`CREATE TABLE session_message(id TEXT,seq INTEGER,type TEXT,data TEXT); CREATE TABLE kv(key TEXT,value TEXT);
      CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT)`)
    const sql: string[] = []
    const graph = Context.make(Context.Service<never, unknown>("@opencode/storage/Database"), { db: { $client: {
      unsafe: (query: string) => { sql.push(query); return { withoutTransform: Effect.sync(() => db.prepare(query).all()) } },
    } } })
    await Effect.runPromise(qualifyNativePassageStorage().pipe(Effect.provide(graph)))
    assert.equal(sql.length, 3); assert.ok(sql.every(query => query.endsWith("WHERE 0")))
    db.exec("DROP TABLE session_message; CREATE TABLE session_message(id TEXT,type TEXT,data TEXT)")
    await assert.rejects(Effect.runPromise(qualifyNativePassageStorage().pipe(Effect.provide(graph))), /seq/)
  } finally { db.close() }
})

test("an old inactive claim remains uncertain across wakes until a correlated native terminal releases it", async () => {
  const f = await passageFixture(), db = new DatabaseSync(":memory:")
  try {
    await f.start() // admitted, no report: the hard kill cut the coordinator mid-turn
    db.exec(`CREATE TABLE session_v2(id TEXT,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,time_suspended INTEGER);
      CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,data TEXT,seq INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT);
      CREATE TABLE session_inbox(id TEXT,session_id TEXT);
      CREATE TABLE event(aggregate_id TEXT,type TEXT,seq INTEGER);
      CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);`)
    // Managed restart recovery can hold the durable claim before taking local ownership.
    db.prepare("INSERT INTO session_v2 VALUES(?,NULL,'project',?,NULL,1000)").run(f.passage.coordinatorSessionID, f.root)
    db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES(?,?,'synthetic','{}')").run(f.passage.messageID, f.passage.coordinatorSessionID)
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
    const before = await f.calendar.read("schedule")
    for (let wake = 0; wake < 3; wake++) assert.equal(await observe(2000), undefined, "old inactive claim never becomes terminal by age")
    assert.deepEqual(await f.calendar.read("schedule"), before, "no archive, cursor advance or replacement pending")
    db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES('msg_terminal',?,'idle',?)")
      .run(f.passage.coordinatorSessionID, JSON.stringify({ outcome: "interrupted" }))
    assert.equal(await observe(2000), undefined, "even a stale idle cannot override a surviving claim")
    db.prepare("UPDATE session_v2 SET time_suspended=NULL").run()
    const settled = (await observe(2000))!
    assert.equal(settled.result.outcome, "ended-without-report")
    assert.equal(settled.result.reason, "interrupted")
    const archived = await f.calendar.finish("schedule", settled.result, 30, () => true, settled.expectedRevision)
    assert.equal(archived.history.at(-1)?.result.reason, "interrupted")
    assert.deepEqual(f.counts().sends, 1, "settlement never sends a continuation")
  } finally { db.close(); await f.dispose() }
})

// Native `serve` (as of the minimum supported OpenCode) leaves the `event` table empty; each execution terminal is
// projected into a durable `idle` message whose `outcome` carries the failure.
async function idleFamily(finish?: "completed") {
  const f = await passageFixture(), db = new DatabaseSync(":memory:")
  await f.start()
  if (finish) await f.finish(finish)
  db.exec(`CREATE TABLE session_v2(id TEXT,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,time_suspended INTEGER);
    CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,data TEXT,seq INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT);
    CREATE TABLE session_inbox(id TEXT,session_id TEXT);
    CREATE TABLE event(aggregate_id TEXT,type TEXT,seq INTEGER);
    CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);`)
  const coordinator = f.passage.coordinatorSessionID, child = "ses_failed_child"
  db.prepare("INSERT INTO session_v2 VALUES(?,NULL,'project',?,NULL,NULL)").run(coordinator, f.root)
  db.prepare("INSERT INTO session_v2 VALUES(?,?,'project',?,NULL,NULL)").run(child, coordinator, f.root)
  db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES(?,?,'synthetic','{}')").run(f.passage.messageID, coordinator)
  db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES('msg_child_input',?,'user','{}')").run(child)
  const idle = (id: string, session: string, outcome: string) => db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES(?,?,'idle',?)")
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
  return { f, db, idle, coordinator, child, observe, native, dispose: async () => { db.close(); await f.dispose() } }
}

test("adoption checkpoints separate old/pruned children, inherited running work, new helpers and continued children without clocks", async () => {
  const t = await idleFamily()
  try {
    t.db.exec("ALTER TABLE session_v2 ADD COLUMN time_updated INTEGER NOT NULL DEFAULT 10")
    t.db.exec("ALTER TABLE session_v2 ADD COLUMN metadata TEXT; CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER)")
    t.db.prepare("INSERT INTO event_sequence VALUES(?,10)").run(t.child)
    const mission = (await t.f.passage.journal.snapshot()).missions[0]
    const owner = { passageID: "passage", missionID: mission.id, coordinatorSessionID: t.coordinator }
    const stamp = (id: string, messageID: string, sequence = 11) => {
      t.db.prepare("UPDATE session_v2 SET metadata=? WHERE id=?").run(JSON.stringify({ "codenomad.passage-input": { ...owner, messageID } }), id)
      t.db.prepare("INSERT INTO event_sequence VALUES(?,?) ON CONFLICT(aggregate_id) DO UPDATE SET seq=excluded.seq").run(id, sequence)
    }
    t.idle("old_child_failed", t.child, "failed")
    const row = t.db.prepare("SELECT seq FROM session_message WHERE id='old_child_failed'").get()!
    const baseline: CoordinatorBaseline = [[t.child, Number(row.seq), "old_child_failed", null, 10]]
    const observe = () => observePassageFamilySettlement({ native: t.native, projectID: "project", mission,
      coordinatorSessionID: t.coordinator, messageID: t.f.passage.messageID, directory: t.f.root, current: () => true,
      signal: new AbortController().signal, reusedCoordinator: true, coordinatorBaseline: baseline, coordinatorOwner: owner })
    t.idle("root_done", t.coordinator, "succeeded")
    assert.equal((await observe())?.outcome, "ended-without-report", "old failure is historical")
    t.db.exec("DELETE FROM session_message WHERE id='msg_child_input'")
    assert.equal((await observe())?.outcome, "ended-without-report", "pruned old input keeps its qualified native boundary")
    t.db.prepare("INSERT INTO session_v2(id,parent_id,project_id,directory) VALUES('new_child',?,'project',?)").run(t.coordinator, t.f.root)
    assert.equal(await observe(), undefined, "new unbound child without input/terminal stays unknown")
    t.db.exec("INSERT INTO session_message(id,session_id,type,data) VALUES('new_input','new_child','user','{}')")
    stamp("new_child", "new_input")
    t.idle("new_failed", "new_child", "failed")
    assert.equal((await observe())?.outcome, "failed", "new ordinary child failure is attributed")
    t.db.exec("DELETE FROM session_message WHERE session_id='new_child'; DELETE FROM session_v2 WHERE id='new_child'")
    t.db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES('continuation',?,'user','{}')").run(t.child)
    stamp(t.child, "continuation")
    assert.equal(await observe(), undefined, "old child continuation requires its new terminal")
    t.idle("continued_done", t.child, "succeeded")
    assert.equal((await observe())?.outcome, "ended-without-report", "old failures stay before the continuation anchor")
    t.db.exec("DELETE FROM session_message WHERE id='continuation'")
    assert.equal(await observe(), undefined, "a pruned continuation cannot fall back to the old terminal")
    t.idle("retained_failure", t.child, "failed")
    t.db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES('later_input',?,'user','{}')").run(t.child)
    t.idle("later_done", t.child, "succeeded")
    assert.equal(await observe(), undefined, "later retained input cannot substitute for the pruned first owned input")
    t.db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES('inherited_input',?,'user','{}')").run(t.child)
    const latest = t.db.prepare("SELECT seq FROM session_message WHERE id='inherited_input'").get()!
    baseline[0] = [t.child, Number(latest.seq), "inherited_input", "inherited_input", 12]
    stamp(t.child, "inherited_input", 12)
    t.idle("inherited_done", t.child, "succeeded")
    assert.equal((await observe())?.outcome, "ended-without-report", "already running work completes under its captured input")
    t.idle("inherited_failure", t.child, "failed")
    t.db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES('inherited_later',?,'user','{}')").run(t.child)
    t.idle("inherited_later_done", t.child, "succeeded")
    assert.equal((await observe())?.outcome, "failed", "a newer successful input cannot hide a failure in inherited owned work")
    t.db.exec("DELETE FROM session_message WHERE id='inherited_input'")
    await assert.rejects(observe(), /boundary unavailable/, "a lost inherited anchor remains unknown")
    baseline[0] = [t.child, Number(row.seq), "old_child_failed", null, 10]
    t.db.prepare("DELETE FROM session_message WHERE session_id=? AND seq>?").run(t.child, row.seq)
    t.db.prepare("UPDATE session_v2 SET metadata=NULL WHERE id=?").run(t.child)
    assert.equal(t.db.prepare("SELECT time_updated FROM session_v2 WHERE id=?").get(t.child)!.time_updated, 10)
    assert.equal(await observe(), undefined, "equal recency timestamps cannot hide admitted and removed work beyond the durable sequence")
  } finally { await t.dispose() }
})

test("a native failed turn without a final report archives failed, read from the idle projection", async () => {
  const t = await idleFamily()
  try {
    t.idle("msg_idle_ok", t.coordinator, "succeeded")
    t.idle("msg_idle_child_ok", t.child, "succeeded")
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
    t.idle("msg_idle_child_ok", t.child, "succeeded")
    assert.equal((await t.observe())?.outcome, "completed")
  } finally { await t.dispose() }
})

test("terminal correlation uses the exact original input and native sequence, excluding unrelated failure history", async () => {
  const t = await idleFamily()
  try {
    t.db.prepare("INSERT INTO session_message(id,session_id,type,data,seq) VALUES('msg_history',?,'idle',?,-1)")
      .run(t.coordinator, JSON.stringify({ outcome: "failed" }))
    t.idle("msg_idle_child", t.child, "succeeded")
    assert.equal(await t.observe(), undefined, "an idle before the pending original cannot qualify")
    t.idle("msg_idle_original", t.coordinator, "succeeded")
    assert.equal((await t.observe())?.outcome, "ended-without-report", "older unrelated failure is excluded")
    t.db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES('msg_new',?,'user','{}')").run(t.coordinator)
    assert.equal(await t.observe(), undefined, "a delivered input after the terminal is uncovered")
    t.idle("msg_idle_new", t.coordinator, "succeeded")
    assert.equal((await t.observe())?.outcome, "ended-without-report")
    t.db.prepare("DELETE FROM session_message WHERE id=?").run(t.f.passage.messageID)
    for (let wake = 0; wake < 3; wake++) assert.equal(await t.observe(), undefined, "pruned original keeps the exact pending uncertain")
    assert.equal(t.f.counts().sends, 1)
  } finally { await t.dispose() }
})

test("an undelivered native background result blocks family settlement even after the child's terminal", async () => {
  const t = await idleFamily("completed")
  try {
    t.idle("msg_idle_root", t.coordinator, "succeeded")
    t.idle("msg_idle_child", t.child, "succeeded")
    const pending = { status: "completed", recovery: { kind: "subagent", parentSessionID: t.coordinator, childSessionID: t.child } }
    t.db.prepare("INSERT INTO kv VALUES('job.background/msg_delivery',?)").run(JSON.stringify(pending))
    for (let wake = 0; wake < 3; wake++) assert.equal(await t.observe(), undefined, "a durable delivery may still wake the root")
    t.db.prepare("DELETE FROM kv").run()
    assert.equal((await t.observe())?.outcome, "completed")
    t.db.prepare("INSERT INTO kv VALUES('job.background/msg_foreign',?)")
      .run(JSON.stringify({ recovery: { kind: "subagent", parentSessionID: "ses_foreign", childSessionID: "ses_elsewhere" } }))
    assert.equal((await t.observe())?.outcome, "completed", "unrelated known ownership is excluded")
    t.db.prepare("UPDATE kv SET value='{}'").run()
    await assert.rejects(t.observe(), /background coverage unavailable/, "unknown background ownership fails closed")
  } finally { await t.dispose() }
})

test("read/grep/edit/webfetch/shell completed calls do not block real passage settlement", async () => {
  const f = await passageFixture(), db = new DatabaseSync(":memory:")
  try {
    await f.start()
    await f.finish()
    db.exec(`CREATE TABLE session_v2(id TEXT,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,time_suspended INTEGER);
      CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,data TEXT,seq INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT);
      CREATE TABLE session_inbox(id TEXT,session_id TEXT);
      CREATE TABLE event(aggregate_id TEXT,type TEXT,seq INTEGER);
      CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);`)
    // Real Windows native SQL uses `/` while Location/schedule paths use `\`.
    db.prepare("INSERT INTO session_v2 VALUES(?,NULL,'project',?,NULL,NULL)").run(f.passage.coordinatorSessionID, f.root.replaceAll("\\", "/"))
    db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES(?,?,'synthetic','{}')").run(f.passage.messageID, f.passage.coordinatorSessionID)
    const content = ["read", "grep", "edit", "webfetch", "shell"].map(name => ({ type: "tool", name, state: { status: "completed" } }))
    db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES('msg_tools',?,'assistant',?)").run(f.passage.coordinatorSessionID, JSON.stringify({ content }))
    db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES('msg_idle',?,'idle',?)")
      .run(f.passage.coordinatorSessionID, JSON.stringify({ outcome: "succeeded" }))
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
      // Native shape (as of the minimum supported OpenCode): Session.active is an Effect of running IDs; SessionExecution is not exposed.
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
    // Split parts override even a stale inline completed copy.
    content[4].state.status = "running"
    db.prepare("INSERT INTO session_part VALUES('msg_tools',?,0,'tool',?)").run(f.passage.coordinatorSessionID, JSON.stringify(content[4]))
    assert.equal(await observe(), undefined, "split running tool blocks settlement")
    content[4].state.status = "completed"
    db.prepare("UPDATE session_part SET data=?").run(JSON.stringify(content[4]))
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
