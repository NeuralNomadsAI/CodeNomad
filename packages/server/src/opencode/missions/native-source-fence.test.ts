import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect, Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { acquireNativeSourceFence, withNativeSourceTransaction } from "./native-source-fence"
import { nativePassageMessageDigest } from "./native-service-adapter"

test("source projections use the document transaction graph and reject changed messages, placement, families and journals", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close())
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,
    directory TEXT,workspace_id TEXT,metadata TEXT,revert TEXT,time_suspended INTEGER); CREATE TABLE session_inbox(session_id TEXT);
    CREATE TABLE session_message(id TEXT,seq INTEGER,type TEXT,data TEXT,session_id TEXT);
    CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT)`)
  const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
  db.prepare("INSERT INTO kv VALUES(?,?)").run(nativeKey("source"), '{"revision":1}')
  db.exec(`INSERT INTO session_v2(id,project_id,directory) VALUES('source','project','/project')`)
  const message = { type: "user", id: "msg_first", text: "exact source", time: { created: 1000 } }
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run(message.id, 1, message.type, JSON.stringify(message), "source")
  const database = Context.Service<never, unknown>("@opencode/storage/Database"), transaction = Context.Service<never, boolean>("source-test-transaction")
  let requireTransaction = false
  const client = Object.assign(() => {}, { unsafe: (sql: string, args: readonly unknown[]) => ({ withoutTransform: Effect.gen(function* () {
    if (requireTransaction) assert.equal(yield* transaction, true)
    return db.prepare(sql).all(...args as []).map(row => ({ ...row }))
  }) }) })
  const graph = Context.make(database, { db: { $client: client } })
  const factory = await Effect.runPromise(Effect.provide(acquireNativeSourceFence(() => true), graph))
  const document = factory(); document.document("source")
  requireTransaction = true
  assert.equal(withNativeSourceTransaction(Context.add(graph, transaction, true), document.current), true)
  requireTransaction = false
  db.prepare("UPDATE kv SET value=? WHERE key=?").run('{"revision":2}', nativeKey("source"))
  assert.throws(document.current, /changed during preparation/)
  const conversation = factory(); conversation.conversation("source")
  const prefix = factory(); prefix.message("source", message.id, nativePassageMessageDigest(Schema.decodeUnknownSync(SessionMessage.Info)(message)))
  const family = factory(); family.family("source")
  const assistant = { type: "assistant", id: "msg_assistant", time: { created: 1001, completed: 1002 }, agent: "worker",
    model: { providerID: "fixture", id: "fixture" }, content: [{ type: "text", text: "split source" }],
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run(assistant.id, 0, "assistant", JSON.stringify({ ...assistant, content: [] }), "source")
  db.prepare("INSERT INTO session_part VALUES(?,?,?,?,?)").run(assistant.id, "source", 0, "text", JSON.stringify(assistant.content[0]))
  const split = factory(); split.message("source", assistant.id, nativePassageMessageDigest(Schema.decodeUnknownSync(SessionMessage.Info)(assistant)))
  assert.equal(split.current(), true)
  db.exec("UPDATE session_part SET data=json_set(data,'$.text','changed source')")
  assert.throws(split.current, /changed during preparation/)
  db.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify({ ...message, text: "rewritten" }), message.id)
  assert.throws(prefix.current, /changed during preparation/)
  db.exec("UPDATE session_v2 SET time_suspended=1000 WHERE id='source'")
  assert.throws(family.current, /changed during preparation/)
  assert.throws(conversation.current, /changed during preparation/)
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run("msg_origin", 2, "synthetic", '{"text":"original admission"}', "source")
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run("msg_terminal", 3, "idle", '{"outcome":"succeeded"}', "source")
  for (const id of ["msg_origin", "msg_terminal"]) {
    for (const mutation of ["rewrite", "delete"] as const) {
      const exact = db.prepare("SELECT * FROM session_message WHERE id=?").get(id)!
      const correlation = factory(); correlation.family("source", "msg_origin")
      if (mutation === "rewrite") db.prepare("UPDATE session_message SET data='{}' WHERE id=?").run(id)
      else db.prepare("DELETE FROM session_message WHERE id=?").run(id)
      assert.throws(correlation.current, /changed during preparation/, `${mutation} ${id} must invalidate even with unchanged family max(seq)`)
      db.prepare("DELETE FROM session_message WHERE id=?").run(id)
      db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run(exact.id, exact.seq, exact.type, exact.data, exact.session_id)
    }
  }
  db.exec("INSERT INTO session_v2(id,parent_id,project_id,directory) VALUES('child','source','project','/project')")
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run("msg_child_input", 1, "user", '{"text":"child admission"}', "child")
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run("msg_child_terminal", 2, "idle", '{"outcome":"succeeded"}', "child")
  const descendants = factory(); descendants.family("source", "msg_origin")
  db.exec("DELETE FROM session_message WHERE id='msg_child_input'")
  assert.throws(descendants.current, /changed during preparation/, "descendant correlation also stays exact")
  const journal = factory(); journal.journal("journal/")
  db.prepare("INSERT INTO kv VALUES(?,?)").run(nativeKey("journal/event"), '{"id":"added"}')
  assert.throws(journal.current, /changed during preparation/)
  db.exec("UPDATE session_v2 SET revert='{}' WHERE id='source'")
  assert.throws(() => factory().conversation("source"), /placement unavailable/)
})
