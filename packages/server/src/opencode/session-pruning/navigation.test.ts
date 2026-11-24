import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { outlineResultSchema } from "./navigation-contract"
import { readNavigationWindow, readSessionOutline } from "./navigation-store"
import { readOutlinePreviews } from "./outline-preview"

const scope = { directory: "/repo", projectID: "p", sessionID: "s" }
const id = (n: number) => `message-${String(n).padStart(5, "0")}`
function fixture(count = 1500) {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_updated INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);
    INSERT INTO session_v2 VALUES ('s','/repo','p',NULL,NULL);`)
  const insert = db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,'s','user',?,?)")
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
    db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,'s','user',?,?)").run(id(18000), 18000 * 7, JSON.stringify({ text: "Later", time: { created: 20000 } }))
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
      { type: "tool", tool: "shell", state: { content: [{ type: "text", text: "output".repeat(2000) }] } },
    ] }), id(1))
    const index = await readSessionOutline(db, scope, undefined, signal())
    if (index.status !== "outline") assert.fail("Expected index")
    assert.equal(index.entries[1].tools, 1)
    assert.equal(index.entries[1].toolName, "shell")
    const unicodeName = "🔧".repeat(256)
    db.prepare("UPDATE session_message SET type='assistant', data=? WHERE id=?").run(JSON.stringify({ content: [
      { type: "tool", name: unicodeName, state: {} },
    ] }), id(2))
    const unicodeIndex = await readSessionOutline(db, scope, undefined, signal())
    if (unicodeIndex.status !== "outline") assert.fail("Expected Unicode index")
    assert.equal(unicodeIndex.entries[2].toolName, "🔧".repeat(128), "tool metadata must satisfy its UTF-16 RPC bound")
    assert.equal(index.entries[1].text, 1)
    assert.equal(unicodeIndex.entries[2].text, 0, "a tool-only step has no visible text")
    db.prepare("UPDATE session_message SET type='assistant', data=? WHERE id=?").run(JSON.stringify({ content: [
      { type: "text", text: " \n\t" }, { type: "text", text: "hidden", synthetic: true }, { type: "text", text: "hidden", ignored: true },
      { type: "reasoning", text: "thinking" },
    ] }), id(2))
    const textless = await readSessionOutline(db, scope, undefined, signal())
    if (textless.status !== "outline") assert.fail("Expected textless index")
    assert.equal(textless.entries[2].text, 0, "blank, synthetic, ignored and reasoning parts are not visible text")
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

test("assistant layouts list visible reasoning and text runs and each tool in content order", async () => {
  const db = fixture(4)
  try {
    const step = (index: number, content: unknown[]) => db.prepare("UPDATE session_message SET type='assistant', data=? WHERE id=?")
      .run(JSON.stringify({ content }), id(index))
    step(0, [{ type: "reasoning", text: "a" }, { type: "reasoning", text: "b" }, { type: "text", text: "c" }, { type: "text", text: "d" },
      { type: "tool", name: "read" }, { type: "tool", name: "grep" }])
    step(1, [{ type: "tool", name: "read" }, { type: "reasoning", text: " " }, { type: "text", text: "after" }, { type: "reasoning", text: "e" },
      { type: "text", text: "x", synthetic: true }, { type: "text", text: "y", ignored: true }, { type: "text", text: "\n" }, { type: "tool", name: "shell" }])
    step(2, [...Array.from({ length: 64 }, (_, index) => ({ type: "tool", name: `tool${index}` })), { type: "text", text: "reply" }])
    step(3, Array.from({ length: 20 }, () => [{ type: "text", text: "t" }, { type: "tool", name: "read" }, { type: "text", text: "t" },
      { type: "reasoning", text: "r" }, { type: "tool", name: "read" }, { type: "reasoning", text: "r" }]).flat())
    const outline = await readSessionOutline(db, scope, undefined, signal(), -1, [], true)
    if (outline.status !== "outline") assert.fail("Expected index")
    assert.deepEqual(outline.entries.map(entry => entry.layout), ["RTXX", "XTRX", `${"X".repeat(64)}T`, "TXTRXR".repeat(20)],
      "every step the transcript displays whole is listed exactly")
    assert(outline.entries.every(entry => entry.omitted === undefined))
    const { outlineLayoutResultSchema } = await import("./navigation-contract")
    assert.equal(outlineLayoutResultSchema.safeParse(outline).success, true)
  } finally { db.close() }
})

test("beyond the display limit, layouts list the parts the transcript displays, with the runs omitted between them", async () => {
  const db = fixture(4)
  try {
    const step = (index: number, data: object) => db.prepare("UPDATE session_message SET type='assistant', data=? WHERE id=?").run(JSON.stringify(data), id(index))
    const parts = (count: number, part: object) => Array.from({ length: count }, () => part)
    const tool = { type: "tool", name: "read" }, text = { type: "text", text: "t" }, reasoning = { type: "reasoning", text: "r" }
    step(0, { content: [...parts(600, tool), ...parts(600, text)] })
    step(1, { content: parts(1200, text) })
    step(2, { content: [...parts(499, tool), reasoning, ...parts(200, text), tool, reasoning, ...parts(300, tool), reasoning, text] })
    // The transcript adds a blank row for a failed step's error when it has no text part.
    step(3, { content: parts(1000, tool), error: { type: "unknown", message: "failed" } })
    const outline = await readSessionOutline(db, scope, undefined, signal(), -1, [], true)
    if (outline.status !== "outline") assert.fail("Expected index")
    assert.deepEqual(outline.entries.map(({ layout, omitted }) => ({ layout, omitted })), [
      { layout: `${"X".repeat(500)}-T`, omitted: { reasoning: 0, text: 1, continues: true } },
      { layout: "T-T", omitted: { reasoning: 0, text: 0, continues: true } },
      // Its reply starts among the 4 omitted parts and continues after them.
      { layout: `${"X".repeat(499)}R-TXR${"X".repeat(300)}RT`, omitted: { reasoning: 0, text: 1, continues: true } },
      // 1,001 displayed parts, the last of them the error row.
      { layout: `${"X".repeat(500)}-${"X".repeat(499)}`, omitted: { reasoning: 0, text: 0, continues: false } },
    ])
    const { outlineLayoutResultSchema } = await import("./navigation-contract")
    assert.equal(outlineLayoutResultSchema.safeParse(outline).success, true)
  } finally { db.close() }
})

test("long layouts end a page early instead of growing it, and the cursor resumes after them", async () => {
  const db = fixture(3000)
  try {
    db.prepare("UPDATE session_message SET type='assistant', data=?").run(JSON.stringify({ content: Array.from({ length: 1000 }, (_, index) =>
      index % 2 ? { type: "tool", name: "read" } : { type: "text", text: "t" }) }))
    const first = await readSessionOutline(db, scope, undefined, signal(), -1, [], true)
    if (first.status !== "outline") assert.fail("Expected index")
    assert(first.cursor, "the page stops before the session's end")
    const layouts = first.entries.reduce((sum, entry) => sum + (entry.layout?.length ?? 0), 0)
    assert(layouts < 16384 * 64 + 512 * 1001, `a page's layouts stay bounded (${layouts})`)
    const ids = first.entries.map(entry => entry.id)
    for (let cursor: { after: number; through: number } | null = first.cursor; cursor;) {
      const page = await readSessionOutline(db, scope, cursor, signal(), -1, [], true)
      if (page.status !== "outline") assert.fail("Expected page")
      ids.push(...page.entries.map(entry => entry.id))
      cursor = page.cursor
    }
    assert.equal(new Set(ids).size, 3000)
  } finally { db.close() }
})

