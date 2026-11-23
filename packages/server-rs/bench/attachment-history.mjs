import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { crc32 } from "node:zlib"
import { fromDist, privateGit } from "./fixtures.mjs"

export async function prepare({ root }) {
  // Strict media ownership refuses Git environment overrides. A private
  // enclosing checkout stops discovery before reaching the CodeNomad checkout.
  await privateGit(root, "attachment-history-boundary")
}

const MiB = 1024 * 1024
const referenceHeaders = { "x-codenomad-user-files": "reference-v1" }
const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const post = (value, headers = {}) => ({
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value),
})

async function toolMedia(call, client, id, root, location, other, database) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQij8BAAIIAVL6yIt6AAAAAElFTkSuQmCC", "base64")
  // 200 KiB PNG (~267 KiB base64) exceeds the 256 KiB inline per-message budget.
  const text = Buffer.from("Comment\0" + "a".repeat(200 * 1024))
  const chunk = Buffer.alloc(text.length + 12)
  chunk.writeUInt32BE(text.length); chunk.write("tEXt", 4); text.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  const large = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)])
  const files = [png, large].map((bytes, index) => ({
    type: "file", name: `image-${index}.png`, mime: "image/png", uri: `data:image/png;base64,${bytes.toString("base64")}`,
  }))
  const session = await client.session.create({ location, title: "Deferred images" })
  const foreign = await client.session.create({ location: { directory: other }, title: "Foreign media" })
  const message = "msg_deferred_media_fixture"
  const content = [{ type: "text", text: "Fixture" }, { type: "tool", id: "call_media_fixture", name: "read",
    time: { created: 1, completed: 2 }, state: { status: "completed", input: {}, content: [{ type: "text", text: "Images" }, ...files] } }]
  const userID = seq => `msg_deferred_media_${String(seq).padStart(3, "0")}`
  const insert = database.prepare("INSERT INTO session_message(id,session_id,type,seq,data,time_created,time_updated) VALUES (?,?,'user',?,?,?,?)")
  const attachment = { name: "note.bin", mime: "application/octet-stream", data: Buffer.from("reference fixture").toString("base64"), source: { type: "inline" } }
  for (let seq = 1; seq <= 202; seq++) {
    if (seq !== 186) insert.run(userID(seq), session.id, seq, JSON.stringify({
      text: "Fixture", time: { created: seq }, ...(seq === 185 ? { files: [attachment] } : {}),
    }), seq, seq)
  }
  const input = { sessionID: session.id, target: { kind: "before", messageID: message } }
  database.prepare("INSERT INTO session_message(id,session_id,type,seq,data,time_created,time_updated) VALUES (?,?,'assistant',186,?,186,187)")
    .run(message, session.id, JSON.stringify({ time: { created: 186, completed: 187 }, content,
      agent: "build", model: { providerID: "fixture", id: "fixture" } }))
  const native = await client.session.message.get({ sessionID: session.id, messageID: message })
  assert.equal(native.id, message)
  assert.deepEqual(native.content[1].state.content.slice(1), files)
  const window = async headers => {
    const response = await call(`${root}/session-history/window`, post(input, headers))
    const data = await response.json()
    assert.equal(response.status, 200)
    assert.equal(data.status, "window", JSON.stringify(data).slice(0, 256))
    return data
  }
  const inline = await window({})
  const tool = page => page.messages[184].content[1].state.content
  const order = Array.from({ length: 200 }, (_, index) => index === 184 ? message : userID(index + 2))
  const { messages, ...cursors } = inline
  assert.deepEqual(messages.map(row => row.id), order)
  assert.deepEqual(cursors, { status: "window", older: { kind: "before", messageID: userID(2) },
    newer: { kind: "after", messageID: userID(201) }, resume: input.target, latest: false })
  assert.deepEqual(tool(inline).slice(1), files)
  assert.deepEqual(await window({ "x-codenomad-media": "inline" }), inline)
  const optIn = { "x-codenomad-media": "deferred" }
  const deferred = await window(optIn)
  const reference = `${root}/session-media/${session.id}/${message}/1/2/${digest(files[1].uri)}`
  assert.deepEqual(tool(deferred).slice(1), [files[0], { ...files[1], uri: reference }])
  tool(deferred)[2].uri = files[1].uri
  assert.deepEqual(deferred, inline, "the window only replaces the large URI")
  const combined = await window({ ...optIn, ...referenceHeaders })
  assert.equal(combined.userFiles, "reference-v1")
  assert.equal(tool(combined)[2].uri, reference)
  assert.deepEqual(combined.messages[183].files, [{ name: attachment.name, mime: attachment.mime,
    source: { type: "deferred", sha256: digest(Buffer.from(attachment.data, "base64")) } }])
  const list = async headers => {
    const response = await call(`/workspaces/${id}/instance/api/session/${session.id}/message?limit=25`, { headers })
    assert.equal(response.status, 200)
    return response.json()
  }
  const listInline = await list({})
  const listRow = page => page.data.find(row => row.id === message)
  const listTool = page => listRow(page).content[1].state.content
  assert.deepEqual(listTool(listInline).slice(1), files)
  assert.deepEqual(await list({ "x-codenomad-media": "inline" }), listInline)
  const listDeferred = await list(optIn)
  assert.deepEqual(listTool(listDeferred).slice(1), [files[0], { ...files[1], uri: reference }])
  listTool(listDeferred)[2].uri = files[1].uri
  assert.deepEqual(listDeferred, listInline, "message.list only replaces the large URI")
  const { parseSessionMediaPath } = await fromDist("opencode/session-media-contract.js")
  assert.deepEqual(parseSessionMediaPath(reference), {
    workspaceId: root.split("/").at(-1), sessionId: session.id, messageId: message, part: 1, index: 2, digest: digest(files[1].uri),
  })
  const served = await call(reference)
  assert.equal(served.status, 200, `${served.status} for deferred image`)
  const headers = Object.fromEntries(["content-type", "cache-control", "x-content-type-options", "content-security-policy"]
    .map(key => [key, served.headers.get(key)]))
  assert.deepEqual(headers, { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" })
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), large)
  const assertNoImage = async (target, expected) => {
    const response = await call(target)
    const raw = Buffer.from(await response.arrayBuffer())
    assert.equal(response.status, expected)
    assert(!raw.includes(png.subarray(0, 8)), `refused media response leaked PNG bytes (${expected})`)
    assert(!raw.includes(large), `refused media response leaked image bytes (${expected})`)
    return response.status
  }
  const badDigest = await assertNoImage(reference.slice(0, -64) + "0".repeat(64), 404)
  const foreignStatus = await assertNoImage(reference.replace(`/${session.id}/`, `/${foreign.id}/`), 403)
  database.prepare("UPDATE session_v2 SET revert=? WHERE id=?").run(JSON.stringify({ messageID: message }), session.id)
  const undoStatus = await assertNoImage(reference, 404)
  database.prepare("UPDATE session_v2 SET revert=NULL WHERE id=?").run(session.id)
  await client.session.move({ sessionID: session.id, directory: other })
  const movedStatus = await assertNoImage(reference, 403)
  return { order: digest(order.join("\n")), cursors, listDeferred: true,
    reference: reference.replace(root, "/api/workspaces/workspace").replace(session.id, "session"),
    bytes: digest(large), headers, badDigest, foreign: foreignStatus, undo: undoStatus, moved: movedStatus }
}

async function qualifyStream(call, client, id, location, size, count, nativeSend = false) {
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
    const input = { text: "stream fixture", files: Array.from({ length: count }, () => file) }
    if (nativeSend) await client.session.prompt({ sessionID: session.id, ...input })
    else {
      const prompt = await call(`/workspaces/${id}/instance/api/session/${session.id}/prompt`, post(input))
      assert.equal(prompt.status, 200, await prompt.text())
    }
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
    return { history: result, toolMedia: await toolMedia(call, client, id, root, location, other, database),
      stream: await qualifyStream(call, client, id, location, 255 * 1024, 1),
      largeStream: await qualifyStream(call, client, id, location, 5 * MiB, 3),
      nestedStream: await qualifyStream(call, client, id, nested, 5 * MiB, 3, true) }
  } finally {
    database.close()
    await call(root, { method: "DELETE" })
  }
}
