// Native terminal-order/claim qualification; private standalone runtime, never discovery.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"
import { definition } from "./missions-terminal-native/definition.mjs"

const cli = process.argv[2], evidenceRoot = process.argv[3]
assert.ok(cli && path.isAbsolute(cli) && evidenceRoot && path.isAbsolute(evidenceRoot), "Explicit private CLI and evidence directory required")
await mkdir(evidenceRoot, { recursive: true })
const root = await mkdtemp(path.join(evidenceRoot, "run-")), plugin = path.join(root, "plugin")
await mkdir(plugin)
const entry = fileURLToPath(new URL("./missions-terminal-native/plugin.ts", import.meta.url))
await build({ ...nativePluginBuild, entryPoints: [entry], outfile: path.join(plugin, "index.mjs") })
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SystemRoot|WINDIR|ComSpec|PATHEXT|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PATH)$/i.test(key)))
Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, ProgramData: path.join(root, "program-data"),
  OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "native.db"),
  OPENCODE_SERVER_PASSWORD: "terminal-fixture-only", OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_FFF: "1", DO_NOT_TRACK: "1", TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp") })
for (const name of ["DATA", "CONFIG", "STATE", "CACHE"]) env[`XDG_${name}_HOME`] = path.join(root, `xdg-${name.toLowerCase()}`)
env.XDG_RUNTIME_DIR = path.join(root, "runtime")
for (const value of Object.values(env).filter(value => typeof value === "string" && value.startsWith(root))) {
  if (!path.extname(value)) await mkdir(value, { recursive: true })
}
let hold = true, fail = false, holdFamilyChild = true, familyRoot, child, stopped, output = "", client, providerError, providerRequests = 0
const releases = new Set()
const evidence = { root, outcome: "running", incarnations: [], stoppedPIDs: [], isolation: {}, observations: [], limits: [
  "Standalone intentionally gates Session.resume; managed startup sweep and autonomous auxiliary schedule remain core integration prerequisites.",
] }
const provider = createServer(async (request, response) => {
  try {
    let raw = ""; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), primary = request.headers["x-fixture-kind"] === "primary"
    if (primary) providerRequests++
    if (primary && hold) return // Active native stream survives until fixture-owned process kill.
    if (primary && familyRoot && request.headers["x-fixture-session"] !== familyRoot && holdFamilyChild)
      await new Promise(resolve => { releases.add(resolve); response.once("close", resolve) })
    if (primary && (fail || familyRoot && request.headers["x-fixture-session"] !== familyRoot)) {
      response.writeHead(400, { "content-type": "application/json" })
      return response.end(JSON.stringify({ error: { message: "TERMINAL_FIXTURE_FAILURE", type: "invalid_request_error" } }))
    }
    if (!body.stream) {
      response.setHeader("content-type", "application/json")
      return response.end(JSON.stringify({ id: "aux", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
    }
    response.setHeader("content-type", "text/event-stream")
    const delegate = primary && familyRoot === request.headers["x-fixture-session"]
      && !body.messages.some(message => message.tool_calls?.some(call => call.function?.name === "subagent"))
    if (delegate) assert.ok(body.tools.some(tool => tool.function.name === "subagent"))
    const delta = delegate ? { role: "assistant", tool_calls: [{ index: 0, id: "terminal-family-child", type: "function", function: {
      name: "subagent", arguments: JSON.stringify({ agent: "general", description: "Terminal family failure", prompt: "Fail natively once", background: true }),
    } }] } : { role: "assistant", content: "Done" }
    for (const [part, finish_reason] of [[delta, null], [{}, delegate ? "tool_calls" : "stop"]])
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: part, finish_reason }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) { providerError = error; response.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", plugins: [plugin],
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: {
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only",
  }, models: { fixture: {} } } } })
