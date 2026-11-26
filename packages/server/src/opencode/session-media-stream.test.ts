import assert from "node:assert/strict"
import { test } from "node:test"
import { INLINE_MEDIA_LIMIT, mediaDigest } from "./session-media"
import { deferToolMediaStream } from "./session-media-stream"

function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const parts: Buffer[] = []
  for await (const chunk of stream) {
    parts.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk))
  }
  return Buffer.concat(parts).toString("utf8")
}

function makeMessage(id: string, dataUri: string, text = "ok") {
  return {
    id,
    type: "assistant",
    content: [
      { type: "text", text },
      {
        type: "tool",
        id: `tool_${id}`,
        name: "read",
        state: {
          status: "completed",
          content: [{ type: "file", mime: "image/png", uri: dataUri }],
        },
      },
    ],
  }
}

test("deferToolMediaStream projects multi-message pages larger than per-element cap across arbitrary chunk splits", async () => {
  const bigUri = `data:image/png;base64,${"A".repeat(INLINE_MEDIA_LIMIT + 1024)}`
  const digest = mediaDigest(bigUri)
  const messages = Array.from({ length: 6 }, (_, index) =>
    makeMessage(`m${index}`, bigUri, `hello "world" \\ café 😀 ${index}`),
  )
  const raw = Buffer.from(JSON.stringify({ meta: { data: [1, 2] }, data: messages, next: "cur_1" }), "utf8")
  // Split into tiny 13-byte chunks to split keys, escapes, multibyte UTF-8, and base64 payloads.
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < raw.byteLength; offset += 13) {
    chunks.push(raw.subarray(offset, offset + 13))
  }
  // Total payload (~200 KiB) exceeds maxElementBytes (64 KiB), while each message (~34 KiB) fits.
  const out = await collect(
    deferToolMediaStream(makeStream(chunks), { workspaceId: "ws/1", sessionId: "ses_1" }, 64 * 1024),
  )
  const parsed = JSON.parse(out) as {
    meta: { data: number[] }
    data: Array<{ id: string; content: Array<{ text?: string; state?: { content: Array<{ uri: string }> } }> }>
    next: string
  }
  assert.deepEqual(parsed.meta, { data: [1, 2] })
  assert.equal(parsed.next, "cur_1")
  assert.equal(parsed.data.length, 6)
  for (let i = 0; i < 6; i++) {
    assert.equal(parsed.data[i]!.content[0]!.text, `hello "world" \\ café 😀 ${i}`)
    assert.equal(
      parsed.data[i]!.content[1]!.state!.content[0]!.uri,
      `/api/workspaces/ws%2F1/session-media/ses_1/m${i}/1/0/${digest}`,
    )
  }
})

test("deferToolMediaStream streams an oversized single message raw without skipping subsequent messages", async () => {
  const hugeUri = `data:image/png;base64,${"B".repeat(INLINE_MEDIA_LIMIT + 40_000)}`
  const normalUri = `data:image/png;base64,${"C".repeat(INLINE_MEDIA_LIMIT + 512)}`
  const normalDigest = mediaDigest(normalUri)
  const raw = Buffer.from(
    JSON.stringify({ data: [makeMessage("huge", hugeUri), makeMessage("normal", normalUri)] }),
    "utf8",
  )
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < raw.byteLength; offset += 4096) {
    chunks.push(raw.subarray(offset, offset + 4096))
  }
  // Cap single element at 48 KiB: `huge` (~73 KiB) streams raw, `normal` (~33 KiB) still projects.
  const out = await collect(
    deferToolMediaStream(makeStream(chunks), { workspaceId: "w", sessionId: "s" }, 48 * 1024),
  )
  const parsed = JSON.parse(out) as {
    data: Array<{ content: Array<{ state?: { content: Array<{ uri: string }> } }> }>
  }
  assert.equal(parsed.data[0]!.content[1]!.state!.content[0]!.uri, hugeUri)
  assert.equal(
    parsed.data[1]!.content[1]!.state!.content[0]!.uri,
    `/api/workspaces/w/session-media/s/normal/1/0/${normalDigest}`,
  )
})
