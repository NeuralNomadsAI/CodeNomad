import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pruneIsolatedMessage } from "./isolated-store"
import { previewContent, revision } from "./planner"
import { contentRevision } from "./revision"
import { pruneRequestSchema } from "./contract"
import { readPruningPreview } from "./preview-store"
import plugin from "./plugin"

const content = [
  { type: "reasoning", text: "thinking", time: { created: 1, completed: 2 } },
  { type: "tool", id: "call-1", state: { status: "completed", content: [{ type: "text", text: "logs" }] } },
  { type: "text", text: "Keep the conclusion" },
]
const data = { content, time: { created: 1, completed: 3 }, tokens: { input: 123 }, snapshot: { start: "snapshot" } }
const input = (indexes = [0, 1]) => ({ sessionID: "s", messageID: "m", revision: revision(content), indexes })
function fixture(filename = ":memory:") {
  const db = new DatabaseSync(filename)
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
    CREATE TABLE event(aggregate_id TEXT,data TEXT);
    INSERT INTO session_v2 VALUES ('s','/work');`)
  db.prepare("INSERT INTO session_message VALUES ('m','s','assistant',7,?)").run(JSON.stringify(data))
  return db
}
function stored(db: DatabaseSync) {
  return JSON.parse(db.prepare("SELECT data FROM session_message WHERE id='m'").get()!.data as string)
}

test("browser and plugin revisions ignore key order but detect content/order changes", async () => {
  assert.equal(await contentRevision(content), revision(content))
  assert.equal(revision([{ type: "text", text: "é" }]), revision([{ text: "é", type: "text" }]))
  assert.notEqual(revision(content), revision([...content].reverse()))
})

test("preview reports technical parts only without changing storage", () => {
  const before = JSON.stringify(data)
  const preview = previewContent(data)
  assert.equal(preview.status, "preview")
  if (preview.status !== "preview") assert.fail()
  assert.equal(preview.liveMutation, false)
  assert.deepEqual(preview.parts.map(p => [p.index, p.type]), [[0, "reasoning"], [1, "tool"]])
  assert.equal(JSON.stringify(data), before)
})

test("isolated SQL prune preserves IDs, ordering, text and metadata", () => {
  const db = fixture()
  try {
    const result = pruneIsolatedMessage(db, input(), "/work")
    assert.equal(result.status, "pruned")
    assert.deepEqual(stored(db), { ...data, content: [content[2]] })
    assert.equal(db.prepare("SELECT seq FROM session_message").get()!.seq, 7)
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok")
    assert.equal(db.isTransaction, false)
  } finally { db.close() }
})

test("individual pruning and all-technical messages are supported", () => {
  const db = fixture()
  try {
    assert.equal(pruneIsolatedMessage(db, input([1]), "/work").status, "pruned")
    assert.deepEqual(stored(db).content, [content[0], content[2]])
    db.prepare("UPDATE session_message SET data=?").run(JSON.stringify({ ...data, content: [content[0]] }))
    assert.equal(pruneIsolatedMessage(db, { ...input([0]), revision: revision([content[0]]) }, "/work").status, "pruned")
    assert.deepEqual(stored(db).content, [])
  } finally { db.close() }
})

for (const [name, change] of [
  ["incomplete message", (d: any) => { delete d.time.completed }],
  ["running tool", (d: any) => { d.content[1].state.status = "running" }],
  ["unknown content kind", (d: any) => { d.content.push({ type: "future" }) }],
] as const) {
  test(`rejects ${name} without partial changes`, () => {
    const db = fixture()
    try {
      const changed = structuredClone(data); change(changed)
      db.prepare("UPDATE session_message SET data=?").run(JSON.stringify(changed))
      assert.equal(pruneIsolatedMessage(db, input(), "/work").status, "blocked")
      assert.deepEqual(stored(db), changed)
      assert.equal(db.isTransaction, false)
    } finally { db.close() }
  })
}

test("rejects stale revisions, text selections, out-of-range and wrong ownership", () => {
  const db = fixture()
  try {
    for (const request of [input([2]), input([99]), { ...input(), revision: "0".repeat(64) }, { ...input(), sessionID: "other" }]) {
      assert.equal(pruneIsolatedMessage(db, request, "/work").status, "blocked")
      assert.deepEqual(stored(db), data)
    }
    assert.equal(pruneIsolatedMessage(db, input(), "/elsewhere").status, "blocked")
  } finally { db.close() }
})

test("rejects replacement content, duplicate indexes and oversized selections at the contract", () => {
  for (const invalid of [{ ...input(), content: [] }, input([]), input([1, 1]), input([-1]), input(Array.from({ length: 4097 }, (_, i) => i))]) {
    assert.equal(pruneRequestSchema.safeParse(invalid).success, false)
  }
})

test("retained events and triggers fail closed rather than silently corrupt replay", () => {
  const db = fixture()
  try {
    db.exec("INSERT INTO event VALUES ('s','{}')")
    assert.deepEqual(pruneIsolatedMessage(db, input(), "/work"), { status: "blocked", reason: "unsupported_storage" })
    db.exec("DELETE FROM event; CREATE TRIGGER guard AFTER UPDATE ON session_message BEGIN SELECT 1; END")
    assert.equal(pruneIsolatedMessage(db, input(), "/work").status, "blocked")
    assert.deepEqual(stored(db), data)
  } finally { db.close() }
})

test("refuses file-backed writes, but supports explicit read-only preview", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codenomad-pruning-test-"))
  const filename = path.join(dir, "fixture.db")
  const db = fixture(filename)
  try {
    assert.deepEqual(pruneIsolatedMessage(db, input(), "/work"), { status: "blocked", reason: "maintenance_required" })
    assert.deepEqual(await readPruningPreview(filename, input(), "/work"), data)
    assert.equal(await readPruningPreview(filename, input(), "/other"), undefined)
    assert.equal(await readPruningPreview(undefined, input(), "/work"), undefined)
    assert.deepEqual(stored(db), data)
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})

test("plugin registers real RPC contract and cannot enable live writes via options", async () => {
  let handlers: any
  let disposed = false
  const cleanup = await plugin.setup({
    location: { directory: "/work" }, options: { allowLiveWrites: true, databasePath: "DO_NOT_OPEN" },
    rpc: { register: async (definition: any, implementation: any) => {
      assert.equal(definition.id, "codenomad.session-pruning")
      handlers = implementation
      return { dispose: () => { disposed = true } }
    } },
  } as any)
  assert.deepEqual(await handlers.prune(input()), { status: "blocked", reason: "maintenance_required" })
  await cleanup?.()
  assert.equal(disposed, true)
})
