import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { readNavigationWindow } from "./navigation-store"
import { readStoredUserFile } from "./user-files"
import { projectInboxUserFiles, USER_FILE_BYTES, userFileDigest } from "./user-file-reference"

const scope = { sessionID: "ses_one", directory: "/repo", projectID: "project" }
const signal = new AbortController().signal
function fixture() {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    INSERT INTO session_v2 VALUES ('ses_one','/repo','project',NULL,NULL);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_updated INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);
    CREATE TABLE blob(hash TEXT PRIMARY KEY,data BLOB);
    CREATE TABLE blob_ref(session_id TEXT,message_id TEXT,hash TEXT);`)
  const row = db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,'ses_one','user',?,?)")
  const put = (id: string, seq: number, files: unknown[]) => row.run(id, seq, JSON.stringify({ text: "files", time: { created: seq }, files }))
  return { db, put }
}

for (const [rows, perRow] of [[1, 3], [4, 1]] as const) {
  test(`history projects ${rows} messages with ${perRow} x 5 MiB without returning file data`, async () => {
    const { db, put } = fixture()
    try {
      const bytes = Buffer.alloc(5 * 1024 * 1024, 27)
      const file = { name: "payload.bin", mime: "application/octet-stream", data: bytes.toString("base64") }
      for (let i = 0; i < rows; i++) put(`msg_${i}`, i, Array.from({ length: perRow }, () => file))
      const window = await readNavigationWindow(db, scope, { kind: "latest" }, signal, true)
      assert.equal(window.status, "window")
      assert.equal(window.userFiles, "reference-v1")
      assert.equal(window.messages.length, rows)
      const sha256 = userFileDigest(bytes)
      assert.deepEqual(window.messages[0]?.files, Array.from({ length: perRow }, () => ({
        name: file.name, mime: file.mime, source: { type: "deferred", sha256 },
      })))
      assert(Buffer.byteLength(JSON.stringify(window)) < 4096)
      const target = { messageID: "msg_0", fileIndex: 0, sha256 }
      const result = readStoredUserFile(db, scope, target, signal)
      assert.equal(result.status, "file")
      assert.deepEqual(Buffer.from(result.data, "base64"), bytes)
      assert.equal(readStoredUserFile(db, scope, { ...target, sha256: "0".repeat(64) }, signal).status, "missing")
      assert.equal(readStoredUserFile(db, scope, { ...target, fileIndex: perRow }, signal).status, "missing")
      db.prepare("UPDATE session_v2 SET revert=?").run(JSON.stringify({ messageID: "msg_0" }))
      assert.equal(readStoredUserFile(db, scope, target, signal).status, "missing")
    } finally { db.close() }
  })
}

test("blob ownership, exact byte ceiling and missing external bytes", async () => {
  const { db, put } = fixture()
  try {
    const bytes = Buffer.alloc(USER_FILE_BYTES, 99), hash = userFileDigest(bytes)
    const blob = { mime: "application/octet-stream", uri: `media:${hash}` }
    const external = { mime: "text/plain", name: "C:\\fixture\\outside.txt", data: "",
      source: { type: "uri", uri: "https://outside.invalid/file" } }
    put("msg_0", 0, [blob, external])
    db.prepare("INSERT INTO blob VALUES (?,?)").run(hash, bytes)
    db.prepare("INSERT INTO blob_ref VALUES ('ses_foreign','msg_0',?)").run(hash)
    const target = { messageID: "msg_0", fileIndex: 0, sha256: hash }
    assert.equal(readStoredUserFile(db, scope, target, signal).status, "missing")
    db.prepare("INSERT INTO blob_ref VALUES ('ses_one','msg_0',?)").run(hash)
    const page = await readNavigationWindow(db, scope, { kind: "latest" }, signal, true)
    assert.equal(page.status, "window")
    assert.deepEqual(page.messages[0]?.files, [
      { mime: blob.mime, source: { type: "deferred", sha256: hash } },
      { name: "outside.txt", mime: external.mime, source: { type: "unavailable" } },
    ])
    const result = readStoredUserFile(db, scope, target, signal)
    assert.equal(result.status, "file")
    assert.equal(readStoredUserFile(db, scope, { ...target, fileIndex: 1, sha256: userFileDigest(Buffer.alloc(0)) }, signal).status, "missing")
    assert.equal(Buffer.from(result.data, "base64").length, USER_FILE_BYTES)
    assert.equal(readStoredUserFile(db, scope, { ...target, confirm: true }, signal).status, "current")
    db.prepare("UPDATE blob SET data=zeroblob(?)").run(USER_FILE_BYTES)
    assert.equal(readStoredUserFile(db, scope, { ...target, confirm: true }, signal).status, "missing")
    db.prepare("UPDATE blob SET data=zeroblob(?)").run(USER_FILE_BYTES + 1)
    assert.equal(readStoredUserFile(db, scope, target, signal).status, "too_large")
  } finally { db.close() }
})

test("reference windows walk forward and backward across the raw input budget", async () => {
  const { db, put } = fixture()
  try {
    const file = { mime: "application/octet-stream", data: Buffer.alloc(5 * 1024 * 1024).toString("base64") }
    for (let i = 0; i < 3; i++) put(`msg_${i}`, i, Array(4).fill(file))
    const read = (target: Parameters<typeof readNavigationWindow>[2]) => readNavigationWindow(db, scope, target, signal, true)
    const latest = await read({ kind: "latest" })
    assert.equal(latest.status, "window")
    assert.deepEqual(latest.messages.map(message => message.id), ["msg_1", "msg_2"])
    assert.ok(latest.older)
    const earlier = await read(latest.older)
    assert.equal(earlier.status, "window")
    assert.deepEqual(earlier.messages.map(message => message.id), ["msg_0", "msg_1"])
    assert.ok(earlier.newer)
    assert.deepEqual(await read(earlier.newer), { ...latest, resume: earlier.newer })
  } finally { db.close() }
})

test("a 255 KiB inbox file projects below the SSE client limit and leaves other subscribers unchanged", () => {
  const bytes = Buffer.alloc(255 * 1024, 31)
  const event = { type: "instance.event", instanceId: "w", event: { type: "session.inbox.enqueued",
    data: { sessionID: "s", inboxID: "msg_one", item: { type: "user", payload: {
      text: "file", files: [{ name: "sample.bin", mime: "application/octet-stream", data: bytes.toString("base64") }],
    } } } } }
  const before = JSON.stringify(event)
  assert(Buffer.byteLength(before) > 256 * 1024)
  const projected = projectInboxUserFiles(event)
  assert(Buffer.byteLength(JSON.stringify(projected)) < 1024)
  assert.deepEqual(projected.event.data.item.payload.files, [
    { name: "sample.bin", mime: "application/octet-stream", source: { type: "deferred", sha256: userFileDigest(bytes) } },
  ])
  assert.equal(JSON.stringify(event), before)
})
