import assert from "node:assert/strict"
import { test } from "node:test"
import { deferToolMedia, INLINE_MEDIA_LIMIT, mediaDigest, sessionMediaPath, toolFile } from "./session-media"
import { isSessionMediaPath, MESSAGE_LIMIT, parseSessionMediaPath } from "./session-media-contract"
import { crc32 } from "node:zlib"

const image = (bytes: number, mime = "image/png") => ({ type: "file", mime, name: "shot.png", uri: `data:${mime};base64,${"A".repeat(bytes)}` })

test("large tool images become digest-pinned session-media paths; everything else stays inline", () => {
  const large = image(INLINE_MEDIA_LIMIT), small = image(1024)
  const mismatched = { ...image(INLINE_MEDIA_LIMIT), mime: "image/jpeg" }
  const text = { type: "text", text: "A".repeat(INLINE_MEDIA_LIMIT * 2) }
  const pdf = image(INLINE_MEDIA_LIMIT, "application/pdf")
  const messages = [
    { id: "msg_user", type: "user", text: "look", files: [image(INLINE_MEDIA_LIMIT)] },
    { id: "msg_assistant", type: "assistant", content: [
      { type: "text", text: "Reading" },
      { type: "tool", id: "call", name: "read", state: { status: "completed", content: [text, structuredClone(large), small, mismatched, pdf] } },
    ] },
  ]
  const before = structuredClone(messages)
  deferToolMedia(messages, { workspaceId: "w/1", sessionId: "ses_1" })

  const files = (messages[1] as any).content[1].state.content
  const path = files[1].uri as string
  assert.equal(path, `/api/workspaces/w%2F1/session-media/ses_1/msg_assistant/1/1/${mediaDigest(large.uri)}`)
  assert.ok(isSessionMediaPath(path))
  assert.deepEqual({ ...files[1], uri: large.uri }, large, "only the URI changes")
  assert.deepEqual([files[0], files[2], files[3], files[4]], [text, small, mismatched, pdf])
  assert.deepEqual(messages[0], before[0], "user attachments are not tool results")
  assert.equal(toolFile(before[1], 1, 1), (before[1] as any).content[1].state.content[1])
  assert.equal(toolFile(before[1], 0, 0), undefined)
  for (const value of [undefined, null, {}, [null, { type: "assistant" }, { type: "assistant", id: "m", content: [null, { type: "tool" }] }]]) {
    assert.doesNotThrow(() => deferToolMedia(value, { workspaceId: "w", sessionId: "s" }))
  }
})

test("real producer and parser agree at positions, identities and encoded path boundaries", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64")
  const payload = Buffer.from(`padding\0${"x".repeat(25_000)}`)
  const chunk = Buffer.alloc(payload.length + 12)
  chunk.writeUInt32BE(payload.length); chunk.write("tEXt", 4); payload.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  const uri = `data:image/png;base64,${Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]).toString("base64")}`
  assert(uri.length > INLINE_MEDIA_LIMIT)
  const digest = mediaDigest(uri)
  const run = (part: number, index: number, scope = { workspaceId: "w", sessionId: "s" }, messageId = "m", admitted = true) => {
    const files: unknown[] = Array(index + 1).fill(null)
    const file = { type: "file", mime: "image/png", name: "real.png", uri }
    files[index] = file
    const content: unknown[] = Array(part + 1).fill(null)
    content[part] = { type: "tool", state: { status: "completed", content: files } }
    const message = { id: messageId, type: "assistant", content }
    const before = structuredClone(message)
    assert(Buffer.byteLength(JSON.stringify({ data: message })) < MESSAGE_LIMIT)
    deferToolMedia([message], scope)
    if (admitted) {
      assert.deepEqual(parseSessionMediaPath(file.uri), { ...scope, messageId, part, index, digest })
      file.uri = uri
    } else assert.equal(file.uri, uri)
    assert.deepEqual(message, before, "only an admitted URI may change")
  }
  for (const position of [100000, 100001]) {
    run(position, 0, undefined, undefined, position === 100000)
    run(0, position, undefined, undefined, position === 100000)
  }
  for (const length of [256, 257]) {
    const id = "a".repeat(length), admitted = length === 256
    run(0, 0, { workspaceId: id, sessionId: "s" }, "m", admitted)
    run(0, 0, { workspaceId: "w", sessionId: id }, "m", admitted)
    run(0, 0, undefined, id, admitted)
  }
  run(0, 0, undefined, "\ud800", false)
  run(0, 0, { workspaceId: "界".repeat(256), sessionId: "界".repeat(256) }, "界".repeat(256), false)
  const chars = Array<string>(765).fill("a")
  const base = sessionMediaPath({ workspaceId: "a".repeat(255), sessionId: "a".repeat(255), messageId: "a".repeat(255), part: 0, index: 0, digest }).length
  let found = false
  for (let nine = Math.floor((4096 - base) / 8); nine >= 0 && !found; nine--) {
    for (let six = 0; six < 4 && !found; six++) for (let three = 0; three < 6 && !found; three++) {
      if (nine * 8 + six * 5 + three * 2 !== 4096 - base) continue
      chars.fill("界", 0, nine); chars.fill("é", nine, nine + six); chars.fill("/", nine + six, nine + six + three)
      found = true
    }
  }
  assert(found)
  const [workspaceId, sessionId, messageId] = [0, 255, 510].map(start => chars.slice(start, start + 255).join(""))
  assert.equal(sessionMediaPath({ workspaceId, sessionId, messageId, part: 0, index: 0, digest }).length, 4096)
  run(0, 0, { workspaceId, sessionId }, messageId)
  run(0, 0, { workspaceId: workspaceId + "a", sessionId }, messageId, false)
})
