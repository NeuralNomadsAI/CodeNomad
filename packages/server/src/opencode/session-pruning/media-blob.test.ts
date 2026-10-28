import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { listSessionAssets, readSessionAsset } from "./assets-store"
import { queryHistoryPage } from "./history-store"
import { historyQuerySchema } from "./history-contract"
import { pruneIsolatedMessage } from "./isolated-store"
import { projectStoredMedia } from "./media-blob"
import { readNavigationWindow } from "./navigation-store"
import { revision } from "./planner"
import { readPruningPreview } from "./preview-store"

// The stored representation OpenCode's `experimental.media_blob` writes (core
// `session/blob.ts`, migration `20261025123711_blob`) and native reads hydrate.
const html = Buffer.from("<p>Private fixture</p>"), png = Buffer.from("png-bytes")
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const ref = (bytes: Buffer) => `media:${sha(bytes)}`
const inline = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`
const tool = (id: string, content: unknown[]) => ({ type: "tool", id, name: id, state: { status: "completed", input: {}, content } })
const stored = {
  time: { created: 1, completed: 2 },
  content: [
    tool("page", [{ type: "file", mime: "text/html", name: "page.html", uri: ref(html) }]),
    tool("image", [{ type: "file", mime: "image/png", uri: ref(png) }, { type: "text", text: "drawn" }]),
    { type: "text", text: "Keep this conclusion" },
  ],
}
const hydrated = {
  ...stored,
  content: [
    tool("page", [{ type: "file", mime: "text/html", name: "page.html", uri: inline("text/html", html) }]),
    tool("image", [{ type: "file", mime: "image/png", uri: inline("image/png", png) }, { type: "text", text: "drawn" }]),
    stored.content[2],
  ],
}
const user = { text: "See attached", time: { created: 1 }, files: [{ mime: "image/png", name: "shot.png", source: { type: "file", path: "/repo/shot.png" }, uri: ref(png) }] }
const scope = { sessionID: "s", directory: "/repo", projectID: "p" }
const signal = () => new AbortController().signal

function fixture({ blobs = true } = {}) {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,time_suspended INTEGER,time_compacting INTEGER,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_updated INTEGER DEFAULT 0);
    CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE event_sequence(aggregate_id TEXT,owner_id TEXT);
    CREATE TABLE event(aggregate_id TEXT);
    INSERT INTO session_v2 VALUES ('s','/repo',NULL,'p',NULL,NULL,NULL);
    INSERT INTO event_sequence VALUES ('s',NULL);`)
  if (blobs) db.exec(`CREATE TABLE blob(hash text PRIMARY KEY, mime text NOT NULL, bytes integer NOT NULL, width integer, height integer, data blob NOT NULL, time_created integer NOT NULL);
    CREATE TABLE blob_ref(session_id text NOT NULL, message_id text NOT NULL, hash text NOT NULL, seq integer NOT NULL,
      PRIMARY KEY(session_id, message_id, hash), FOREIGN KEY (hash) REFERENCES blob(hash) ON DELETE CASCADE);`)
  const message = db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,'s',?,?,?)")
  message.run("u", "user", 1, JSON.stringify(user))
  message.run("m", "assistant", 2, JSON.stringify(stored))
  if (blobs) {
    for (const [bytes, mime] of [[html, "text/html"], [png, "image/png"]] as const) {
      db.prepare("INSERT INTO blob VALUES (?,?,?,NULL,NULL,?,1)").run(sha(bytes), mime, bytes.length, bytes)
    }
    const owns = db.prepare("INSERT INTO blob_ref VALUES ('s',?,?,?)")
    owns.run("u", sha(png), 1); owns.run("m", sha(html), 2); owns.run("m", sha(png), 2)
  }
  return db
}
const data = (db: DatabaseSync, id = "m") => JSON.parse(String(db.prepare("SELECT data FROM session_message WHERE id=?").get(id)!.data))
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const refs = (db: DatabaseSync) => db.prepare("SELECT message_id, hash FROM blob_ref ORDER BY message_id, hash").all().map(row => `${row.message_id}:${row.hash}`)
const blobs = (db: DatabaseSync) => db.prepare("SELECT hash FROM blob ORDER BY hash").all().map(row => row.hash)

test("projection inlines refs exactly as native reads, and leaves rows without refs untouched", () => {
  const db = fixture()
  try {
    const projected = projectStoredMedia(db, stored, bytes(stored), 16 * 1024 * 1024)
    assert.equal(projected.status, "ok")
    assert.deepEqual(projected.status === "ok" && projected.data, hydrated)
    assert(projected.status === "ok" && projected.bytes >= bytes(hydrated))
    const { uri: _, ...file } = user.files[0]
    assert.deepEqual((projectStoredMedia(db, user, bytes(user), 1 << 20) as any).data, { ...user, files: [{ ...file, data: png.toString("base64") }] })
    const plain = { content: [{ type: "text", text: "no refs" }] }
    assert.equal((projectStoredMedia(db, plain, bytes(plain), 1 << 20) as any).data, plain)
    // A running tool is never hydrated natively.
    const page = stored.content[0] as ReturnType<typeof tool>
    const running = { content: [{ ...page, state: { status: "running", content: page.state.content } }] }
    assert.deepEqual((projectStoredMedia(db, running, bytes(running), 1 << 20) as any).data, running)
    assert.deepEqual(projectStoredMedia(db, stored, bytes(stored), bytes(stored) + 8), { status: "limit" })
    db.exec("DELETE FROM blob")
    const gone = projectStoredMedia(db, stored, bytes(stored), 1 << 20) as any
    assert.deepEqual(gone.data.content[0].state.content, [{ type: "text", text: "[media unavailable: page.html (text/html)]" }])
    assert.deepEqual(gone.data.content[1].state.content[0], { type: "text", text: "[media unavailable: image/png]" })
    assert.deepEqual((projectStoredMedia(db, user, bytes(user), 1 << 20) as any).data.files[0],
      { ...file, mime: "text/plain", data: Buffer.from("[media unavailable: shot.png (image/png)]").toString("base64") })
  } finally { db.close() }
  const legacy = fixture({ blobs: false })
  try {
    assert.deepEqual(projectStoredMedia(legacy, stored, bytes(stored), 1 << 20), { status: "unsupported" })
    assert.equal((projectStoredMedia(legacy, hydrated, bytes(hydrated), 1 << 20) as any).data, hydrated)
  } finally { legacy.close() }
})

