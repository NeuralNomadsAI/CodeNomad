import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect } from "effect"
import { acquireNativePassageObservation } from "./native-passage-observation"
import { passageFixture } from "./native-passage-test-fixture"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"
import { RECURRENCE_STORAGE_PREFIX } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"

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
    db.prepare("INSERT INTO session_v2 VALUES(?,NULL,'project',?,NULL,NULL)").run(f.passage.coordinatorSessionID, f.root)
    db.prepare("INSERT INTO session_message VALUES(?,?,'synthetic','{}')").run(f.passage.messageID, f.passage.coordinatorSessionID)
    const content = ["read", "grep", "edit", "webfetch", "shell"].map(name => ({ type: "tool", name, state: { status: "completed" } }))
    db.prepare("INSERT INTO session_message VALUES('msg_tools',?,'assistant',?)").run(f.passage.coordinatorSessionID, JSON.stringify({ content }))
    db.prepare("INSERT INTO event VALUES(?,'session.execution.succeeded.1',1)").run(f.passage.coordinatorSessionID)
    const tag = (name: string) => Context.Service<never, unknown>(name)
    let graph = Context.empty() as Context.Context<never>
    const running = new Set<string>()
    for (const [name, value] of [
      ["@opencode/storage/Database", { db: { $client: { unsafe: (sql: string, params: readonly unknown[]) => ({
        withoutTransform: Effect.sync(() => db.prepare(sql).all(...params as [])) }) } } }],
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
    const observe = async () => observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!, storage: f.storage,
      native, directory: f.root, current: () => true, signal: new AbortController().signal })
    const settled = (await observe())!
    assert.equal(settled.result.outcome, "completed")
    settled.current()
    running.add(f.passage.coordinatorSessionID)
    assert.equal(await observe(), undefined, "a natively running coordinator blocks settlement")
    assert.throws(settled.current, /became active/)
    running.clear()
    content[4].state.status = "running"
    db.prepare("UPDATE session_message SET data=? WHERE id='msg_tools'").run(JSON.stringify({ content }))
    assert.equal(await observe(), undefined)
    content[4].state.status = "completed"
    db.prepare("UPDATE session_message SET data=? WHERE id='msg_tools'").run(JSON.stringify({ content }))
    assert.equal((await observe())?.result.outcome, "completed")
    db.prepare("INSERT INTO session_inbox VALUES('msg_pending',?)").run(f.passage.coordinatorSessionID)
    assert.equal(await observe(), undefined, "an inbox item blocks quiescence")
    assert.throws(settled.current, /became active/)
  } finally { db.close(); await f.dispose() }
})
