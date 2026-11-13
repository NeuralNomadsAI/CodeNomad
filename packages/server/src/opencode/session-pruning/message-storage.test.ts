import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { createHash } from "node:crypto"
import { messageStorage } from "./message-storage"
import { queryHistoryPage } from "./history-store"
import { queryRankedHistory } from "./history-ranked-store"
import { readNavigationWindow } from "./navigation-store"
import { readSessionOutline } from "./outline-index"
import { readOutlinePreviews } from "./outline-preview"
import { listSessionAssets } from "./assets-store"
import { pruneTransaction } from "./transaction"
import { previewContent } from "./planner"
import { projectStoredMedia } from "./media-blob"
import { openFixture } from "./assets-gallery-fixture"

const signal = () => new AbortController().signal
const partTable = `CREATE TABLE session_part(message_id TEXT NOT NULL,session_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
  type TEXT NOT NULL,call_id TEXT,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,data TEXT NOT NULL,
  PRIMARY KEY(message_id,ordinal));`
const content = [
  { type: "text", text: "Split needle answer", time: { created: 1, completed: 2 } },
  { type: "tool", id: "call_read", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "technical needle" }], metadata: {} }, time: { created: 3, completed: 4 } },
  { type: "reasoning", text: "private reasoning", time: { created: 5, completed: 6 } },
  { type: "text", text: "Inline tail", time: { created: 7, completed: 8 } },
]
function split(db: DatabaseSync, count: number, messageID = "m") {
  const row = db.prepare("SELECT session_id,data FROM session_message WHERE id=?").get(messageID)!
  const data = JSON.parse(String(row.data))
  const insert = db.prepare("INSERT INTO session_part VALUES(?,?,?,?,?,?,?,?)")
  data.content.slice(0, count).forEach((part: any, index: number) => insert.run(messageID, row.session_id, index, part.type, part.id ?? null, 1, 1, JSON.stringify(part)))
  db.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify({ ...data, content: data.content.slice(count) }), messageID)
}
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(":memory:")
  t.after(() => db.close())
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,project_id TEXT,workspace_id TEXT,parent_id TEXT,title TEXT,metadata TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,time_created INTEGER,time_updated INTEGER); ${partTable}`)
  const directory = path.resolve("split-fixture").replaceAll("\\", "/")
  db.prepare("INSERT INTO session_v2 VALUES('s',?,'project',NULL,NULL,'Title','{}',NULL)").run(directory)
  db.prepare("INSERT INTO session_message VALUES('m','s','assistant',1,1,1,?)").run(JSON.stringify({ time: { created: 1, completed: 9 }, metadata: { keep: true }, content }))
  const scope = { sessionID: "s", directory, projectID: "project" }
  const read = () => JSON.parse(String(db.prepare(`SELECT data FROM ${messageStorage(db).table} WHERE id='m'`).get()!.data))
  return { db, scope, read }
}

test("inline, split and mixed messages share history, ranked search, navigation and outline positions", async t => {
  for (const count of [0, 2, 4]) {
    const f = fixture(t)
    split(f.db, count)
    assert.deepEqual(f.read().content, content)
    const literal = await queryHistoryPage(f.db, f.scope, { purpose: "search", query: "split needle", includeTechnical: false }, signal())
    assert.equal(literal.hits.length, 1)
    assert.equal(literal.hits[0].partIndex, 0)
    const ranked = await queryRankedHistory(f.db, f.scope, { version: 1, query: "split needle", includeTechnical: false, limit: 10 }, signal(), async () => "owned")
    assert.equal(ranked.hits.length, 1)
    const window = await readNavigationWindow(f.db, f.scope, { kind: "oldest" }, signal())
    assert.equal(window.status, "window")
    if (window.status === "window") assert.deepEqual(window.messages[0].content, content)
    const outline = await readSessionOutline(f.db, f.scope, undefined, signal(), -1, [], true)
    assert.equal(outline.status, "outline")
    if (outline.status === "outline") assert.deepEqual([outline.entries[0].tools, outline.entries[0].reasoning, outline.entries[0].text], [1, 1, 2])
    const previews = await readOutlinePreviews(f.db, f.scope, ["m"], signal())
    assert.equal(previews.status, "previews")
    if (previews.status === "previews") assert.match(previews.entries[0].text, /Split needle answer[\s\S]*Inline tail/)
  }
})

test("split pruning preserves retained bytes, native ordinals and inline tail, with atomic replay receipts", t => {
  const f = fixture(t)
  split(f.db, 3)
  const before = f.db.prepare("SELECT ordinal,data FROM session_part ORDER BY ordinal").all()
  const preview = previewContent(f.read())
  assert.equal(preview.status, "preview")
  if (preview.status !== "preview") return
  const request = { sessionID: "s", messageID: "m", revision: preview.revision, indexes: [1, 2] }
  const result = pruneTransaction(f.db, request, () => undefined, "receipt/")
  assert.equal(result.status, "pruned")
  assert.deepEqual(f.read().content, [content[0], content[3]])
  assert.deepEqual(f.db.prepare("SELECT ordinal,data FROM session_part ORDER BY ordinal").all(), [before[0]])
  assert.deepEqual(JSON.parse(String(f.db.prepare("SELECT data FROM session_message").get()!.data)).content, [content[3]])
  assert.deepEqual(pruneTransaction(f.db, request, () => undefined, "receipt/"), result)
  assert.deepEqual(f.read().content, [content[0], content[3]])
  assert.equal(f.read().metadata.keep, true)
})

test("a failed inline CAS rolls back split deletion and receipt together", t => {
  const f = fixture(t)
  split(f.db, 3)
  const before = f.read(), rows = f.db.prepare("SELECT * FROM session_part ORDER BY ordinal").all()
  const preview = previewContent(before)
  assert.equal(preview.status, "preview")
  if (preview.status !== "preview") return
  const proxy = new Proxy(f.db, { get(db, name) {
    if (name === "prepare") return (sql: string) => sql.startsWith("UPDATE session_message SET data=json_set")
      ? { run: () => ({ changes: 0 }) } : db.prepare(sql)
    const value = Reflect.get(db, name, db)
    return typeof value === "function" ? value.bind(db) : value
  } })
  assert.deepEqual(pruneTransaction(proxy, { sessionID: "s", messageID: "m", revision: preview.revision, indexes: [1] }, () => undefined, "receipt/"), { status: "blocked", reason: "conflict" })
  assert.deepEqual(f.db.prepare("SELECT * FROM session_part ORDER BY ordinal").all(), rows)
  assert.deepEqual(f.read(), before)
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM kv").get()!.n, 0)
})

test("part-only edits invalidate a pruning revision even when the inline envelope is unchanged", t => {
  const f = fixture(t)
  split(f.db, 3)
  const preview = previewContent(f.read())
  assert.equal(preview.status, "preview")
  if (preview.status !== "preview") return
  const inline = f.db.prepare("SELECT data FROM session_message").get()!.data
  f.db.prepare("UPDATE session_part SET data=json_set(data,'$.text','changed reasoning') WHERE ordinal=2").run()
  const rows = f.db.prepare("SELECT * FROM session_part ORDER BY ordinal").all()
  assert.deepEqual(pruneTransaction(f.db, { sessionID: "s", messageID: "m", revision: preview.revision, indexes: [2] }, () => undefined), { status: "blocked", reason: "conflict" })
  assert.deepEqual(f.db.prepare("SELECT * FROM session_part ORDER BY ordinal").all(), rows)
  assert.equal(f.db.prepare("SELECT data FROM session_message").get()!.data, inline)
})

test("foreign ownership and mismatched tool identity fail closed; unknown table shapes are refused", async t => {
  for (const mutation of ["session_id='foreign'", "call_id='wrong'"]) {
    const f = fixture(t)
    split(f.db, 3)
    f.db.exec(`UPDATE session_part SET ${mutation} WHERE ordinal=1`)
    assert.equal((await readNavigationWindow(f.db, f.scope, { kind: "oldest" }, signal())).status, "blocked")
  }
  const f = fixture(t)
  f.db.exec("DROP TABLE session_part; CREATE TABLE session_part(data TEXT)")
  assert.throws(() => messageStorage(f.db), /Unsupported native part storage/)
})

test("split pruning releases only dropped message media refs and preserves blobs shared by another owner", t => {
  for (const shared of [false, true]) {
    const f = fixture(t), bytes = Buffer.from("synthetic image"), hash = createHash("sha256").update(bytes).digest("hex")
    f.db.exec("CREATE TABLE blob(hash TEXT PRIMARY KEY,data BLOB); CREATE TABLE blob_ref(session_id TEXT,message_id TEXT,hash TEXT)")
    f.db.prepare("INSERT INTO blob VALUES(?,?)").run(hash, bytes)
    f.db.prepare("INSERT INTO blob_ref VALUES('s','m',?)").run(hash)
    if (shared) f.db.prepare("INSERT INTO blob_ref VALUES('other','other',?)").run(hash)
    const data = f.read()
    data.content[1].state.content = [{ type: "file", mime: "image/png", name: "image.png", uri: `media:${hash}` }]
    f.db.prepare("UPDATE session_message SET data=?").run(JSON.stringify(data))
    split(f.db, 3)
    const stored = f.read(), projection = projectStoredMedia(f.db, stored, Buffer.byteLength(JSON.stringify(stored)), 16 * 1024 * 1024)
    assert.equal(projection.status, "ok")
    if (projection.status !== "ok") continue
    const preview = previewContent(projection.data)
    assert.equal(preview.status, "preview")
    if (preview.status !== "preview") continue
    const result = pruneTransaction(f.db, { sessionID: "s", messageID: "m", revision: preview.revision, indexes: [1] }, () => undefined)
    assert.equal(result.status, "pruned")
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM blob_ref WHERE message_id='m'").get()!.n, 0)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM blob").get()!.n, shared ? 1 : 0)
    assert.deepEqual(f.read().content, [content[0], content[2], content[3]])
  }
})

test("plain and blob-backed image galleries retain targets, pixels and provenance with mixed storage", async t => {
  for (const kind of ["plain", "blob"] as const) {
    const f = openFixture(kind)
    t.after(f.close)
    const before = await f.walk(true)
    const image = before.all.find(entry => entry.kind === "image")!
    assert(image.kind === "image")
    const pixels = await f.read(image.target), reference = await f.reference(image.target)
    f.raw.exec(partTable)
    for (const row of f.raw.prepare("SELECT id,data FROM session_message WHERE type='assistant'").all()) {
      const n = JSON.parse(String(row.data)).content.length
      split(f.raw, Math.max(1, n - 1), String(row.id))
    }
    assert.deepEqual(await f.walk(true), before)
    assert.deepEqual(await f.read(image.target), pixels)
    assert.deepEqual(await f.reference(image.target), reference)
    assert.equal((await listSessionAssets(f.db, f.scope, undefined, signal())).status, "page")
  }
})

test("split headers retain rowid seeks and do not execute JSON decoding", t => {
  const f = fixture(t)
  split(f.db, 3)
  const storage = messageStorage(f.db)
  const bytecode = f.db.prepare(`EXPLAIN SELECT ${storage.bytes()},time_updated FROM ${storage.table} WHERE id='m'`).all()
  assert(!bytecode.some(op => String(op.p4).includes("json_")), "metadata headers do not reconstruct or decode messages")
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT m.rowid FROM ${storage.table} m WHERE m.rowid>? AND m.rowid<=? ORDER BY m.rowid DESC LIMIT 128`).all(0, 128)
  assert(plan.some(row => /SEARCH raw USING INTEGER PRIMARY KEY/.test(String(row.detail))))
})

