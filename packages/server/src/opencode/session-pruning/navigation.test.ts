import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { readNavigationWindow, readSessionOutline } from "./navigation-store"

const scope = { directory: "/repo", projectID: "p", sessionID: "s" }
const id = (n: number) => `message-${String(n).padStart(5, "0")}`
function fixture(count = 1500) {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);
    INSERT INTO session_v2 VALUES ('s','/repo','p',NULL,NULL);`)
  const insert = db.prepare("INSERT INTO session_message VALUES (?,'s','user',?,?)")
  for (let n = 0; n < count; n++) insert.run(id(n), n * 7, JSON.stringify({ text: `Passage ${n}`, time: { created: n + 1 } }))
  return db
}
const signal = () => new AbortController().signal
test("direct distant windows retain native sequence order, bound content and overlap adjacent windows", async () => {
  const db = fixture()
  try {
    const around = await readNavigationWindow(db, scope, { kind: "around", messageID: id(1000) }, signal())
    assert.equal(around.status, "window")
    if (around.status !== "window") return
    assert.equal(around.messages.length, 200)
    assert.equal(around.messages[80].id, id(1000))
    assert.equal(around.messages[0].id, id(920))
    assert.equal(around.messages.at(-1)?.id, id(1119))
    assert.equal(around.latest, false)
    assert.deepEqual(await readNavigationWindow(db, scope, around.resume, signal()), around)
    const before = await readNavigationWindow(db, scope, around.older!, signal())
    assert.equal(before.status, "window")
    if (before.status !== "window") return
    assert.equal(before.messages.length, 200)
    assert(before.messages.some(message => message.id === around.messages[0].id))
    const after = await readNavigationWindow(db, scope, around.newer!, signal())
    assert.equal(after.status, "window")
    if (after.status !== "window") return
    assert(after.messages.some(message => message.id === around.messages.at(-1)?.id))
    assert.equal(after.messages.at(-1)?.id, id(1303))
    assert.equal(db.isTransaction, false)
  } finally { db.close() }
})
test("outline pages remain bounded and full despite scheduler delays, and exclude newly appended rows", async (t) => {
  const db = fixture()
  let clock = 0
  t.mock.method(performance, "now", () => clock += 100)
  try {
    const first = await readSessionOutline(db, scope, undefined, signal())
    assert.equal(first.status, "outline")
    if (first.status !== "outline") return
    assert.equal(first.total, 1500)
    assert.equal(first.entries.length, 256, "event-loop delays must not fragment metadata into tiny RPC pages")
    assert(first.cursor)
    db.prepare("INSERT INTO session_message VALUES (?,'s','user',?,?)").run(id(1500), 1500 * 7, JSON.stringify({ text: "Later", time: { created: 2000 } }))
    const ids = first.entries.map(entry => entry.id)
    let cursor: { after: number; through: number } | null = first.cursor
    while (cursor) {
      const page = await readSessionOutline(db, scope, cursor, signal())
      assert.equal(page.status, "outline")
      if (page.status !== "outline") break
      assert(page.entries.length <= 256)
      assert(page.entries.every(entry => entry.preview.length <= 220 && !("content" in entry)))
      ids.push(...page.entries.map(entry => entry.id)); cursor = page.cursor
    }
    assert.equal(ids.length, 1500)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(ids.at(-1), id(1499))
  } finally { db.close() }
})
test("navigation enforces ownership, message membership and staged undo visibility", async () => {
  const db = fixture()
  try {
    await assert.rejects(readNavigationWindow(db, { ...scope, directory: "/foreign" }, { kind: "latest" }, signal()))
    assert.equal(db.isTransaction, false)
    assert.deepEqual(await readNavigationWindow(db, scope, { kind: "around", messageID: "foreign" }, signal()), { status: "blocked", reason: "conflict" })
    db.prepare("UPDATE session_v2 SET revert=?").run(JSON.stringify({ messageID: id(300) }))
    const latest = await readNavigationWindow(db, scope, { kind: "latest" }, signal())
    assert.equal(latest.status, "window")
    if (latest.status === "window") {
      assert.equal(latest.messages.at(-1)?.id, id(299))
      assert.equal(latest.newer, null)
      assert.equal(latest.latest, true)
    }
    assert.equal((await readNavigationWindow(db, scope, { kind: "around", messageID: id(1000) }, signal())).status, "blocked")
    const outline = await readSessionOutline(db, scope, undefined, signal())
    if (outline.status === "outline") assert.equal(outline.total, 300)
  } finally { db.close() }
})
test("oversized windows fail explicitly and cancelled reads release their transaction", async () => {
  const db = fixture(1)
  try {
    db.prepare("UPDATE session_message SET data=?").run(JSON.stringify({ text: "x".repeat(16 * 1024 * 1024), time: { created: 1 } }))
    assert.equal((await readNavigationWindow(db, scope, { kind: "latest" }, signal())).status, "blocked")
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(readNavigationWindow(db, scope, { kind: "latest" }, cancelled.signal), /abort/i)
    assert.equal(db.isTransaction, false)
  } finally { db.close() }
})

test("navigation yields for cancellation and outline byte budgets retain the next unread message", async () => {
  const db = fixture(300)
  try {
    const controller = new AbortController()
    setImmediate(() => controller.abort())
    await assert.rejects(readNavigationWindow(db, scope, { kind: "latest" }, controller.signal), /abort/i)
    assert.equal(db.isTransaction, false)
    const data = JSON.stringify({ text: "large".repeat(2 * 1024 * 1024), time: { created: 1 } })
    for (let n = 0; n < 3; n++) db.prepare("UPDATE session_message SET data=? WHERE id=?").run(data, id(n))
    const first = await readSessionOutline(db, scope, undefined, signal())
    assert.equal(first.status, "outline")
    if (first.status !== "outline") return
    assert.deepEqual(first.entries.map(entry => entry.id), [id(0), id(1)])
    const next = await readSessionOutline(db, scope, first.cursor!, signal())
    if (next.status !== "outline") assert.fail('Expected next outline page')
    assert.equal(next.entries[0].id, id(2))
  } finally { db.close() }
})
