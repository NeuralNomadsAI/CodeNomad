import assert from "node:assert/strict"
import test from "node:test"
import {
  estimateRetainedBytes,
  estimateRetainedValuesIncrementally,
  exceedsRetainedByteLimit,
  selectSessionMemoryEvictions,
} from "./session-memory-budget.ts"

test("session memory eviction applies one byte budget across workspaces and subagents", () => {
  const entries = Array.from({ length: 5 }, (_, workspace) => [
    { key: `${workspace}:parent`, byteSize: 8, lastTouched: workspace * 2 + 1, protected: workspace === 4 },
    { key: `${workspace}:subagent`, byteSize: 8, lastTouched: workspace * 2 + 2, protected: false },
  ]).flat()

  const evictions = selectSessionMemoryEvictions(entries, 40)
  assert.deepEqual(evictions, ["0:parent", "0:subagent", "1:parent", "1:subagent", "2:parent"])
  assert.equal(evictions.includes("4:parent"), false)
})

test("session memory eviction favors old large sessions and permits protected overage", () => {
  assert.deepEqual(selectSessionMemoryEvictions([
    { key: "visible", byteSize: 12, lastTouched: 3, protected: true },
    { key: "old-large", byteSize: 10, lastTouched: 1, protected: false },
    { key: "new-small", byteSize: 2, lastTouched: 2, protected: false },
  ], 12), ["old-large", "new-small"])
  assert.deepEqual(selectSessionMemoryEvictions([{ key: "visible", byteSize: 20, lastTouched: 1, protected: true }], 10), [])
})

test("retained byte estimates handle cycles without allocating serialized copies", () => {
  const value: { text: string; self?: unknown } = { text: "hello" }
  value.self = value
  assert.ok(estimateRetainedBytes(value) >= 26)
  assert.equal(exceedsRetainedByteLimit(Array.from({ length: 1_000 }, () => ({})), 10_000), true)
})

test("incremental retained byte estimates yield without changing the estimate", async () => {
  const values = Array.from({ length: 20 }, (_, index) => ({ index, text: `message-${index}` }))
  let yields = 0
  const measured = await estimateRetainedValuesIncrementally(values, {
    yieldEvery: 5,
    yieldControl: async () => { yields += 1 },
  })

  assert.equal(measured, values.reduce((total, value) => total + estimateRetainedBytes(value), 0))
  assert.ok(yields > 1)
})

test("incremental retained byte estimates stop at a cancellation checkpoint", async () => {
  const controller = new AbortController()
  let yields = 0
  await assert.rejects(estimateRetainedValuesIncrementally([
    Array.from({ length: 1_000 }, (_, index) => ({ index })),
  ], {
    signal: controller.signal,
    yieldEvery: 10,
    yieldControl: async () => {
      yields += 1
      controller.abort(new Error("measurement replaced"))
    },
  }), /measurement replaced/)
  assert.equal(yields, 1)
})
