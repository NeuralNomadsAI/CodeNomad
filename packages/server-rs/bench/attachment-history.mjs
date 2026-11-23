import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"

const MiB = 1024 * 1024
const referenceHeaders = { "x-codenomad-user-files": "reference-v1" }
const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const post = (value, headers = {}) => ({
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value),
})

async function qualifyStream(call, client, id, location, size, count) {
  const session = await client.session.create({ location, title: "Reference SSE fixture" })
  const controller = new AbortController()
  const response = await call("/api/events?clientId=files&connectionId=projected&userFiles=reference-v1", {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
  })
  assert.equal(response.status, 200)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  try {
    const bytes = Buffer.alloc(size, 17)
    const name = "queued.bin", mime = "application/octet-stream"
    const file = { name, uri: `data:${mime};base64,${bytes.toString("base64")}` }
    const prompt = await call(`/workspaces/${id}/instance/api/session/${session.id}/prompt`, post({
      text: "stream fixture", files: Array.from({ length: count }, () => file),
    }))
    assert.equal(prompt.status, 200, await prompt.text())
    let pending = "", found = false
    for (;;) {
      const { value, done } = await reader.read()
      assert(!done, "SSE closed before the next native event")
      pending += value
      for (let at; (at = pending.indexOf("\n\n")) >= 0;) {
        const frame = pending.slice(0, at)
        pending = pending.slice(at + 2)
        const line = frame.split("\n").find(line => line.startsWith("data: "))
        if (!line) continue
        const { event } = JSON.parse(line.slice(6))
        if (event?.data?.sessionID !== session.id) continue
        if (found) return true
        if (event.type !== "session.inbox.enqueued") continue
        assert(Buffer.byteLength(frame) < 2048)
        assert.deepEqual(event.data.item.payload.files,
          Array.from({ length: count }, () => ({ name, mime, source: { type: "deferred", sha256: digest(bytes) } })))
        found = true
      }
    }
  } finally {
    controller.abort()
    await reader.cancel().catch(() => {})
  }
}

export async function run({ call, fixture, folder, other }) {
  const opened = await call("/api/workspaces", post({ path: folder }))
  assert.equal(opened.status, 201)
  const { id, location } = await opened.json()
  const root = `/api/workspaces/${id}`
  const client = fixture.client
  const { DatabaseSync } = await import("node:sqlite")
  const database = new DatabaseSync(path.join(fixture.root, "fixture.db"))
  database.exec("PRAGMA busy_timeout=5000")
  const result = []
  try {
    const insert = database.prepare("INSERT INTO session_message(id,session_id,type,seq,data,time_created,time_updated) VALUES (?,?,'user',?,?,1,1)")
    const moveUndo = database.prepare("UPDATE session_v2 SET revert=? WHERE id=?")
    const nested = { directory: path.join(location.directory, "sub") }
    await mkdir(nested.directory, { recursive: true })
    for (const [rows, perRow] of [[1, 3], [4, 1]]) {
      const session = await client.session.create({ location: rows === 4 ? nested : location, title: "Attachment projection fixture" })
      const bytes = Buffer.alloc(5 * MiB, rows)
      const sha = digest(bytes)
      const file = { name: "attachment.bin", mime: "application/octet-stream", data: bytes.toString("base64"), source: { type: "inline" } }
      const ids = Array.from({ length: rows }, (_, i) => `msg_fixture_files_${rows}_${i}`)
      for (const [index, message] of ids.entries()) insert.run(message, session.id, index + 1,
        JSON.stringify({ text: "stored", time: { created: index + 1 }, files: Array.from({ length: perRow }, () => file) }))
      const page = await call(`${root}/session-history/window`, post({ sessionID: session.id, target: { kind: "latest" } }, referenceHeaders))
      assert.equal(page.status, 200)
      const wire = await page.text()
      assert(Buffer.byteLength(wire) < 4096)
      const window = JSON.parse(wire)
      assert.equal(window.status, "window", wire)
      assert.equal(window.userFiles, "reference-v1")
      assert.deepEqual(window.messages.map(row => row.id), ids)
      for (const row of window.messages) {
        assert.deepEqual(row.files, Array.from({ length: perRow }, () => ({ name: file.name, mime: file.mime, source: { type: "deferred", sha256: sha } })))
      }
      const href = (sessionID, messageID, index, hash) => `${root}/session-attachment/${sessionID}/${messageID}/${index}/${hash}`
      const target = href(session.id, ids[0], 0, sha)
      const downloaded = await call(target)
      assert.equal(downloaded.status, 200)
      assert.equal(downloaded.headers.get("content-type"), "application/octet-stream")
      assert.equal(downloaded.headers.get("content-disposition"), "attachment")
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes)
      const foreign = await client.session.create({ location: { directory: other }, title: "Foreign file fixture" })
      for (const [route, status] of [
        [href(session.id, ids[0], 0, "0".repeat(64)), 404],
        [href(session.id, ids[0], perRow, sha), 404],
        [href(session.id, "msg_absent", 0, sha), 404],
        [href(foreign.id, ids[0], 0, sha), 403],
      ]) assert.equal((await call(route)).status, status)
      moveUndo.run(JSON.stringify({ messageID: ids[0] }), session.id)
      assert.equal((await call(target)).status, 404)
      result.push({ rows, perRow, sha })
    }
    const session = await client.session.create({ location, title: "Native attachment blob fixture" })
    const message = "msg_fixture_owned_blob"
    const bytes = Buffer.alloc(8 * MiB, 37), sha = digest(bytes)
    database.prepare("INSERT INTO blob(hash,mime,bytes,data,time_created) VALUES (?,'application/octet-stream',?,?,1)").run(sha, bytes.length, bytes)
    database.prepare("INSERT INTO blob_ref(session_id,message_id,hash,seq) VALUES (?,?,?,1)").run(session.id, message, sha)
    insert.run(message, session.id, 1, JSON.stringify({ text: "stored", time: { created: 1 },
      files: [{ mime: "application/octet-stream", uri: `media:${sha}`, name: "stored.bin" }] }))
    const route = `${root}/session-attachment/${session.id}/${message}/0/${sha}`
    const response = await call(route)
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    database.prepare("UPDATE blob SET data=zeroblob(?),bytes=? WHERE hash=?").run(bytes.length + 1, bytes.length + 1, sha)
    assert.equal((await call(route)).status, 413)
    result.push({ blob: true, bound: bytes.length })
    return { history: result, stream: await qualifyStream(call, client, id, location, 255 * 1024, 1),
      largeStream: await qualifyStream(call, client, id, location, 5 * MiB, 3) }
  } finally {
    database.close()
    await call(root, { method: "DELETE" })
  }
}