// The `outline` entry shape an older CodeNomad backend validates strictly.
const legacyOutlineSchema = z.object({ status: z.literal("outline"), entries: z.array(z.object({
  id: z.string(), seq: z.number(), type: z.string(), tools: z.number(), reasoning: z.number(), text: z.number().optional(), toolName: z.string().optional(),
}).strict()), total: z.number(), cursor: z.unknown(), checkpoints: z.array(z.unknown()) }).strict()

test("layouts are opt-in: the default outline keeps the entry shape older backends accept", async () => {
  const db = fixture(2)
  try {
    db.prepare("UPDATE session_message SET type='assistant', data=? WHERE id=?").run(JSON.stringify({ content: [
      { type: "reasoning", text: "a" }, { type: "text", text: "b" }, { type: "tool", name: "read" }] }), id(1))
    const legacy = await readSessionOutline(db, scope, undefined, signal())
    assert.equal(legacyOutlineSchema.safeParse(legacy).success, true, "an older backend parses the default outline")
    assert.equal(outlineResultSchema.safeParse(legacy).success, true)
    assert(legacy.status === "outline" && legacy.entries.every(entry => !("layout" in entry) && !("omitted" in entry)))
    const layouts = await readSessionOutline(db, scope, undefined, signal(), -1, [], true)
    assert(layouts.status === "outline" && layouts.entries[1].layout === "RTX")
    assert.equal(legacyOutlineSchema.safeParse(layouts).success, false, "layouts would be rejected as unrecognized keys")
    assert.equal(outlineResultSchema.safeParse(layouts).success, false, "the `outline` method's output stays the legacy shape")
    const { outlineLayoutResultSchema } = await import("./navigation-contract")
    assert.equal(outlineLayoutResultSchema.safeParse(layouts).success, true)
  } finally { db.close() }
})