test("pruning compares the native revision, keeps surviving refs stored and releases only dropped blobs", async () => {
  const db = fixture()
  try {
    // The stored-form hash is stale against the native form the UI hashed.
    assert.deepEqual(pruneIsolatedMessage(db, { sessionID: "s", messageID: "m", revision: revision(stored.content), indexes: [0] }, "/repo"),
      { status: "blocked", reason: "conflict" })
    const page = await queryHistoryPage(db, scope, historyQuerySchema.parse({ purpose: "prune", sessionID: "s" }), signal())
    assert.equal(page.candidates.find(candidate => candidate.messageID === "m")?.revision, revision(hydrated.content))
    const result = pruneIsolatedMessage(db, { sessionID: "s", messageID: "m", revision: revision(hydrated.content), indexes: [0] }, "/repo")
    assert.deepEqual(result, { status: "pruned", messageID: "m", revision: revision(hydrated.content.slice(1)), removedCount: 1 })
    assert.deepEqual(data(db), { ...stored, content: stored.content.slice(1) })
    assert.deepEqual(refs(db), [`m:${sha(png)}`, `u:${sha(png)}`])
    assert.deepEqual(blobs(db), [sha(png)])
    // A blob another row still references stays when this message releases it.
    assert.equal(pruneIsolatedMessage(db, { sessionID: "s", messageID: "m", revision: revision(hydrated.content.slice(1)), indexes: [0] }, "/repo").status, "pruned")
    assert.deepEqual(refs(db), [`u:${sha(png)}`])
    assert.deepEqual(blobs(db), [sha(png)])
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok")
  } finally { db.close() }
})

test("read-only previews hash the native form", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codenomad-media-preview-"))
  const filename = path.join(dir, "fixture.db"), db = fixture()
  try {
    db.exec(`VACUUM INTO '${filename.replaceAll("'", "''")}'`)
    const preview = await readPruningPreview(filename, { sessionID: "s", messageID: "m" }, { directory: "/repo" }, "p")
    assert.deepEqual(preview?.status === "ok" && preview.data, hydrated)
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})

test("pruning refuses ref-backed rows whose blob storage it cannot maintain, without changes", () => {
  const db = fixture()
  try {
    db.exec("DROP TABLE blob_ref")
    assert.deepEqual(pruneIsolatedMessage(db, { sessionID: "s", messageID: "m", revision: revision(hydrated.content), indexes: [0] }, "/repo"),
      { status: "blocked", reason: "unsupported_storage" })
    assert.deepEqual(data(db), stored)
    assert.equal(db.isTransaction, false)
  } finally { db.close() }
})

test("assets list and read media refs as the inline files native reads return", async () => {
  const db = fixture()
  try {
    const page = await listSessionAssets(db, scope, undefined, signal())
    assert.equal(page.status, "page")
    if (page.status !== "page") return
    assert.deepEqual(page.entries.map(entry => [entry.name, entry.mime, entry.available]), [["page.html", "text/html", true], ["image · 1", "image/png", true]])
    assert(!JSON.stringify(page).includes(html.toString("base64")))
    assert.deepEqual(await readSessionAsset(db, scope, page.entries[0].target, signal()), { status: "asset", mime: "text/html", uri: inline("text/html", html) })
    // Native reads show a ref whose blob is gone as text, so it is no asset.
    db.prepare("DELETE FROM blob WHERE hash=?").run(sha(png))
    const remaining = await listSessionAssets(db, scope, undefined, signal())
    assert.deepEqual(remaining.status === "page" && remaining.entries.map(entry => entry.name), ["page.html"])
    assert.deepEqual(await readSessionAsset(db, scope, page.entries[1].target, signal()), { status: "blocked", reason: "unavailable" })
    // Blobs beyond the embedded-asset limit stay listed as unavailable.
    db.prepare("UPDATE blob SET data=zeroblob(8*1024*1024) WHERE hash=?").run(sha(html))
    const large = await listSessionAssets(db, scope, undefined, signal())
    assert.deepEqual(large.status === "page" && large.entries.map(entry => entry.available), [false])
    assert.deepEqual(await readSessionAsset(db, scope, page.entries[0].target, signal()), { status: "blocked", reason: "unavailable" })
  } finally { db.close() }
})

test("navigation windows emit native read forms for media refs", async () => {
  const db = fixture()
  try {
    const window = await readNavigationWindow(db, scope, { kind: "latest" }, signal())
    assert.equal(window.status, "window")
    if (window.status !== "window") return
    const { uri: _, ...file } = user.files[0]
    assert.deepEqual(window.messages.map(message => ({ ...message })), [
      { ...user, files: [{ ...file, data: png.toString("base64") }], id: "u", type: "user" },
      { ...hydrated, id: "m", type: "assistant" },
    ])
    db.prepare("UPDATE blob SET data=zeroblob(17*1024*1024) WHERE hash=?").run(sha(html))
    assert.deepEqual(await readNavigationWindow(db, scope, { kind: "latest" }, signal()), { status: "blocked", reason: "unsupported_storage" })
  } finally { db.close() }
})
