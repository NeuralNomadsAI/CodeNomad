// Explicit isolated CLI + local deterministic provider. Never discovers the shared service.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { registerHooks, createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import pino from "pino"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute isolated CLI executable")
// Optional read-only fallback for checkouts missing bare workspace dependencies.
// Never redirects source modules, installs packages, or modifies node_modules.
const dependencies = process.argv[3]
const resolver = dependencies && createRequire(path.join(path.resolve(dependencies), "package.json"))
const dependencyHook = resolver && registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || /^[./]|:/.test(specifier)) throw error
    return { url: pathToFileURL(resolver.resolve(specifier)).href, shortCircuit: true }
  }
} })
const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim()
const temporary = path.join(os.tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await mkdtemp(path.join(temporary, "missions-native-"))
for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)) delete process.env[key]
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
Object.assign(process.env, {
  HOME: root, USERPROFILE: root, APPDATA: root, OPENCODE_TEST_HOME: root, LOCALAPPDATA: root, XDG_RUNTIME_DIR: root,
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
const { stableToken } = await tsImport("../packages/server/src/missions/journal.ts", import.meta.url)
let child, stopped, manager, plugin, removeBridge, output = "", failure, held, hold = false, stage = "setup"
const diagnosticReads = []
const gates = [], failedGates = [], failures = []
const receipt = { status: "running", cli, cliVersion: version, nodeVersion: process.version, artifacts: root, gates, failedGates, failures }
let previousFailures = 0
const gate = name => {
  if (failures.length > previousFailures) { failedGates.push(name); console.error(`FAIL ${name}`) }
  else { gates.push(name); console.log(`PASS ${name}`) }
  previousFailures = failures.length
}
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
    model: "fixture/fixture", update: "disable", snapshots: false, permissions: [{ action: "*", resource: "*", effect: "allow" }],
    agents: { reviewer: { mode: "all", description: "Fixture reviewer" } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" },
      models: { fixture: {}, selected: { variants: [{ id: "careful" }] } } } }, plugins: [fixturePlugin],
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
  receipt.runtime = { version: info.version, pid: info.pid, url }
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  let variables = { MISSION_FIXTURE: "first" }
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(),
    settings: { getOwner: () => ({ environmentVariables: variables }), readEnvironmentForAdmission: async () => ({ ...variables }) },
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Isolated missions" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }),
  })
  const { workspace } = await manager.create(project)
  const client = await manager.getSharedServiceClient()
  const connection = await manager.getSharedServiceConnection(workspace.id)
  const paths = await resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: cli })
  assert.equal(paths.config, process.env.OPENCODE_CONFIG_DIR)
  const registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
  bridge.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 400 || request.body?.mode !== "mission-input") return
    const command = request.body.command
    if (command?.kind === "create-root") {
      receipt.rejectedAdmission = { status: reply.statusCode, kind: command.kind, taskKey: command.input?.taskKey }
      diagnosticReads.push((async () => {
        const snapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location: { directory: project }, signal: AbortSignal.timeout(10_000) })
        const mission = snapshot.missions.find(value => value.id === command.input?.missionID)
        const task = mission?.tasks.find(value => value.key === command.input?.taskKey)
        const actor = mission?.actors.find(value => value.sessionId === task?.actorSessionId)
        Object.assign(receipt.rejectedAdmission, { taskStatus: task?.status, actorSessionID: actor?.sessionId, actorManaged: actor?.managed,
          expectedFreshActorSessionID: task && `ses_${stableToken(`${mission.id}\0task\0${task.id}`, 26)}` })
        receipt.failureSnapshot = snapshot
      })().catch(() => { receipt.rejectedAdmission.observation = "unknown" }))
      return
    }
    if (command?.kind !== "prompt") return
    const metadata = command.input?.metadata?.["codenomad.mission"]
    const snapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location: { directory: project } })
    const mission = snapshot.missions.find(value => value.id === metadata?.missionID)
    const task = mission?.tasks.find(value => value.key === metadata?.taskKey)
    const { assignmentInput } = await tsImport("../packages/server/src/missions/inputs.ts", import.meta.url)
    const expected = mission && task && assignmentInput(mission, task)
    // Identity/shape-only diagnosis; never persist bridge tokens or environment.
    receipt.rejectedAdmission = { status: reply.statusCode, taskKey: task?.key, taskStatus: task?.status,
      differences: expected && Object.keys(expected).filter(key => !isDeepStrictEqual(expected[key], command.input[key])) }
  })
  const worktreeDeletionFence = new WorktreeDeletionFence()
  registerMissionRoutes(bridge, { workspaceManager: manager, worktreeDeletionFence })
  registerAutomationPluginRoute(bridge, { workspaceManager: manager, worktreeDeletionFence,
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
  gate("native catalog and configured variant discovery")
  // These original cases test durable root queues, report notifications and
  // root lifecycle/cleanup across plugin reloads. They are explicit independent
  // lifetime exceptions, not the default native child declaration path.
  const task = { taskKey: "native-review", title: "Review", brief: "Conclude briefly", role: "reviewer",
    executionMode: { kind: "independent", reason: "lifetime",
      explanation: "Exercise durable independent-root inbox, notification, lifecycle and cleanup behavior across plugin reloads." },
    execution: { agent: "reviewer", model: { providerID: "fixture", id: "selected", variant: "careful" } } }
  stage = "explicit independent root assignment"
  // Keep reused-root inbox/outbox/lifecycle cases independent of managed-root
  // creation provenance. The original managed-root reuse regression remains
  // mandatory at the end, so a failure cannot suppress these other checks.
  const existingActor = await client.session.create({ location, title: "Existing durable fixture actor", ...task.execution })
  const delegated = await invoke("delegate", { ...task, targetSessionID: existingActor.id })
  const actorID = delegated.mission.tasks[0].actorSessionId
  const actor = await client.session.get({ sessionID: actorID })
  assert.equal(actor.parentID, undefined)
  assert.equal(actor.agent, "reviewer")
  assert.deepEqual(actor.model, task.execution.model)
  await client.session.wait({ sessionID: actorID }, { signal: AbortSignal.timeout(20_000) })
  assert(requests.some(request => request.session === actorID && request.model === "selected"))
  assert.deepEqual(delegated.mission.tasks.find(value => value.key === task.taskKey).executionMode, task.executionMode)
  gate("explicit independent root selection and variant persistence")
  const probe = async (sessionID, expected) => {
    const file = path.join(project, "environment.json")
    await writeFile(path.join(project, "probe.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env.MISSION_FIXTURE))`)
    await client.session.shell({ sessionID, command: "node probe.cjs" })
    assert.equal(JSON.parse(await readFile(file, "utf8")), expected)
  }
  await probe(actorID, "first")
  variables = { MISSION_FIXTURE: "changed" }
  stage = "busy independent root queue and environment"
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
  gate("busy root queue, selection conflict, fresh actor/coordinator environment and idle coordinator report consumption")

  stage = "default native task declaration"
  const nativeTask = { taskKey: "native-declaration", title: "Native declaration", brief: "Return ordinary native evidence to the coordinator.",
    role: "reviewer", execution: task.execution, blockedBy: [] }
  const sessionsBeforeDeclaration = await client.session.list({ location, limit: 32 })
  const requestsBeforeDeclaration = requests.length
  const declared = await invoke("delegate", nativeTask)
  const declaration = declared.mission.tasks.find(value => value.key === nativeTask.taskKey)
  assert.equal(declared.disposition, "declared")
  assert.deepEqual(declaration.executionMode, { kind: "native", parentTaskKey: null })
  assert.equal(declaration.actorSessionId, undefined)
  assert.equal(declaration.admissionId, undefined)
  assert.equal(declaration.status, "ready")
  assert.match(declared.assignmentPrompt, /ordinary native subagent result/)
  assert.equal((await invoke("delegate", nativeTask)).disposition, "existing")
  assert.deepEqual(await client.session.list({ location, limit: 32 }), sessionsBeforeDeclaration)
  assert.equal(requests.length, requestsBeforeDeclaration, "Declarations and replay never create a provider turn")
  gate("default native declaration and canonical prompt replay without actor creation or execution")

  stage = "coordinator project briefing"
  const beforeBriefing = (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions[0]
  const briefingInput = { missionID: beforeBriefing.id, requestID: "fixture-briefing", basedOnRevision: beforeBriefing.revision,
    summary: "The review is verified; the native follow-up is planned, not executed.",
    achieved: [{ text: "Selected review returned its evidence.", taskKeys: [task.taskKey] }],
    ongoing: [], obstacles: [], next: [{ text: "Carry out the declared follow-up after this readout.", taskKeys: [nativeTask.taskKey] }] }
  const briefed = await invoke("briefing", briefingInput)
  assert.equal(briefed.mission.briefing.requestID, briefingInput.requestID)
  assert.equal(briefed.mission.briefing.basedOnRevision, beforeBriefing.revision)
  assert.deepEqual(briefed.mission.tasks, beforeBriefing.tasks)
  assert.deepEqual(briefed.mission.reports, beforeBriefing.reports)
  assert.equal(briefed.mission.status, beforeBriefing.status)
  assert.equal(requests.length, requestsBeforeDeclaration, "Publishing a briefing never creates a provider turn")
  assert.deepEqual(await invoke("briefing", briefingInput), briefed)
  const nativeBriefingSnapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })
  assert.deepEqual(nativeBriefingSnapshot.missions[0].briefing, briefed.mission.briefing,
    "Native RPC output decoding must retain the briefing for the actual UI read path")
  await assert.rejects(invoke("briefing", { ...briefingInput, requestID: "foreign-briefing" }, actorID))
  await assert.rejects(invoke("briefing", { ...briefingInput, requestID: "stale-briefing" }))
  gate("native coordinator briefing, bounded sources, exact replay and no task/execution mutation")

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
  gate("revision lineage, withdrawn late evidence and busy coordinator report consumption")

  // A durable report must wake its coordinator after transport recovery, without
  // another report call or human prompt. Exercise both live recovery and reload.
  for (const restart of [false, true]) {
    stage = `report outbox recovery (restart=${restart})`
    const taskKey = restart ? "outbox-restart" : "outbox-live"
    const summary = `Recovered report ${taskKey}`
    await invoke("delegate", { ...task, taskKey, targetSessionID: actorID })
    await client.session.wait({ sessionID: actorID }, { signal: AbortSignal.timeout(20_000) })
    await removeBridge(); removeBridge = undefined
    const savedReport = await invoke("report", { taskKey, outcome: "completed", summary }, actorID)
    assert.equal(savedReport.disposition, "reported", "A missing bridge does not negate a saved durable report")
    assert.equal(savedReport.mission.reports.find(report => report.taskKey === taskKey)?.notificationStatus, "pending")
    const pending = (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions[0]
    assert.equal(pending.tasks.find(task => task.key === taskKey).report.summary, summary)
    assert.equal(pending.tasks.find(task => task.key === taskKey).report.notificationStatus, "pending")
    assert(!requests.some(request => request.session === coordinator.id && request.messages.includes(summary)))
    if (restart) {
      await plugin.stop()
      assert.equal((await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions[0]
        .reports.find(report => report.taskKey === taskKey)?.notificationStatus, "pending",
      "Presence loss retains active Mission executors and the pending report")
      // Presence loss deliberately retains active work now. Explicitly reload
      // only this owned private daemon to exercise real executor teardown and
      // re-registration; never discover or reload the shared user service.
      await client.location.reload({ signal: AbortSignal.timeout(20_000) })
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
    gate(`durable report outbox recovery and one-message replay (plugin restart=${restart})`)
  }

  stage = "explicit targeted coordinator recovery"
  await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })
  const beforeRecovery = (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions[0]
  const recoveryRequest = { missionID: beforeRecovery.id, expectedRevision: beforeRecovery.revision, target: "coordinator" }
  const recovery = await client.rpc(CODENOMAD_MISSIONS_RPC).recover(recoveryRequest, { location })
  assert.equal(recovery.admitted, true)
  assert.equal(recovery.mission.revision, beforeRecovery.revision, "targeted recovery does not revise or redispatch work")
  await until(() => requests.some(request => request.session === coordinator.id
    && request.messages.includes(`Recover coordination of existing mission ${beforeRecovery.id}.`)))
  await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })
  const recoveredTurns = requests.filter(request => request.session === coordinator.id).length
  await client.rpc(CODENOMAD_MISSIONS_RPC).recover(recoveryRequest, { location })
  await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })
  assert.equal(requests.filter(request => request.session === coordinator.id).length, recoveredTurns,
    "an exact recovery retry never admits a second model turn")
  const recoveredMessages = await client.message.list({ sessionID: coordinator.id, limit: { order: "asc", limit: 100 } })
  assert.equal(recoveredMessages.data.filter(message => message.type === "synthetic"
    && message.metadata?.["codenomad.mission"]?.kind === "recovery").length, 1)
  gate("targeted coordinator recovery without plan changes or duplicate model turn")

  stage = "explicit targeted missing-report recovery"
  const missingReportTask = "targeted-report"
  await invoke("delegate", { ...task, taskKey: missingReportTask, targetSessionID: actorID })
  await client.session.wait({ sessionID: actorID }, { signal: AbortSignal.timeout(20_000) })
  const missingReportMap = (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions[0]
  const missingReportRequest = { missionID: missingReportMap.id, expectedRevision: missingReportMap.revision,
    target: "report", taskKey: missingReportTask }
  await client.rpc(CODENOMAD_MISSIONS_RPC).recover(missingReportRequest, { location })
  await until(() => requests.some(request => request.session === actorID
    && request.messages.includes(`Recover the missing report for task ${missingReportTask}`)))
  await client.session.wait({ sessionID: actorID }, { signal: AbortSignal.timeout(20_000) })
  const actorRecoveryTurns = requests.filter(request => request.session === actorID).length
  await client.rpc(CODENOMAD_MISSIONS_RPC).recover(missingReportRequest, { location })
  await client.session.wait({ sessionID: actorID }, { signal: AbortSignal.timeout(20_000) })
  assert.equal(requests.filter(request => request.session === actorID).length, actorRecoveryTurns)
  const preservedMap = (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions[0]
  assert.equal(preservedMap.revision, missingReportMap.revision)
  assert.deepEqual(preservedMap.tasks.find(candidate => candidate.key === missingReportTask),
    missingReportMap.tasks.find(candidate => candidate.key === missingReportTask), "recovery does not replay or complete the task")
  await invoke("report", { taskKey: missingReportTask, outcome: "completed", summary: "Existing result recovered" }, actorID)
  await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(20_000) })

  // Native lifecycle RPC is the same typed capability brokered by the authenticated UI routes.
  gate("targeted missing-report recovery without task replay or duplicate model turn")
  stage = "lifecycle CRUD and transcript preservation"
  const missionURL = `/api/workspaces/${workspace.id}/missions`
  const crudInput = { requestID: "native-crud-create", objective: "Keep this conversation", notes: "CRUD fixture", template: "custom" }
  const crudCreated = await client.rpc(CODENOMAD_MISSIONS_RPC).create(crudInput, { location })
  const crudReplay = await client.rpc(CODENOMAD_MISSIONS_RPC).create(crudInput, { location })
  assert.equal(crudReplay.mission.id, crudCreated.mission.id)
  assert.equal(crudReplay.mission.coordinatorSessionId, crudCreated.mission.coordinatorSessionId)
  await assert.rejects(client.rpc(CODENOMAD_MISSIONS_RPC).create({ ...crudInput, objective: "Different creation" }, { location }),
    error => error.type === "mission.rejected" && error.data?.code === "request-conflict",
    "Native creation rejects a changed contract with the exact declared request-conflict")
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
  const rejectedMutation = async (method, suffix, payload, status, code) => {
    const response = await bridge.inject({ method, url: missionURL + suffix, payload })
    // Keep every contract assertion and a red overall exit, but collect independent
    // structured-error failures so later storage/deletion/control checks still run.
    try {
      assert.equal(response.statusCode, status, `${method} ${suffix}: ${response.body}`)
      assert.equal(response.json().code, code)
    } catch (error) {
      failures.push({ stage, method, suffix, expected: { status, code }, actual: { status: response.statusCode, code: response.json().code },
        message: error.message })
      console.error(`FAIL ${method} ${suffix}: expected ${status}/${code}, got ${response.statusCode}/${response.json().code}`)
    }
  }
  await rejectedMutation("PATCH", `/${crudCreated.mission.id}`, {
    requestId: "stale-update", expectedRevision: 1, objective: "Stale edit",
  }, 409, "revision-conflict")
  await rejectedMutation("DELETE", `/${crudCreated.mission.id}`, {
    requestId: "stale-delete", expectedRevision: 1,
  }, 409, "revision-conflict")
   const beforeCreationConflict = await client.session.list({ location, limit: 32 })
   const conflictingCreation = { requestId: crudInput.requestID, objective: "Different creation", template: "custom" }
   // POST adds prepared:true and holds physical creation admission. The declared
   // RPC rejection above is not a successful native settlement receipt: after
   // dispatch this stricter boundary parks its permit rather than claiming denial.
   await rejectedMutation("POST", "", conflictingCreation, 409, "creation-uncertain")
   await rejectedMutation("POST", "", conflictingCreation, 409, "creation-uncertain")
   await rejectedMutation("POST", "", { ...conflictingCreation, objective: "Changed held contract" }, 409, "creation-conflict")
   assert.deepEqual(await client.session.list({ location, limit: 32 }), beforeCreationConflict,
     "Native conflict and parked HTTP retries never create another coordinator")
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
  gate("lifecycle CRUD replay, structured HTTP/RPC conflicts, tombstone and exact transcript preservation")

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
  let cleanupReceipt
  for (let replay = 0; replay < 2; replay++) {
    const response = await bridge.inject({ method: "DELETE", url: `${missionURL}/${cleanup.mission.id}`, payload: cleanupRequest })
    assert.equal(response.statusCode, 200, response.body)
    const result = response.json()
    assert.equal(result.deleted, true)
    assert.equal(result.cleanup.missionID, cleanup.mission.id)
    assert.equal(result.cleanup.requestID, cleanupRequest.requestId)
    assert.equal(result.cleanup.expectedRevision, cleanupRequest.expectedRevision)
    assert.equal(result.cleanup.deleteManagedSessions, true)
    assert.equal(result.cleanup.removed, 1)
    assert.equal(result.cleanup.pending, 0)
    assert.equal(result.cleanup.retained, 0, "Reused roots are excluded from immutable cleanup targets")
    if (cleanupReceipt) assert.deepEqual(result, cleanupReceipt, "Exact deletion replay retains the same cleanup receipt")
    cleanupReceipt = result
  }
  await assert.rejects(client.session.get({ sessionID: managedSession }), "Opt-in cleanup removes the managed specialist")
  assert.equal((await client.session.get({ sessionID: reusedSession.id })).id, reusedSession.id, "Cleanup preserves reused conversations")
  assert.equal((await client.session.get({ sessionID: cleanupCoordinator })).id, cleanupCoordinator, "Cleanup preserves the coordinator")
  await rejectedMutation("DELETE", `/${cleanup.mission.id}`, { ...cleanupRequest, deleteManagedSessions: false }, 409, "request-conflict")
  gate("opt-in managed specialist deletion preserves coordinator and reused session")

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
  gate("prepared Play, root Pause/Resume, parked report notification and irreversible Stop")

  stage = "native outcome and queued idle boundary"
  const { resolveHydratedGenerationRecovery, reconcileFetchedSessionRuntime } = await tsImport(
    "../packages/ui/src/stores/session-generation-recovery.ts", import.meta.url)
  const outcomeSession = await client.session.create({ location, title: "Private outcome boundary" })
  await client.session.prompt({ sessionID: outcomeSession.id, text: "Finish normally before detachment" })
  await client.session.wait({ sessionID: outcomeSession.id }, { signal: AbortSignal.timeout(20_000) })
  const previousOutcome = await client.session.get({ sessionID: outcomeSession.id })
  assert.equal(previousOutcome.outcome, "succeeded")
  assert.equal(resolveHydratedGenerationRecovery("working", "idle", true, previousOutcome.outcome), null,
    "product recovery never invents Interrupted for real normal completion")
  const parkedOutcome = await client.session.synthetic({ sessionID: outcomeSession.id, text: "Already admitted work, not yet executed",
    delivery: "queue", resume: false })
  const queuedOutcome = await client.session.get({ sessionID: outcomeSession.id })
  const pendingOutcome = { ...previousOutcome, status: "idle", runtimeStatusKnown: true, generationRecovery: "pending", generationAdmissionEpoch: 1 }
  assert.ok((await client.session.inbox.list({ sessionID: outcomeSession.id })).some(item => item.id === parkedOutcome.id))
  assert.equal(reconcileFetchedSessionRuntime(queuedOutcome, pendingOutcome, await client.session.active()).generationRecovery, "pending",
    "a historical success cannot resolve admitted-but-unexecuted work")
  await client.session.synthetic({ sessionID: outcomeSession.id, text: "Explicitly resume the existing private inbox", resume: true })
  await client.session.wait({ sessionID: outcomeSession.id }, { signal: AbortSignal.timeout(20_000) })
  const completedOutcome = await client.session.get({ sessionID: outcomeSession.id })
  assert.ok(completedOutcome.time.idle > previousOutcome.time.idle, "real queued execution publishes a newer idle boundary")
  assert.equal(reconcileFetchedSessionRuntime(completedOutcome, pendingOutcome, await client.session.active()).generationRecovery, null)
  gate("normal native outcome and distinct queued-but-unexecuted idle boundary")

  stage = "presence restart and durable replay"
  const beforeRestart = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })
  await plugin.stop()
  assert.deepEqual((await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions, beforeRestart.missions,
    "Presence loss alone retains active Mission executors without changing the journal")
  await client.location.reload({ signal: AbortSignal.timeout(20_000) })
  await until(async () => { try { await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location }); return false } catch { return true } })
  plugin = new DesktopPluginLifecycle("missions")
  await plugin.start(paths)
  await until(async () => { try { return Boolean(await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })) } catch { return false } })
  assert.equal((await invoke("delegate", task)).disposition, "existing")
  const afterRestart = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })
  assert.deepEqual(afterRestart.missions, beforeRestart.missions)
  assert.equal((await client.server.info()).pid, info.pid)
  receipt.finalSnapshot = afterRestart; receipt.providerRequests = requests.length
  gate("presence retention, explicit private reload/re-registration, durable journal and idempotent root admission on the same daemon")
  stage = "managed root busy reuse retains its original creation ownership"
  const managedReuse = await invoke("delegate", { ...task, taskKey: "managed-reuse-source" })
  const managedReuseSession = managedReuse.mission.tasks.find(value => value.key === "managed-reuse-source").actorSessionId
  const managedReuseActor = await client.session.get({ sessionID: managedReuseSession })
  assert.equal(managedReuseActor.parentID, undefined)
  assert.equal(managedReuseActor.agent, task.execution.agent)
  assert.deepEqual(managedReuseActor.model, task.execution.model)
  await client.session.wait({ sessionID: managedReuseSession }, { signal: AbortSignal.timeout(20_000) })
  await probe(managedReuseSession, "changed")
  hold = true
  await client.session.prompt({ sessionID: managedReuseSession, text: "Busy managed actor before reused assignment" })
  await until(() => Boolean(held))
  const beforeManagedReuse = await client.session.list({ location, limit: 32 })
  variables = { MISSION_FIXTURE: "managed-reuse-fresh" }
  const reusedManagedInput = { ...task, taskKey: "managed-reuse-queued", targetSessionID: managedReuseSession,
    executionMode: { kind: "independent", reason: "existing-root", explanation: "Reuse the same managed actor's durable native context without creating another root or changing its profile." } }
  const reusedManaged = await invoke("delegate", reusedManagedInput)
  assert.equal(reusedManaged.mission.tasks.find(value => value.key === reusedManagedInput.taskKey).actorSessionId, managedReuseSession)
  assert.equal(reusedManaged.mission.actors.find(value => value.sessionId === managedReuseSession).managed, true,
    "Reuse retains the original immutable managed cleanup provenance")
  assert.deepEqual((await client.session.list({ location, limit: 32 })).data.map(value => value.id).sort(),
    beforeManagedReuse.data.map(value => value.id).sort(), "Explicit managed reuse never creates another root")
  const managedInbox = await client.session.inbox.list({ sessionID: managedReuseSession })
  assert(managedInbox.some(item => item.id === reusedManaged.mission.tasks.find(value => value.key === reusedManagedInput.taskKey).admissionId),
    "Busy managed root retains the second durable assignment without a new creation identity")
  held(); held = undefined
  await client.session.wait({ sessionID: managedReuseSession }, { signal: AbortSignal.timeout(20_000) })
  assert.deepEqual((await client.session.get({ sessionID: managedReuseSession })).model, managedReuseActor.model)
  await probe(managedReuseSession, "managed-reuse-fresh")
  gate("managed root creation, environment and busy reuse preserve original ownership and durable queue")
  assert.equal(failures.length, 0, "Every baseline expectation must pass; collected errors are never skipped or accepted")
  receipt.status = "passed"; receipt.passCount = gates.length
  receipt.finalSnapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location }); receipt.providerRequests = requests.length
  console.log(`PASS ${version}: native catalog, selection, busy queue, conflict, environment, idle/busy coordinator resumption, report outbox recovery with/without restart, explicit targeted coordinator/report recovery without replay, native outcome/queued idle boundary, revise/late report, lifecycle create/update/delete idempotence, Play/Pause/Resume/terminal Stop, optional managed specialist cleanup, structured HTTP/RPC mutation errors and transcript preservation, presence restart; ${root}`)
} catch (error) {
  if (!failedGates.includes(stage)) failedGates.push(stage)
  receipt.status = "failed"; receipt.failure = { stage, message: error.message, stack: error.stack }
  console.error(`Fixture failed during ${stage} at ${root}: ${output.slice(-8000)}`)
  throw error
} finally {
  held?.()
  await Promise.allSettled(diagnosticReads)
  await removeBridge?.()
  await plugin?.stop()
  await bridge.close()
  await manager?.shutdown()
  child?.kill()
  if (stopped) await stopped
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  receipt.cleanup = { ownedServeExited: child ? child.exitCode !== null || child.signalCode !== null : false,
    exitCode: child?.exitCode, signalCode: child?.signalCode }
  receipt.passCount = gates.length; receipt.failedGateCount = failedGates.length
  await writeFile(path.join(root, "runtime.log"), output)
  await writeFile(path.join(root, "provider-requests.json"), JSON.stringify(requests, null, 2))
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2))
  console.log(`RECEIPT ${path.join(root, "receipt.json")}`)
  dependencyHook?.deregister()
}
