// Real isolated OpenCode + shipped bundle + authenticated production HTTP/HMAC routes.
// Usage: node scripts/test-recurring-simple-native.mjs <absolute-existing-cli> [any of A, B, C, D, G; default ABCD]
// No installer, default service discovery, shared database/config or pattern kills.
// Settlement is event-driven: each archive must follow family quiescence within
// SETTLE (2.5 min), far below the hourly Job ceiling. Next-day passages cannot be
// fast-forwarded here; the offline day e2e covers them.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import pino from "pino"
import { OpenCode } from "@opencode/client"

const source = process.argv[2], journeys = process.argv[3] ?? "ABCD"
assert.ok(source && path.isAbsolute(source), "Explicit existing CLI required")
assert.match(journeys, /^A?B?C?D?G?$/, "Journeys: ordered subset of ABCDG")
const root = await realpath(await mkdtemp(path.join(process.env.LOCALAPPDATA, "Temp/opencode/recurring-simple-native-")))
const cli = path.join(root, "opencode.exe"), project = path.join(root, "project")
await copyFile(source, cli)
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SystemRoot|WINDIR|ComSpec|PATHEXT|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PATH)$/i.test(key)))
const env = { ...clean, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
  OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_SERVER_PASSWORD: randomUUID(), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_FFF: "1", DO_NOT_TRACK: "1", TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp") }
for (const name of ["DATA", "CONFIG", "STATE", "CACHE", "RUNTIME"]) env[`XDG_${name}_HOME`] = path.join(root, `xdg-${name.toLowerCase()}`)
env.XDG_RUNTIME_DIR = path.join(root, "runtime")
for (const directory of [project, env.TEMP, env.OPENCODE_CONFIG_DIR, ...Object.entries(env).filter(([k]) => k.startsWith("XDG_")).map(([,v]) => v)]) await mkdir(directory, { recursive: true })
// Imported backend modules must see the same private roots as the child service.
for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_|WSL_)/i.test(key)) delete process.env[key]
Object.assign(process.env, env)
execFileSync("git", ["init", "-q", project], { env })
await writeFile(path.join(project, "input.txt"), "deterministic native useful-work input\n")
const version = execFileSync(cli, ["--version"], { env, encoding: "utf8" }).trim()
const evidence = { root, cliVersion: version, outcome: "running", journeys: {}, providerCalls: [], isolation: {} }
for (const key of ["home", "config", "state", "data", "cache", "db"]) {
  const actual = execFileSync(cli, ["debug", "paths", key], { env, encoding: "utf8" }).trim()
  assert.ok(!path.relative(root, actual).startsWith("..") && path.isAbsolute(actual), `Private ${key}`)
  evidence.isolation[key] = actual
}
const load = file => tsImport(`../packages/server/src/${file}.ts`, import.meta.url)
const { WorkspaceManager } = await load("workspaces/manager")
const { EventBus } = await load("events/bus")
const { rememberRuntime } = await load("opencode/compatibility/runtime")
const { DesktopPluginLifecycle } = await load("opencode/desktop-plugin-lifecycle")
const { resolveDesktopPluginPaths } = await load("opencode/desktop-plugin-paths")
const { createAutomationBridgeRegistration, publishAutomationBridge } = await load("opencode/automation-plugin")
const { registerAutomationPluginRoute } = await load("server/routes/automation-plugin")
const { registerMissionRecurrenceCreate } = await load("server/routes/mission-recurrence-create")
const { registerMissionRecurrenceControl } = await load("server/routes/mission-recurrence-control")
const { registerMissionRecurrenceManual } = await load("server/routes/mission-recurrence-manual")
const { WorktreeDeletionFence } = await load("workspaces/worktree-session-evacuation")
const { CODENOMAD_MISSIONS_RPC } = await load("missions/rpc")
let child, closed, output = "", endpoint, manager, bridge, plugin, removeBridge, client, workspace, stage = "provider"
let hold = false, held = false
const releases = new Set()
const provider = createServer(async (request, response) => {
  try {
    let raw = ""; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), primary = request.headers["x-fixture-kind"] === "primary"
    let call
    if (primary) {
      const messages = body.messages ?? [], tools = (body.tools ?? []).map(t => t.function.name)
      const calls = messages.flatMap(m => m.tool_calls ?? []).map(t => t.function.name)
      const name = ["read", "shell", "mission_inspect", "mission_report"].find(name => !calls.includes(name))
      evidence.providerCalls.push({ sessionID: request.headers["x-fixture-session"], model: body.model, name: name ?? "done", tools })
      if (hold) {
        held = true
        await new Promise(resolve => { releases.add(resolve); response.once("close", resolve) })
        if (response.destroyed) return
      }
      if (name) {
        assert.ok(tools.includes(name), `Ordinary/native tool ${name} unavailable: ${tools.join(",")}`)
        const args = name === "read" ? { filePath: path.join(project, "input.txt") }
          : name === "shell" ? { command: "echo native-recurring-useful-work", description: "Isolated useful shell" }
          : name === "mission_inspect" ? {} : { outcome: "completed", summary: "Native read and shell completed", final: true }
        call = { index: 0, id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name, arguments: JSON.stringify(args) } }
      }
    }
    response.setHeader("content-type", body.stream ? "text/event-stream" : "application/json")
    if (!body.stream) return response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
    for (const [delta, finish_reason] of [[call ? { role: "assistant", tool_calls: [call] } : { role: "assistant", content: "Done" }, null], [{}, call ? "tool_calls" : "stop"]])
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) { evidence.providerError = error.message; response.destroy(error) }
})
async function until(predicate, timeout = 90_000, interval = 250) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (evidence.providerError) throw new Error(evidence.providerError)
    if (await predicate()) return
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error("Owned service exited")
    await delay(interval)
  }
  throw new Error(`Timeout: ${stage}`)
}
async function start() {
  output = ""
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { env, cwd: root, windowsHide: true })
  closed = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  endpoint = { url: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], auth: { type: "basic", username: "opencode", password: env.OPENCODE_SERVER_PASSWORD } }
  const info = await (await fetch(`${endpoint.url}/api/info`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } })).json()
  assert.equal(info.pid, child.pid)
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  // Fixture-owned read-only observer bound to this exact service; independent of the backend.
  client = OpenCode.make({ baseUrl: endpoint.url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } })
  evidence.serviceStarts ??= []; evidence.serviceStarts.push({ pid: info.pid, version: info.version })
}
async function stop() {
  assert.equal((await client.server.info()).pid, child.pid, "Exact owned PID before stop")
  child.kill(); await Promise.race([closed, delay(10_000).then(() => { throw new Error("Owned service stop timeout") })])
  evidence.stoppedPIDs ??= []; evidence.stoppedPIDs.push(child.pid)
}
const yaml = path.join(root, "profile.yaml")
await writeFile(yaml, "server:\n  environmentVariables: {}\n")
const profileScope = { channel: "native-fixture", configIdentity: yaml, key: createHash("sha256").update(`native-fixture\0${yaml}`).digest("hex") }
const settings = { getProfileScope: () => profileScope, configYamlPathForAuthority: () => yaml,
  getOwner: () => ({ environmentVariables: {} }), readEnvironmentForAdmission: async () => ({}) }
