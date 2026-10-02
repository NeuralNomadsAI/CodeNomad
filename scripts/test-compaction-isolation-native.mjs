// Explicit CLI only: no discovery, shared service, user database or external provider.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { build } from "esbuild"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute isolated CLI executable")
const contextFlag = process.argv.indexOf("--context-mib")
const contextMiB = contextFlag < 0 ? 0 : Number(process.argv[contextFlag + 1])
if (![0, 2, 8, 32].includes(contextMiB)) throw new Error("--context-mib accepts only 0, 2, 8 or 32")
const skipOutline = process.argv.includes("--skip-outline")
const temporaryRoot = path.join(os.tmpdir(), "opencode")
await mkdir(temporaryRoot, { recursive: true })
const root = await realpath(await mkdtemp(path.join(temporaryRoot, "compaction-isolation-")))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_)/i.test(key)))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
Object.assign(env, {
  HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "test.db"),
  OPENCODE_SERVER_PASSWORD: "private-compaction-fixture", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
})
const runtimeVersion = execFileSync(cli, ["--version"], { cwd: root, env, encoding: "utf8" }).trim().replace(/^opencode2? v/, "")
assert.match(runtimeVersion, /^2\.0\.(19|21|22)$/, "This fixture qualifies only the requested runtimes")
await Promise.all(["config", "plugin", "pruning"].map(name => mkdir(path.join(root, name), { recursive: true })))
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../packages/server/src/opencode/session-pruning/plugin.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", target: "node22", write: false,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
})
await writeFile(path.join(root, "pruning", "index.mjs"), bundle.outputFiles[0].contents)
await writeFile(path.join(root, "plugin", "index.ts"), `
export default { id:'private-compaction-fixture', async setup(ctx) {
  await ctx.session.hook('http.request', event => {
    event.request.headers.set('x-fixture-kind', event.kind)
    event.request.headers.set('x-fixture-session', event.sessionID)
  })
  await ctx.tool.transform(editor => editor.add({ name:'isolation_probe', description:'Inert fixture',
    input:{type:'object',properties:{}}, options:{codemode:false}, execute:async()=>({content:'Synthetic tool result'}) }))
} }
`)

const gates = new Map(), requests = [], toolIssued = new Set()
const gate = key => {
  let release
  const promise = new Promise(resolve => { release = resolve })
  const value = { promise, release, released: false }
  gates.set(key, value)
  return () => { value.released = true; release(); gates.delete(key) }
}
const summary = ["## Objective", "## Requirements", "## Decisions", "## Work State", "### Completed",
  "### Active", "### Blocked", "## Next Move", "## Relevant Files", "## Important Context"]
  .map(heading => `${heading}\n- Synthetic isolation fixture`).join("\n\n")
