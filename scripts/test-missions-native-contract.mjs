// Version-independent qualification of the SHIPPED Missions plugin against an
// explicit isolated CLI (CI runs it on the technical minimum and latest). It
// consumes only contracts the product itself uses: native plugin loading, the
// model-visible mission tools through the ordinary prompt loop (no fixture
// ctx.tool.list, which postdates 2.0.7), the one-time journal RPC and the
// recurrence RPC. The supported contract must serve the native graph without
// creating schedules, sessions or journal changes; arbitrary RPC errors cannot
// count as successful qualification.
// Never discovers the shared service, user home, database or a real provider.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import pino from "pino"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute isolated CLI executable")
const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim()
const temporary = path.join(os.tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await realpath(await mkdtemp(path.join(temporary, "missions-contract-")))
for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)) delete process.env[key]
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
Object.assign(process.env, {
  HOME: root, USERPROFILE: root, APPDATA: root, OPENCODE_TEST_HOME: root, LOCALAPPDATA: root, XDG_RUNTIME_DIR: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_SERVER_PASSWORD: "isolated-missions-contract", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
})
delete process.env.WSL_DISTRO_NAME
const project = path.join(root, "project")
await mkdir(project)
await mkdir(process.env.OPENCODE_CONFIG_DIR)
await writeFile(path.join(process.env.OPENCODE_CONFIG_DIR, "opencode.json"), "{}\n")
const { WorkspaceManager } = await tsImport("../packages/server/src/workspaces/manager.ts", import.meta.url)
const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
const { DesktopPluginLifecycle } = await tsImport("../packages/server/src/opencode/desktop-plugin-lifecycle.ts", import.meta.url)
const { resolveDesktopPluginPaths } = await tsImport("../packages/server/src/opencode/desktop-plugin-paths.ts", import.meta.url)
const { CODENOMAD_MISSIONS_RPC } = await tsImport("../packages/server/src/missions/rpc.ts", import.meta.url)

const receipt = { status: "running", cli, cliVersion: version, nodeVersion: process.version, artifacts: root, gates: [] }
const gate = name => { receipt.gates.push(name); console.log(`PASS ${name}`) }
const requests = []
let child, stopped, manager, plugin, output = "", failure, stage = "setup"
const chunk = (response, delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "fixture",
  object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
// Deterministic model: the first coordinator turn calls the exposed mission
// inspect tool exactly once; every later turn (and any title request) is text.
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const part of request) raw += part
    const body = JSON.parse(raw)
    const tools = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean)
    const answered = (body.messages ?? []).some(message => message.role === "tool")
    requests.push({ tools, answered })
    const inspect = tools.find(name => /^mission[._]inspect$/.test(name))
    if (!body.stream) {
      response.setHeader("content-type", "application/json")
      return response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
    }
    response.setHeader("content-type", "text/event-stream")
    if (inspect && !answered) {
      chunk(response, { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture_inspect", type: "function",
        function: { name: inspect, arguments: JSON.stringify({ start: { objective: "Minimum contract qualification", template: "custom" } }) } }] })
      chunk(response, {}, "tool_calls")
    } else {
      chunk(response, { role: "assistant", content: "Done" })
      chunk(response, {}, "stop")
    }
    response.end("data: [DONE]\n\n")
  } catch (error) { failure = error; response.destroy(error) }
})
async function until(predicate) {
  for (let i = 0; i < 600; i++) {
    if (failure) throw failure
    if (await predicate()) return
    if (child && child.exitCode !== null) throw new Error(output.slice(-6000))
    await delay(100)
  }
  throw new Error(`Isolated fixture timed out: ${output.slice(-6000)}`)
}
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))

