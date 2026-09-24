import assert from "node:assert/strict"
import test from "node:test"

import { FrameBudget } from "./frame-budget"

test("bounds queued frames by count and aggregate bytes", () => {
  const budget = new FrameBudget(2, 10)
  const releaseFirst = budget.reserve(6)
  const releaseSecond = budget.reserve(4)
  assert.ok(releaseFirst)
  assert.ok(releaseSecond)
  assert.equal(budget.reserve(0), null)
  assert.equal(budget.reserve(1), null)
  assert.deepEqual(budget.usage(), { frames: 2, bytes: 10 })

  releaseFirst()
  const releaseReplacement = budget.reserve(5)
  assert.ok(releaseReplacement)
  assert.deepEqual(budget.usage(), { frames: 2, bytes: 9 })
  releaseFirst()
  releaseSecond()
  releaseReplacement()
  assert.deepEqual(budget.usage(), { frames: 0, bytes: 0 })
})

test("rejects invalid budget limits and frame sizes", () => {
  assert.throws(() => new FrameBudget(0, 1), RangeError)
  assert.throws(() => new FrameBudget(1, Number.POSITIVE_INFINITY), RangeError)
  const budget = new FrameBudget(1, 1)
  assert.throws(() => budget.reserve(-1), RangeError)
  assert.throws(() => budget.reserve(1.5), RangeError)
})
