// Run both CI scenarios, or compare independent builds with --mode counters --levels 8,32.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { withBrowser } from "./browser.mjs"
import { withDaemon } from "./daemon-host.mjs"
import { privatePath, runDirectory } from "./isolation.mjs"
import { MARKER, p95, sleep, sseReader } from "./lib.mjs"
import { seed, waitIdle } from "./seed.mjs"
import { withTui } from "./tui.mjs"

const { values, positionals: [binary] } = parseArgs({
  allowPositionals: true, options: {
    mode: { type: "string", default: "both" }, rounds: { type: "string", default: "3" },
    levels: { type: "string" }, turns: { type: "string", default: "300" },
    chunks: { type: "string", default: "200" }, tree: { type: "string", multiple: true },
  },
})
const { mode } = values
assert(["counters", "latency", "both"].includes(mode))
const rounds = Number(values.rounds), chunks = Number(values.chunks), turns = Number(values.turns)
const levels = values.levels?.split(",").map(Number)
const trees = values.tree?.map(tree => path.resolve(tree)) ?? [fileURLToPath(new URL("../..", import.meta.url))]
assert(Number.isInteger(rounds) && rounds > 0 && rounds * (trees.length + 1) * (levels?.length ?? 3) < 100)
assert(Number.isInteger(chunks) && chunks >= 8 && chunks <= 9999 && Number.isInteger(turns) && turns > 0)
assert(levels === undefined || (new Set(levels).size === levels.length && levels.every(n => Number.isInteger(n) && n >= 1 && n <= 32)))
assert(path.isAbsolute(binary ?? ""), "Usage: node scripts/perf/bench.mjs /absolute/path/to/opencode")
const root = await mkdtemp(path.join(await mkdir(privatePath(runDirectory), { recursive: true }).then(() => privatePath(runDirectory)), "perf-"))
const results = path.join(root, "results")
await mkdir(results)
console.log(`Benchmark results: ${results}`)

const sessionCode = i => String.fromCharCode(65 + Math.floor(i / 26), 65 + i % 26)
let pass = 0
async function measure(daemon, ids, driver, countWork) {
  const run = String(++pass).padStart(2, "0")
  const daemonAt = new Map(), outcomes = new Set()
  const wanted = new Set(ids)
  let daemonFrames = 0, failure
  const stop = await sseReader(`${daemon.url}/api/event`, daemon.authorization, (frame, at) => {
    const event = JSON.parse(frame)
    if (event.type === "server.connected" || event.type === "server.heartbeat") return
    daemonFrames++
    for (const key of frame.match(MARKER) ?? []) if (!daemonAt.has(key)) daemonAt.set(key, at)
    if (wanted.has(event.data?.sessionID) && event.type?.startsWith("session.execution.")) {
      if (event.type === "session.execution.succeeded") outcomes.add(event.data.sessionID)
      if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") failure = event.type
    }
  })
  try {
    await driver.arm(countWork)
    await Promise.all(ids.map((id, i) => daemon.call("POST", `/api/session/${id}/prompt`, { text: `BENCH:${sessionCode(i)}:${run} LIVE stream please` })))
    const keys = []
    const typing = countWork ? Promise.resolve() : (async () => {
      await sleep(700)
      for (let i = 0; i < 5; i++) {
        keys.push(await driver.typeKey(i))
        await sleep(250)
      }
    })().catch(error => { failure = error })
    const deadline = Date.now() + 120_000
    while (!failure && outcomes.size < ids.length && Date.now() < deadline) await sleep(100)
    await typing
    if (failure) throw Error(`Execution failed during measurement: ${failure}`)
    assert.equal(outcomes.size, ids.length, "Timed out waiting for successful native completions")
    const expected = Array.from({ length: Math.ceil(chunks / 8) }, (_, i) => `MKAA${run}${String(i * 8).padStart(4, "0")}K`)
    const last = expected.at(-1)
    assert(expected.every(key => daemon.markers.has(key) && daemonAt.has(key)), "Missing provider or daemon marker")
    const rendered = Date.now() + 30_000
    let observation = await driver.collect()
    while (observation.shown[last] === undefined && Date.now() < rendered) {
      await sleep(100)
      observation = await driver.collect()
    }
    // Let work triggered by the final native events settle before ending coverage.
    await sleep(800)
    const coverage = countWork ? await driver.coverage() : undefined
    const { shown, mutations, pageFrames } = await driver.collect()
    await driver.clear()
    await waitIdle(daemon)
    const seen = expected.filter(key => shown[key] !== undefined)
    assert(seen.includes(last) && seen.length >= expected.length * .8, `Only ${seen.length}/${expected.length} foreground markers displayed`)
    const stages = {
      daemonToShown: { p95: p95(seen.map(key => shown[key] - daemonAt.get(key))) },
      total: { p95: p95(seen.map(key => shown[key] - daemon.markers.get(key))) },
    }
    const counters = coverage && {
      callsPerDaemonEvent: coverage.reduce((sum, script) => sum + script.fns.reduce((total, fn) => total + fn[2], 0), 0) / daemonFrames,
      mutationsPerDaemonEvent: mutations / daemonFrames,
      pageFramesPerDaemonEvent: pageFrames / daemonFrames,
    }
    return { daemonFrames, markers: seen.length, expectedMarkers: expected.length, stages, keys: { p95: p95(keys) }, counters, coverage }
  } finally { await stop() }
}

await withDaemon(binary, path.join(root, "daemon"), chunks, async daemon => {
  const ids = await seed(daemon, turns, Math.max(32, ...(levels ?? [])))
  const write = async (scenario, kind, label, round, level, result) => {
    const stem = path.join(results, `${scenario}-${label}-r${round}-L${level}`)
    const { coverage, ...data } = result
    if (coverage) await writeFile(`${stem}-coverage.json`, JSON.stringify(coverage))
    await writeFile(`${stem}.json`, JSON.stringify({ scenario, kind, label, round, level, ...data }, null, 2))
    console.log(`${scenario} ${label} r${round} L${level}:`, data)
  }
  for (const scenario of mode === "both" ? ["counters", "latency"] : [mode]) {
    const countWork = scenario === "counters"
    const samples = levels ?? (countWork ? [8] : [8, 32])
    const entries = trees.map((tree, i) => ({ label: `cn${i}`, tree }))
    if (!countWork) entries.push({ label: "tui" })
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < entries.length; i++) {
        const { label, tree } = entries[(i + round) % entries.length]
        const run = async driver => {
          await sleep(3000)
          for (const level of samples) {
            await write(scenario, tree ? "codenomad" : "tui", label, round, level, await measure(daemon, ids.slice(0, level), driver, countWork))
          }
        }
        if (tree) await withBrowser(daemon, tree, path.join(root, `${scenario}-${label}-${round}`), run)
        else await withTui(binary, daemon, ids[0], run)
      }
    }
  }
})
