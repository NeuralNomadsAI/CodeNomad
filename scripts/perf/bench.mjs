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
import { seed, waitIdle, withSampleSessions } from "./seed.mjs"
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
  const daemonAt = new Map(), outcomes = new Set(), finalEvents = new Map()
  const owners = new Map(ids.map((id, i) => [id, sessionCode(i)]))
  const codes = ids.map((_, i) => sessionCode(i))
  const expected = Array.from({ length: Math.ceil(chunks / 8) }, (_, i) => `MKAA${run}${String(i * 8).padStart(4, "0")}K`)
  const last = expected.at(-1)
  const markerFor = (key, code) => key.replace("MKAA", `MK${code}`)
  const daemonEvents = new Set()
  let failure
  const stop = await sseReader(`${daemon.url}/api/event`, daemon.authorization, (frame, at) => {
    const event = JSON.parse(frame)
    if (event.type === "server.connected" || event.type === "server.heartbeat") return
    if (typeof event.id === "string") daemonEvents.add(event.id)
    const code = owners.get(event.data?.sessionID)
    if (code && (event.type === "session.text.delta" || event.type === "session.text.ended")) {
      const text = event.data.delta ?? event.data.text
      for (const key of text?.match(MARKER) ?? []) if (key.startsWith(`MK${code}${run}`)) {
        if (!daemonAt.has(key)) daemonAt.set(key, at)
        if (key === markerFor(last, code) && event.type === "session.text.ended") finalEvents.set(code, event.id)
      }
    }
    if (code && event.type?.startsWith("session.execution.")) {
      if (event.type === "session.execution.succeeded") outcomes.add(event.data.sessionID)
      if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") failure = event.type
    }
  })
  try {
    await driver.arm(countWork)
    daemon.arm(run, ids.length)
    await Promise.all(ids.map((id, i) => daemon.call("POST", `/api/session/${id}/prompt`, { text: `BENCH:${sessionCode(i)}:${run} LIVE stream please` })))
    const keys = []
    const deadline = Date.now() + 120_000
    const typing = countWork ? Promise.resolve() : (async () => {
      while (!failure && !codes.every(code => daemon.markers.has(markerFor(expected[0], code)))) {
        if (Date.now() >= deadline) throw Error("Not all provider streams started")
        await sleep(30)
      }
      for (let i = 0; i < 5; i++) {
        if (failure) return
        keys.push(await driver.typeKey(i))
        await sleep(100)
      }
    })().catch(error => { failure = error })
    while (!failure && outcomes.size < ids.length && Date.now() < deadline) await sleep(100)
    await typing
    if (failure) throw Error(`Execution failed during measurement: ${failure}`)
    assert.equal(outcomes.size, ids.length, "Timed out waiting for successful native completions")
    for (const code of codes) {
      assert(expected.every(key => daemon.markers.has(markerFor(key, code))), `Missing synthetic provider marker for ${code}`)
      assert(daemonAt.has(markerFor(last, code)), `The daemon stream never published the final marker for ${code}`)
    }
    const start = Math.max(...codes.map(code => daemon.markers.get(markerFor(expected[0], code))))
    const end = Math.min(...codes.map(code => daemon.markers.get(markerFor(last, code))))
    assert(start < end, `The ${ids.length} provider streams did not overlap`)
    assert(keys.every(key => key.at >= start && key.at < end), "A key sample started outside concurrent streaming")
    const rendered = Date.now() + 30_000
    let observation = await driver.collect()
    while (observation.shown[last] === undefined && Date.now() < rendered) {
      await sleep(100)
      observation = await driver.collect()
    }
    // Let work triggered by the final native events settle before ending coverage.
    await sleep(800)
    const coverage = countWork ? await driver.coverage() : undefined
    const { shown, mutations, pageEvents } = await driver.collect(countWork)
    const sourceFrames = daemonEvents.size
    const delivered = new Set(pageEvents)
    const pageFrames = [...delivered].filter(id => daemonEvents.has(id)).length
    const seen = expected.filter(key => shown[key] !== undefined && daemonAt.has(key))
    assert(seen.includes(last), "The final foreground marker never appeared")
    const stages = {
      // The final marker stays in the viewport; earlier markers can scroll out between paints.
      finalMarkerMs: shown[last] - daemonAt.get(last),
      visibleMarkerP95: p95(seen.map(key => shown[key] - daemonAt.get(key))),
    }
    if (coverage) {
      assert(pageFrames >= sourceFrames * .95, `Only ${pageFrames}/${sourceFrames} SSE frames reached the renderer`)
      for (const code of codes) assert(delivered.has(finalEvents.get(code)), `Renderer missed the final native text event for ${code}`)
    }
    const counters = coverage && {
      callsPerDaemonEvent: coverage.reduce((sum, script) => sum + script.fns.reduce((total, fn) => total + fn[2], 0), 0) / sourceFrames,
      mutationsPerDaemonEvent: mutations / sourceFrames,
      pageFramesPerDaemonEvent: pageFrames / sourceFrames,
    }
    await driver.clear()
    await waitIdle(daemon)
    return { daemonFrames: sourceFrames, markers: seen.length, expectedMarkers: expected.length, stages, keys: { p95: p95(keys.map(key => key.elapsed)) }, counters, coverage }
  } finally { await stop() }
}

await withDaemon(binary, path.join(root, "daemon"), chunks, async daemon => {
  const templates = await seed(daemon, turns, Math.max(32, ...(levels ?? [])))
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
        for (const level of samples) await withSampleSessions(daemon, templates.slice(0, level), async ids => {
          const run = async driver => {
            await sleep(3000)
            await write(scenario, tree ? "codenomad" : "tui", label, round, level, await measure(daemon, ids, driver, countWork))
          }
          if (tree) await withBrowser(daemon, tree, path.join(root, `${scenario}-${label}-${round}-${level}`), !countWork, run)
          else await withTui(binary, daemon, ids[0], run)
        })
      }
    }
  }
})
