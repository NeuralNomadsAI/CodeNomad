// Explicit isolated CLI + local deterministic provider. Never discovers the shared service.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import pino from "pino"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute isolated CLI executable")
const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim()
const temporary = path.join(os.tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await mkdtemp(path.join(temporary, "missions-native-"))
for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)) delete process.env[key]
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
Object.assign(process.env, {
  HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root, LOCALAPPDATA: root, XDG_RUNTIME_DIR: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_SERVER_PASSWORD: "isolated-missions", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
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
const { createAutomationBridgeRegistration, publishAutomationBridge } = await tsImport("../packages/server/src/opencode/automation-plugin.ts", import.meta.url)
const { registerAutomationPluginRoute } = await tsImport("../packages/server/src/server/routes/automation-plugin.ts", import.meta.url)
const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
const { CODENOMAD_MISSIONS_RPC } = await tsImport("../packages/server/src/missions/rpc.ts", import.meta.url)
let child, stopped, manager, plugin, removeBridge, output = "", failure, held, hold = false
let requests = []
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.headers["x-fixture-kind"] === "primary") {
      requests.push({ session: request.headers["x-fixture-session"], model: body.model,
        tools: (body.tools ?? []).map(tool => tool.function?.name) })
      if (hold) { hold = false; await new Promise(resolve => { held = resolve }) }
    }
    if (!body.stream) {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
    } else {
      response.setHeader("content-type", "text/event-stream")
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "Done" }, null], [{}, "stop"]]) {
        response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture",
          choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      }
      response.end("data: [DONE]\n\n")
    }
  } catch (error) { failure = error; response.destroy(error) }
})
const bridge = Fastify()
async function until(predicate) {
  for (let i = 0; i < 600; i++) {
    if (failure) throw failure
    if (await predicate()) return
    if (child && child.exitCode !== null) throw new Error(output.slice(-6000))
    await delay(100)
  }
  throw new Error(`Isolated fixture timed out: ${output.slice(-6000)}`)
}
const invocation = {
  id: "missions.fixture",
  methods: { invoke: { input: { type: "object" }, output: { type: "string" } } },
  events: {},
}
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  const fixturePlugin = path.join(root, "fixture-plugin")
  await mkdir(fixturePlugin)
  // Test-only RPC drives the actual registered tool executors without relying on LLM decisions.
  await writeFile(path.join(fixturePlugin, "index.ts"), `export default { id: 'missions.fixture', async setup(ctx) {
    await ctx.session.hook('http.request', event => {
      event.request.headers.set('x-fixture-kind', event.kind)
      event.request.headers.set('x-fixture-session', event.sessionID)
    })
    await ctx.rpc.register(${JSON.stringify(invocation)}, { invoke: async input => {
      const tool = (await ctx.tool.list()).find(tool => tool.id === 'mission_' + input.tool)
      if (!tool) throw new Error('Mission tool unavailable')
      const result = await tool.execute(input.input, { sessionID: input.sessionID, messageID: 'msg_fixture',
        id: input.callID, progress: async () => {}, signal: new AbortController().signal })
      return result.content
    } })
  } }`)
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    model: "fixture/fixture", permissions: [{ action: "*", resource: "*", effect: "allow" }],
    agents: { reviewer: { mode: "all", description: "Fixture reviewer" } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" },
      models: { fixture: {}, selected: { variants: [{ id: "careful" }] } } } }, plugins: [fixturePlugin],
  })
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: process.env, windowsHide: true })
  stopped = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const endpoint = { url, auth: { type: "basic", username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD } }
  const info = await (await fetch(`${url}/api/info`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } })).json()
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  let variables = { MISSION_FIXTURE: "first" }
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(),
    settings: { getOwner: () => ({ environmentVariables: variables }) },
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Isolated missions" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }),
  })
  const { workspace } = await manager.create(project)
  const client = await manager.getSharedServiceClient()
  const connection = await manager.getSharedServiceConnection(workspace.id)
  const paths = await resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: cli })
  assert.equal(paths.config, process.env.OPENCODE_CONFIG_DIR)
  const registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
  registerAutomationPluginRoute(bridge, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence(),
    authManager: { isLoopbackRequest: () => true }, bridgeToken: registration.token, nativeParent: {}, developerCdp: {} })
  await bridge.listen({ host: "127.0.0.1", port: 0 })
  registration.url = `http://127.0.0.1:${bridge.server.address().port}/api/opencode-plugin/automation`
  removeBridge = await publishAutomationBridge(registration)
  plugin = new DesktopPluginLifecycle("missions")
  await plugin.start(paths)
  const location = { directory: project }
  await until(async () => (await client.plugin.list({ location })).data.some(plugin => plugin.id === "codenomad.missions" && plugin.state.status === "active"))
  const coordinator = await client.session.create({ location, title: "Coordinator" })
  const invoke = async (tool, input, sessionID = coordinator.id, callID = `fixture-${tool}`) =>
    JSON.parse(await client.rpc(invocation).invoke({ tool, input, sessionID, callID }, { location }))
  const inspected = await invoke("inspect", { catalog: true, start: { objective: "Native integration", template: "custom" } })
  assert(inspected.catalog.agents.some(agent => agent.id === "reviewer"))
  assert(inspected.catalog.models.some(model => model.id === "selected" && model.variants.includes("careful")))
  const task = { taskKey: "native-review", title: "Review", brief: "Conclude briefly", role: "reviewer",
    execution: { agent: "reviewer", model: { providerID: "fixture", id: "selected", variant: "careful" } } }
  const delegated = await invoke("delegate", task)
  const actorID = delegated.mission.tasks[0].actorSessionId
  const actor = await client.session.get({ sessionID: actorID })
  assert.equal(actor.parentID, undefined)
  assert.equal(actor.agent, "reviewer")
  assert.deepEqual(actor.model, task.execution.model)
  await client.session.wait({ sessionID: actorID }, { signal: AbortSignal.timeout(20_000) })
  assert(requests.some(request => request.session === actorID && request.model === "selected"))
  const probe = async (sessionID, expected) => {
    const file = path.join(project, "environment.json")
    await writeFile(path.join(project, "probe.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env.MISSION_FIXTURE))`)
    await client.session.shell({ sessionID, command: "node probe.cjs" })
    assert.equal(JSON.parse(await readFile(file, "utf8")), expected)
  }
  await probe(actorID, "first")
  variables = { MISSION_FIXTURE: "changed" }
  hold = true
  await client.session.prompt({ sessionID: actorID, text: "Busy actor" })
  await until(() => Boolean(held))
  const queued = { ...task, taskKey: "queued-review", targetSessionID: actorID }
  const queueResult = await invoke("delegate", queued)
  const inbox = await client.session.inbox.list({ sessionID: actorID })
  assert(inbox.some(item => item.id === queueResult.mission.tasks.find(task => task.key === queued.taskKey).admissionId),
    "Busy actor retains the new durable assignment")
  const before = await client.session.get({ sessionID: actorID })
  await assert.rejects(invoke("delegate", { ...queued, taskKey: "conflict", execution: { agent: "build" } }))
  assert.deepEqual((await client.session.get({ sessionID: actorID })).model, before.model)
  held(); held = undefined
  await client.session.wait({ sessionID: actorID }, { signal: AbortSignal.timeout(20_000) })
  await probe(actorID, "changed")
  await invoke("report", { taskKey: task.taskKey, outcome: "completed", summary: "Native verified" }, actorID)
  await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })
  await probe(coordinator.id, "changed")
  const beforeRestart = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })
  await plugin.stop()
  await until(async () => { try { await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location }); return false } catch { return true } })
  plugin = new DesktopPluginLifecycle("missions")
  await plugin.start(paths)
  await until(async () => { try { return Boolean(await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })) } catch { return false } })
  assert.equal((await invoke("delegate", task)).disposition, "existing")
  const afterRestart = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })
  assert.deepEqual(afterRestart.missions, beforeRestart.missions)
  assert.equal((await client.server.info()).pid, info.pid)
  console.log(`PASS ${version}: native catalog, selection, busy queue, conflict, environment, reports, presence restart and idempotence; ${root}`)
} catch (error) {
  console.error(`Fixture failed at ${root}: ${output.slice(-8000)}`)
  throw error
} finally {
  held?.()
  await removeBridge?.()
  await plugin?.stop()
  await bridge.close()
  await manager?.shutdown()
  child?.kill()
  if (stopped) await stopped
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
}
