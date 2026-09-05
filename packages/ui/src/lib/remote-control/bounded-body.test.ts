import assert from "node:assert/strict"
import test from "node:test"

import { readBoundedBody } from "./bounded-body"

test("reads request bodies only up to the transport limit", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2))
      controller.enqueue(Uint8Array.of(3))
      controller.close()
    },
  })
  assert.deepEqual(await readBoundedBody(source, 3), Uint8Array.of(1, 2, 3))
})

test("cancels request body reads before retaining oversized input", async () => {
  let cancelled = false
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4))
      controller.enqueue(new Uint8Array(4))
    },
    cancel() {
      cancelled = true
    },
  })
  assert.equal(await readBoundedBody(source, 4), null)
  assert.equal(cancelled, true)
})
