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

test("unmeasured zero-seeded probes survive repeated reorders by key", () => {
  let keys = ["a", "b"]
  let state = remapVirtualMeasurements(keys, [...keys, "prompt"], [[48, 48], 48])!
  keys = [...keys, "prompt"]
  for (let i = 0; i < 20; i++) {
    const next = [...keys].reverse()
    state = remapVirtualMeasurements(keys, next, state.cache, true, state.probes.map(index => keys[index]))!
    keys = next
    assert.deepEqual(state.probes, [keys.indexOf("prompt")])
    assert.equal(state.cache[0][keys.indexOf("prompt")], 0)
  }
})

test("settled probes preserve positive measurements without remounting offscreen rows", () => {
  assert.deepEqual(remapVirtualMeasurements(["a", "prompt"], ["prompt", "a"], [[48, 72], 48], false, ["prompt"]), {
    cache: [[72, 48], 48], probes: [],
  })
})

test("probe overflow restores estimation instead of stranding zero-height rows", () => {
  const keys = ["a", ...Array.from({ length: 8 }, (_, i) => `pending-${i}`)]
  const result = remapVirtualMeasurements(keys, [...keys, "new"], [[48, ...Array(8).fill(0)], 48], true, keys.slice(1))!
  assert.deepEqual(result.probes, [])
  assert.deepEqual(result.cache, [[48, ...Array(9).fill(-1)], 48])
})

test("removed pending keys cannot seed an unrelated row at their former index", () => {
  assert.deepEqual(remapVirtualMeasurements(["pending", "a", "b"], ["b", "a"], [[0, 48, 72], 48], false, ["pending"]), {
    cache: [[72, 48], 48], probes: [],
  })
})
