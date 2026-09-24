import assert from "node:assert/strict"
import test from "node:test"

import { parseRelayDevices, parseRelayPairing, readRelayJson } from "./relay-response"

test("Remote Control bounds relay control responses before parsing JSON", async () => {
  const oversized = new Response("{}", { headers: { "content-length": String(129 * 1024) } })
  await assert.rejects(() => readRelayJson(oversized), /too large/)

  const streamed = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(128 * 1024))
      controller.enqueue(Uint8Array.of(1))
    },
  }))
  await assert.rejects(() => readRelayJson(streamed), /too large/)
})

test("Remote Control validates pairing and device control metadata", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000"
  assert.deepEqual(parseRelayPairing({ token: "a".repeat(43), expiresAt: "2026-09-05T12:00:00.000Z" }), {
    token: "a".repeat(43),
    expiresAt: "2026-09-05T12:00:00.000Z",
  })
  assert.equal(parseRelayPairing({ token: "short", expiresAt: "later" }), null)
  assert.deepEqual(parseRelayDevices({ devices: [{
    id,
    name: "Browser",
    createdAt: "2026-09-05T12:00:00.000Z",
    lastSeenAt: "2026-09-05T12:01:00.000Z",
  }] })?.map((device) => device.id), [id])
  assert.equal(parseRelayDevices({ devices: Array.from({ length: 65 }, () => ({
    id,
    name: "Browser",
    createdAt: "2026-09-05T12:00:00.000Z",
    lastSeenAt: "2026-09-05T12:01:00.000Z",
  })) }), null)
})