const human = { sessionId: "isolated-human" }
const auth = { isAuthEnabled: () => true, isLoopbackRequest: () => true, getCookieName: () => "session",
  getSessionFromHeaders: headers => headers.cookie === "session=isolated-human" ? human : null,
  getSessionFromRequest: request => request.headers.cookie === "session=isolated-human" ? human : null }
async function openBackend() {
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(), settings,
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Isolated recurring" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }) })
  workspace = (await manager.create(project)).workspace
  const connection = await manager.getSharedServiceConnection(workspace.id)
  const paths = await resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: cli })
  assert.equal(paths.config, env.OPENCODE_CONFIG_DIR)
  const registration = createAutomationBridgeRegistration("http://127.0.0.1:1"), fence = new WorktreeDeletionFence()
  bridge = Fastify({ logger: { level: "warn" } })
  registerAutomationPluginRoute(bridge, { workspaceManager: manager, worktreeDeletionFence: fence, authManager: auth,
    bridgeToken: registration.token, settings, nativeParent: {}, developerCdp: {} })
  registerMissionRecurrenceCreate(bridge, { workspaceManager: manager, worktreeDeletionFence: fence, auth, settings, bridgeToken: registration.token })
  for (const register of [registerMissionRecurrenceControl, registerMissionRecurrenceManual])
    register(bridge, { manager, fence, auth, settings, bridgeToken: registration.token })
  await bridge.listen({ host: "127.0.0.1", port: 0 })
  registration.url = `http://127.0.0.1:${bridge.server.address().port}/api/opencode-plugin/automation`
  removeBridge = await publishAutomationBridge(registration)
  plugin = new DesktopPluginLifecycle("missions"); await plugin.start(paths)
  await until(async () => (await client.plugin.list({ location: { directory: project } })).data.some(p => p.id === "codenomad.missions" && p.state.status === "active"))
}
async function closeBackend() {
  await plugin?.stop(); plugin = undefined
  await removeBridge?.(); removeBridge = undefined
  await bridge?.close(); bridge = undefined
  await manager?.shutdown(); manager = undefined // Drops connections only; never stops the owned service.
}
const location = { directory: project }
const rpc = () => client.rpc(CODENOMAD_MISSIONS_RPC)
const snapshot = async id => (await rpc().recurrenceSnapshot({}, { location })).schedules.find(s => s.id === id)
async function http(suffix, payload) {
  const response = await bridge.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/missions/recurrence${suffix}`,
    headers: { cookie: "session=isolated-human" }, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function create(title, due) {
  const selected = { agent: "fixture-worker", model: { providerID: "fixture", id: "fixture" } }
  const result = await http("", { requestID: `create_${randomUUID().replaceAll("-", "")}`, title,
    instructions: "Read input.txt, run an echo shell, inspect the mission and submit a final completed mission_report.",
    clock: { time: new Date(due).toISOString().slice(11,16), zone: "UTC" }, template: "custom",
    profiles: { coordinator: selected, roles: { specialist: selected } }, taskMode: "native", watchedConversationIDs: [] })
  assert.equal(result.schedule.state, "paused")
  return result.schedule.id
}
async function control(id, action) {
  const s = await snapshot(id)
  return http(`/${id}/${action === "run-now" ? "run-now" : "control"}`, {
    requestID: `control_${randomUUID().replaceAll("-", "")}`, expectedRevision: s.revision, ...(action === "run-now" ? {} : { action }) })
}
async function runNow(id) {
  const payload = { requestID: `control_${randomUUID().replaceAll("-", "")}`, expectedRevision: (await snapshot(id)).revision }
  return { payload, result: await http(`/${id}/run-now`, payload) }
}
// Coordinator start messages per passage, read from the isolated native API.
async function passageStarts(sessionID) {
  const all = (await client.message.list({ sessionID, limit: 100 })).data
  return all.filter(m => m.type === "user" || m.type === "synthetic").map(m => ({ id: m.id, type: m.type }))
}
const sessions = async () => (await client.session.list({ limit: { limit: 100 } })).data
  .map(s => ({ id: s.id, parentID: s.parentID ?? null, created: s.time?.created }))
const done = sessionID => evidence.providerCalls.some(c => c.sessionID === sessionID && c.name === "done")
async function journeyD() {
  stage = "D Pause Stop"
  const due = Math.ceil((Date.now() + 75_000) / 60_000) * 60_000
  const id = await create("Paused before due", due)
  const D = evidence.journeys.D = { id, dueAt: due }
  await control(id, "play"); D.running = await snapshot(id)
  await control(id, "pause"); D.paused = await snapshot(id)
  assert.equal(D.paused.state, "paused"); assert.equal(D.paused.nextDueAt, null)
  await delay(Math.max(0, due - Date.now()) + 30_000)
  D.afterDue = await snapshot(id)
  assert.equal(D.afterDue.pending, null); assert.equal(D.afterDue.history.length, 0)
  D.rootSessionsCreatedAfterDue = (await sessions()).filter(s => !s.parentID && s.created >= due).map(s => s.id)
  assert.deepEqual(D.rootSessionsCreatedAfterDue, [], "no passage session after the cancelled due time")
  await control(id, "stop"); D.stopped = await snapshot(id)
  assert.equal(D.stopped.state, "stopped"); assert.deepEqual(D.stopped.actions, [])
  const refused = await bridge.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/missions/recurrence/${id}/control`,
    headers: { cookie: "session=isolated-human" }, payload: { requestID: `control_${randomUUID().replaceAll("-", "")}`,
      expectedRevision: D.stopped.revision, action: "resume" } })
  D.resumeAfterStop = refused.statusCode; assert.notEqual(refused.statusCode, 200, "Stop is terminal")
  D.result = "passed"
}
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  const hooks = path.join(root, "provider-hook"); await mkdir(hooks)
  await writeFile(path.join(hooks, "index.ts"), `export default { id: 'recurring.fixture', async setup(ctx) {
    await ctx.session.hook('http.request', event => { event.request.headers.set('x-fixture-kind', event.kind); event.request.headers.set('x-fixture-session', event.sessionID) })
  } }`)
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", update: "disable", snapshots: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }], agents: { "fixture-worker": { mode: "all", description: "Deterministic native fixture worker" } }, plugins: [hooks], providers: { fixture: {
      package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" }, models: { fixture: {} } } } })
  await writeFile(path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"), "{}\n")
  await start(); await openBackend()
  // Event-driven settlement: the archive must follow family quiescence well before
  // the hourly Job ceiling. The real service clock cannot be compressed for tomorrow.
  const SETTLE = 150_000, SLOW = 1_000
  const nextMinute = lead => Math.ceil((Date.now() + lead) / 60_000) * 60_000
  const quiet = sessionID => client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) })
  if (journeys.includes("A")) {
    stage = "A daily useful work"
    const due = nextMinute(75_000)
    const id = await create("Native daily useful work", due)
    const A = evidence.journeys.A = { id, dueAt: due, paused: await snapshot(id) }
    await control(id, "play")
    A.played = await snapshot(id); assert.equal(A.played.state, "running"); assert.equal(A.played.nextDueAt, due)
    await closeBackend() // No backend, presence or bridge during the passage; only the read-only observer.
    A.backendClosedAt = Date.now()
    await until(async () => (A.pending = await snapshot(id)).pending?.conversationID, 180_000)
    A.pendingObservedAt = Date.now()
    const sessionID = A.pending.pending.conversationID
    await until(() => done(sessionID), 180_000)
    A.workDoneAt = Date.now()
    await quiet(sessionID); A.quiescentAt = Date.now()
    stage = "A event-driven archive"
    await until(async () => (A.settled = await snapshot(id)).history.length === 1, SETTLE, SLOW)
    A.settledObservedAt = Date.now(); A.archiveLatencyMs = A.settledObservedAt - A.quiescentAt
    assert.equal(A.settled.latestResult.outcome, "completed")
    assert.equal(A.settled.pending, null)
    assert.equal(A.settled.state, "running", "the same Job stays armed for the next civil day")
    assert.equal(A.settled.nextDueAt, due + 86_400_000)
    A.starts = await passageStarts(sessionID); assert.equal(A.starts.length, 1)
    A.toolsUsed = evidence.providerCalls.filter(c => c.sessionID === sessionID).map(c => c.name)
    A.sessions = await sessions()
    A.result = "passed"
    if (journeys.length > 1) await openBackend()
  }
  if (journeys.includes("B")) {
    stage = "B restart pending"
    const id = await create("Native restart reconcile", nextMinute(6 * 3_600_000))
    await control(id, "play"); hold = true
    await control(id, "run-now"); await until(() => held)
    const B = evidence.journeys.B = { id, before: await snapshot(id) }
    const sessionID = B.before.pending.conversationID
    B.startsBefore = await passageStarts(sessionID)
    await closeBackend(); await stop(); hold = false; held = false; for (const release of releases) release(); releases.clear()
    await start(); B.restartedAt = Date.now()
    B.interrupted = await snapshot(id)
    assert.equal(B.interrupted.state, "interrupted"); assert.equal(B.interrupted.interruptionReason, "service-restart")
    assert.equal(B.interrupted.pending.passageID, B.before.pending.passageID)
    // Record whether native resumes the cut turn by itself; Resume must not depend on it.
    await delay(20_000)
    B.nativeAfterRestart = { calls: evidence.providerCalls.filter(c => c.sessionID === sessionID).length, done: done(sessionID),
      active: Object.keys(await client.session.active()).includes(sessionID) }
    assert.equal(B.nativeAfterRestart.active, false)
    await openBackend()
    await control(id, "resume"); B.resumedAt = Date.now()
    stage = "B interrupted settlement"
    await until(async () => (B.after = await snapshot(id)).history.length === 1, SETTLE, SLOW)
    B.settledObservedAt = Date.now(); B.archiveLatencyMs = B.settledObservedAt - B.resumedAt
    assert.equal(B.after.latestResult.passageID, B.before.pending.passageID)
    assert.equal(B.after.latestResult.outcome, "ended-without-report")
    assert.equal(B.after.latestResult.reason, "interrupted")
    assert.equal(B.after.state, "running"); assert.equal(B.after.pending, null)
    B.starts = await passageStarts(sessionID); assert.equal(B.starts.length, 1, "Resume never sends a second coordinator message")
    assert.deepEqual(B.starts.map(m => m.id), B.startsBefore.map(m => m.id))
    B.callsAfterResume = evidence.providerCalls.filter(c => c.sessionID === sessionID).length
    assert.equal(B.callsAfterResume, B.nativeAfterRestart.calls, "no continuation turn after Resume")
    await control(id, "stop")
    B.result = "passed"
  }
  if (journeys.includes("C")) {
    stage = "C repeated Run now on one schedule"
    const id = await create("Native manual useful work", nextMinute(6 * 3_600_000))
    await control(id, "play")
    const C = evidence.journeys.C = { id, passages: [] }
    for (let n = 0; n < 2; n++) {
      const { payload } = await runNow(id)
      let pending
      await until(async () => (pending = await snapshot(id)).pending?.conversationID)
      const sessionID = pending.pending.conversationID
      if (n === 0) {
        // Exact duplicate request (same requestID/expectedRevision): no second passage.
        const replay = await bridge.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/missions/recurrence/${id}/run-now`,
          headers: { cookie: "session=isolated-human" }, payload })
        C.duplicate = { status: replay.statusCode, body: (() => { try { return replay.json() } catch { return replay.body.slice(0, 200) } })() }
      }
      await until(() => done(sessionID), 180_000)
      await quiet(sessionID); const quiescentAt = Date.now()
      let after
      await until(async () => (after = await snapshot(id)).history.length === n + 1, SETTLE, SLOW)
      const item = { passageID: pending.pending.passageID, sessionID, archiveLatencyMs: Date.now() - quiescentAt,
        outcome: after.latestResult.outcome, starts: await passageStarts(sessionID),
        tools: evidence.providerCalls.filter(c => c.sessionID === sessionID).map(c => c.name) }
      assert.equal(after.latestResult.passageID, item.passageID); assert.equal(item.outcome, "completed")
      assert.equal(item.starts.length, 1)
      C.passages.push(item)
    }
    assert.notEqual(C.passages[0].passageID, C.passages[1].passageID)
    assert.notEqual(C.passages[0].sessionID, C.passages[1].sessionID)
    C.rootSessions = (await sessions()).filter(s => !s.parentID).map(s => s.id)
    assert.equal(C.rootSessions.filter(s => C.passages.some(p => p.sessionID === s)).length, 2)
    C.final = await snapshot(id)
    await control(id, "stop")
    C.result = "passed"
  }
  if (journeys.includes("D")) await journeyD()
  if (journeys.includes("G")) {
    // Paused schedule: only the settlement-only observer Job may archive; no Play/Resume.
    stage = "G paused Run now"
    const id = await create("Native paused Run now", nextMinute(6 * 3_600_000))
    const G = evidence.journeys.G = { id, paused: await snapshot(id) }
    assert.equal(G.paused.state, "paused")
    const { result } = await runNow(id); G.accepted = result
    await until(async () => (G.pending = await snapshot(id)).pending?.conversationID)
    const sessionID = G.pending.pending.conversationID
    assert.equal(G.pending.state, "paused")
    await until(() => done(sessionID), 180_000)
    await quiet(sessionID); G.quiescentAt = Date.now()
    stage = "G observer archive without Play/Resume"
    await until(async () => (G.settled = await snapshot(id)).history.length === 1, SETTLE, SLOW)
    G.settledObservedAt = Date.now(); G.archiveLatencyMs = G.settledObservedAt - G.quiescentAt
    assert.equal(G.settled.latestResult.passageID, G.pending.pending.passageID)
    assert.equal(G.settled.latestResult.outcome, "completed")
    assert.equal(G.settled.pending, null); assert.equal(G.settled.state, "paused", "Run now never plays the schedule")
    assert.equal(G.settled.nextDueAt, null)
    G.starts = await passageStarts(sessionID); assert.equal(G.starts.length, 1)
    G.tools = evidence.providerCalls.filter(c => c.sessionID === sessionID).map(c => c.name)
    await control(id, "stop")
    G.result = "passed"
  }
  evidence.outcome = "passed"
} catch (error) {
  evidence.outcome = "failed"; evidence.failedStage = stage; evidence.error = error.message; process.exitCode = 1
  evidence.nativeErrors = output.split("\n").filter(line => /ERROR|WARN|Error:|Cause:|recurrence|codenomad\.missions|job/i.test(line)).slice(-40)
    .map(line => line.replaceAll(env.OPENCODE_SERVER_PASSWORD, "[redacted]"))
} finally {
  // Finish evidence even when settlement times out; read only this fixture's DB.
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(env.OPENCODE_DB, { readOnly: true })
  try {
    evidence.nativePassages = db.prepare("SELECT id,parent_id,project_id,directory FROM session_v2").all().map(s => ({ ...s,
      starts: db.prepare("SELECT id,type FROM session_message WHERE session_id=? AND type IN ('user','synthetic')").all(s.id) }))
  } finally { db.close() }
  hold = false; for (const release of releases) release()
  await closeBackend().catch(error => { evidence.backendCleanupError = error.message })
  if (child && child.exitCode === null) await stop().catch(error => { evidence.serviceCleanupError = error.message; process.exitCode = 1 })
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
  // Native log may contain credentials: retain bounded error labels, never raw logs.
  await writeFile(path.join(root, "qualification.json"), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ root, cliVersion: version, outcome: evidence.outcome, failedStage: evidence.failedStage, error: evidence.error }, null, 2))
}