test("too many small split rows are refused before aggregate JSON is built", t => {
  const f = fixture(t)
  f.db.prepare("UPDATE session_message SET data=json_set(data,'$.content',json('[]'))").run()
  const insert = f.db.prepare("INSERT INTO session_part VALUES('m','s',?,'text',NULL,1,1,?)")
  f.db.exec("BEGIN")
  for (let index = 0; index < 100_002; index++) insert.run(index, '{"type":"text","text":""}')
  f.db.exec("COMMIT")
  const storage = messageStorage(f.db)
  const row = f.db.prepare(`SELECT ${storage.bytes()} AS bytes,data FROM ${storage.table} WHERE id='m'`).get()!
  assert(Number(row.bytes) < 16 * 1024 * 1024)
  assert.equal(row.data, null)
})

test("oversized or malformed split rows cannot become empty successful reads or writes", async t => {
  const f = fixture(t)
  split(f.db, 3)
  const inline = f.db.prepare("SELECT data FROM session_message").get()!.data
  f.db.prepare("UPDATE session_part SET data=? WHERE ordinal=0").run("x".repeat(16 * 1024 * 1024 + 1))
  assert.equal((await readNavigationWindow(f.db, f.scope, { kind: "oldest" }, signal())).status, "blocked")
  assert.equal(pruneTransaction(f.db, { sessionID: "s", messageID: "m", revision: "a".repeat(64), indexes: [1] }, () => undefined).status, "blocked")
  assert.equal(f.db.prepare("SELECT data FROM session_message").get()!.data, inline)
  f.db.prepare("UPDATE session_part SET data='{}' WHERE ordinal=0").run()
  assert.equal((await readNavigationWindow(f.db, f.scope, { kind: "oldest" }, signal())).status, "blocked")
})
