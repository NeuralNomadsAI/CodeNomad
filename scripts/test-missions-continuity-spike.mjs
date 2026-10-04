// Private native V2 capability spike. No desktop, shared-service discovery, or product edits.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import pino from "pino"

const allowedCLI = "C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe"
const cli = process.argv[2] ?? allowedCLI
assert.equal(path.resolve(cli).toLowerCase(), path.resolve(allowedCLI).toLowerCase(), "Use only the assigned absolute CLI as a private serve child")
const root = await mkdtemp(path.join(os.tmpdir(), "opencode", "missions-continuity-"))
const project = path.join(root, "project")
const config = path.join(root, "config")
for (const directory of [project, config]) await mkdir(directory)
// The runner's imports provision presence only after all host identities are private.
for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)) delete process.env[key]
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
Object.assign(process.env, {
  HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root, LOCALAPPDATA: root, APPDATA: root,
  XDG_RUNTIME_DIR: root, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_SERVER_PASSWORD: "private-continuity", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
})
delete process.env.WSL_DISTRO_NAME
await writeFile(path.join(config, "opencode.json"), "{}\n")
const { DesktopPluginLifecycle } = await tsImport("../packages/server/src/opencode/desktop-plugin-lifecycle.ts", import.meta.url)
const { resolveDesktopPluginPaths } = await tsImport("../packages/server/src/opencode/desktop-plugin-paths.ts", import.meta.url)
const { WorkspaceManager } = await tsImport("../packages/server/src/workspaces/manager.ts", import.meta.url)
const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
const { createAutomationBridgeRegistration, publishAutomationBridge } = await tsImport("../packages/server/src/opencode/automation-plugin.ts", import.meta.url)
const { registerAutomationPluginRoute } = await tsImport("../packages/server/src/server/routes/automation-plugin.ts", import.meta.url)
const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
const { projectMissionActivity } = await tsImport("../packages/server/src/missions/activity.ts", import.meta.url)
const { assertNativeMissionRecoveryReady } = await tsImport("../packages/server/src/missions/native-recovery-observation.ts", import.meta.url)
const requests = [], events = [], results = {}, sessions = new Map(), plans = new Map(), releases = new Map(), childPlans = new Map()
let child, stopped, presence, client, manager, removeBridge, watchdog, output = "", stage = "setup", failure
const bridge = Fastify()
const runDeadline = Date.now() + 180_000
const subscription = new AbortController()
const rpcDefinition = { id: "continuity.spike", methods: { control: { input: { type: "object" }, output: { type: "object" } } }, events: {} }
const pluginDirectory = path.join(root, "spike-plugin")
await mkdir(pluginDirectory)
await writeFile(path.join(pluginDirectory, "index.ts"), `
export default { id: 'continuity.spike', async setup(ctx) {
  let disposable, contextRegistration;
  const captured = new Map();
  await ctx.session.hook('http.request', event => {
    event.request.headers.set('x-spike-kind', event.kind);
    event.request.headers.set('x-spike-session', event.sessionID);
  });
  await ctx.session.hook('retry', event => { event.decision = { retry: false }; });
  await ctx.session.hook('context', async event => {
    const contract = await ctx.storage.get('contract/' + event.sessionID);
    if (contract) event.system.push({ type: 'text', text: 'SPIKE_CONTRACT:' + JSON.stringify(contract) });
  });
  await ctx.tool.transform(editor => {
    editor.namespace({ name: 'spike', description: 'Private capability fixture' });
    editor.add({ name: 'report', description: 'Persist and notify the authorized private coordinator',
      input: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
      options: { namespace: 'spike', codemode: false }, execute: async (input, tool) => {
        const contract = await ctx.storage.get('contract/' + tool.sessionID);
        if (!contract) throw new Error('No private contract for caller');
        const report = { ...contract, sessionID: tool.sessionID, callID: tool.id, summary: input.summary };
        await ctx.storage.set('report/' + contract.taskKey, report);
        await ctx.session.synthetic({ sessionID: contract.coordinatorID, id: contract.reportID,
          text: 'SPIKE_REPORT:' + input.summary, resume: true, delivery: 'queue', metadata: { 'spike.contract': report } });
        return { content: 'SPIKE_REPORT_SAVED' };
      } });
  });
  // Preserve the real native executor and permission options. Bind from structured
  // progress before child prompt admission, never from the human-readable result.
  await ctx.tool.transform(editor => editor.update('subagent', definition => {
    const native = definition.execute;
    definition.execute = async (input, tool) => {
      const invocation = await ctx.storage.get('invocation/' + tool.id);
      return native(input, { ...tool, progress: async update => {
        if (invocation && typeof update.sessionID === 'string') {
          const child = await ctx.session.get({ sessionID: update.sessionID });
          if (child.parentID !== tool.sessionID || invocation.coordinatorID !== tool.sessionID) throw new Error('Native parent mismatch');
          const binding = { ...invocation, childID: child.id, parentID: tool.sessionID, callID: tool.id };
          await ctx.storage.set('binding/' + tool.id, binding);
          await ctx.storage.set('contract/' + child.id, binding);
        }
        await tool.progress(update);
      } });
    };
  }));
  await ctx.rpc.register(${JSON.stringify(rpcDefinition)}, { control: async input => {
    if (input.action === 'catalog') return JSON.parse(JSON.stringify({ tools: (await ctx.tool.list()).map(t => ({ id: t.id, input: t.input, options: t.options })),
      sessionMethods: Object.keys(ctx.session), agentMethods: Object.keys(ctx.agent) }));
    if (input.action === 'contract') { await ctx.storage.set('contract/' + input.sessionID, input.contract); return { saved: true }; }
    if (input.action === 'invocation') { await ctx.storage.set('invocation/' + input.callID, input.contract); return { saved: true }; }
    if (input.action === 'read') return { value: await ctx.storage.get(input.key) ?? null };
    if (input.action === 'register') {
      contextRegistration = await ctx.session.hook('context', event => { event.system.push({ type: 'text', text: 'DISPOSABLE_CONTEXT' }); });
      disposable = await ctx.tool.transform(editor => {
        editor.namespace({ name: 'spike', description: 'Private capability fixture' });
        editor.add({ name: 'captured', description: 'Test a captured executor after disposal', input: { type: 'object', properties: {} },
          options: { namespace: 'spike', codemode: false }, execute: async () => ({ content: 'CAPTURED_EXECUTOR_FINISHED' }) });
      });
      return { registered: true };
    }
    if (input.action === 'dispose') { await disposable.dispose(); await contextRegistration.dispose(); return { disposed: true }; }
    if (input.action === 'capture') {
      captured.set(input.key, (await ctx.tool.list()).find(t => t.id === input.tool)); return { captured: Boolean(captured.get(input.key)) };
    }
    if (input.action === 'invoke') {
      const tool = captured.get(input.key) ?? (await ctx.tool.list()).find(t => t.id === input.tool);
      if (!tool) throw new Error('Tool unavailable');
      try { const result = await tool.execute(input.input ?? {}, { sessionID: input.sessionID, messageID: 'msg_spike', id: 'call_spike', progress: async () => {}, signal: new AbortController().signal });
        return { result }; } catch (error) { return { error: String(error) }; }
    }
    throw new Error('Unknown private fixture action');
  } });
} }
`)