async function until(predicate, label) {
  const end = Date.now() + 45000
  while (Date.now() < end) {
    if (providerError) throw providerError
    if (await predicate()) return
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error("Fixture-owned server exited")
    await delay(50)
  }
  throw new Error(`Timeout: ${label}`)
}
async function start() {
  output = ""
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
  stopped = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), "private listen")
  client = OpenCode.make({ baseUrl: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], headers: {
    Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
  } })
  await until(async () => { try { return (await client.server.info()).pid === child.pid } catch { return false } }, "private ready")
  const info = await client.server.info()
  evidence.incarnations.push({ pid: info.pid, version: info.version })
  assert.equal(info.version, "2.2.1", "This fixture records the requested exact runtime")
}
const rpc = () => client.rpc(definition)
const read = (sessionID, messageID) => rpc().read({ sessionID, ...(messageID ? { messageID } : {}) }, { location: { directory: root } })
try {
  for (const name of ["home", "config", "state", "data", "cache", "db"]) {
    const actual = execFileSync(cli, ["debug", "paths", name], { env, encoding: "utf8", windowsHide: true }).trim()
    const relative = path.relative(root, actual)
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `Private ${name}`)
    evidence.isolation[name] = actual
  }
  await start()
  const session = await client.session.create({ location: { directory: root }, model: { providerID: "fixture", id: "fixture" } })
  const original = await client.session.synthetic({ sessionID: session.id, id: "msg_terminal_original", text: "Only original pending prompt", resume: true })
  await until(() => providerRequests === 1, "original model stream")
  const live = await read(session.id, original.id)
  assert.equal(live.active, true); assert.equal(live.suspended, true); assert.equal(live.terminal, undefined)
  evidence.observations.push({ stage: "before-crash", ...live })
  child.kill("SIGKILL"); await stopped; evidence.stoppedPIDs.push(child.pid)
  await start() // No sweep in standalone: recovery is held before the native resume call.
  for (let wake = 0; wake < 3; wake++) {
    const old = await read(session.id, original.id)
    assert.equal(old.active, false); assert.equal(old.suspended, true); assert.equal(old.orphaned, true)
    assert.equal(old.messagePresent, true); assert.equal(old.terminal, undefined)
    evidence.observations.push({ stage: `held-recovery-${wake}`, ...old })
  }
  assert.equal(providerRequests, 1, "No second original prompt or continuation before releasing native resume")
  hold = false
  await rpc().resume({ sessionID: session.id }, { location: { directory: root } })
  let resumed
  await until(async () => { resumed = await read(session.id, original.id); return !resumed.active && !resumed.suspended && resumed.terminal }, "native resumed terminal")
  assert.equal(resumed.terminal.inputMessageID, original.id); assert.equal(resumed.terminal.outcome, "succeeded")
  const messages = await client.message.list({ sessionID: session.id, limit: 100 })
  assert.equal(messages.data.filter(message => message.type === "user" || message.type === "synthetic").length, 1)
  assert.equal(messages.data.filter(message => message.id === original.id).length, 1)
  evidence.observations.push({ stage: "resumed-original", ...resumed })
  evidence.originalMessageID = original.id
  // Unrelated older failed busy periods must not poison a new original input.
  fail = true
  const older = await client.session.prompt({ sessionID: session.id, text: "Historical failing prompt" })
  await until(async () => (await read(session.id, older.id)).terminal?.outcome === "failed", "native failure")
  fail = false
  const current = await client.session.prompt({ sessionID: session.id, text: "New pending original after unrelated failure" })
  let clean
  await until(async () => { clean = await read(session.id, current.id); return !clean.active && !clean.suspended && clean.terminal }, "new exact terminal")
  assert.equal(clean.failed, false); assert.equal(clean.terminal.inputMessageID, current.id)
  assert.equal((await read(session.id, original.id)).failed, true, "Original span still includes its subsequent failure")
  evidence.observations.push({ stage: "excluded-unrelated-failure", ...clean })
  const missing = await read(session.id, "msg_missing_original")
  assert.equal(missing.terminal, undefined, "An unrelated idle cannot prove a missing original")
  const family = await client.session.create({ location: { directory: root }, model: { providerID: "fixture", id: "fixture" } })
  familyRoot = family.id
  const familyOriginal = await client.session.prompt({ sessionID: family.id, text: "Family original: delegate once, then finish" })
  let familyState
  await until(async () => { familyState = await read(family.id, familyOriginal.id); return !familyState.active && !familyState.suspended && familyState.terminal }, "native family terminal")
  const descendants = (await client.session.list({ location: { directory: root } })).data.filter(item => item.parentID === family.id)
  assert.equal(descendants.length, 1)
  const familyIDs = [family.id, descendants[0].id]
  assert.equal((await rpc().waits({ sessionIDs: familyIDs }, { location: { directory: root } })).blocked, true, "real durable background delivery blocks the family")
  holdFamilyChild = false
  for (const release of releases) release()
  let descendant
  await until(async () => {
    descendant = await read(descendants[0].id)
    familyState = await read(family.id, familyOriginal.id)
    return !descendant.active && !descendant.suspended && descendant.terminal && !familyState.active && !familyState.suspended
      && !(await rpc().waits({ sessionIDs: familyIDs }, { location: { directory: root } })).blocked
  }, "background result delivered and family quiescent")
  assert.equal(descendant.active, false); assert.equal(descendant.suspended, false)
  assert.equal(descendant.terminal?.outcome, "failed"); assert.equal(descendant.failed, true)
  assert.equal(familyState.terminal.inputMessageID, familyOriginal.id)
  evidence.observations.push({ stage: "native-family-root", ...familyState }, { stage: "native-family-child-failed", ...descendant })
  evidence.outcome = "passed"
  console.log(JSON.stringify({ outcome: evidence.outcome, root, checks: ["old-claim-held", "single-original-native-resume", "durable-sequence-terminal", "unrelated-failure-excluded", "missing-anchor-uncertain", "native-family-child-terminal", "durable-background-delivery"] }))
} catch (error) { evidence.outcome = "failed"; evidence.error = String(error); throw error }
finally {
  if (child?.exitCode === null) { await stopFixtureChild(child, stopped); evidence.stoppedPIDs.push(child.pid) }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
  await writeFile(path.join(root, "native.log"), output)
  await writeFile(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2))
}
