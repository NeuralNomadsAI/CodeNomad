// node scripts/perf/perf-check.mjs <results dir> [--tree <build>] [--client cn0] [--summary <file>]
// Add --calibrate to print a budget candidate; never recalibrate on ordinary PR validation.
import assert from "node:assert/strict"
import { appendFileSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { assertRatchet, budgetReport } from "./budget-report.mjs"
import { byFile, byFunction } from "./coverage-top.mjs"
import { solidCounters } from "./solid-counters.mjs"
import { assetsDirectory } from "./stacks.mjs"

const { values, positionals: [directory] } = parseArgs({
  allowPositionals: true, options: {
    tree: { type: "string", default: fileURLToPath(new URL("../..", import.meta.url)) },
    client: { type: "string", default: "cn0" }, summary: { type: "string" },
    base: { type: "string" },
    calibrate: { type: "boolean" }, measure: { type: "boolean" },
  },
})
assert(directory, "Pass the benchmark results directory")
const load = file => JSON.parse(readFileSync(file, "utf8"))
const median = values => {
  assert(values.length && values.every(Number.isFinite), "Missing or invalid measurement")
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
}
const records = readdirSync(directory).filter(file => /-r\d+-L\d+\.json$/.test(file)).map(file => ({ ...load(path.join(directory, file)), file }))
const counters = records.filter(r => r.scenario === "counters" && r.label === values.client)
assert(counters.length, `Missing counter samples for ${values.client}`)
for (const record of records) {
  assert(Number.isInteger(record.daemonFrames) && record.daemonFrames > 0
    && Number.isInteger(record.expectedMarkers) && Number.isInteger(record.markers)
    && record.markers > 0 && record.markers <= record.expectedMarkers, `Invalid sample: ${record.file}`)
}
const assets = assetsDirectory(values.tree)
const solidDir = path.join(values.tree, "node_modules/solid-js")
const byLevel = {}
for (const level of new Set(counters.map(r => r.level))) {
  const samples = counters.filter(r => r.level === level)
  const functions = samples.map(r => byFunction(path.join(directory, r.file.replace(/\.json$/, "-coverage.json")), assets, r.daemonFrames))
  const metrics = samples.map((r, i) => ({ ...r.counters, ...solidCounters(functions[i], solidDir) }))
  const files = functions.map(byFile)
  byLevel[level] = {
    rounds: samples.length,
    metrics: Object.fromEntries(Object.keys(metrics[0]).map(key => [key, median(metrics.map(row => row[key]))])),
    files: Object.fromEntries([...new Set(files.flatMap(m => [...m.keys()]))].sort().map(key => [key, median(files.map(m => m.get(key) ?? 0))])),
  }
}
if (values.measure) {
  console.log(JSON.stringify(Object.fromEntries(Object.entries(byLevel).map(([level, { rounds, metrics }]) => [level, { rounds, metrics }])), null, 2))
  process.exit(0)
}
function latency(level, selector) {
  const rows = records.filter(r => r.scenario === "latency" && r.level === level)
  const read = kind => {
    const matches = rows.filter(r => r.label === kind)
    checkRounds(matches, `${kind} latency at L${level}`)
    const timings = matches.map(selector)
    assert(timings.every(value => Number.isFinite(value) && value >= 0), `Missing or negative ${kind} latency at L${level}`)
    return median(timings)
  }
  const cn = read(values.client), tui = read("tui")
  return { cn, tui, ratio: Math.max(cn, 50) / Math.max(tui, 50) }
}
function checkRounds(samples, name) {
  assert.deepEqual(samples.map(row => row.round).sort(), [0, 1, 2], `Expected distinct rounds 0–2 for ${name}`)
}
const counter = byLevel[8]
checkRounds(counters.filter(row => row.level === 8), "counters at L8")
const ratios = Object.fromEntries([8, 32].map(level => [level, {
  finalMarker: latency(level, r => r.stages.finalMarkerMs),
  keysP95: latency(level, r => r.keys.p95),
}]))
const roundUp = value => Math.ceil(value * 10_000) / 10_000
if (values.calibrate) {
  const limits = metrics => Object.fromEntries(Object.entries(metrics).map(([key, baseline]) => [key, { baseline, max: roundUp(baseline * 1.15) }]))
  console.log(JSON.stringify({
    counters: limits(counter.metrics),
    latency: Object.fromEntries(Object.entries(ratios).map(([level, metrics]) => [level, limits(Object.fromEntries(Object.entries(metrics).map(([key, v]) => [key, v.ratio])))])),
    callsByFile: Object.fromEntries(Object.entries(counter.files).filter(([, calls]) => calls > 0).map(([file, calls]) => [file, +calls.toFixed(2)])),
  }, null, 2))
  process.exit(0)
}

const budgets = load(new URL("./perf-budgets.json", import.meta.url))
if (values.base) {
  const base = load(values.base)
  try { assertRatchet(base, budgets) } catch (error) {
    if (values.summary) appendFileSync(values.summary, `### Performance guard\n\n${error.message}\n`)
    throw error
  }
  budgets.callsByFile = base.callsByFile
}
const { report, failures } = budgetReport(budgets, counter, ratios)
console.log(report)
if (values.summary) appendFileSync(values.summary, report)
for (const failure of failures) console.error(`::error title=Performance budget exceeded::${failure}`)
if (failures.length) process.exitCode = 1