function emit(response, value) {
  response.setHeader("content-type", "text/event-stream")
  const delta = typeof value === "string" ? { role: "assistant", content: value } : { role: "assistant", tool_calls: [{ index: 0, id: value.id,
    type: "function", function: { name: value.tool, arguments: JSON.stringify(value.input) } }] }
  for (const [data, finish_reason] of [[delta, null], [{}, typeof value === "string" ? "stop" : "tool_calls"]]) {
    response.write(`data: ${JSON.stringify({ id: "spike", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: data, finish_reason }] })}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const sessionID = request.headers["x-spike-session"]
    const kind = request.headers["x-spike-kind"]
    const record = { index: requests.length, sessionID, kind, body, time: Date.now() }
    requests.push(record)
    assert(requests.length <= 160, 'Bounded deterministic provider request budget');
    if (kind === "primary") {
      if (!plans.has(sessionID)) {
        const text = JSON.stringify(body.messages)
        for (const [marker, steps] of childPlans) if (text.includes(marker)) { plans.set(sessionID, steps); childPlans.delete(marker); break }
      }
      const queue = plans.get(sessionID)
      const step = queue?.shift()
      if (step?.hold) await new Promise(resolve => { releases.set(step.hold, resolve); response.once("close", resolve) })
      if (response.destroyed) return
      if (step?.httpStatus) {
        response.writeHead(step.httpStatus, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_FAILURE", type: "invalid_request_error" } }))
        return
      }
      const answer = step?.answer ?? `NATIVE_DONE:${sessionID}`
      if (typeof answer !== "string") assert(body.tools.some(tool => tool.function.name === answer.tool), `Requested tool absent: ${answer.tool}`)
      emit(response, answer)
    } else if (body.stream) emit(response, "Private title")
    else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "spike", choices: [{ message: { role: "assistant", content: "Private title" }, finish_reason: "stop" }] })) }
  } catch (error) { failure = error; response.destroy() }
})
async function until(predicate, label = stage) {
  const deadline = Math.min(Date.now() + 30_000, runDeadline)
  while (Date.now() < deadline) {
    if (failure) throw failure
    if (await predicate()) return
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Private serve exited: ${output.slice(-3000)}`)
    await delay(50)
  }
  throw new Error(`Timeout: ${label}`)
}
const primary = id => requests.filter(r => r.sessionID === id && r.kind === "primary")
const release = name => { assert(releases.has(name), `Missing hold ${name}`); releases.get(name)(); releases.delete(name) }
const control = input => client.rpc(rpcDefinition).control(input, { location: { directory: project }, signal: AbortSignal.timeout(10_000) })
const wait = sessionID => client.session.wait({ sessionID }, { signal: AbortSignal.timeout(20_000) })
const messages = async sessionID => (await client.message.list({ sessionID, limit: { order: "asc", limit: 100 } })).data
const create = async (name, options = {}) => {
  const session = await client.session.create({ location: { directory: project }, title: name, ...options })
  sessions.set(name, session.id)
  return session.id
}
const toolCall = (tool, input, id) => ({ tool, input, id })
const toolParts = messages => messages.flatMap(message => message.content ?? []).filter(part => part.type === "tool")
const childOf = async parentID => {
  await until(() => events.some(e => e.type === "session.created" && e.data.parentID === parentID))
  return events.find(e => e.type === "session.created" && e.data.parentID === parentID).data.sessionID
}
const childInput = (description, prompt, extra = {}) => ({ agent: "spike_child", description, prompt, ...extra })
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    model: "fixture/fixture", update: "disable", snapshots: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "execute", resource: "*", effect: "deny" }],
    agents: { spike_child: { mode: "subagent", description: "Private deterministic child", system: "Private child only", model: "fixture/child" },
      spike_primary: { mode: "primary", description: "Private primary-only agent" } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "private" }, models: { fixture: {}, child: {} } } },
    plugins: [pluginDirectory],
  })
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: process.env, windowsHide: true })
  watchdog = setTimeout(() => {
    failure = new Error(`Private fixture exceeded total deadline during ${stage}`)
    child.kill()
    provider.closeAllConnections()
  }, Math.max(1, runDeadline - Date.now()))
  watchdog.unref()
  stopped = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { failure = error })
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
  client = OpenCode.make({ baseUrl: url, headers: { authorization } })
  results.server = await client.server.info()
  assert.equal(results.server.version, "2.0.21", "This spike qualifies exactly 2.0.21")
  // Discovery here is injected to return ONLY this freshly spawned private endpoint.
  const endpoint = { url, auth: { type: "basic", username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD } }
  rememberRuntime(endpoint, { version: results.server.version, pid: results.server.pid, discovery: "info" })
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(),
    settings: { getOwner: () => ({ environmentVariables: { CONTINUITY_FIXTURE: "private" } }),
      readEnvironmentForAdmission: async () => ({ CONTINUITY_FIXTURE: "private" }) },
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Private continuity serve" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }),
  })
  await manager.create(project)
  const registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
  registerAutomationPluginRoute(bridge, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence(),
    authManager: { isLoopbackRequest: () => true }, bridgeToken: registration.token, nativeParent: {}, developerCdp: {} })
  await bridge.listen({ host: "127.0.0.1", port: 0 })
  registration.url = `http://127.0.0.1:${bridge.server.address().port}/api/opencode-plugin/automation`
  removeBridge = await publishAutomationBridge(registration)
  const openapi = await (await fetch(`${url}/openapi.json`, { headers: { authorization }, signal: AbortSignal.timeout(10_000) })).json()
  await writeFile(path.join(root, "openapi.json"), JSON.stringify(openapi, null, 2))
  void (async () => { try { for await (const event of client.event.subscribe({ signal: subscription.signal })) events.push(event) } catch (error) { if (!subscription.signal.aborted) failure = error } })()
  const location = { directory: project }
  await client.agent.list({ location })
  results.agents = await client.agent.list({ location })
  results.catalog = await control({ action: "catalog" })
  assert(results.catalog.tools.some(t => t.id === "subagent"))
  await writeFile(path.join(root, "catalog.json"), JSON.stringify(results.catalog, null, 2))
  const createSchema = openapi.paths["/api/session"].post.requestBody.content["application/json"].schema
  results.createSchema = createSchema
  assert(createSchema.properties)
  assert.equal(createSchema.additionalProperties, false)
  assert(!Object.hasOwn(createSchema.properties, "parentID"), "Public create has no child-parent field")
  assert(!results.catalog.agentMethods.includes("create"), "Agent catalog/transform is not an agent creation API")

  stage = "actual Missions presence loss and captured snapshots"
  const paths = await resolveDesktopPluginPaths({ client, assertCurrent() {} }, { kind: "host", platform: process.platform, binary: cli })
  assert.equal(paths.config, config)
  presence = new DesktopPluginLifecycle("missions")
  await presence.start(paths)
  await until(async () => (await control({ action: "catalog" })).tools.some(t => t.id === "mission_inspect"))
  const coordinator = await create("coordinator")
  const inspected = await control({ action: "invoke", tool: "mission_inspect", sessionID: coordinator, input: { start: { objective: "Private continuity", template: "custom" } } })
  assert(!inspected.error, JSON.stringify(inspected))
  const missionProbe = await create("missionProbe")
  plans.set(missionProbe, [{ hold: "mission-probe", answer: toolCall("mission_inspect", {}, "captured_mission_call") }])
  await client.session.prompt({ sessionID: missionProbe, text: "Call captured Mission tool after detach" })
  await until(() => releases.has("mission-probe"))
  await client.session.prompt({ sessionID: coordinator, text: "Observe initial Mission context" })
  await wait(coordinator)
  assert(JSON.stringify(primary(coordinator)[0].body.messages).includes("Private continuity"))
  await control({ action: "capture", tool: "mission_inspect", key: "mission" })
  await control({ action: "capture", tool: "mission_report", key: "mission-report" })
  await control({ action: "register" })
  const snapshot = await create("snapshot")
  plans.set(snapshot, [{ hold: "snapshot", answer: toolCall("spike_captured", {}, "snapshot_call") }])
  await client.session.prompt({ sessionID: snapshot, text: "Test disposal of captured executor" })
  await until(() => releases.has("snapshot"))
  childPlans.set("ROOT_MISSION_BEFORE_DETACH", [{ hold: "root-model", answer: toolCall("spike_report", { summary: "ROOT_REPORT_AFTER_DETACH" }, "root_report") }])
  const delegated = await control({ action: "invoke", tool: "mission_delegate", sessionID: coordinator,
    input: { taskKey: "root-work", title: "Private root continuation", brief: "ROOT_MISSION_BEFORE_DETACH", role: "prototype" } })
  assert(!delegated.error, JSON.stringify(delegated))
  const admittedMission = JSON.parse(delegated.result.content).mission
  const rootTask = admittedMission.tasks.find(task => task.key === "root-work")
  const rootActor = rootTask.actorSessionId
  sessions.set("rootActor", rootActor)
  await until(() => releases.has("root-model"))
  const reportID = `msg_${"a".repeat(24)}`
  const contract = { taskKey: "root-work", coordinatorID: coordinator, reportID, execution: "root" }
  await control({ action: "contract", sessionID: rootActor, contract })
  results.bridgeAdmission = { missionID: admittedMission.id, actorSessionID: rootActor, admissionID: rootTask.admissionId,
    consumedRequest: primary(rootActor)[0].index }
  // Lose the actual authenticated bridge, not merely a stub capability flag.
  await removeBridge(); removeBridge = undefined
  await bridge.close()
  await presence.stop()
  await until(async () => !(await control({ action: "catalog" })).tools.some(t => t.id === "mission_inspect"))
  await control({ action: "dispose" })
  results.capturedMissionAfterDetach = await control({ action: "invoke", key: "mission", sessionID: coordinator })
  assert.match(results.capturedMissionAfterDetach.error, /no longer available/)
  results.capturedReportAfterDetach = await control({ action: "invoke", key: "mission-report", sessionID: rootActor,
    input: { taskKey: "root-work", outcome: "completed", summary: "Cannot use disposed current Mission executor" } })
  assert.match(results.capturedReportAfterDetach.error, /no longer available/)
  release("snapshot")
  release("root-model")
  release("mission-probe")
  await Promise.all([wait(snapshot), wait(rootActor), wait(missionProbe)])
  await until(() => primary(coordinator).some(r => JSON.stringify(r.body.messages).includes("ROOT_REPORT_AFTER_DETACH")))
  await wait(coordinator)
  results.root = { session: await client.session.get({ sessionID: rootActor }), report: await control({ action: "read", key: "report/root-work" }) }
  assert.equal(results.root.session.parentID, undefined)
  assert.equal(results.root.session.outcome, "succeeded")
  assert.equal(results.root.report.value.summary, "ROOT_REPORT_AFTER_DETACH")
  const reportMessages = (await messages(coordinator)).filter(m => m.type === "synthetic" && m.metadata?.["spike.contract"]?.taskKey === "root-work")
  assert.equal(reportMessages.length, 1)
  assert.equal(reportMessages[0].id, reportID)
  assert(!JSON.stringify(primary(coordinator).at(-1).body.messages).includes("Private continuity"), "Mission hook is absent after detach")
  results.missionProbe = toolParts(await messages(missionProbe))
  assert.equal(results.missionProbe[0].state.status, "error")
  const snapshotRequests = primary(snapshot)
  assert(snapshotRequests[0].body.tools.some(t => t.function.name === "spike_captured"))
  assert(JSON.stringify(snapshotRequests[0].body.messages).includes("DISPOSABLE_CONTEXT"))
  assert(snapshotRequests.length >= 2)
  assert(!snapshotRequests[1].body.tools.some(t => t.function.name === "spike_captured"))
  assert(!snapshotRequests[1].body.tools.some(t => t.function.name === "mission_inspect"))
  assert(!JSON.stringify(snapshotRequests[1].body.messages).includes("DISPOSABLE_CONTEXT"))
  assert(JSON.stringify(snapshotRequests[1].body.messages).includes("CAPTURED_EXECUTOR_FINISHED"))
  results.snapshots = { before: snapshotRequests[0].index, after: snapshotRequests[1].index }

  stage = "native subagent foreground"
  const parent = await create("foregroundParent")
  await control({ action: "invocation", callID: "fg_call", contract: { taskKey: "fg-work", coordinatorID: parent, execution: "native-child" } })
  childPlans.set("FOREGROUND_CHILD", [{ answer: toolCall("spike_report", { summary: "FOREGROUND_CHILD_REPORT" }, "fg_report_call") }])
  plans.set(parent, [{ answer: toolCall("subagent", { agent: "spike_child", description: "Private foreground child", prompt: "FOREGROUND_CHILD" }, "fg_call") }])
  await client.session.prompt({ sessionID: parent, text: "Run a real native foreground subagent" })
  await wait(parent)
  const fgChild = await childOf(parent)
  const fgParts = toolParts(await messages(parent))
  assert.equal(fgParts[0].state.metadata.sessionID, fgChild)
  assert.equal(fgParts[0].state.status, "completed")
  assert.equal((await client.session.get({ sessionID: fgChild })).parentID, parent)
  assert.equal(primary(fgChild)[0].body.model, "child")
  assert(primary(fgChild)[0].body.messages.some(m => typeof m.content === "string" && m.content.includes('"taskKey":"fg-work"')), "Contract bound before first child model request")
  assert(primary(parent).some(r => JSON.stringify(r.body.messages).includes(`NATIVE_DONE:${fgChild}`)))
  results.foreground = { child: await client.session.get({ sessionID: fgChild }), messages: await messages(parent), binding: await control({ action: "read", key: "binding/fg_call" }) }
  results.foreground.report = await control({ action: "read", key: "report/fg-work" })
  assert.equal(results.foreground.report.value.sessionID, fgChild)
  assert(primary(parent).some(r => JSON.stringify(r.body.messages).includes("FOREGROUND_CHILD_REPORT")), "Parent really consumed child's structured report")
  // Continue the exact child, with no second child creation.
  plans.set(parent, [{ answer: toolCall("subagent", childInput("Continue private child", "CONTINUED_CHILD", { sessionID: fgChild }), "continue_call") }])
  await client.session.prompt({ sessionID: parent, text: "Continue existing native child" })
  await wait(parent)
  assert.equal(toolParts(await messages(parent)).find(p => p.id === "continue_call").state.metadata.sessionID, fgChild)
  assert.equal(events.filter(e => e.type === "session.created" && e.data.parentID === parent).length, 1)
  assert(primary(fgChild).some(r => JSON.stringify(r.body.messages).includes("CONTINUED_CHILD")))
  results.continuation = { childID: fgChild, requests: primary(fgChild).map(r => r.index) }
  const otherParent = await create("foreignContinuation")
  const childRequestsBefore = primary(fgChild).length
  plans.set(otherParent, [{ answer: toolCall("subagent", childInput("Foreign child continuation", "FOREIGN_CONTINUE", { sessionID: fgChild }), "foreign_continue_call") }])
  await client.session.prompt({ sessionID: otherParent, text: "Attempt continuation from another root" })
  await wait(otherParent)
  results.foreignContinuation = { tools: toolParts(await messages(otherParent)), childRequestsDelta: primary(fgChild).length - childRequestsBefore }
  assert.equal(results.foreignContinuation.tools[0].state.status, "error")
  assert.equal(results.foreignContinuation.childRequestsDelta, 0)

  stage = "native subagent background"
  const bgParent = await create("backgroundParent")
  await control({ action: "invocation", callID: "bg_call", contract: { taskKey: "bg-work", coordinatorID: bgParent, execution: "native-child" } })
  childPlans.set("BACKGROUND_CHILD", [{ hold: "bg-child", answer: toolCall("spike_report", { summary: "BACKGROUND_CHILD_REPORT" }, "bg_report_call") }, { answer: "BACKGROUND_CHILD_FINISHED" }])
  plans.set(bgParent, [{ answer: toolCall("subagent", { agent: "spike_child", description: "Private background child", prompt: "BACKGROUND_CHILD", background: true }, "bg_call") }])
  await client.session.prompt({ sessionID: bgParent, text: "Run a real native background subagent" })
  const bgChild = await childOf(bgParent)
  await until(() => releases.has("bg-child"))
  await wait(bgParent)
  results.backgroundWhileWaiting = { active: await client.session.active(), parent: await client.session.get({ sessionID: bgParent }), child: await client.session.get({ sessionID: bgChild }) }
  assert(!results.backgroundWhileWaiting.active[bgParent])
  assert(results.backgroundWhileWaiting.active[bgChild])
  const nativeRoot = results.backgroundWhileWaiting.parent
  results.productNativeFamilyObservation = {
    children: await client.session.list({ parentID: bgParent, limit: 33 }),
    shells: await client.shell.list({ location: nativeRoot.location }),
    forms: await client.form.list({ location: nativeRoot.location }),
    permissions: await client.permission.request.list({ location: nativeRoot.location }),
    inbox: await client.session.inbox.list({ sessionID: bgParent }),
  }
  const projection = await projectMissionActivity({ client, workspaceID: "private-fixture", ownsLocation: async (_id, candidate) => candidate.directory === project,
    snapshot: { version: 1, projectID: nativeRoot.projectID, generatedAt: Date.now(), discardedEvents: 0, missions: [{
      id: "private-projection", actors: [{ sessionId: bgParent, location: nativeRoot.location }], tasks: [],
    }] } })
  results.productNativeFamilyProjection = projection
  assert.equal(projection.missions[0].actors[0].state, "background", "product sidecar observes a real active native child below an idle root")
  await assert.rejects(assertNativeMissionRecoveryReady(client, nativeRoot, AbortSignal.timeout(10_000)),
    error => error?.code === "recovery-busy", "product recovery never nudges an idle parent with an active native descendant")
  assert.equal(toolParts(await messages(bgParent))[0].state.metadata.status, "running")
  release("bg-child")
  await wait(bgChild)
  await until(() => primary(bgParent).length >= 3)
  await wait(bgParent)
  results.background = { child: await client.session.get({ sessionID: bgChild }), parent: await client.session.get({ sessionID: bgParent }), messages: await messages(bgParent) }
  assert(results.background.messages.some(m => m.type === "synthetic" && m.metadata?.source === "subagent" && m.metadata.childID === bgChild && m.metadata.state === "completed"))
  assert(primary(bgParent).some(r => JSON.stringify(r.body.messages).includes("BACKGROUND_CHILD_FINISHED")))
  results.background.report = await control({ action: "read", key: "report/bg-work" })
  assert.equal(results.background.report.value.sessionID, bgChild)
  assert(primary(bgParent).some(r => JSON.stringify(r.body.messages).includes("BACKGROUND_CHILD_REPORT")))

  stage = "native shell background finish without desktop"
  const shellParent = await create("backgroundShell")
  const shellOutput = path.join(project, "background-finished.json")
  const command = `node -e "setTimeout(()=>{require('fs').writeFileSync('${shellOutput.replaceAll("\\", "/")}', JSON.stringify({done:true}));console.log('SHELL_FINISHED_WITHOUT_DESKTOP')}, 1500)"`
  plans.set(shellParent, [{ answer: toolCall("shell", { command, background: true }, "shell_bg_call") }])
  await client.session.prompt({ sessionID: shellParent, text: "Run the native background shell" })
  await until(() => primary(shellParent).some(r => r.body.messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.includes("SHELL_FINISHED_WITHOUT_DESKTOP"))))
  await wait(shellParent)
  assert.equal(JSON.parse(await readFile(shellOutput, "utf8")).done, true)
  results.shellBackground = { messages: await messages(shellParent), requests: primary(shellParent).map(r => r.index) }

  stage = "permissions and invalid agent"
  const denied = await create("deniedParent", { permissions: [{ action: "subagent", resource: "spike_child", effect: "deny" }] })
  plans.set(denied, [{ answer: toolCall("subagent", childInput("Denied child", "MUST_NOT_RUN"), "denied_call") }])
  await client.session.prompt({ sessionID: denied, text: "Attempt explicitly denied subagent" })
  await wait(denied)
  results.denied = toolParts(await messages(denied))
  assert.equal(results.denied[0].state.status, "error")
  assert(!events.some(e => e.type === "session.created" && e.data.parentID === denied))
  const invalid = await create("invalidAgentParent")
  plans.set(invalid, [{ answer: toolCall("subagent", { agent: "spike_primary", description: "Invalid primary launch", prompt: "MUST_NOT_RUN" }, "invalid_call") }])
  await client.session.prompt({ sessionID: invalid, text: "Attempt primary-only agent as child" })
  await wait(invalid)
  results.invalidAgent = toolParts(await messages(invalid))
  assert.equal(results.invalidAgent[0].state.status, "error")
  assert(!events.some(e => e.type === "session.created" && e.data.parentID === invalid))
  const permissionsParent = await create("inheritedPermissions", { permissions: [{ action: "shell", resource: "*", effect: "deny" }] })
  childPlans.set("PERMISSION_CHILD", [{ answer: "CHILD_WITHOUT_SHELL_CAPABILITY" }])
  plans.set(permissionsParent, [{ answer: toolCall("subagent", childInput("Inherited permissions", "PERMISSION_CHILD"), "permissions_call") }])
  await client.session.prompt({ sessionID: permissionsParent, text: "Child inherits parent session rules" })
  await wait(permissionsParent)
  const permissionChild = await childOf(permissionsParent)
  results.inheritedPermissions = { child: await client.session.get({ sessionID: permissionChild }),
    created: events.find(e => e.type === "session.created" && e.data.sessionID === permissionChild),
    tools: primary(permissionChild)[0].body.tools.map(t => t.function.name) }
  assert(!results.inheritedPermissions.tools.includes("shell"), "Inherited deny removes shell from child's model tools")

  // Measure cancellation, without assuming recursive semantics. Provider holds
  // make parent/child execution overlap deterministic and independent of timers.
  for (const background of [false, true]) {
    stage = `parent interrupt (background=${background})`
    const cancelParent = await create(background ? "bgInterruptParent" : "fgInterruptParent")
    const marker = background ? "BG_CANCEL_CHILD" : "FG_CANCEL_CHILD"
    const hold = background ? "bg-cancel-child" : "fg-cancel-child"
    childPlans.set(marker, [{ hold, answer: `${marker}_FINISHED` }])
    plans.set(cancelParent, [{ answer: toolCall("subagent", childInput("Cancellation semantics", marker, { background }), `${marker}_call`) },
      ...(background ? [{ hold: "bg-cancel-parent", answer: "PARENT_AFTER_INTERRUPT" }] : [])])
    await client.session.prompt({ sessionID: cancelParent, text: "Measure explicit parent interrupt" })
    const cancelChild = await childOf(cancelParent)
    await until(() => releases.has(hold) && (!background || releases.has("bg-cancel-parent")))
    await client.session.interrupt({ sessionID: cancelParent, continue: false })
    await wait(cancelParent)
    await delay(100)
    const childActive = Boolean((await client.session.active())[cancelChild])
    const afterInterrupt = { parent: await client.session.get({ sessionID: cancelParent }), child: await client.session.get({ sessionID: cancelChild }), childActive }
    assert.equal(afterInterrupt.parent.outcome, "interrupted")
    release(hold)
    if (background) release("bg-cancel-parent")
    await wait(cancelChild)
    if (background) { await until(() => primary(cancelParent).some(r => JSON.stringify(r.body.messages).includes(`${marker}_FINISHED`))); await wait(cancelParent) }
    results[background ? "backgroundParentInterrupt" : "foregroundParentInterrupt"] = { afterInterrupt,
      childFinal: await client.session.get({ sessionID: cancelChild }), parentFinal: await client.session.get({ sessionID: cancelParent }), messages: await messages(cancelParent) }
    assert.equal(childActive, background, "2.0.21: foreground child stops, detached background child survives")
    assert.equal((await client.session.get({ sessionID: cancelChild })).outcome, background ? "succeeded" : "interrupted")
    assert.equal((await client.session.get({ sessionID: cancelParent })).outcome, background ? "succeeded" : "interrupted",
      "Native background completion can wake an explicitly interrupted parent")
  }

  stage = "explicit child interrupt notification"
  const directParent = await create("directChildInterrupt")
  childPlans.set("DIRECT_CANCEL_CHILD", [{ hold: "direct-cancel", answer: "MUST_NOT_FINISH" }])
  plans.set(directParent, [{ answer: toolCall("subagent", childInput("Explicit child cancellation", "DIRECT_CANCEL_CHILD", { background: true }), "direct_cancel_call") }])
  await client.session.prompt({ sessionID: directParent, text: "Interrupt only the native child" })
  const directChild = await childOf(directParent)
  await until(() => releases.has("direct-cancel"))
  await wait(directParent)
  await client.session.interrupt({ sessionID: directChild, continue: false })
  await wait(directChild)
  release("direct-cancel")
  await until(async () => (await messages(directParent)).some(m => m.type === "synthetic" && m.metadata?.childID === directChild && m.metadata.state === "cancelled"))
  await until(() => primary(directParent).length >= 3)
  await wait(directParent)
  results.explicitChildInterrupt = { child: await client.session.get({ sessionID: directChild }), messages: await messages(directParent) }
  assert.equal(results.explicitChildInterrupt.child.outcome, "interrupted")

  stage = "native background provider failure notification"
  const failingParent = await create("failedBackgroundChild")
  childPlans.set("FAILED_CHILD", [{ hold: "failing-child", httpStatus: 400 }])
  plans.set(failingParent, [{ answer: toolCall("subagent", childInput("Failing native child", "FAILED_CHILD", { background: true }), "failed_child_call") }])
  await client.session.prompt({ sessionID: failingParent, text: "Observe terminal child provider failure" })
  const failingChild = await childOf(failingParent)
  await until(() => releases.has("failing-child"))
  await wait(failingParent)
  release("failing-child")
  await wait(failingChild)
  await until(async () => (await messages(failingParent)).some(m => m.type === "synthetic" && m.metadata?.childID === failingChild && m.metadata.state === "error"))
  await until(() => primary(failingParent).length >= 3)
  await wait(failingParent)
  results.failedBackground = { child: await client.session.get({ sessionID: failingChild }), messages: await messages(failingParent) }
  assert.equal(results.failedBackground.child.outcome, "failed")

  const ids = new Set([...sessions.values(), ...events.filter(e => e.type === "session.created").map(e => e.data.sessionID)])
  const transcripts = Object.fromEntries(await Promise.all([...ids].map(async id => [id, await messages(id)])))
  await writeFile(path.join(root, "transcripts.json"), JSON.stringify(transcripts, null, 2))
  results.requestEvidence = requests.filter(r => r.kind === "primary").map(r => ({ index: r.index, sessionID: r.sessionID, model: r.body.model,
    tools: r.body.tools.map(t => t.function.name), lastMessage: r.body.messages.at(-1) }))

  results.status = "passed"
  results.counts = { providerRequests: requests.length, primaryRequests: requests.filter(r => r.kind === "primary").length,
    nativeSessions: ids.size, nativeEvents: events.length }
  console.log(`PASS private OpenCode ${results.server.version}: ${root}`)
} catch (error) {
  results.status = "failed"
  results.failure = { stage, error: String(error), stack: error.stack }
  console.error(`FAIL ${stage}: ${root}`)
  throw error
} finally {
  clearTimeout(watchdog)
  for (const resolve of releases.values()) resolve()
  subscription.abort()
  try {
    await Promise.allSettled([presence?.stop(), removeBridge?.(), bridge.close(), manager?.shutdown()])
    await writeFile(path.join(root, "requests.json"), JSON.stringify(requests, null, 2))
    await writeFile(path.join(root, "events.json"), JSON.stringify(events, null, 2))
    await writeFile(path.join(root, "results.json"), JSON.stringify({ ...results, sessions: Object.fromEntries(sessions) }, null, 2))
    await writeFile(path.join(root, "serve.log"), output)
  } finally {
    // Even an artifact write/cleanup failure must stop only our own private child.
    child?.kill()
    if (stopped) await stopped
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
  }
}
