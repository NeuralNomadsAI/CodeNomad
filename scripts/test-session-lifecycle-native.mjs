// Explicit isolated native capture of the session lifecycle signals CodeNomad
// consumes: completion, provider retry, failure and interruption. Records the
// real event stream and asserts that terminal/retry state arrives through
// session.execution.* and session.retry.scheduled, never the deprecated V1
// session.idle/session.status declarations. No service discovery or real provider.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute CLI path; shared service discovery is forbidden")
const temporary = path.join(os.tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await mkdtemp(path.join(temporary, "lifecycle-native-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_|npm_config_)/i.test(key)))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
if (process.platform === "win32") {
  for (const key of Object.keys(env)) if (key.toLowerCase() === "programdata") delete env[key]
  env.ProgramData = path.join(root, "ProgramData")
}
const password = randomUUID()
Object.assign(env, {
  HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
})
await mkdir(env.OPENCODE_CONFIG_DIR)
await mkdir(path.join(root, "plugin"))
await writeFile(path.join(root, "plugin", "index.ts"), `export default { id: 'lifecycle-fixture', async setup(ctx) {
  await ctx.session.hook('http.request', event => {
    event.request.headers.set('x-fixture-kind', event.kind)
    event.request.headers.set('x-fixture-session', event.sessionID)
  })
} }`)

// Per-session provider behaviour, keyed by the session ID the plugin forwards.
const behaviours = new Map()
const requests = new Map()
let providerError
const provider = createServer(async (request, response) => {
  try {
    for await (const _chunk of request) { /* drain */ }
    if (request.headers["x-fixture-kind"] !== "primary") {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ id: "aux", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
      return
    }
    const sessionID = request.headers["x-fixture-session"]
    const count = (requests.get(sessionID) ?? 0) + 1
    requests.set(sessionID, count)
    const behaviour = behaviours.get(sessionID) ?? "complete"
    if ((behaviour === "retry" && count === 1) || behaviour === "fail") {
      // 503 is retryable (ProviderInternal); 400 is a deterministic request failure.
      response.statusCode = behaviour === "fail" ? 400 : 503
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ error: { message: `fixture ${behaviour}`, type: "fixture_error" } }))
      return
    }
    response.setHeader("Content-Type", "text/event-stream")
    const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture",
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`)
    chunk({ role: "assistant", content: "FIXTURE_ANSWER" })
    if (behaviour === "hold") return // Stays open until native interruption.
    chunk({}, "stop", { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 })
    response.end("data: [DONE]\n\n")
  } catch (error) { providerError = error; response.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: "fixture/fixture", plugins: [path.join(root, "plugin")],
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: {
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only",
  }, models: { fixture: {} } } },
})

let output = ""
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
child.stdout.on("data", data => { output += data })
child.stderr.on("data", data => { output += data })
async function until(predicate, label) {
  for (let attempt = 0; attempt < 1500; attempt++) {
    if (providerError) throw providerError
    if (await predicate()) return
    if (child.exitCode !== null) throw new Error("Isolated native server exited")
    await delay(20)
  }
  throw new Error(`Isolated condition timed out: ${label}`)
}

const events = []
const streams = new AbortController()
const TERMINAL = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])
const LIFECYCLE = /^session\.(execution\.|retry\.|step\.(started|ended|failed)$|usage\.updated$|status$|idle$)/
const forSession = (sessionID) => events.filter(event => event.data?.sessionID === sessionID)
const terminalOf = (sessionID) => forSession(sessionID).find(event => TERMINAL.has(event.type))

try {
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), "server start")
  const client = OpenCode.make({ baseUrl: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], headers: {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  } })
  const runtime = (await client.server.info()).version
  void (async () => {
    try { for await (const event of client.event.subscribe({ signal: streams.signal })) events.push(event) } catch {}
  })()
  await until(() => events.some(event => event.type === "server.connected"), "event stream")

  const capture = {}
  for (const behaviour of ["complete", "retry", "fail", "hold"]) {
    const session = await client.session.create({ location: { directory: root }, model: { providerID: "fixture", id: "fixture" } })
    behaviours.set(session.id, behaviour)
    await client.session.prompt({ sessionID: session.id, text: `Lifecycle fixture: ${behaviour}` })
    if (behaviour === "hold") {
      await until(() => forSession(session.id).some(event => event.type === "session.text.delta"), "held stream")
      await client.session.interrupt({ sessionID: session.id, resume: false })
    }
    await until(() => terminalOf(session.id), `${behaviour} terminal`)
    await delay(300) // Let trailing ephemeral events (usage, legacy status) arrive.
    capture[behaviour] = forSession(session.id).filter(event => LIFECYCLE.test(event.type))
      .map(event => ({ type: event.type, data: event.data }))
  }

  const all = events.map(event => event.type)
  await writeFile(path.join(root, "lifecycle-events.json"), JSON.stringify({ runtime, capture, types: [...new Set(all)] }, null, 2))
  console.log("Runtime", runtime)
  for (const [behaviour, list] of Object.entries(capture)) {
    console.log(`\n[${behaviour}]`)
    for (const event of list) console.log(" ", event.type, JSON.stringify(event.data))
  }

  // The V1 declarations are never published by the V2 runtime.
  assert(!all.includes("session.idle"), "session.idle must not be published")
  assert(!all.includes("session.status"), "session.status must not be published")
  assert.equal(terminalOf([...behaviours].find(([, value]) => value === "complete")[0]).type, "session.execution.succeeded")
  assert.equal(terminalOf([...behaviours].find(([, value]) => value === "fail")[0]).type, "session.execution.failed")
  const interrupted = terminalOf([...behaviours].find(([, value]) => value === "hold")[0])
  assert.equal(interrupted.type, "session.execution.interrupted")
  assert.equal(interrupted.data.reason, "user")
  const retry = capture.retry.find(event => event.type === "session.retry.scheduled")
  assert(retry, "a retryable provider failure schedules a native retry")
  assert.equal(retry.data.attempt, 2)
  assert.equal(typeof retry.data.at, "number")
  assert.equal(typeof retry.data.error?.message, "string")
  assert.equal(capture.retry.at(-1).type, "session.execution.succeeded")
  const ended = capture.complete.find(event => event.type === "session.step.ended")
  assert(ended && typeof ended.data.cost === "number" && ended.data.tokens?.input >= 0, "step end carries usage")
  console.log(`\nPASS: V2 lifecycle captured (${runtime}); evidence ${path.join(root, "lifecycle-events.json")}`)
} catch (error) {
  console.error("Evidence:", root)
  throw error
} finally {
  streams.abort()
  await writeFile(path.join(root, "native.log"), output)
  await stopFixtureChild(child, stopped)
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
}
