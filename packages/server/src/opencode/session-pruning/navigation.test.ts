import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { readNavigationWindow, readSessionOutline } from "./navigation-store"
import { readOutlinePreviews } from "./outline-preview"

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
test("structural index pages stay bounded without excerpts and exclude newly appended rows", async (t) => {
  const db = fixture(18000)
  let clock = 0
  t.mock.method(performance, "now", () => clock += 100)
  try {
    const first = await readSessionOutline(db, scope, undefined, signal())
    assert.equal(first.status, "outline")
    if (first.status !== "outline") return
    assert.equal(first.total, 18000)
    assert.equal(first.entries.length, 16384, "structural metadata must not require hundreds of excerpt-sized pages")
    assert(first.cursor)
    db.prepare("INSERT INTO session_message VALUES (?,'s','user',?,?)").run(id(18000), 18000 * 7, JSON.stringify({ text: "Later", time: { created: 20000 } }))
    const ids = first.entries.map(entry => entry.id)
    let cursor: { after: number; through: number } | null = first.cursor
    while (cursor) {
      const page = await readSessionOutline(db, scope, cursor, signal())
      assert.equal(page.status, "outline")
      if (page.status !== "outline") break
      assert(page.entries.length <= 16384)
      assert(page.entries.every(entry => !("preview" in entry) && !("content" in entry)))
      ids.push(...page.entries.map(entry => entry.id)); cursor = page.cursor
    }
    assert.equal(ids.length, 18000)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(ids.at(-1), id(17999))
    const delta = await readSessionOutline(db, scope, undefined, signal(), 17998 * 7)
    if (delta.status !== "outline") assert.fail("Expected delta")
    assert.deepEqual(delta.entries.map(entry => entry.id), [id(17999), id(18000)])
  } finally { db.close() }
})
test("navigation enforces ownership, message membership and staged undo visibility", async () => {
  const db = fixture()
  try {
    await assert.rejects(readNavigationWindow(db, { ...scope, directory: "/foreign" }, { kind: "latest" }, signal()))
    assert.equal(db.isTransaction, false)
    assert.deepEqual(await readNavigationWindow(db, scope, { kind: "around", messageID: "foreign" }, signal()), { status: "blocked", reason: "anchor_missing" })
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

test("navigation yields for cancellation and large bodies do not delay index pagination", async () => {
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
    assert.equal(first.entries.length, 300)
    assert.equal(first.cursor, null)
    assert(!JSON.stringify(first).includes("large"))
  } finally { db.close() }
})

test("demand excerpts preserve Markdown, bound tool output and enforce ownership/undo", async () => {
  const db = fixture(3)
  try {
    db.prepare("UPDATE session_message SET type='assistant', data=? WHERE id=?").run(JSON.stringify({ content: [
      { type: "text", text: "**Rich** [link](https://example.org)\n\n" + "text ".repeat(2000) },
      { type: "tool", name: "shell", state: { content: [{ type: "text", text: "output".repeat(2000) }] } },
    ] }), id(1))
    const index = await readSessionOutline(db, scope, undefined, signal())
    if (index.status !== "outline") assert.fail("Expected index")
    assert.equal(index.entries[1].tools, 1)
    const previews = await readOutlinePreviews(db, scope, [id(1), "foreign"], signal())
    if (previews.status !== "previews") assert.fail("Expected previews")
    assert.equal(previews.entries.length, 1)
    assert(previews.entries[0].text.startsWith("**Rich** [link]"))
    assert.equal(previews.entries[0].text.length, 4096)
    assert.equal(previews.entries[0].tools.length, 4096)
    await assert.rejects(readOutlinePreviews(db, { ...scope, directory: "/foreign" }, [id(1)], signal()))
    db.prepare("UPDATE session_v2 SET revert=?").run(JSON.stringify({ messageID: id(1) }))
    assert.deepEqual(await readOutlinePreviews(db, scope, [id(1)], signal()), { status: "previews", entries: [] })
  } finally { db.close() }
})
