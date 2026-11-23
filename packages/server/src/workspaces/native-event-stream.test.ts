import assert from "node:assert/strict"
import test from "node:test"
import { userFileDigest } from "../opencode/user-file-reference"
import { projectLargeNativeEvents } from "./native-event-stream"

test("the shared SDK stream receives a large inbox as references and retains following events", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 23)
  const file = { name: "inbox.bin", mime: "application/octet-stream", data: bytes.toString("base64") }
  const inbox = (count: number) => ({ type: "session.inbox.enqueued", data: { item: { type: "user", payload: {
    files: Array(count).fill(file),
  } } } })
  const wire = [": ping\r", "\n\r\n", `data: ${JSON.stringify(inbox(3))}\r`, "\n\r", "\ndata: {\"type\":\"after\"}\n\n"]
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    const chunk = wire.shift()
    if (chunk === undefined) controller.close()
    else controller.enqueue(encoder.encode(chunk))
  } })
  const response = projectLargeNativeEvents(new Response(stream, { headers: { "content-type": "text/event-stream" } }))
  const text = await response.text()
  assert(text.startsWith(": ping\n\n"))
  assert(text.length < 2048)
  const records = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
  assert.deepEqual(records[0].data.item.payload.files, Array(3).fill({
    name: file.name, mime: file.mime, source: { type: "deferred", sha256: userFileDigest(bytes) },
  }))
  assert.deepEqual(records[1], { type: "after" })
})
