import assert from "node:assert/strict"
import test from "node:test"
import { parseHostMessage, readPairingInput } from "./relay-messages"

const id = "123e4567-e89b-42d3-a456-426614174000"

test("host relay messages require bounded identifiers and close metadata", () => {
  assert.ok(parseHostMessage(JSON.stringify({ type: "tunnel.message", id, data: "", binary: true })))
  assert.equal(parseHostMessage(JSON.stringify({ type: "tunnel.message", id: "not-a-uuid", data: "", binary: true })), null)
  assert.equal(parseHostMessage(JSON.stringify({ type: "tunnel.close", id, reason: 42 })), null)
  assert.equal(parseHostMessage(JSON.stringify({ type: "tunnel.close", id, code: 1.5 })), null)
  assert.equal(parseHostMessage(JSON.stringify({ type: "tunnel.close", id, reason: "🙂".repeat(31) })), null)
})

test("pairing input rejects excessive stream fragmentation", async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array())
    },
    cancel() {
      cancelled = true
    },
  })

  assert.equal(await readPairingInput(new Request("https://relay.example", { method: "POST", body: stream, duplex: "half" } as RequestInit), 4096), null)
  assert.equal(cancelled, true)
})
