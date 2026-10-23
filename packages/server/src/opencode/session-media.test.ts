import assert from "node:assert/strict"
import { test } from "node:test"
import { deferToolMedia, INLINE_MEDIA_LIMIT, mediaDigest, toolFile } from "./session-media"
import { isSessionMediaPath } from "./session-media-contract"

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
