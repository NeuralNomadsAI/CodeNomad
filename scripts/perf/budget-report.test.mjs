import assert from "node:assert/strict"
import { test } from "node:test"
import { assertRatchet, budgetReport } from "./budget-report.mjs"

const budgets = {
  counters: { "solid.createComputation": { max: 115 } },
  callsByFile: { "timeline.ts": 100, "sidebar.tsx": 10, "moved.ts": 1 },
  latency: { 8: { shownP95: { max: 1.15 } } },
}
const ratios = { 8: { shownP95: { cn: 60, tui: 50, ratio: 1.2 } } }
const files = { "timeline.ts": 115, "sidebar.tsx": 12, "composer.tsx": 24, "moved.ts": .5 }

test("an exceeded counter names the metric and ranks positive call growth by file", () => {
  const { report, failures } = budgetReport(budgets, { metrics: { "solid.createComputation": 118 }, files }, ratios)
  assert.deepEqual(failures, [
    "L8 solid.createComputation: 118 exceeds 115",
    "L8 shownP95 CodeNomad/TUI (50 ms floor): 1.2 exceeds 1.15",
  ])
  assert.match(report, /\| composer\.tsx \| 24\.00 \|\n\| timeline\.ts \| 15\.00 \|\n\| sidebar\.tsx \| 2\.00 \|/)
  assert.doesNotMatch(report, /moved\.ts/)
})

test("a timing-only failure reports both latencies and the separately measured call growth", () => {
  const { report, failures } = budgetReport(budgets, { metrics: { "solid.createComputation": 115 }, files }, ratios)
  assert.deepEqual(failures, ["L8 shownP95 CodeNomad/TUI (50 ms floor): 1.2 exceeds 1.15"])
  assert.match(report, /60\.0 ms \/ 50\.0 ms; raw 1\.20×/)
  assert.match(report, /Largest increases/)
})

test("a narrow breach does not round to the same value as its budget", () => {
  const { failures } = budgetReport(budgets, { metrics: { "solid.createComputation": 115.0001 }, files }, {})
  assert.deepEqual(failures, ["L8 solid.createComputation: 115.0001 exceeds 115"])
})

test("a PR can tighten a dev budget but cannot raise it or drop a metric", () => {
  const make = max => ({ ...budgets, counters: { "solid.createComputation": { max } } })
  assert.doesNotThrow(() => assertRatchet(budgets, make(114)))
  assert.throws(() => assertRatchet(budgets, make(116)), /budget increased above dev/)
  assert.throws(() => assertRatchet(budgets, { ...budgets, counters: {} }), /budget keys changed/)
})
