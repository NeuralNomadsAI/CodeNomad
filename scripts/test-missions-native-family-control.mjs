// Private deterministic native family-control fixture. Real OpenCode background
// subagents (depth 3) under a Mission coordinator; exercises recursive Pause/Play
// and Stop through the owned HTTP control route. Isolated CLI/home/database/provider
// only: never discovers the shared service or a user's database.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import pino from "pino"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass an absolute existing isolated CLI")
const temporary = path.join(os.tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
// Physical path: Windows runners report an 8.3 temp path, but missions are keyed by the resolved project.
const root = await realpath(await mkdtemp(path.join(temporary, "missions-native-family-")))
const project = path.join(root, "project"), config = path.join(root, "config")
const requests = [], gates = [], holds = new Map(), released = new Set()
const receipt = { status: "running", cli, artifacts: root, gates,
  limits: ["Deterministic provider; every family member is held in an in-flight provider request when controlled.",
    "No forced partial (stuck sub-agent) case: native interrupt always succeeded here; partial receipts are unit-tested only."] }
let child, stopped, manager, plugin, removeBridge, output = "", failure, stage = "isolated setup"
const bridge = Fastify()
const call = (tool, input, id) => ({ tool, input, id })
const launch = (marker, id) => call("subagent", { agent: "family_child", description: `Family ${marker}`,
  prompt: `${marker}: hold until mission control.`, background: true }, id)
// Holds an in-flight provider turn until native interruption aborts it.
const hold = (key, response) => new Promise(resolve => {
  holds.set(key, resolve); response.once("close", () => { released.add(key); resolve() })
})
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), sessionID = request.headers["x-fixture-session"], kind = request.headers["x-fixture-kind"]
    const messages = JSON.stringify(body.messages ?? [])
    requests.push({ index: requests.length, at: Date.now(), sessionID, kind, messages })
    assert(requests.length < 200, "Provider request budget")
    let answer = "Fixture title"
    if (kind === "primary") {
      const turn = requests.filter(item => item.kind === "primary" && item.sessionID === sessionID).length
      const first = JSON.stringify(body.messages.find(message => message.role === "user")?.content ?? "")
      const marker = ["FAMILY_A", "FAMILY_B", "FAMILY_LEAF", "FAMILY_DEEP"].find(value => first.includes(value))
      const key = `${marker ?? "coordinator"}:${sessionID}`
      if (!marker) {
        // Coordinator: launch two background children, then hold its own turn.
        if (turn === 1) answer = [launch("FAMILY_A", `launch_a_${sessionID}`), launch("FAMILY_B", `launch_b_${sessionID}`)]
        else if (turn === 2) { await hold(key, response); answer = "Coordinator waiting" }
        else answer = "Coordinator resumed"
      } else if (marker === "FAMILY_A" || marker === "FAMILY_LEAF") {
        // Recursive background delegation, then remain active.
        if (turn === 1) answer = launch(marker === "FAMILY_A" ? "FAMILY_LEAF" : "FAMILY_DEEP", `launch_${marker}_${sessionID}`)
        else if (turn === 2) { await hold(key, response); answer = `${marker} waiting` }
        else answer = `${marker} done`
      } else if (turn === 1) { await hold(key, response); answer = `${marker} done` }
      else answer = `${marker} done`
    }
    if (response.destroyed) return
    const delta = typeof answer === "string" ? { role: "assistant", content: answer } : { role: "assistant",
      tool_calls: (Array.isArray(answer) ? answer : [answer]).map((entry, index) => ({ index, id: entry.id, type: "function",
        function: { name: entry.tool, arguments: JSON.stringify(entry.input) } })) }
    if (!body.stream) {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: String(answer) }, finish_reason: "stop" }] }))
      return
    }
    response.setHeader("content-type", "text/event-stream")
    for (const [value, finish_reason] of [[delta, null], [{}, typeof answer === "string" ? "stop" : "tool_calls"]]) {
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`)
    }
    response.end("data: [DONE]\n\n")
  } catch (error) { failure = error; response.destroy() }
})
const gate = name => { gates.push(name); console.log(`PASS ${name}`) }
async function until(predicate, label = stage) {
  const end = Date.now() + 45_000
  while (Date.now() < end) {
    if (failure) throw failure
    if (child && child.exitCode !== null) throw new Error(`Private serve exited: ${output.slice(-4000)}`)
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(`Bounded timeout: ${label}`)
}
/** Every nativeAcknowledgement recorded for `sessionID` anywhere in the map. */
function acknowledgements(value, sessionID, found = []) {
  if (!value || typeof value !== "object") return found
  if (value.nativeAcknowledgement?.sessionID === sessionID) found.push(value.nativeAcknowledgement)
  for (const entry of Object.values(value)) acknowledgements(entry, sessionID, found)
  return found
}
try {
  for (const directory of [project, config]) await mkdir(directory)
  for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)) delete process.env[key]
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
  Object.assign(process.env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, OPENCODE_TEST_HOME: root, XDG_RUNTIME_DIR: root,
    OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_SERVER_PASSWORD: randomUUID(),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1" })
  delete process.env.WSL_DISTRO_NAME
  receipt.cliVersion = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim()
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
  await writeFile(path.join(fixturePlugin, "index.ts"), `export default { id: 'missions.family.fixture', async setup(ctx) {
    await ctx.session.hook('http.request', event => {
      event.request.headers.set('x-fixture-kind', event.kind); event.request.headers.set('x-fixture-session', event.sessionID);
    });
    await ctx.session.hook('retry', event => { event.decision = { retry: false }; });
  } }`)
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", update: "disable", snapshots: false,
    experimental: { subagent_depth: 4 }, permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "execute", resource: "*", effect: "deny" }],
    agents: { family_child: { mode: "all", description: "Private recursive background fixture", steps: 12,
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
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Private family control" }) },
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
  const location = { directory: project }
  await until(async () => (await client.plugin.list({ location })).data.some(value => value.id === "codenomad.missions" && value.state.status === "active"))
  const missionURL = `/api/workspaces/${workspace.id}/missions`
  const active = () => client.session.active({}, { signal: AbortSignal.timeout(20_000) })
  const children = async parentID => (await client.session.list({ location, parentID, limit: 32 })).data
  const control = async (mission, action, requestId) => {
    const response = await bridge.inject({ method: "POST", url: `${missionURL}/${mission.id}/control`,
      payload: { requestId, expectedRevision: mission.revision, action } })
    assert.equal(response.statusCode, 200, response.body)
    return response.json().mission
  }

  /** Creates and Plays a mission whose coordinator owns a real depth-3 background tree, all mid-turn. */
  async function runningFamily(label) {
    const created = await bridge.inject({ method: "POST", url: missionURL, payload: { requestId: `family-${label}-create`, objective: `Family ${label}`, template: "custom" } })
    assert.equal(created.statusCode, 200, created.body)
    let mission = created.json().mission
    const coordinator = mission.coordinatorSessionId
    mission = await control(mission, "start", `family-${label}-start`)
    let family
    await until(async () => {
      const [a, b] = ["FAMILY_A", "FAMILY_B"].map(marker => [...holds.keys()].find(key => key.startsWith(`${marker}:`))?.split(":")[1])
      const leaf = [...holds.keys()].find(key => key.startsWith("FAMILY_LEAF:") && !released.has(key))?.split(":")[1]
      const deep = [...holds.keys()].find(key => key.startsWith("FAMILY_DEEP:") && !released.has(key))?.split(":")[1]
      if (!holds.has(`coordinator:${coordinator}`) || !a || !b || !leaf || !deep) return false
      family = { coordinator, a, b, leaf, deep }
      return true
    }, `${label}: whole family held`)
    // Real native ancestry and simultaneous activity, not inferred.
    assert.deepEqual((await children(coordinator)).map(value => value.id).sort(), [family.a, family.b].sort())
    assert.deepEqual((await children(family.a)).map(value => value.id), [family.leaf])
    assert.deepEqual((await children(family.leaf)).map(value => value.id), [family.deep])
    const running = await active()
    for (const id of Object.values(family)) assert(running[id], `${label}: ${id} active before control`)
    return { mission: (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions.find(value => value.id === mission.id), family }
  }
  async function assertFamilyQuiet(label, family) {
    const ids = Object.values(family)
    const running = await active()
    assert.deepEqual(ids.filter(id => running[id]), [], `${label}: no family session remains active`)
    for (const id of ids) assert.equal((await client.session.get({ sessionID: id })).outcome, "interrupted", `${label}: ${id} interrupted`)
    const mark = requests.length
    await delay(2_500)
    const late = requests.slice(mark).filter(value => value.kind === "primary" && ids.includes(value.sessionID))
    assert.deepEqual(late.map(value => value.sessionID), [], `${label}: no family session re-woken after control`)
    const after = await active()
    assert.deepEqual(ids.filter(id => after[id]), [], `${label}: family still inactive after settle window`)
  }
  const assertReceipt = (label, mission, family, action) => {
    const acks = acknowledgements(mission, family.coordinator).filter(ack => ack.action === action)
    assert.equal(acks.length, 1, `${label}: one coordinator receipt`)
    const [ack] = acks
    assert.equal(ack.disposition, "interrupt-observed")
    const descendants = ack.descendants
    assert(descendants, `${label}: recursive summary recorded`)
    assert.equal(descendants.observed, 4)
    assert.equal(descendants.interrupted, 4, `${label}: all four active descendants natively interrupted`)
    assert.equal(descendants.unconfirmed, 0)
    assert.equal(descendants.complete, true)
    const order = descendants.sessions
    assert.deepEqual([...order].sort(), [family.a, family.b, family.leaf, family.deep].sort())
    assert(order.indexOf(family.deep) < order.indexOf(family.leaf) && order.indexOf(family.leaf) < order.indexOf(family.a), `${label}: deepest first`)
    return ack
  }

  stage = "recursive Pause parks deliveries until Play"
  const paused = await runningFamily("pause")
  const pauseMark = requests.length
  let mission = await control(paused.mission, "pause", "family-pause")
  assert.equal(mission.runState, "paused")
  const pauseAck = assertReceipt("pause", mission, paused.family, "pause")
  assert.deepEqual(pauseAck.cancellations, [], "Pause cancels nothing")
  await assertFamilyQuiet("pause", paused.family)
  const parkedInboxes = Object.fromEntries(await Promise.all(Object.values(paused.family).map(async id =>
    [id, await client.session.inbox.list({ sessionID: id })])))
  const parkedAtCoordinator = parkedInboxes[paused.family.coordinator].filter(item => item.payload?.metadata?.source === "subagent")
  assert(parkedAtCoordinator.length >= 1, "Cancelled child results stay parked at the coordinator")
  receipt.pause = { family: paused.family, descendants: pauseAck.descendants,
    parked: Object.fromEntries(Object.entries(parkedInboxes).map(([id, items]) => [id, items.map(item => ({ id: item.id, type: item.type, source: item.payload?.metadata?.source }))])),
    requestsDuringPause: requests.slice(pauseMark).filter(value => value.kind === "primary").map(value => value.sessionID) }
  gate("Pause natively interrupts a real depth-3 background family deepest first with a complete receipt")
  gate("paused family stays inactive and parked subagent results do not wake the coordinator")

  stage = "explicit Play consumes parked results"
  const playMark = requests.length
  mission = await control(mission, "start", "family-play")
  assert.equal(mission.runState, "running")
  await until(() => requests.slice(playMark).some(value => value.kind === "primary" && value.sessionID === paused.family.coordinator))
  await client.session.wait({ sessionID: paused.family.coordinator }, { signal: AbortSignal.timeout(20_000) })
  const resumed = requests.slice(playMark).find(value => value.kind === "primary" && value.sessionID === paused.family.coordinator)
  assert.match(resumed.messages, /Start or resume existing mission/)
  for (const id of [paused.family.a, paused.family.b]) assert(resumed.messages.includes(id), `Play names interrupted child ${id}`)
  const remaining = await client.session.inbox.list({ sessionID: paused.family.coordinator })
  assert.deepEqual(remaining.filter(item => parkedAtCoordinator.some(parked => parked.id === item.id)), [], "Play consumed parked results")
  receipt.play = { coordinatorTurnsAfterPlay: requests.slice(playMark).filter(value => value.kind === "primary" && value.sessionID === paused.family.coordinator).length }
  gate("explicit Play resumes the coordinator with parked results and interrupted conversations")

  stage = "recursive Stop terminates the family without re-waking the coordinator"
  for (const key of [...holds.keys()]) holds.delete(key)
  released.clear()
  const stopping = await runningFamily("stop")
  mission = await control(stopping.mission, "stop", "family-stop")
  assert.equal(mission.status, "stopped")
  const stopAck = assertReceipt("stop", mission, stopping.family, "stop")
  await assertFamilyQuiet("stop", stopping.family)
  for (const id of Object.values(stopping.family)) {
    const queued = (await client.session.inbox.list({ sessionID: id })).filter(item => item.type === "user" || item.type === "synthetic")
    assert.deepEqual(queued.map(item => item.id), [], `stop: ${id} inbox has no queued delivery`)
  }
  receipt.stop = { family: stopping.family, descendants: stopAck.descendants, cancellations: stopAck.cancellations }
  gate("Stop natively interrupts a real depth-3 background family with a complete receipt")
  gate("Stop cancels child deliveries so no family session, including the coordinator, is re-woken")
  assert.equal((await client.server.info()).pid, info.pid)
  receipt.status = "passed"; receipt.passCount = gates.length
  receipt.providerPrimaryRequests = requests.filter(value => value.kind === "primary").length
} catch (error) {
  receipt.status = "failed"; receipt.failure = { stage, message: error.message, stack: error.stack }
  console.error(`FAIL ${stage}: ${error.stack}`)
  process.exitCode = 1
} finally {
  for (const resolve of holds.values()) resolve()
  await removeBridge?.(); await plugin?.stop(); await bridge.close(); await manager?.shutdown()
  // Bounded: a serve that ignores termination fails the fixture instead of hanging CI.
  if (child) await stopFixtureChild(child, stopped).catch(error => {
    receipt.status = "failed"; receipt.cleanupFailure = error.message; process.exitCode = 1
  })
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
  receipt.cleanup = { ownedServeExited: child ? child.exitCode !== null || child.signalCode !== null : false, exitCode: child?.exitCode, signalCode: child?.signalCode }
  await writeFile(path.join(root, "runtime.log"), output)
  await writeFile(path.join(root, "provider-requests.json"), JSON.stringify(requests, null, 2))
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2))
  console.log(`RECEIPT ${path.join(root, "receipt.json")}`)
}
