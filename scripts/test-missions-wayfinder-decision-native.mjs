// Build first: npm run build:missions --workspace @neuralnomads/codenomad
// Run: node scripts/test-missions-wayfinder-decision-native.mjs <absolute-existing-CLI>
// Private daemon/database/discovery/provider only; never discovers the shared service.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import pino from "pino"
import { stopFixtureChild, clearFixtureGitEnvironment } from "./native-fixture-guards.mjs"

const source = process.argv[2]
assert(source && path.isAbsolute(source), "Explicit existing CLI required")
const temporary = path.join(os.tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await realpath(await mkdtemp(path.join(temporary, "missions-wayfinder-decision-native-")))
const cli = path.join(root, process.platform === "win32" ? "opencode.exe" : "opencode")
const project = path.join(root, "project"), config = path.join(root, "config")
const receipt = { status: "running", source, root, nodeVersion: process.version, calls: [], answers: [], gates: [], template: "wayfinder",
  limits: ["Synthetic provider and authenticated route injection, not a live desktop gesture or LLM planning qualification."] }
const destination = `${root}.json`, previousEnvironment = { ...process.env }
let child, closed, output = "", failure, manager, plugin, removeBridge, client, coordinator, assignment, index = 0
let journalBefore, snapshot, missionID
const bridge = Fastify(), question = { question: "Choose the seam?", header: "Seam", options: [{ label: "Module", description: "Own the boundary" }] }
const gate = name => { receipt.gates.push(name); console.log(`PASS ${name}`) }
const stored = prefix => {
  const db = new DatabaseSync(path.join(root, "fixture.db"), { readOnly: true })
  try { return db.prepare("SELECT key,value FROM kv WHERE key LIKE ? ORDER BY key").all(`%${prefix}%`).map(row => ({ ...row })) }
  finally { db.close() }
}
const marks = () => stored("codenomad-missions/human-marks-v1").map(row => {
  const { state, via, formID, sessionID, answeredAt, answer } = JSON.parse(row.value)
  return { state, via, formID, sessionID, answeredAt, answer }
})
const toolText = (body, id) => {
  const result = body.messages.findLast(message => message.role === "tool" && message.tool_call_id === id)
  assert(result, `Actual native result for ${id}`)
  return typeof result.content === "string" ? result.content : result.content.map(part => part.text ?? "").join("")
}
async function until(predicate) {
  const end = Date.now() + 60_000
  while (Date.now() < end) {
    if (failure) throw failure
    if (await predicate()) return
    if (child?.exitCode !== undefined && child.exitCode !== null) throw new Error("Private daemon exited")
    await delay(50)
  }
  throw new Error(`Timeout at coordinator turn ${index}`)
}
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) { raw += chunk; assert(raw.length < 2 * 1024 * 1024, "Provider body budget") }
    const body = JSON.parse(raw), sessionID = request.headers["x-fixture-session"]
    let answer = "Fixture"
    if (request.headers["x-fixture-kind"] === "primary") {
      let call
      if (sessionID !== coordinator) {
        const asked = body.messages.some(message => message.tool_calls?.some(tool => tool.function.name === "question"))
        assert(JSON.stringify(body.messages).includes(JSON.stringify(assignment.assignmentPrompt).slice(1, -1)), "Exact canonical native assignment")
        if (!asked) call = { id: "ask", name: "question", args: { questions: [question] } }
        else {
          assert.match(toolText(body, "ask"), /Module/)
          await until(() => receipt.answers[0]?.status === 204)
          const confirmed = marks()
          assert.equal(confirmed.length, 1)
          assert.equal(confirmed[0].state, "confirmed")
          assert.equal(confirmed[0].via, "ui")
          assert.equal(confirmed[0].sessionID, sessionID)
          assert.equal(confirmed[0].formID, receipt.answers[0].formID)
          assert.deepEqual(confirmed[0].answer, { q0: "Module" })
          receipt.confirmedMark = confirmed[0]
          answer = "The human chose Module"
        }
      } else {
        if (index === 1) {
          assignment = JSON.parse(toolText(body, "declare"))
          assert.equal(assignment.disposition, "declared")
          journalBefore = stored("codenomad-missions/v2/")
          assert(journalBefore.length > 0, "Actual one-time journal exists")
          assert.deepEqual(marks(), [])
        }
        if (index === 2) {
          receipt.rejectedReport = toolText(body, "unanswered")
          // Also continue past the known upstream graph error so the red run
          // reaches the confirmed UI answer, rather than failing prematurely.
          assert.match(receipt.rejectedReport, /Human decision required|Native human answer graph unavailable/)
          const after = stored("codenomad-missions/v2/")
          assert.deepEqual(after, journalBefore, "Rejected report must not mutate any one-time journal row")
          assert.deepEqual(marks(), [], "No manufactured UI mark")
          const mission = await snapshot()
          assert.equal(mission.revision, assignment.revision)
          assert.equal(mission.tasks[0].executionMode.kind, "native")
          assert.equal(mission.tasks[0].status, "ready")
          assert.equal(mission.reports.length, 0)
          receipt.rejection = { unchangedJournal: true, rows: after.length, revision: mission.revision,
            journalSHA256: createHash("sha256").update(JSON.stringify(after)).digest("hex") }
          gate("unanswered decision rejected without journal mutation or human mark")
        }
        if (index === 4) {
          assert.match(toolText(body, "launch"), /The human chose Module/)
          receipt.decisionResult = JSON.parse(toolText(body, "decision"))
          assert.equal(receipt.decisionResult.disposition, "reported", "Confirmed UI mark discovered without supplied artifact")
          gate("native child UI answer discovered by artifact-free coordinator report")
        }
        if (index === 5) assert.equal(JSON.parse(toolText(body, "final")).disposition, "finished")
        call = [
          { id: "declare", name: "mission_delegate", args: { taskKey: "decision", title: "Choose the seam", role: "decision", brief: "Ask the human which seam to use through a native question Form." } },
          { id: "unanswered", name: "mission_report", args: { taskKey: "decision", outcome: "completed", summary: "Premature decision without human input" } },
          { id: "launch", name: "subagent", args: { agent: "fixture-worker", description: "Decision worker", prompt: assignment?.assignmentPrompt } },
          { id: "decision", name: "mission_report", args: { taskKey: "decision", outcome: "completed", summary: "The human chose Module" } },
          { id: "final", name: "mission_report", args: { outcome: "completed", final: true, summary: "Human decision recorded" } },
        ][index++]
        assert(index <= 6, "Coordinator request budget")
      }
      if (call) {
        assert(body.tools.some(tool => tool.function.name === call.name), `Actual native tool available: ${call.name}`)
        if (call.name === "mission_report") assert(!Object.hasOwn(call.args, "artifact"), "Never supply a decision artifact")
        receipt.calls.push({ sessionID, id: call.id, name: call.name, ...(call.name === "mission_report" ? { artifactSupplied: false } : {}) })
        answer = { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      }
    }
    response.setHeader("content-type", body.stream ? "text/event-stream" : "application/json")
    if (!body.stream) return response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
    for (const [delta, finish_reason] of [[typeof answer === "string" ? { role: "assistant", content: answer } : answer, null], [{}, typeof answer === "string" ? "stop" : "tool_calls"]])
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) { failure = error; response.destroy() }
})
try {
  await copyFile(source, cli)
  for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_|WSL_|CLAUDE_|CODEX_|ANTHROPIC_|OPENAI_)|TOKEN|SECRET|API_KEY|PASSWORD/i.test(key)) delete process.env[key]
  clearFixtureGitEnvironment()
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    process.env[key] = path.join(root, key); await mkdir(process.env[key])
  }
  Object.assign(process.env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: config,
    OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FFF: "1", OPENCODE_SERVER_PASSWORD: randomUUID(), DO_NOT_TRACK: "1" })
  await mkdir(project); await mkdir(config); execFileSync("git", ["init", "-q", project])
  await writeFile(path.join(config, "opencode.json"), "{}\n")
  receipt.cliVersion = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim()
  receipt.binarySHA256 = createHash("sha256").update(await readFile(cli)).digest("hex")
  const load = file => tsImport(`../packages/server/src/${file}.ts`, import.meta.url)
  const [{ WorkspaceManager }, { EventBus }, { rememberRuntime }, { DesktopPluginLifecycle }, { resolveDesktopPluginPaths },
    { createAutomationBridgeRegistration, publishAutomationBridge }, { registerAutomationPluginRoute }, { registerMissionRoutes },
    { WorktreeDeletionFence }, { registerInstanceProxyRoutes }, { CODENOMAD_MISSIONS_RPC }] = await Promise.all([
    load("workspaces/manager"), load("events/bus"), load("opencode/compatibility/runtime"), load("opencode/desktop-plugin-lifecycle"),
    load("opencode/desktop-plugin-paths"), load("opencode/automation-plugin"), load("server/routes/automation-plugin"), load("server/routes/missions"),
    load("workspaces/worktree-session-evacuation"), load("server/http-server"), load("missions/rpc")])
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  const hooks = path.join(root, "provider-hook"); await mkdir(hooks)
  await writeFile(path.join(hooks, "index.ts"), `export default { id: 'wayfinder.fixture', async setup(ctx) {
    await ctx.session.hook('http.request', event => { event.request.headers.set('x-fixture-kind', event.kind); event.request.headers.set('x-fixture-session', event.sessionID) });
    await ctx.session.hook('retry', event => { event.decision = { retry: false } });
  } }`)
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", update: "disable", snapshots: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }], agents: { "fixture-worker": { mode: "all", description: "Deterministic native fixture worker" } }, plugins: [hooks],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" }, models: { fixture: {} } } } })
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { env: process.env, cwd: root, windowsHide: true })
  closed = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { failure = error })
  child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const endpoint = { url, auth: { type: "basic", username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD } }
  const info = await (await fetch(`${url}/api/info`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } })).json()
  assert.equal(info.pid, child.pid); receipt.runtime = { pid: info.pid, version: info.version }
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  const yaml = path.join(root, "profile.yaml"); await writeFile(yaml, "server:\n  environmentVariables: {}\n")
  const profile = { channel: "native-fixture", configIdentity: yaml, key: createHash("sha256").update(`native-fixture\0${yaml}`).digest("hex") }
  const settings = { getProfileScope: () => profile, configYamlPathForAuthority: () => yaml, getOwner: () => ({ environmentVariables: {} }), readEnvironmentForAdmission: async () => ({}) }
  const human = { sessionId: "isolated-human", username: "fixture-human" }
  const auth = { isAuthEnabled: () => true, isLoopbackRequest: () => true, getCookieName: () => "session",
    getSessionFromHeaders: headers => headers.cookie === "session=isolated-human" ? human : null,
    getSessionFromRequest: request => request.headers.cookie === "session=isolated-human" ? human : null }
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(), settings,
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Private Wayfinder decision fixture" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }) })
  const { workspace } = await manager.create(project); client = await manager.getSharedServiceClient()
  const paths = await resolveDesktopPluginPaths(await manager.getSharedServiceConnection(workspace.id), { kind: "host", platform: process.platform, binary: cli })
  assert.equal(paths.config, config)
  const registration = createAutomationBridgeRegistration("http://127.0.0.1:1"), fence = new WorktreeDeletionFence()
  registerMissionRoutes(bridge, { workspaceManager: manager, worktreeDeletionFence: fence })
  registerAutomationPluginRoute(bridge, { workspaceManager: manager, worktreeDeletionFence: fence, authManager: auth, settings, bridgeToken: registration.token, nativeParent: {}, developerCdp: {} })
  registerInstanceProxyRoutes(bridge, { workspaceManager: manager, worktreeDeletionFence: fence, logger: pino({ level: "silent" }), humanAnswers: { auth, manager, settings, bridgeToken: registration.token } })
  await bridge.listen({ host: "127.0.0.1", port: 0 })
  registration.url = `http://127.0.0.1:${bridge.server.address().port}/api/opencode-plugin/automation`
  removeBridge = await publishAutomationBridge(registration)
  plugin = new DesktopPluginLifecycle("missions"); await plugin.start(paths)
  const location = { directory: project }
  assert.deepEqual(manager.getServiceLocation(workspace.id), location)
  snapshot = async () => (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location, signal: AbortSignal.timeout(10_000) })).missions.find(mission => mission.id === missionID)
  await until(async () => (await client.plugin.list({ location })).data.some(value => value.id === "codenomad.missions" && value.state.status === "active"))
  const missionURL = `/api/workspaces/${workspace.id}/missions`
  const created = await bridge.inject({ method: "POST", url: missionURL, payload: { requestId: "wayfinder-create", objective: "Decide the seam with the human through a native Form", template: "wayfinder" } })
  assert.equal(created.statusCode, 200, created.body)
  const mission = created.json().mission; coordinator = mission.coordinatorSessionId; missionID = mission.id
  assert.equal(mission.template, "wayfinder"); assert.equal(mission.runState, "prepared")
  receipt.mission = { id: mission.id, template: mission.template }
  const started = await bridge.inject({ method: "POST", url: `${missionURL}/${mission.id}/control`, payload: { requestId: "wayfinder-play", expectedRevision: mission.revision, action: "start" } })
  assert.equal(started.statusCode, 200, started.body)
  let forms
  await until(async () => (forms = (await client.form.list({ location })).data).length === 1)
  const form = forms[0], actor = await client.session.get({ sessionID: form.sessionID })
  assert.equal(actor.parentID, coordinator); assert.equal(form.metadata?.kind, "question")
  const answer = { formID: form.id, sessionID: form.sessionID }; receipt.answers.push(answer)
  const reply = await bridge.inject({ method: "POST", url: `/workspaces/${workspace.id}/instance/api/session/${form.sessionID}/form/${form.id}/reply`,
    headers: { cookie: "session=isolated-human", "content-type": "application/json", "x-codenomad-human-answer": "1" }, payload: JSON.stringify({ answer: { q0: "Module" } }) })
  answer.status = reply.statusCode; assert.equal(reply.statusCode, 204, reply.body)
  await until(() => index === 6)
  await client.session.wait({ sessionID: coordinator }, { signal: AbortSignal.timeout(30_000) })
  const completed = await snapshot(), report = completed.tasks[0].report
  assert.equal(completed.status, "completed"); assert.equal(completed.tasks[0].status, "completed")
  assert.equal(completed.reports.length, 1); assert.equal(report.delivery, "coordinator-readout")
  assert.equal(report.artifact.kind, "decision"); assert.equal(report.artifact.question, question.question)
  assert.equal(report.artifact.answer, "Module"); assert.equal(report.artifact.provenance.sessionID, form.sessionID)
  assert.equal(report.artifact.provenance.formID, form.id)
  receipt.report = report
  gate("one-time Wayfinder completion retains exact discovered decision provenance")
  receipt.status = "passed"
} catch (error) {
  receipt.status = "failed"; receipt.failure = { stage: `coordinator turn ${index}`, message: error.message, stack: error.stack }
  console.error(error.stack); process.exitCode = 1
} finally {
  try { receipt.marks = marks() } catch (error) { receipt.observationError = error.message }
  receipt.nativeErrors = output.split("\n").filter(line => /Native human answer|acquireNativeHumanAnswers|managed-owner-plugin/.test(line)).slice(-20)
    .map(line => line.replaceAll(process.env.OPENCODE_SERVER_PASSWORD ?? "unused-fixture-secret", "[redacted]"))
  // Always attempt the remaining owned cleanup, even if an earlier disposal fails.
  for (const dispose of [() => removeBridge?.(), () => plugin?.stop(), () => bridge.close(), () => manager?.shutdown(),
    async () => { if (child) await stopFixtureChild(child, closed) },
    async () => { provider.closeAllConnections(); if (provider.listening) await new Promise(resolve => provider.close(resolve)) }]) {
    try { await dispose() } catch (error) { (receipt.cleanupErrors ??= []).push(error.message); receipt.status = "failed"; process.exitCode = 1 }
  }
  receipt.ownedDaemonExited = child ? child.exitCode !== null || child.signalCode !== null : true
  try { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); receipt.temporaryRootRemoved = true }
  catch (error) { receipt.temporaryRootRemoved = false; (receipt.cleanupErrors ??= []).push(error.message); receipt.status = "failed"; process.exitCode = 1 }
  for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key]
  Object.assign(process.env, previousEnvironment)
  await writeFile(destination, JSON.stringify(receipt, null, 2) + "\n")
  console.log(`RESULT ${receipt.status}; daemon exited=${receipt.ownedDaemonExited}; root removed=${receipt.temporaryRootRemoved}\nRECEIPT ${destination}`)
}