try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    model: "fixture/fixture", update: "disable", snapshots: false, permissions: [{ action: "*", resource: "*", effect: "allow" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" }, models: { fixture: {} } } },
  })
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: process.env, windowsHide: true })
  stopped = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { failure = error })
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const endpoint = { url, auth: { type: "basic", username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD } }
  const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
  const info = await (await fetch(`${url}/api/info`, { headers: { authorization } })).json()
  receipt.runtime = { version: info.version, pid: info.pid }
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(),
    settings: { getOwner: () => ({ environmentVariables: {} }), readEnvironmentForAdmission: async () => ({}) },
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Isolated missions contract" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }),
  })
  const { workspace } = await manager.create(project)
  const client = await manager.getSharedServiceClient()
  const paths = await resolveDesktopPluginPaths(await manager.getSharedServiceConnection(workspace.id),
    { kind: "host", platform: process.platform, binary: cli })
  assert.equal(paths.config, process.env.OPENCODE_CONFIG_DIR, "Provisioning targets only the isolated discovery root")
  plugin = new DesktopPluginLifecycle("missions")
  await plugin.start(paths)
  const location = { directory: project }
  const missions = client.rpc(CODENOMAD_MISSIONS_RPC)
  const active = async () => (await client.plugin.list({ location })).data
    .some(entry => entry.id === "codenomad.missions" && entry.state.status === "active")
  stage = "shipped plugin loading"
  await until(active)
  await until(async () => (await settle(missions.snapshot({}, { location }))).ok)
  assert.deepEqual((await missions.snapshot({}, { location })).missions, [])
  gate("shipped bundle loads active and serves the presence-owned one-time journal RPC")

  stage = "model-visible mission tools through the ordinary prompt loop"
  const coordinator = await client.session.create({ location, title: "Contract coordinator" })
  await client.session.prompt({ sessionID: coordinator.id, text: "Start the mission" })
  await until(() => requests.some(request => request.answered))
  await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })
  const offered = requests.find(request => request.tools.some(name => /^mission[._]/.test(name)))?.tools.filter(name => /^mission[._]/.test(name))
  receipt.offeredTools = offered
  assert.deepEqual(offered?.map(name => name.replace(/^mission[._]/, "")).sort(), ["briefing", "delegate", "inspect", "report", "revise"])
  const started = await missions.snapshot({}, { location })
  assert.equal(started.missions.length, 1, "The native tool call recorded exactly one mission")
  assert.equal(started.missions[0].coordinatorSessionId, coordinator.id)
  assert.equal(started.missions[0].objective, "Minimum contract qualification")
  gate("tool transform, context hook and mission inspect execute through the native model loop")

  // Recurrence RPC is registered without presence and qualifies the private
  // native graph on demand. Both minimum and latest must support this contract;
  // do not let authentication, storage or plugin failures masquerade as support.
  stage = "recurrence capability qualification"
  const sessionsBefore = (await client.session.list({ location, limit: 64 })).data.map(value => value.id).sort()
  const recurrence = await settle(missions.recurrenceSnapshot({}, { location }))
  receipt.recurrence = recurrence.ok ? { supported: true, schedules: recurrence.value.schedules?.length }
    : { supported: false, error: { type: recurrence.error?.type, message: recurrence.error?.message } }
  assert(recurrence.ok, `Recurrence contract unavailable: ${recurrence.error?.type ?? ""}: ${recurrence.error?.message ?? ""}`)
  assert.deepEqual(recurrence.value.schedules, [], "A fresh isolated store has no schedules")
  assert.deepEqual((await client.session.list({ location, limit: 64 })).data.map(value => value.id).sort(), sessionsBefore,
    "Recurrence qualification creates no native sessions")
  assert.deepEqual((await missions.snapshot({}, { location })).missions, started.missions,
    "Recurrence qualification leaves the one-time journal unchanged")
  gate("native recurrence graph available with an empty isolated schedule store")
  receipt.status = "passed"
  console.log(`PASS ${version}: Missions plugin native contract (${receipt.gates.length} gates); ${root}`)
} catch (error) {
  receipt.status = "failed"; receipt.failure = { stage, message: error.message, stack: error.stack }
  console.error(`Fixture failed during ${stage} at ${root}: ${output.slice(-8000)}`)
  throw error
} finally {
  await plugin?.stop()
  await manager?.shutdown()
  // Bounded: a serve that ignores termination fails the fixture instead of hanging CI.
  if (child) await stopFixtureChild(child, stopped).catch(error => {
    receipt.status = "failed"; receipt.cleanupFailure = error.message; process.exitCode = 1
  })
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  await writeFile(path.join(root, "runtime.log"), output)
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2))
  console.log(`RECEIPT ${path.join(root, "receipt.json")}`)
}
