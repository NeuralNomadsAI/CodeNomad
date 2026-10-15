import assert from "node:assert/strict"
import { test } from "node:test"
import { createListLayout } from "virtua/unstable_core"
import { remapVirtualMeasurements } from "./virtual-follow-measurements"

test("reorders measured sizes by stable key without mutating the previous cache", () => {
  const cache: [number[], number] = [[140, 0, 420], 200]
  assert.deepEqual(remapVirtualMeasurements(["a", "meta", "b"], ["b", "a", "meta"], cache), {
    cache: [[420, 140, 0], 280], probes: [],
  })
  assert.deepEqual(cache, [[140, 0, 420], 200])
})

test("small insertions start at zero only when scheduled for immediate measurement", () => {
  assert.deepEqual(remapVirtualMeasurements(["a", "b"], ["meta", "a", "prompt", "b"], [[140, 420], 200]), {
    cache: [[0, 140, 0, 420], 280], probes: [0, 2],
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
  assert.deepEqual(result.cache, [[140, ...Array(200).fill(-1)], 140])
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
    cache: [[72, 48], 60], probes: [],
  })
})

test("probe overflow returns pending rows to the carried default instead of stranding zero-height rows", () => {
  const keys = ["a", ...Array.from({ length: 8 }, (_, i) => `pending-${i}`)]
  const result = remapVirtualMeasurements(keys, [...keys, "new"], [[48, ...Array(8).fill(0)], 48], true, keys.slice(1))!
  assert.deepEqual(result.probes, [])
  assert.deepEqual(result.cache, [[48, ...Array(9).fill(-1)], 48])
})

test("removed pending keys cannot seed an unrelated row at their former index", () => {
  assert.deepEqual(remapVirtualMeasurements(["pending", "a", "b"], ["b", "a"], [[0, 48, 72], 48], false, ["pending"]), {
    cache: [[72, 48], 60], probes: [],
  })
})

// VirtualFollowList remounts Virtua with `cache` and `itemSize={cache[1]}`.
// Virtua documents its CacheSnapshot as internal: an upgrade that changes
// this layout or the itemSize semantics must fail here, not in production.
test("Virtua keeps the carried default for unmeasured rows and never re-estimates it", () => {
  // createListLayout is untyped: the runtime assertions below pin the contract.
  const layout = createListLayout(3, 210, [[120, -1, 300], 210])
  assert.equal(layout.$getItemSize(1), 210)
  assert.equal(layout.$getTotalSize(), 630)
  assert.equal(layout.$estimateDefaultSize, undefined)
  assert.deepEqual(layout.$snapshot(), [[120, -1, 300], 210])
})

test("a carried fallback default is refreshed once every retained row is measured", () => {
  // A new conversation remounts on its next append before Virtua's first
  // estimate, so the snapshot carries the 40px fallback.
  const append = remapVirtualMeasurements(["a", "b"], ["a", "b", "c"], [[120, 300], 40], true)!
  assert.equal(append.cache[1], 210)
  // A later page of never-measured rows is sized by the refreshed default.
  const older = Array.from({ length: 50 }, (_, i) => `older-${i}`)
  const page = remapVirtualMeasurements(["a", "b", "c"], [...older, "a", "b", "c"], [[120, 300, 80], append.cache[1]])!
  assert.equal(createListLayout(page.cache[0].length, page.cache[1], page.cache).$getTotalSize(), 50 * 120 + 500)
  // Unmeasured retained rows keep the carried default: refreshing it would resize them.
  assert.equal(remapVirtualMeasurements(["a", "b"], ["a", "b", "c"], [[-1, 300], 40], true)!.cache[1], 40)
})
