import assert from "node:assert/strict"
import { test } from "node:test"
import { remapVirtualMeasurements } from "./virtual-follow-measurements"

test("reorders measured sizes by stable key without mutating the previous cache", () => {
  const cache: [number[], number] = [[140, 0, 420], 200]
  assert.deepEqual(remapVirtualMeasurements(["a", "meta", "b"], ["b", "a", "meta"], cache), {
    cache: [[420, 140, 0], 200], probes: [],
  })
  assert.deepEqual(cache, [[140, 0, 420], 200])
})

test("small insertions start at zero only when scheduled for immediate measurement", () => {
  assert.deepEqual(remapVirtualMeasurements(["a", "b"], ["meta", "a", "prompt", "b"], [[140, 420], 200]), {
    cache: [[0, 140, 0, 420], 200], probes: [0, 2],
  })
})

test("following remeasures unknown tail entries rather than estimating them as full replies", () => {
  assert.deepEqual(remapVirtualMeasurements(["a", "meta"], ["prompt", "a", "meta"], [[140, -1], 200], true), {
    cache: [[0, 140, 0], 200], probes: [0, 2],
  })
  assert.deepEqual(remapVirtualMeasurements(["a", "meta"], ["prompt", "a", "meta"], [[140, -1], 200]), {
    cache: [[0, 140, -1], 200], probes: [0],
  })
})

test("unknown offscreen history is never collapsed to zero by tail probing", () => {
  const keys = Array.from({ length: 12 }, (_, i) => String(i))
  const result = remapVirtualMeasurements(keys, [...keys, "prompt"], [[-1, ...Array(11).fill(140)], 200], true)!
  assert.equal(result.cache[0][0], -1)
  assert.deepEqual(result.probes, [12])
})

test("large page changes keep unknown-size estimation and a bounded probe set", () => {
  const next = ["a", ...Array.from({ length: 200 }, (_, i) => String(i))]
  const result = remapVirtualMeasurements(["a"], next, [[140], 200])!
  assert.deepEqual(result.probes, [])
  assert.deepEqual(result.cache, [[140, ...Array(200).fill(-1)], 200])
})

test("unrelated pages and missing measurements use a fresh virtualizer cache", () => {
  assert.equal(remapVirtualMeasurements(["a"], ["b"], [[140], 200]), undefined)
  assert.equal(remapVirtualMeasurements(["a"], ["a"], undefined), undefined)
})