test("persisted checkpoints reconcile offline edits, pruning, deletions and appends without replaying unchanged ranges", async () => {
  const db = fixture(1500)
  try {
    const first = await readSessionOutline(db, scope, undefined, signal())
    if (first.status !== "outline") assert.fail("Expected index")
    const known = first.checkpoints.map(({ changed: _, ...checkpoint }) => checkpoint)
    const unchanged = await readSessionOutline(db, scope, undefined, signal(), -1, known)
    if (unchanged.status !== "outline") assert.fail("Expected revalidation")
    assert.equal(unchanged.entries.length, 476, "only the live tail is conservatively refreshed")
    db.prepare("DELETE FROM session_message WHERE id=?").run(id(250))
    db.prepare("UPDATE session_message SET type='assistant',data=?,time_updated=1 WHERE id=?").run(
      JSON.stringify({ content: [{ type: "tool", name: "read" }] }), id(260))
    db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,'s','user',?,?)").run(id(1500), 1500 * 7, '{"text":"new"}')
    const delta = await readSessionOutline(db, scope, undefined, signal(), -1, known)
    if (delta.status !== "outline") assert.fail("Expected delta")
    assert.equal(delta.total, 1500)
    assert.equal(delta.entries.length, 988)
    assert.equal(delta.checkpoints.filter(checkpoint => !checkpoint.changed).length, 1)
    assert(!delta.entries.some(entry => entry.id === id(250)))
    assert.equal(delta.entries.find(entry => entry.id === id(260))?.tools, 1)
    assert.equal(delta.entries.find(entry => entry.id === id(260))?.toolName, "read")
    // Pruning uses a conditional data update, without changing native timestamps.
    db.prepare("UPDATE session_message SET data=? WHERE id=?").run('{"content":[]}', id(260))
    const pruned = await readSessionOutline(db, scope, undefined, signal(), -1,
      delta.checkpoints.map(({ changed: _, ...checkpoint }) => checkpoint))
    if (pruned.status !== "outline") assert.fail("Expected prune delta")
    assert.equal(pruned.entries.find(entry => entry.id === id(260))?.tools, 0)
    assert.equal(pruned.entries.find(entry => entry.id === id(260))?.toolName, undefined)
    assert.equal(db.isTransaction, false)
  } finally { db.close() }
})

test("appending across repeated refreshes fills the tail checkpoint instead of growing one per message", async () => {
  const db = fixture(1025)
  try {
    let known: import("./navigation-contract").OutlineCheckpoint[] = []
    for (let seq = 1025; seq < 1065; seq++) {
      db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,'s','user',?,?)")
        .run(id(seq), seq * 7, '{"text":"new"}')
      const page = await readSessionOutline(db, scope, undefined, signal(), -1, known)
      if (page.status !== "outline") assert.fail("Expected index")
      assert.equal(page.checkpoints.length, 3)
      known = page.checkpoints.map(({ changed: _, ...checkpoint }) => checkpoint)
    }
  } finally { db.close() }
})

test("changed checkpoints with deletion holes never exceed the RPC page limit", async () => {
  const db = fixture(18000)
  try {
    const { outlineResultSchema } = await import("./navigation-contract")
    const known: import("./navigation-contract").OutlineCheckpoint[] = []
    let cursor: { after: number; through: number } | undefined
    do {
      const page = await readSessionOutline(db, scope, cursor, signal())
      if (page.status !== "outline") assert.fail("Expected index")
      known.push(...page.checkpoints.map(({ changed: _, ...checkpoint }) => checkpoint))
      cursor = page.cursor ?? undefined
    } while (cursor)
    db.prepare("DELETE FROM session_message WHERE id=?").run(id(250))
    db.exec("UPDATE session_message SET time_updated=1")
    let count = 0
    do {
      const page = await readSessionOutline(db, scope, cursor, signal(), -1, known)
      assert(outlineResultSchema.safeParse(page).success, "every delta page satisfies the actual RPC contract")
      if (page.status !== "outline") assert.fail("Expected delta")
      count += page.entries.length
      cursor = page.cursor ?? undefined
    } while (cursor)
    assert.equal(count, 17999)
  } finally { db.close() }
})