let providerError
const provider = createServer(async (request, response) => {
  try {
    const started = performance.now()
    let raw = ""
    for await (const chunk of request) raw += chunk
    const bodyReceived = performance.now()
    const body = JSON.parse(raw), kind = request.headers["x-fixture-kind"], sessionID = request.headers["x-fixture-session"]
    const record = { kind, sessionID, started, bodyReceived, received: performance.now(), bytes: Buffer.byteLength(raw),
      messageCount: body.messages?.length, markerCount: (raw.match(/NATIVE_CONTEXT_CANARY_\d+/g) ?? []).length,
      payloadFillBytes: (raw.match(/Z{1024,}/g) ?? []).reduce((sum, fill) => sum + fill.length, 0) }
    requests.push(record)
    const pending = gates.get(`${kind}:${sessionID}`)
    if (pending) await pending.promise
    if (response.destroyed) return
    const text = kind === "compaction" ? summary : "Synthetic conclusion"
    if (!body.stream) {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ id: "aux", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      return
    }
    response.setHeader("Content-Type", "text/event-stream")
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
    })}\n\n`)
    chunk({ role: "assistant" })
    const tool = kind === "primary" && !toolIssued.has(sessionID)
    if (tool) {
      toolIssued.add(sessionID)
      chunk({ tool_calls: [{ index: 0, id: `inert-${sessionID}`, type: "function", function: { name: "isolation_probe", arguments: "{}" } }] })
    } else {
      // Exercise real compaction delta events, without an artificial slow observer.
      for (let i = 0; i < text.length; i += 16) chunk({ content: text.slice(i, i + 16) })
    }
    chunk({}, tool ? "tool_calls" : "stop")
    response.end("data: [DONE]\n\n")
    record.responded = performance.now()
  } catch (error) { providerError = error; response.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: "fixture/fixture",
  // Fixture-only: preserve the entire imported corpus in a manual summary request.
  ...(contextMiB ? { compaction: { auto: false, keep: { tokens: 0 } } } : {}),
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: {
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only",
  }, models: { fixture: contextMiB ? { limit: { context: 16777216, output: 8192 } } : {} } } },
  plugins: [path.join(root, "plugin"), { package: path.join(root, "pruning"), options: { databasePath: env.OPENCODE_DB } }],
})
let output = "", observerError, spawnError
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "debug", "--print-logs"], { cwd: root, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
child.on("error", error => { spawnError = error })
child.stdout.on("data", data => { output += data })
child.stderr.on("data", data => { output += data })
const streams = new AbortController(), events = [], measurements = []
let phase = "setup"
const report = { runtimeVersion, root, pid: child.pid, contextMiB, skipOutline, measurements, requests, outline: undefined,
  pruningBundleSha256: createHash("sha256").update(bundle.outputFiles[0].contents).digest("hex") }
let observer, client, releaseA, releaseB
const options = () => ({ signal: AbortSignal.timeout(15_000) })
async function until(predicate, timeout = 30_000) {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    if (providerError) throw providerError
    if (observerError) throw observerError
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error("Private server exited early")
    if (await predicate()) return
    await delay(20)
  }
  throw new Error("Private fixture condition timed out")
}
async function measured(name, call) {
  const started = performance.now()
  const startedPhase = phase
  try { const value = await call(); const finished = performance.now(); measurements.push({ name, started, finished, startedPhase, finishedPhase: phase, ms: finished - started, status: "ok" }); return value }
  catch (error) { const finished = performance.now(); measurements.push({ name, started, finished, startedPhase, finishedPhase: phase, ms: finished - started, status: "failed" }); throw error }
}
const wait = sessionID => client.session.wait({ sessionID }, options())
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return { count: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }
}
try {
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  report.baseUrl = baseUrl
  client = OpenCode.make({ baseUrl, headers: { Authorization: `Basic ${Buffer.from("opencode:private-compaction-fixture").toString("base64")}` } })
  const info = await client.server.info(options())
  assert.equal(info.version, runtimeVersion)
  assert.equal(info.pid, child.pid, "The endpoint must belong to the child we created")
  observer = (async () => {
    for await (const event of client.event.subscribe({ signal: streams.signal })) {
      events.push({ phase, type: event.type, sessionID: event.data?.sessionID, created: event.created, received: Date.now() })
    }
  })().catch(error => { if (!streams.signal.aborted) observerError = error })
  await until(() => events.some(event => event.type === "server.connected"))
  const location = { directory: root }
  let a = await client.session.create({ location, title: "Private compaction A" }, options())
  const b = await client.session.create({ location, title: "Private witness B" }, options())
  report.sessions = { a: a.id, b: b.id }
  await until(async () => {
    const plugins = (await client.plugin.list({ location }, options())).data
    const failed = plugins.filter(item => item.source.type !== "builtin" && item.state.status === "failed")
    assert.equal(failed.length, 0, JSON.stringify(failed))
    return plugins.some(item => item.id === "codenomad-session-pruning" && item.state.status === "active")
  })
  phase = "seed"
  for (const session of [a, b]) {
    await client.session.prompt({ sessionID: session.id, text: "Use isolation_probe, then conclude." }, options())
    await wait(session.id)
  }
  const nativeMessages = (await client.message.list({ sessionID: a.id, limit: 20 }, options())).data
  const template = nativeMessages.find(message => message.type === "assistant" && message.content.some(part => part.type === "tool"))
  assert(template, "A real native assistant/tool template must exist")
  const userTemplate = nativeMessages.find(message => message.type === "user")
  assert(userTemplate)
  const tool = template.content.find(part => part.type === "tool")
  assert.equal(tool.state.status, "completed")
  if (contextMiB) {
    const exportedA = await client.session.export({ sessionID: a.id }, options())
    const count = contextMiB * 4, bytes = 262144
    let fillBytes = 0
    const imported = Array.from({ length: count }, (_, index) => {
      const marker = `NATIVE_CONTEXT_CANARY_${String(index).padStart(4, "0")}\n`
      const text = marker + "Z".repeat(bytes - marker.length)
      fillBytes += bytes - marker.length
      return [
        { ...structuredClone(userTemplate), id: `msg_context_user_${String(index).padStart(4, "0")}`, text: `Inspect synthetic item ${index}.` },
        { ...structuredClone(template), id: `msg_context_assistant_${String(index).padStart(4, "0")}`,
          content: [{ ...structuredClone(tool), id: `tool_context_${index}`, state: { ...structuredClone(tool.state), content: [{ type: "text", text }] } }] },
      ]
    }).flat()
    // Native manual compaction retains the current turn even with keep.tokens=0.
    // A small trailing turn puts every large tool result in the summarized prefix.
    imported.push(
      { ...structuredClone(userTemplate), id: "msg_context_tail_user", text: "Corpus complete; retain this small trailing turn." },
      { ...structuredClone(template), id: "msg_context_tail_assistant", content: [{ type: "text", text: "Synthetic trailing conclusion" }] },
    )
    await client.session.remove({ sessionID: a.id }, options())
    a = await client.session.import({ ...exportedA, messages: imported, location }, { signal: AbortSignal.timeout(60_000) })
    report.sessions.a = a.id
    const stored = await client.session.context({ sessionID: a.id }, { signal: AbortSignal.timeout(60_000) })
    const storedTools = stored.filter(message => message.type === "assistant").flatMap(message => message.content.filter(part => part.type === "tool"))
    const storedBytes = storedTools.reduce((sum, part) => sum + part.state.content.reduce((total, content) => total + Buffer.byteLength(content.text ?? ""), 0), 0)
    assert.equal(storedTools.length, count)
    assert.equal(storedBytes, contextMiB * 1048576)
    assert.equal(stored.length, imported.length)
    report.contextCorpus = { turns: count + 1, payloadTurns: count, messages: imported.length, payloadBytes: storedBytes, payloadFillBytes: fillBytes,
      keepTokens: 0, modelContextLimit: 16777216 }
  }

  // Seeding is outside the timed compaction/outline intervals and uses native import.
  let corpus
  if (!skipOutline) {
    const empty = await client.session.create({ location, title: "Private outline corpus" }, options())
    const exported = await client.session.export({ sessionID: empty.id }, options())
    await client.session.remove({ sessionID: empty.id }, options())
    const payload = "x".repeat(262144)
    const messages = Array.from({ length: 128 }, (_, index) => ({ ...structuredClone(template), id: `msg_isolation_${index}`,
      content: [{ ...structuredClone(tool), id: `tool_isolation_${index}`, state: { ...structuredClone(tool.state), content: [{ type: "text", text: payload }] } }],
    }))
    corpus = await client.session.import({ ...exported, messages, location }, { signal: AbortSignal.timeout(60_000) })
  }

  // Flush seed observations before the measured phase; import is not compaction.
  await delay(100)
  phase = "assembly-before-provider"
  const compactStart = performance.now()
  releaseA = gate(`compaction:${a.id}`)
  const admission = measured("A.compact.admission", () => client.session.compact({ sessionID: a.id }, options()))
  admission.catch(() => {})
  let probingAssembly = true
  const assemblyProbes = (async () => {
    while (probingAssembly && !requests.some(item => item.kind === "compaction" && item.sessionID === a.id)) {
      await Promise.all([
        measured("assembly.info", () => client.server.info(options())),
        measured("assembly.B.get", () => client.session.get({ sessionID: b.id }, options())),
      ])
      if (probingAssembly) await delay(5)
    }
  })()
  assemblyProbes.catch(() => {})
  const earlyB = (async () => {
    await measured("assembly.B.prompt.admission", () => client.session.prompt({ sessionID: b.id, text: "Conclude during A summary assembly." }, options()))
    await measured("assembly.B.wait", () => wait(b.id))
    assert.equal((await client.session.get({ sessionID: b.id }, options())).outcome, "succeeded")
  })()
  earlyB.catch(() => {})
  const admitted = await admission
  assert.equal(typeof admitted.time.created, "number")
  try { await until(() => requests.some(item => item.kind === "compaction" && item.sessionID === a.id)) }
  finally { probingAssembly = false; await assemblyProbes }
  const assembled = requests.find(item => item.kind === "compaction" && item.sessionID === a.id)
  const admittedAt = measurements.find(item => item.name === "A.compact.admission").finished
  report.compactionAssembly = { submissionToProviderHeadersMs: assembled.started - compactStart,
    admissionResponseToProviderHeadersMs: assembled.started - admittedAt,
    submissionToProviderBodyMs: assembled.bodyReceived - compactStart, providerParseMs: assembled.received - assembled.bodyReceived,
    providerBytes: assembled.bytes, providerMessages: assembled.messageCount, markerCount: assembled.markerCount, payloadFillBytes: assembled.payloadFillBytes }
  if (contextMiB) {
    assert.equal(assembled.markerCount, report.contextCorpus.payloadTurns, "Provider must receive every corpus tool marker")
    assert.equal(assembled.payloadFillBytes, report.contextCorpus.payloadFillBytes, "Stored corpus bytes must really reach the compaction provider")
  }
  await until(() => events.some(event => event.sessionID === a.id && event.type === "session.compaction.started"))
  await earlyB
  assert(!events.some(event => event.sessionID === a.id && event.type === "session.compaction.ended"))
  report.earlyBCompletedBeforeReleaseA = true
  report.assemblyWitnesses = measurements.filter(item => item.name.startsWith("assembly.")).map(item => ({ ...item,
    startedBeforeProviderHeaders: item.started < assembled.started, completedBeforeProviderHeaders: item.finished < assembled.started,
    completedBeforeProviderBody: item.finished < assembled.bodyReceived }))
  for (const name of ["assembly.info", "assembly.B.get", "assembly.B.prompt.admission"]) {
    assert(report.assemblyWitnesses.some(item => item.name === name && item.startedBeforeProviderHeaders), `${name} must be issued before A reaches the provider`)
  }
  report.preProviderLatencyMs = Object.fromEntries([...new Set(report.assemblyWitnesses.map(item => item.name))]
    .map(name => [name, distribution(report.assemblyWitnesses.filter(item => item.name === name && item.startedBeforeProviderHeaders).map(item => item.ms))]))
  report.whollyPreProviderLatencyMs = Object.fromEntries([...new Set(report.assemblyWitnesses.map(item => item.name))]
    .map(name => [name, distribution(report.assemblyWitnesses.filter(item => item.name === name && item.completedBeforeProviderHeaders).map(item => item.ms))]))
  report.bCompletedBeforeProviderHeaders = report.assemblyWitnesses.some(item => item.name === "assembly.B.wait" && item.completedBeforeProviderHeaders)
  phase = "held-compaction"
  let aFinished = false
  const waitingA = wait(a.id).then(() => { aFinished = true })
  // Attach a rejection handler immediately; still await the actual result later.
  waitingA.catch(() => {})
  for (let sample = 0; sample < 4; sample++) {
    await Promise.all([
      measured("held.info", () => client.server.info(options())),
      measured("held.A.get", () => client.session.get({ sessionID: a.id }, options())),
      measured("held.B.get", () => client.session.get({ sessionID: b.id }, options())),
      measured("held.active", () => client.session.active(options())),
    ])
    await delay(50)
  }
  phase = "both-held"
  releaseB = gate(`primary:${b.id}`)
  const beforeB = requests.length
  await measured("held.B.prompt.admission", () => client.session.prompt({ sessionID: b.id, text: "Conclude while A summary is held." }, options()))
  await until(() => requests.slice(beforeB).some(item => item.kind === "primary" && item.sessionID === b.id))
  report.activeWhileBothHeld = await measured("both-held.active", () => client.session.active(options()))
  assert(report.activeWhileBothHeld[a.id] && report.activeWhileBothHeld[b.id], "Both native executions must be active")
  await measured("both-held.B.get", () => client.session.get({ sessionID: b.id }, options()))
  releaseB(); releaseB = undefined
  await measured("A-held.B.wait", () => wait(b.id))
  const completedB = await client.session.get({ sessionID: b.id }, options())
  assert.equal(completedB.outcome, "succeeded", "B must succeed, not simply stop after an error")
  const messagesB = (await client.message.list({ sessionID: b.id, limit: 8 }, options())).data
  assert(messagesB.some(message => message.type === "assistant" && message.content.some(part => part.type === "text" && part.text === "Synthetic conclusion")))
  assert.equal(aFinished, false, "B completed independently before releasing A")
  assert(!events.some(event => event.sessionID === a.id && event.type === "session.compaction.ended"))
  report.bCompletedBeforeReleaseA = true

  if (!skipOutline) {
    phase = "outline-under-held-compaction"
    let outlining = true
    const outlineStart = performance.now(), heartbeats = []
    const heartbeat = (async () => {
      while (outlining) {
        const start = performance.now()
        await client.server.info(options())
        heartbeats.push({ startedMs: start - outlineStart, ms: performance.now() - start })
        if (outlining) await delay(5)
      }
    })()
    heartbeat.catch(() => {})
    try {
      const outline = (await measured("A-held.outline", () => client.rpc.call({ rpcID: "codenomad.session-pruning", method: "outline", location,
        input: { sessionID: corpus.id } }, options()))).output
      assert.equal(outline.status, "outline", JSON.stringify(outline))
      assert.equal(outline.entries.length, 128)
      assert(outline.entries.every(entry => entry.tools === 1 && entry.toolName === tool.name))
      const elapsedMs = performance.now() - outlineStart
      report.outline = { count: 128, payloadBytes: 262144, elapsedMs, heartbeats,
        completedHeartbeatsDuringOutline: heartbeats.filter(item => item.startedMs + item.ms <= elapsedMs).length }
    } finally { outlining = false; await heartbeat }
  }
  assert.equal(aFinished, false)
  phase = "held-compaction"
  // A genuine pending provider wait, not merely a race through a fast reply.
  await delay(1_000)
  await measured("held-final.B.get", () => client.session.get({ sessionID: b.id }, options()))
  await measured("held-final.info", () => client.server.info(options()))
  assert.equal(aFinished, false)
  report.aHeldMs = performance.now() - compactStart
  const releasedAt = performance.now()
  phase = "summary-release"
  releaseA(); releaseA = undefined
  await waitingA
  report.aCompletionAfterReleaseMs = performance.now() - releasedAt
  const context = await client.session.context({ sessionID: a.id }, options())
  assert(context.some(message => message.type === "compaction" && message.status === "completed"), "Real native compaction must finish successfully")
  await until(() => events.some(event => event.sessionID === a.id && event.type === "session.compaction.ended"))
  assert(!events.some(event => event.sessionID === a.id && event.type === "session.compaction.failed"))
  report.eventCounts = Object.fromEntries([...new Set(events.map(event => event.type))].map(type => [type, events.filter(event => event.type === type).length]))
  const business = events.filter(event => event.type.startsWith("session.") && typeof event.created === "number")
  report.eventDeliveryLagByPhaseMs = Object.fromEntries([...new Set(business.map(event => event.phase))]
    .map(name => [name, distribution(business.filter(event => event.phase === name).map(event => event.received - event.created))]))
  report.events = events
  report.latencyByOperationMs = Object.fromEntries([...new Set(measurements.map(item => item.name))]
    .map(name => [name, distribution(measurements.filter(item => item.name === name).map(item => item.ms))]))
  report.status = "passed"
  console.log(JSON.stringify({ ...report, events: undefined, measurements: undefined, requests: undefined, assemblyWitnesses: undefined }, null, 2))
  console.log(`PASS: B completed before releasing A's provider; corpus=${contextMiB} MiB, outline=${!skipOutline}`)
} catch (error) {
  report.status = "failed"
  report.error = String(error.stack ?? error)
  throw error
} finally {
  releaseA?.(); releaseB?.()
  for (const value of gates.values()) value.release()
  streams.abort()
  await observer
  child.kill()
  await stopped
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  await writeFile(path.join(root, "server.log"), output)
  await writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2))
  console.log(`Private fixture retained at ${root}; only its child was stopped`)
}
