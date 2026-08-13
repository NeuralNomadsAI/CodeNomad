import assert from "node:assert/strict"
import test from "node:test"

import { estimateRetainedBytes, estimateRetainedBytesIncrementally } from "./retained-size.ts"

test("retained-size estimators traverse Map keys and values and Set values", async () => {
  const key = { payload: "key" }
  const value = { payload: "value" }
  const member = { payload: "member" }
  const map = new Map([[key, value]])
  const set = new Set([member])
  const expectedMap = 32 + 24 + estimateRetainedBytes(key) + estimateRetainedBytes(value)
  const expectedSet = 32 + 16 + estimateRetainedBytes(member)

  assert.equal(estimateRetainedBytes(map), expectedMap)
  assert.equal(await estimateRetainedBytesIncrementally(map, { yieldEvery: 1 }), expectedMap)
  assert.equal(estimateRetainedBytes(set), expectedSet)
  assert.equal(await estimateRetainedBytesIncrementally(set, { yieldEvery: 1 }), expectedSet)
})

test("retained-size estimators count a shared ArrayBuffer backing store once", async () => {
  const buffer = new ArrayBuffer(64)
  const references = [buffer, new Uint8Array(buffer), new DataView(buffer)]
  const expected = estimateRetainedBytes([null, null, null]) + buffer.byteLength

  assert.equal(estimateRetainedBytes(references), expected)
  assert.equal(await estimateRetainedBytesIncrementally(references, { yieldEvery: 1 }), expected)
})

test("incremental retained-size consumes root iterables lazily", async () => {
  let yielded = 0
  function* roots() {
    yielded += 1
    yield { text: "one" }
    yielded += 1
    yield { text: "two" }
  }

  const measurement = estimateRetainedBytesIncrementally(roots(), { rootIterable: true, yieldEvery: 1 })
  assert.ok(yielded < 2)
  assert.ok(await measurement > 0)
  assert.equal(yielded, 2)
})

test("incremental retained-size consumes array children lazily", async () => {
  let accessed = 0
  const values = ["one"]
  Object.defineProperty(values, 1, { enumerable: true, get: () => { accessed += 1; return "two" } })
  values.length = 2

  const controller = new AbortController()
  const measurement = estimateRetainedBytesIncrementally(values, { signal: controller.signal, yieldEvery: 1 })
  await Promise.resolve()
  assert.equal(accessed, 0)
  controller.abort()
  await assert.rejects(measurement, { name: "AbortError" })
})

test("limited retained-size does not enumerate an entire collection", () => {
  let yielded = 0
  const map = new Map(Array.from({ length: 100 }, (_, index) => [index, index]))
  const entries = map.entries.bind(map)
  ;(map as any)[Symbol.iterator] = function* () {
    for (const entry of entries()) {
      yielded += 1
      yield entry
    }
  }

  assert.ok(estimateRetainedBytes(map, 40) > 40)
  assert.equal(yielded, 0)
})

test("incremental retained-size stops at byte and node ceilings", async () => {
  assert.equal(await estimateRetainedBytesIncrementally("large", { maxBytes: 1 }), Number.POSITIVE_INFINITY)
  assert.equal(await estimateRetainedBytesIncrementally({ child: {} }, { maxNodes: 1 }), Number.POSITIVE_INFINITY)
})
