// Private deterministic native trajectory only. No shared service discovery or paid models.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID, createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { registerHooks, createRequire } from "node:module"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import pino from "pino"

const cli = process.argv[2], dependencies = process.argv[3]
assert(cli && path.isAbsolute(cli), "Pass an absolute existing isolated CLI")
// Optional read-only fallback for this checkout's omitted bare dependencies.
// Never redirects source, installs packages, or changes node_modules.
const resolver = dependencies && createRequire(path.join(path.resolve(dependencies), "package.json"))
const dependencyHook = resolver && registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || /^[./]|:/.test(specifier)) throw error
    return { url: pathToFileURL(resolver.resolve(specifier)).href, shortCircuit: true }
  }
} })
const temporary = path.join(os.tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await mkdtemp(path.join(temporary, "missions-native-trajectory-"))
const project = path.join(root, "project"), config = path.join(root, "config")
const previousEnvironment = { ...process.env }, requests = [], checkpoints = [], gates = [], holds = new Map()
const receipt = { status: "running", cli, artifacts: root, gates, checkpoints,
  limits: ["Deterministic provider drives decisions; not evidence of general LLM planning quality.",
    "No live desktop/mobile mission, persistent-host, recursive Pause/Stop, or paid-provider qualification.",
    "Coordinator business readout intentionally does not manufacture task/child invocation bindings."] }
let child, stopped, manager, plugin, removeBridge, output = "", failure, mission, coordinator, coordinatorStep = 0
let stage = "isolated setup", nativeToolBefore, rootAfterLaunch = false, rootReleased = false
let capture
const bridge = Fastify()
const call = (tool, input, id) => ({ tool, input, id })
const task = key => ({ taskKey: key, title: key, brief: `TRAJECTORY_${key.toUpperCase()}: Return bounded native evidence; recurse only within native permissions.`,
  role: "specialist", blockedBy: [], execution: { agent: "trajectory_child", model: { providerID: "fixture", id: "fixture" } } })
const definition = { id: "missions.trajectory.fixture", methods: { inspect: { input: { type: "object" }, output: { type: "object" } } }, events: {} }
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) { raw += chunk; assert(raw.length < 2 * 1024 * 1024, "Provider body budget") }
    const body = JSON.parse(raw), sessionID = request.headers["x-fixture-session"], kind = request.headers["x-fixture-kind"]
    const text = JSON.stringify(body.messages ?? [])
    requests.push({ index: requests.length, sessionID, kind, model: body.model, body })
    assert(requests.length < 100, "Provider request budget")
    let answer = "Private fixture title"
    if (kind === "primary") {
      if (sessionID === coordinator) {
        if (coordinatorStep === 0) { await capture("started"); answer = call("mission_inspect", { catalog: true }, "trajectory_catalog") }
        else if (coordinatorStep === 1) answer = call("mission_delegate", task("alpha"), "trajectory_declare_alpha")
        else if (coordinatorStep === 2) answer = call("mission_delegate", task("beta"), "trajectory_declare_beta")
        else if (coordinatorStep === 3) {
          const planned = await capture("planned")
          assert.equal(planned.snapshot.missions[0].tasks.length, 2)
          assert.equal(planned.sessions.filter(session => session.parentID).length, 0, "Declarations never create native children")
          const declared = key => {
            const result = body.messages.findLast(message => message.role === "tool" && message.tool_call_id === `trajectory_declare_${key}`)
            assert(result, `Native declaration result ${key}`)
            const content = typeof result.content === "string" ? result.content : result.content.map(part => part.text ?? "").join("")
            const value = JSON.parse(content)
            assert.match(value.assignmentPrompt, /bounded assignment/)
            return value.assignmentPrompt
          }
          answer = ["alpha", "beta"].map(key => call("subagent", { agent: "trajectory_child", description: `Native ${key}`,
            prompt: declared(key), background: true }, `trajectory_launch_${key}`))
        } else if (coordinatorStep === 4) {
          rootAfterLaunch = true
          await new Promise(resolve => { holds.set("coordinator", resolve); response.once("close", resolve) })
          answer = "Private native work launched; await native returns."
        } else if (text.includes("ALPHA_NATIVE_RETURN") && text.includes("BETA_NATIVE_RETURN")) {
          if (coordinatorStep === 5) answer = call("mission_report", { taskKey: "alpha", outcome: "completed",
            summary: "Alpha returned recursive evidence", evidence: ["ALPHA_NATIVE_RETURN", "LEAF_NATIVE_RETURN"] }, "trajectory_report_alpha")
          else if (coordinatorStep === 6) answer = call("mission_report", { taskKey: "beta", outcome: "completed",
            summary: "Beta returned independent evidence", evidence: ["BETA_NATIVE_RETURN"] }, "trajectory_report_beta")
          else if (coordinatorStep === 7) answer = call("mission_report", { outcome: "completed", summary: "Both ready workstreams completed", final: true }, "trajectory_final")
          else answer = "MISSION_TRAJECTORY_COMPLETE"
        } else { answer = "Awaiting both actual native returns."; coordinatorStep-- }
        coordinatorStep++
      } else {
        const first = requests.filter(item => item.kind === "primary" && item.sessionID === sessionID).length === 1
        const assignment = JSON.stringify(body.messages.find(message => message.role === "user")?.content)
        if (assignment.includes("TRAJECTORY_LEAF")) {
          if (first) await new Promise(resolve => { holds.set("leaf", resolve); response.once("close", resolve) })
          answer = "LEAF_NATIVE_RETURN: bounded recursive helper evidence"
        } else if (assignment.includes("TRAJECTORY_ALPHA")) {
          if (first) answer = call("subagent", { agent: "trajectory_child", description: "Bounded recursive leaf",
            prompt: "TRAJECTORY_LEAF: Return only bounded helper evidence." }, "trajectory_recurse")
          else { assert(text.includes("LEAF_NATIVE_RETURN")); answer = "ALPHA_NATIVE_RETURN: consumed LEAF_NATIVE_RETURN" }
        } else if (assignment.includes("TRAJECTORY_BETA")) {
          if (first) await new Promise(resolve => { holds.set("beta", resolve); response.once("close", resolve) })
          answer = "BETA_NATIVE_RETURN: independent ready work evidence"
        } else throw new Error("Unexpected private native child")
      }
    }
    if (response.destroyed) return
    if (typeof answer !== "string") for (const entry of Array.isArray(answer) ? answer : [answer]) {
      assert(body.tools.some(tool => tool.function.name === entry.tool), `Real native tool unavailable: ${entry.tool}`)
    }
    if (!body.stream) {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }] }))
    } else {
      const delta = typeof answer === "string" ? { role: "assistant", content: answer } : { role: "assistant",
        tool_calls: (Array.isArray(answer) ? answer : [answer]).map((entry, index) => ({ index, id: entry.id, type: "function",
          function: { name: entry.tool, arguments: JSON.stringify(entry.input) } })) }
      response.setHeader("content-type", "text/event-stream")
      for (const [value, finish_reason] of [[delta, null], [{}, typeof answer === "string" ? "stop" : "tool_calls"]]) {
        response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`)
      }
      response.end("data: [DONE]\n\n")
    }
  } catch (error) { failure = error; response.destroy() }
})
const gate = name => { gates.push(name); console.log(`PASS ${name}`) }
async function until(predicate, label = stage) {
  const end = Date.now() + 35_000
  while (Date.now() < end) {
    if (failure) throw failure
    if (child && child.exitCode !== null) throw new Error(`Private serve exited: ${output.slice(-4000)}`)
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(`Bounded timeout: ${label}`)
}
const release = key => { holds.get(key)?.(); holds.delete(key) }
try {
  for (const directory of [project, config]) await mkdir(directory)
  for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)) delete process.env[key]
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
  Object.assign(process.env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, OPENCODE_TEST_HOME: root, XDG_RUNTIME_DIR: root,
    OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_SERVER_PASSWORD: randomUUID(),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1" })
  delete process.env.WSL_DISTRO_NAME
  receipt.cliVersion = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim()
  receipt.nodeVersion = process.version
  receipt.binarySHA256 = createHash("sha256").update(await readFile(cli)).digest("hex")
  receipt.sourceSHA256 = Object.fromEntries(await Promise.all([
    "scripts/test-missions-native-trajectory.mjs", "packages/server/src/opencode/missions-plugin.ts",
    "packages/server/src/missions/control.ts", "packages/server/src/missions/recipes.ts",
  ].map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])))
  await writeFile(path.join(config, "opencode.json"), "{}\n")
  const load = file => tsImport(`../packages/server/src/${file}`, import.meta.url)
  const [{ WorkspaceManager }, { EventBus }, { rememberRuntime }, { DesktopPluginLifecycle }, { resolveDesktopPluginPaths },
    { createAutomationBridgeRegistration, publishAutomationBridge }, { registerAutomationPluginRoute }, { registerMissionRoutes },
    { WorktreeDeletionFence }, { CODENOMAD_MISSIONS_RPC }] = await Promise.all([
    load("workspaces/manager.ts"), load("events/bus.ts"), load("opencode/compatibility/runtime.ts"), load("opencode/desktop-plugin-lifecycle.ts"),
    load("opencode/desktop-plugin-paths.ts"), load("opencode/automation-plugin.ts"), load("server/routes/automation-plugin.ts"),
    load("server/routes/missions.ts"), load("workspaces/worktree-session-evacuation.ts"), load("missions/rpc.ts")])
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  const fixturePlugin = path.join(root, "fixture-plugin")
  await mkdir(fixturePlugin)
  await writeFile(path.join(fixturePlugin, "index.ts"), `export default { id: 'missions.trajectory.fixture', async setup(ctx) {
    await ctx.session.hook('http.request', event => {
      event.request.headers.set('x-fixture-kind', event.kind); event.request.headers.set('x-fixture-session', event.sessionID);
    });
    await ctx.session.hook('retry', event => { event.decision = { retry: false }; });
    await ctx.rpc.register(${JSON.stringify(definition)}, { inspect: async () => {
      const tool = (await ctx.tool.list()).find(tool => tool.id === 'subagent');
      return JSON.parse(JSON.stringify({ id: tool.id, input: tool.input, options: tool.options }));
    } });
  } }`)
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", update: "disable", snapshots: false,
    experimental: { subagent_depth: 3 }, permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "execute", resource: "*", effect: "deny" }],
    agents: { trajectory_child: { mode: "all", description: "Private bounded recursive fixture", steps: 12,
      permissions: [{ action: "subagent", resource: "*", effect: "allow" }] } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: "fixture", baseURL: `http://127.0.0.1:${provider.address().port}/v1` },
      models: { fixture: {} } } }, plugins: [fixturePlugin] })
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: process.env, windowsHide: true })
  stopped = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { failure = error })
  child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const endpoint = { url, auth: { type: "basic", username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD } }
  const info = await (await fetch(`${url}/api/info`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } })).json()
  receipt.runtime = { version: info.version, pid: info.pid, url }
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(),
    settings: { getOwner: () => ({ environmentVariables: {} }), readEnvironmentForAdmission: async () => ({}) },
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Private native trajectory" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }) })
  const { workspace } = await manager.create(project), client = await manager.getSharedServiceClient()
  const paths = await resolveDesktopPluginPaths(await manager.getSharedServiceConnection(workspace.id), { kind: "host", platform: process.platform, binary: cli })
  assert.equal(paths.config, config)
  const registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
  const worktreeDeletionFence = new WorktreeDeletionFence()
  registerMissionRoutes(bridge, { workspaceManager: manager, worktreeDeletionFence })
  registerAutomationPluginRoute(bridge, { workspaceManager: manager, worktreeDeletionFence,
    authManager: { isLoopbackRequest: () => true }, bridgeToken: registration.token, nativeParent: {}, developerCdp: {} })
  await bridge.listen({ host: "127.0.0.1", port: 0 })
  registration.url = `http://127.0.0.1:${bridge.server.address().port}/api/opencode-plugin/automation`
  removeBridge = await publishAutomationBridge(registration)
  plugin = new DesktopPluginLifecycle("missions"); await plugin.start(paths)
  const location = { directory: project }, options = () => ({ location, signal: AbortSignal.timeout(20_000) })
  const rpc = client.rpc(CODENOMAD_MISSIONS_RPC)
  await until(async () => (await client.plugin.list({ location })).data.some(value => value.id === "codenomad.missions" && value.state.status === "active"))
  nativeToolBefore = await client.rpc(definition).inspect({}, options())
  const checkpoint = capture = async label => {
    const snapshot = await rpc.snapshot({}, options())
    const active = await client.session.active({}, { signal: AbortSignal.timeout(20_000) })
    const sessions = (await client.session.list({ location, limit: 32 }, { signal: AbortSignal.timeout(20_000) })).data
    const response = await bridge.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/missions` })
    assert.equal(response.statusCode, 200, response.body)
    const display = response.json()
    assert.equal(display.available, true, "Real owned Missions display route")
    const record = { label, at: new Date().toISOString(), snapshot, active, sessions, display }
    checkpoints.push(record); await writeFile(path.join(root, `${label}.json`), JSON.stringify(record, null, 2))
    console.log(`CHECKPOINT ${label}: ${snapshot.missions.map(value => `${value.runState}/${value.status}, ${value.tasks.length} tasks, ${value.reports.length} reports`).join("; ")}`)
    return record
  }
  await checkpoint("before")
  const missionURL = `/api/workspaces/${workspace.id}/missions`
  stage = "prepared create"
  const created = await bridge.inject({ method: "POST", url: missionURL, payload: { requestId: "trajectory-create", objective: "Observe parallel native children and recursive evidence", template: "custom" } })
  assert.equal(created.statusCode, 200, created.body); mission = created.json().mission; coordinator = mission.coordinatorSessionId
  assert.equal(mission.runState, "prepared"); assert.equal(requests.filter(value => value.kind === "primary").length, 0)
  await checkpoint("prepared"); gate("prepared map creates no model execution")
  stage = "explicit Play and native planning"
  const started = await bridge.inject({ method: "POST", url: `${missionURL}/${mission.id}/control`, payload: {
    requestId: "trajectory-start", expectedRevision: mission.revision, action: "start" } })
  assert.equal(started.statusCode, 200, started.body)
  await until(() => rootAfterLaunch && holds.has("beta") && holds.has("leaf"))
  const during = await checkpoint("during")
  mission = during.snapshot.missions[0]
  assert.equal(mission.runState, "running"); assert.deepEqual(mission.tasks.map(value => value.blockedBy), [[], []])
  assert(mission.tasks.every(value => value.executionMode.kind === "native" && !value.actorSessionId))
  assert.equal(mission.reports.length, 0)
  const alpha = during.sessions.find(value => value.parentID === coordinator && value.title.includes("alpha"))
  const beta = during.sessions.find(value => value.parentID === coordinator && value.title.includes("beta"))
  assert(alpha && beta, "Real native siblings")
  const leaf = during.sessions.find(value => value.parentID === alpha.id)
  assert(leaf, "Actual native grandchild")
  assert(during.active[alpha.id] && during.active[beta.id] && during.active[leaf.id], "Observe overlap, not just declarations")
  const family = during.display.activity.missions[0].family
  assert.equal(family.state, "observed")
  assert.equal(family.members.length, 4)
  assert.equal(family.members.find(value => value.sessionId === leaf.id).parentSessionId, alpha.id)
  assert.equal(family.members.filter(value => value.kind === "ordinary").length, 3)
  assert(family.members.every(value => !value.taskKey), "Observed ancestry never invents task associations")
  receipt.nativeAncestry = { coordinator, alpha: alpha.id, beta: beta.id, leaf: leaf.id }
  gate("independent ready tasks have no artificial blockedBy or manufactured child bindings")
  gate("native declarations create a readable plan without starting child sessions")
  gate("real OpenCode parallel siblings and recursive grandchild active simultaneously")
  gate("owned display route observes four genuine conversations without guessed task associations")
  stage = "native return and coordinator consumption"
  release("leaf"); release("beta")
  await Promise.all([alpha.id, beta.id, leaf.id].map(sessionID => client.session.wait({ sessionID }, { signal: AbortSignal.timeout(20_000) })))
  const returned = await checkpoint("returned-before-readout")
  assert.equal(returned.snapshot.missions[0].reports.length, 0)
  assert.equal(returned.snapshot.missions[0].status, "active")
  assert(returned.snapshot.missions[0].tasks.every(value => value.status === "ready"))
  gate("native successful return alone never completes business tasks")
  rootReleased = true; release("coordinator")
  await until(async () => (await rpc.snapshot({}, options())).missions[0]?.status === "completed")
  await client.session.wait({ sessionID: coordinator }, { signal: AbortSignal.timeout(20_000) })
  const after = await checkpoint("completed")
  mission = after.snapshot.missions[0]
  assert(mission.tasks.every(value => value.status === "completed" && value.report.delivery === "coordinator-readout"))
  assert.equal(mission.reports.length, 2, "Task reports exclude the terminal mission readout")
  const messages = await client.message.list({ sessionID: coordinator, limit: { order: "asc", limit: 100 } })
  const toolParts = messages.data.flatMap(message => message.content ?? []).filter(part => part.type === "tool")
  for (const id of ["trajectory_catalog", "trajectory_declare_alpha", "trajectory_declare_beta", "trajectory_launch_alpha", "trajectory_launch_beta", "trajectory_report_alpha", "trajectory_report_beta", "trajectory_final"]) {
    assert.equal(toolParts.find(part => part.id === id)?.state.status, "completed", `Actual native tool completed: ${id}`)
  }
  const consumed = requests.find(value => value.sessionID === coordinator && value.kind === "primary" && JSON.stringify(value.body.messages).includes("ALPHA_NATIVE_RETURN") && JSON.stringify(value.body.messages).includes("BETA_NATIVE_RETURN"))
  assert(consumed, "Provider actually saw both native returns before reports")
  receipt.consumedRequestIndex = consumed.index
  gate("coordinator consumes native returns then reports two tasks and terminal completion")
  assert.deepEqual(await client.rpc(definition).inspect({}, options()), nativeToolBefore)
  assert.equal((await client.server.info()).pid, info.pid)
  gate("native subagent schema/options unchanged and same isolated runtime survives")
  receipt.status = "passed"; receipt.passCount = gates.length
  receipt.nativeToolResults = toolParts.map(({ id, name, state }) => ({ id, name, status: state.status }))
  receipt.providerPrimaryRequests = requests.filter(value => value.kind === "primary").length
} catch (error) {
  receipt.status = "failed"; receipt.failure = { stage, message: error.message, stack: error.stack }
  console.error(`FAIL ${stage}: ${error.stack}`)
  process.exitCode = 1
} finally {
  for (const key of holds.keys()) release(key)
  await removeBridge?.(); await plugin?.stop(); await bridge.close(); await manager?.shutdown()
  child?.kill(); if (stopped) await stopped
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
  receipt.cleanup = { ownedServeExited: child ? child.exitCode !== null || child.signalCode !== null : false,
    exitCode: child?.exitCode, signalCode: child?.signalCode, rootReleased }
  await writeFile(path.join(root, "runtime.log"), output)
  await writeFile(path.join(root, "provider-requests.json"), JSON.stringify(requests, null, 2))
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2))
  console.log(`RECEIPT ${path.join(root, "receipt.json")}`)
  for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key]
  Object.assign(process.env, previousEnvironment); dependencyHook?.deregister()
}
