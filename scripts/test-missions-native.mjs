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
const { registerMissionRoutes } = await tsImport("../packages/server/src/server/routes/missions.ts", import.meta.url)
const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
const { CODENOMAD_MISSIONS_RPC } = await tsImport("../packages/server/src/missions/rpc.ts", import.meta.url)
let child, stopped, manager, plugin, removeBridge, output = "", failure, held, hold = false, stage = "setup"
let requests = []
const blockSessions = new Set(), heldSessions = new Map()
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.headers["x-fixture-kind"] === "primary") {
      requests.push({ session: request.headers["x-fixture-session"], model: body.model,
        tools: (body.tools ?? []).map(tool => tool.function?.name),
        messages: JSON.stringify(body.messages ?? []) })
      if (hold) { hold = false; await new Promise(resolve => { held = resolve }) }
      const sessionID = request.headers["x-fixture-session"]
      if (blockSessions.delete(sessionID)) await new Promise(resolve => { heldSessions.set(sessionID, resolve); response.once("close", resolve) })
      if (response.destroyed) return
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
  const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
  const info = await (await fetch(`${url}/api/info`, { headers: { authorization } })).json()
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
  registerMissionRoutes(bridge, { workspaceManager: manager })
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
  await until(() => requests.some(request => request.session === coordinator.id && request.messages.includes("Native verified")))
  await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })
  await probe(coordinator.id, "changed")

  // Exercise the native plan-revision tool and prove that a late report is history, not a reactivation.
  stage = "mission.revise and late report"
  const beforeRevision = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })
  const current = beforeRevision.missions[0]
  const revised = await invoke("revise", {
    missionID: current.id, expectedRevision: current.revision, requestID: "native-revise-1",
    reason: "Replace the queued review with a focused follow-up",
    retireTasks: [{ taskKey: queued.taskKey, replacementTaskKey: "native-revision-replacement" }],
    addTasks: [{ taskKey: "native-revision-replacement", title: "Focused follow-up", brief: "Recheck the selected behavior.",
      role: "reviewer", blockedBy: [], replacesTaskKey: queued.taskKey }],
    dependencyUpdates: [],
  })
  const withdrawn = revised.mission.tasks.find(task => task.key === queued.taskKey)
  assert.equal(withdrawn.status, "withdrawn")
  assert.equal(withdrawn.replacedByTaskKey, "native-revision-replacement")
  assert.equal(revised.mission.tasks.find(task => task.key === "native-revision-replacement").replacesTaskKey, queued.taskKey)
  assert.equal(revised.mission.history.at(-1).reason, "Replace the queued review with a focused follow-up")
  hold = true
  await client.session.prompt({ sessionID: coordinator.id, text: "Busy coordinator before review result" })
  await until(() => Boolean(held))
  const lateReport = await invoke("report", { taskKey: queued.taskKey, outcome: "completed", summary: "Late native result" }, actorID)
  assert((await client.session.inbox.list({ sessionID: coordinator.id })).some(item =>
    item.type === "synthetic" && item.payload.text.includes("Late native result")), "Busy coordinator retains the report")
  held(); held = undefined
  await until(() => requests.some(request => request.session === coordinator.id && request.messages.includes("Late native result")))
  await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })
  assert.equal(lateReport.mission.tasks.find(task => task.key === queued.taskKey).status, "withdrawn")
  assert.equal(lateReport.mission.tasks.find(task => task.key === queued.taskKey).lateReports.at(-1).late, true)
  assert(lateReport.mission.reports.some(report => report.taskKey === queued.taskKey && report.late === true))
  assert((await client.session.get({ sessionID: actorID })).id === actorID, "Revision keeps the original actor conversation")

  // A durable report must wake its coordinator after transport recovery, without
  // another report call or human prompt. Exercise both live recovery and reload.
  for (const restart of [false, true]) {
    stage = `report outbox recovery (restart=${restart})`
    const taskKey = restart ? "outbox-restart" : "outbox-live"
    const summary = `Recovered report ${taskKey}`
    await invoke("delegate", { ...task, taskKey, targetSessionID: actorID })
    await client.session.wait({ sessionID: actorID }, { signal: AbortSignal.timeout(20_000) })
    await removeBridge(); removeBridge = undefined
    await assert.rejects(invoke("report", { taskKey, outcome: "completed", summary }, actorID))
    const pending = (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions[0]
    assert.equal(pending.tasks.find(task => task.key === taskKey).report.summary, summary)
    assert.equal(pending.tasks.find(task => task.key === taskKey).report.notificationStatus, "pending")
    assert(!requests.some(request => request.session === coordinator.id && request.messages.includes(summary)))
    if (restart) {
      await plugin.stop()
      await until(async () => { try { await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location }); return false } catch { return true } })
    }
    removeBridge = await publishAutomationBridge(registration)
    if (restart) { plugin = new DesktopPluginLifecycle("missions"); await plugin.start(paths) }
    await until(() => requests.some(request => request.session === coordinator.id && request.messages.includes(summary)))
    await until(async () => (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions[0]
      .reports.find(report => report.taskKey === taskKey)?.notificationStatus === "admitted")
    await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })
    const count = requests.filter(request => request.session === coordinator.id).length
    assert.equal((await invoke("report", { taskKey, outcome: "completed", summary }, actorID)).disposition, "existing")
    await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })
    assert.equal(requests.filter(request => request.session === coordinator.id).length, count, "Acknowledged report replay does not wake the coordinator again")
    const transcript = await client.message.list({ sessionID: coordinator.id, limit: { order: "asc", limit: 100 } })
    assert.equal(transcript.data.filter(message => message.type === "synthetic"
      && message.metadata?.["codenomad.mission"]?.taskKey === taskKey).length, 1, "One correlated native report survives recovery and replay")
  }

  // Native lifecycle RPC is the same typed capability brokered by the authenticated UI routes.
  stage = "lifecycle CRUD and transcript preservation"
  const crudInput = { requestID: "native-crud-create", objective: "Keep this conversation", notes: "CRUD fixture", template: "custom" }
  const crudCreated = await client.rpc(CODENOMAD_MISSIONS_RPC).create(crudInput, { location })
  const crudReplay = await client.rpc(CODENOMAD_MISSIONS_RPC).create(crudInput, { location })
  assert.equal(crudReplay.mission.id, crudCreated.mission.id)
  assert.equal(crudReplay.mission.coordinatorSessionId, crudCreated.mission.coordinatorSessionId)
  const crudCoordinator = crudCreated.mission.coordinatorSessionId
  await client.session.prompt({ sessionID: crudCoordinator, text: "Conversation retained by tombstone" })
  await client.session.wait({ sessionID: crudCoordinator }, { signal: AbortSignal.timeout(20_000) })
  const messagesBefore = await client.message.list({ sessionID: crudCoordinator, limit: { order: "asc", limit: 50 } })
  const crudUpdated = await client.rpc(CODENOMAD_MISSIONS_RPC).update({
    missionID: crudCreated.mission.id, requestID: "native-crud-update", expectedRevision: crudCreated.mission.revision,
    objective: "Updated but retained", notes: "Updated notes",
  }, { location })
  const updateReplay = await client.rpc(CODENOMAD_MISSIONS_RPC).update({
    missionID: crudCreated.mission.id, requestID: "native-crud-update", expectedRevision: crudCreated.mission.revision,
    objective: "Updated but retained", notes: "Updated notes",
  }, { location })
  assert.equal(updateReplay.mission.revision, crudUpdated.mission.revision)
  assert.equal(updateReplay.mission.notes, "Updated notes")
  stage = "native mutation errors through HTTP routes"
  const missionURL = `/api/workspaces/${workspace.id}/missions`
  const rejectedMutation = async (method, suffix, payload, status, code) => {
    const response = await bridge.inject({ method, url: missionURL + suffix, payload })
    assert.equal(response.statusCode, status, `${method} ${suffix}: ${response.body}`)
    assert.equal(response.json().code, code)
  }
  await rejectedMutation("PATCH", `/${crudCreated.mission.id}`, {
    requestId: "stale-update", expectedRevision: 1, objective: "Stale edit",
  }, 409, "revision-conflict")
  await rejectedMutation("DELETE", `/${crudCreated.mission.id}`, {
    requestId: "stale-delete", expectedRevision: 1,
  }, 409, "revision-conflict")
  await rejectedMutation("POST", "", {
    requestId: crudInput.requestID, objective: "Different creation", template: "custom",
  }, 409, "request-conflict")
  await rejectedMutation("PATCH", `/${crudCreated.mission.id}`, {
    requestId: "native-crud-update", expectedRevision: 1, objective: "Different edit",
  }, 409, "request-conflict")
  for (const method of ["PATCH", "DELETE"]) await rejectedMutation(method, "/msn_unknown", {
    requestId: `unknown-${method}`, expectedRevision: 1, ...(method === "PATCH" ? { objective: "Unknown" } : {}),
  }, 404, "mission-not-found")
  assert.equal((await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location }))
    .missions.find(mission => mission.id === crudCreated.mission.id).revision, crudUpdated.mission.revision)
  const deletion = { missionID: crudCreated.mission.id, requestID: "native-crud-delete", expectedRevision: crudUpdated.mission.revision }
  assert.deepEqual(await client.rpc(CODENOMAD_MISSIONS_RPC).delete(deletion, { location }), { deleted: true })
  assert.deepEqual(await client.rpc(CODENOMAD_MISSIONS_RPC).delete(deletion, { location }), { deleted: true })
  await rejectedMutation("DELETE", `/${crudCreated.mission.id}`, {
    requestId: deletion.requestID, expectedRevision: 1,
  }, 409, "request-conflict")
  const afterDeleteSnapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })
  assert(!afterDeleteSnapshot.missions.some(mission => mission.id === crudCreated.mission.id), "Tombstone hides the mission map")
  assert.equal((await client.session.get({ sessionID: crudCoordinator })).id, crudCoordinator, "Tombstone preserves the coordinator session")
  const messagesAfter = await client.message.list({ sessionID: crudCoordinator, limit: { order: "asc", limit: 50 } })
  assert.deepEqual(messagesAfter, messagesBefore, "Tombstone preserves the native conversation transcript")

  stage = "optional managed specialist cleanup"
  const cleanup = await client.rpc(CODENOMAD_MISSIONS_RPC).create({
    requestID: "native-cleanup-create", objective: "Clean only owned specialists", template: "custom",
  }, { location })
  const cleanupCoordinator = cleanup.mission.coordinatorSessionId
  const managedTask = await invoke("delegate", { ...task, missionID: cleanup.mission.id, taskKey: "managed-cleanup" }, cleanupCoordinator, "cleanup-managed")
  const managedSession = managedTask.mission.tasks.find(task => task.key === "managed-cleanup").actorSessionId
  await client.session.wait({ sessionID: managedSession }, { signal: AbortSignal.timeout(20_000) })
  const reusedSession = await client.session.create({ location, title: "Pre-existing specialist", agent: "reviewer", model: task.execution.model })
  const reusedTask = await invoke("delegate", { ...task, missionID: cleanup.mission.id, taskKey: "reused-cleanup", targetSessionID: reusedSession.id }, cleanupCoordinator, "cleanup-reused")
  await client.session.wait({ sessionID: reusedSession.id }, { signal: AbortSignal.timeout(20_000) })
  const cleanupRequest = { requestId: "native-cleanup-delete", expectedRevision: reusedTask.mission.revision, deleteManagedSessions: true }
  for (let replay = 0; replay < 2; replay++) {
    const response = await bridge.inject({ method: "DELETE", url: `${missionURL}/${cleanup.mission.id}`, payload: cleanupRequest })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { deleted: true })
  }
  await assert.rejects(client.session.get({ sessionID: managedSession }), "Opt-in cleanup removes the managed specialist")
  assert.equal((await client.session.get({ sessionID: reusedSession.id })).id, reusedSession.id, "Cleanup preserves reused conversations")
  assert.equal((await client.session.get({ sessionID: cleanupCoordinator })).id, cleanupCoordinator, "Cleanup preserves the coordinator")
  await rejectedMutation("DELETE", `/${cleanup.mission.id}`, { ...cleanupRequest, deleteManagedSessions: false }, 409, "request-conflict")

  stage = "Play Pause Resume and terminal Stop"
  const preparedResponse = await bridge.inject({ method: "POST", url: missionURL, payload: { requestId: "native-run-create", objective: "Controlled mission", template: "custom" } })
  assert.equal(preparedResponse.statusCode, 200, preparedResponse.body)
  let controlled = preparedResponse.json().mission
  assert.equal(controlled.runState, "prepared")
  const runCoordinator = controlled.coordinatorSessionId
  const runAction = async action => {
    const request = { requestId: `native-${action}-${controlled.revision}`, expectedRevision: controlled.revision, action }
    const response = await bridge.inject({ method: "POST", url: `${missionURL}/${controlled.id}/control`, payload: request })
    assert.equal(response.statusCode, 200, response.body)
    controlled = response.json().mission
    return request
  }
  const startRequest = await runAction("start")
  await until(() => requests.some(request => request.session === runCoordinator && request.messages.includes(`Start or resume existing mission ${controlled.id}`)))
  await client.session.wait({ sessionID: runCoordinator }, { signal: AbortSignal.timeout(20_000) })
  controlled = (await invoke("delegate", { ...task, missionID: controlled.id, taskKey: "running-worker" }, runCoordinator, "running-worker")).mission
  const runWorker = controlled.tasks.find(task => task.key === "running-worker").actorSessionId
  await client.session.wait({ sessionID: runWorker }, { signal: AbortSignal.timeout(20_000) })
  controlled = (await invoke("delegate", { ...task, missionID: controlled.id, taskKey: "reporting-worker" }, runCoordinator, "reporting-worker")).mission
  const reportWorker = controlled.tasks.find(task => task.key === "reporting-worker").actorSessionId
  await client.session.wait({ sessionID: reportWorker }, { signal: AbortSignal.timeout(20_000) })
  for (const sessionID of [runCoordinator, runWorker]) {
    blockSessions.add(sessionID)
    await client.session.prompt({ sessionID, text: "Hold execution until the mission control is applied" })
  }
  await until(() => heldSessions.has(runCoordinator) && heldSessions.has(runWorker))
  await runAction("pause")
  assert.equal(controlled.runState, "paused")
  await Promise.all([runCoordinator, runWorker].map(sessionID => client.session.wait({ sessionID }, { signal: AbortSignal.timeout(20_000) })))
  for (const sessionID of [runCoordinator, runWorker]) assert.equal((await client.session.get({ sessionID })).outcome, "interrupted")
  for (const release of heldSessions.values()) release()
  heldSessions.clear()
  const pausedRequests = requests.length
  controlled = (await invoke("report", { missionID: controlled.id, taskKey: "reporting-worker", outcome: "completed", summary: "Saved while paused", evidence: [], next: [] }, reportWorker, "paused-report")).mission
  assert.equal(controlled.reports.at(-1).notificationStatus, "pending")
  await delay(300)
  assert.equal(requests.length, pausedRequests, "Paused reports must not wake the coordinator")
  await runAction("start")
  await until(() => requests.slice(pausedRequests).some(request => request.session === runWorker && request.messages.includes("Resume your interrupted assignments")))
  await until(() => requests.slice(pausedRequests).some(request => request.session === runCoordinator && request.messages.includes("Start or resume existing mission")))
  await Promise.all([runCoordinator, runWorker].map(sessionID => client.session.wait({ sessionID }, { signal: AbortSignal.timeout(20_000) })))
  await until(async () => {
    controlled = (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions.find(mission => mission.id === controlled.id)
    return controlled.reports.every(report => report.notificationStatus === "admitted")
  })
  const parked = await client.session.synthetic({ sessionID: runWorker, text: "Pending mission input", resume: false,
    metadata: { "codenomad.mission": { missionID: controlled.id, kind: "assignment" } } })
  await runAction("stop")
  assert.equal(controlled.status, "stopped")
  assert.equal(controlled.control.pending.length, 0)
  assert.ok(!(await client.session.inbox.list({ sessionID: runWorker })).some(item => item.id === parked.id))
  const restarted = await bridge.inject({ method: "POST", url: `${missionURL}/${controlled.id}/control`, payload: { requestId: "restart-stopped", expectedRevision: controlled.revision, action: "start" } })
  assert.equal(restarted.statusCode, 409, restarted.body)
  assert.equal(restarted.json().code, "mission-finished")
  const staleStart = await bridge.inject({ method: "POST", url: `${missionURL}/${controlled.id}/control`, payload: startRequest })
  assert.equal(staleStart.json().mission.status, "stopped", "Replaying an old Play cannot restart a stopped mission")
  assert.equal((await client.session.get({ sessionID: runWorker })).id, runWorker)

  stage = "presence restart and durable replay"
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
  console.log(`PASS ${version}: native catalog, selection, busy queue, conflict, environment, idle/busy coordinator resumption, report outbox recovery with/without restart, revise/late report, lifecycle create/update/delete idempotence, Play/Pause/Resume/terminal Stop, optional managed specialist cleanup, structured HTTP/RPC mutation errors and transcript preservation, presence restart; ${root}`)
} catch (error) {
  console.error(`Fixture failed during ${stage} at ${root}: ${output.slice(-8000)}`)
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
