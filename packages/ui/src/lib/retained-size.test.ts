import assert from "node:assert/strict"
import test from "node:test"

import { estimateRetainedBytes, estimateRetainedBytesIncrementally } from "./retained-size.ts"

test("handles shared buffers and aborts before traversing a lazy tail", async () => {
  const buffer = new ArrayBuffer(64)
  const references = [buffer, new Uint8Array(buffer), new DataView(buffer)]
  assert.equal(estimateRetainedBytes(references), estimateRetainedBytes([null, null, null]) + buffer.byteLength)

  let accessed = false
  Object.defineProperty(references, 3, { enumerable: true, get: () => { accessed = true; return "tail" } })
  references.length = 4
  const controller = new AbortController()
  const measurement = estimateRetainedBytesIncrementally(references, { signal: controller.signal, yieldEvery: 1 })
  await Promise.resolve()
  assert.equal(accessed, false)
  controller.abort()
  await assert.rejects(measurement, { name: "AbortError" })
})
