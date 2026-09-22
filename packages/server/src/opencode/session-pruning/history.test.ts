import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { queryHistoryPage, type HistoryScope } from "./history-store"
import { historyQuerySchema, type HistoryPage } from "./history-contract"
import { pruneTransaction } from "./transaction"
import { validateClaimFence, storageKey } from "./claim-fence"
import { revision } from "./planner"

const scope: HistoryScope = { directory: "/repo", sessionID: "s", projectID: "p" }
const content = [{ type: "reasoning", text: "Réflexion ancienne" },
  { type: "tool", name: "shell", state: { status: "completed", input: { command: "historical needle" }, content: [{ type: "text", text: "old output" }] } },
  { type: "text", text: "Keep the answer" }]
const data = { content, time: { created: 1, completed: 2 }, snapshot: { start: "untouched" } }
function fixture(count = 1) {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,time_suspended INTEGER,time_compacting INTEGER,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
    CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE event_sequence(aggregate_id TEXT,owner_id TEXT);
    CREATE TABLE event(aggregate_id TEXT);
    INSERT INTO session_v2 VALUES ('s','/repo',NULL,'p',NULL,NULL,NULL);
    INSERT INTO event_sequence VALUES ('s',NULL);`)
  for (let i = 0; i < count; i++) db.prepare("INSERT INTO session_message VALUES (?, 's', 'assistant', ?, ?)").run(`m-${i}`, i, JSON.stringify(data))
  return db
}
async function all(db: DatabaseSync, owner = scope, value: Record<string, unknown> = {}) {
  const pages: HistoryPage[] = []
  let cursor: string | undefined
  do {
    const page = await queryHistoryPage(db, owner, historyQuerySchema.parse({ purpose: "stats", ...value, cursor }), new AbortController().signal)
    pages.push(page)
    cursor = page.cursor ?? undefined
  } while (cursor)
  return pages
}

test("counts and searches beyond 200 messages without returning transcripts", async () => {
  const db = fixture(257)
  try {
    const pages = await all(db)
    assert.equal(pages.reduce((n, p) => n + p.scanned, 0), 257)
    assert.equal(pages.reduce((n, p) => n + p.tools, 0), 257)
    assert.equal(pages.reduce((n, p) => n + p.reasoning, 0), 257)
    assert(pages.every(p => p.hits.length === 0 && p.scanned <= 32 && !JSON.stringify(p).includes("Keep the answer")))
    const search = await all(db, scope, { purpose: "search", query: "RÉFLEXION" })
    assert.equal(search.flatMap(p => p.hits).length, 257)
    assert(search.every(p => p.hits.every(hit => hit.excerpt.length <= 320)))
    assert.equal((await all(db, scope, { purpose: "search", query: "needle", includeTechnical: false })).flatMap(p => p.hits).length, 0)
    assert.equal((await all(db, scope, { purpose: "search", query: "needle" })).flatMap(p => p.hits).length, 257)
  } finally { db.close() }
})

test("searches edit diffs stored in tool metadata", async () => {
  const db = fixture(0)
  try {
    const edit = (metadata: Record<string, unknown>) => ({ content: [{ type: "tool", name: "edit", state: {
      status: "completed", input: { path: "src/a.ts", oldString: "1", newString: "2" }, metadata,
      content: [{ type: "text", text: "Edited src/a.ts (1 replacement)" }] } }], time: { created: 1, completed: 2 } })
    db.prepare("INSERT INTO session_message VALUES ('v2','s','assistant',1,?)").run(JSON.stringify(edit({
      files: [{ file: "src/a.ts", patch: "@@ -1 +1 @@\n-const a = 1\n+const a = patchneedle", additions: 1, deletions: 1, status: "modified" }],
    })))
    db.prepare("INSERT INTO session_message VALUES ('v1','s','assistant',2,?)").run(JSON.stringify(edit({ diff: "-old\n+legacyneedle" })))
    const hits = (query: string, value: Record<string, unknown> = {}) => all(db, scope, { purpose: "search", query, ...value }).then(pages => pages.flatMap(p => p.hits))
    assert.deepEqual((await hits("patchneedle")).map(hit => [hit.messageID, hit.kind]), [["v2", "tool"]])
    assert.deepEqual((await hits("legacyneedle")).map(hit => hit.messageID), ["v1"])
    assert.equal((await hits("patchneedle", { includeTechnical: false })).length, 0)
  } finally { db.close() }
})

test("includes native text messages, nested directories and historical global sessions, excluding sibling paths and other identities", async () => {
  const db = fixture(0)
  try {
    for (const [id, directory, workspace, project] of [
      ["child", "/repo/src", null, "global"], ["sibling", "/repo-other", null, "p"], ["identity", "/repo", "other", "p"],
      ["foreign", "/repo/independent-clone", null, "foreign-project"],
    ]) db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,NULL,NULL,NULL)").run(id, directory, workspace, project)
    for (const session of ["s", "child", "sibling", "identity", "foreign"]) db.prepare("INSERT INTO session_message VALUES (?,?,'user',1,?)")
      .run(session, session, JSON.stringify({ text: "A searchable question", time: { created: 1 } }))
    const pages = await all(db, { directory: "/repo", projectID: "p" }, { purpose: "search", query: "question" })
    assert.deepEqual(pages.flatMap(p => p.hits.map(h => h.sessionID)).sort(), ["child", "s"])
    assert.equal(pages.reduce((n, p) => n + p.skipped, 0), 0)
    assert.equal((await all(db, { ...scope, workspaceID: "other" })).reduce((n, p) => n + p.scanned, 0), 0)
  } finally { db.close() }
})

test("cursor is scope/query bound and scan horizon excludes appended messages", async () => {
  const db = fixture(40)
  try {
    const input = historyQuerySchema.parse({ purpose: "stats" })
    const first = await queryHistoryPage(db, scope, input, new AbortController().signal)
    assert(first.cursor)
    db.prepare("INSERT INTO session_message VALUES ('new','s','assistant',100,?)").run(JSON.stringify(data))
    let count = first.scanned, cursor = first.cursor
    while (cursor) {
      const page = await queryHistoryPage(db, scope, { ...input, cursor }, new AbortController().signal)
      count += page.scanned; cursor = page.cursor!
    }
    assert.equal(count, 40)
    await assert.rejects(queryHistoryPage(db, { ...scope, directory: "/other" }, { ...input, cursor: first.cursor }, new AbortController().signal), /cursor/)
    await assert.rejects(queryHistoryPage(db, scope, { ...input, query: "changed", cursor: first.cursor }, new AbortController().signal), /cursor/)
    const abort = new AbortController(); abort.abort()
    await assert.rejects(queryHistoryPage(db, scope, input, abort.signal), /abort/i)
  } finally { db.close() }
})

test("whole-message batch transaction is CAS checked, fenced and idempotent", () => {
  const db = fixture()
  const identity = { key: "challenge", nonce: "fresh", directory: "/repo", projectID: "p" }
  db.prepare("INSERT INTO kv VALUES (?, ?, 0, 0)").run(identity.key, JSON.stringify(identity.nonce))
  const target = { sessionID: "s", messageID: "m-0", revision: revision(content) }
  const run = () => pruneTransaction(db, target, () => validateClaimFence(db, "s", identity), storageKey("pruning/receipt/"), true)
  try {
    db.exec("UPDATE session_v2 SET time_suspended=1")
    assert.deepEqual(run(), { status: "blocked", reason: "maintenance_required" })
    db.exec("UPDATE session_v2 SET time_suspended=NULL")
    const result = run()
    assert.equal(result.status, "pruned")
    assert.deepEqual(run(), result)
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT data FROM session_message").get()!.data)), { ...data, content: [content[2]] })
    assert.equal(pruneTransaction(db, { ...target, revision: "0".repeat(64) }, () => validateClaimFence(db, "s", identity), undefined, true).status, "blocked")
    assert.equal(db.isTransaction, false)
  } finally { db.close() }
})

test("plan skips incomplete/malformed/oversized messages explicitly and never returns tool payloads", async () => {
  const db = fixture()
  try {
    for (const [id, value] of [["active", JSON.stringify({ content, time: { created: 1 } })], ["broken", "{"], ["large", "x".repeat(16 * 1024 * 1024 + 1)]]) {
      db.prepare("INSERT INTO session_message VALUES (?, 's','assistant',1,?)").run(id!, value!)
    }
    const pages = await all(db, scope, { purpose: "prune", sessionID: "s" })
    assert.equal(pages.reduce((n, p) => n + p.skipped, 0), 3)
    assert.deepEqual(pages.flatMap(p => p.candidates).map(c => c.messageID), ["m-0"])
    assert(!JSON.stringify(pages).includes("historical needle"))
  } finally { db.close() }
})
