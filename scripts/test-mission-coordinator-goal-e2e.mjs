// End-to-end isolated OpenCode 2.4.1 test for the REAL bundled `codenomad.missions` plugin
// coordinator `/goal` lifecycle and unattended restart recovery:
// 1. Prepared mission with `coordinatorGoal: true` does NOT arm `/goal` or create watchdog.
// 2. Play (`lifecycle: start`) arms `/goal` on the coordinator and creates the project-level
//    Code Mode watchdog automation (`codenomad-mission-goal-watchdog`).
// 3. Graceful Pause (`lifecycle: pause, graceful: true`) pauses the owned `/goal`;
//    Resume (`lifecycle: start`) resumes it.
// 4. Closing CodeNomad (removing presence + stopping bridge) + restarting OpenCode `--service` cold:
//    the persistent Code Mode watchdog fires unattended inside OpenCode and resumes the
//    restart-paused `/goal` (adopting the new daemon's `boot`).
// 5. Restoring presence and deleting the mission clears `/goal` and removes the watchdog cleanly.
// Usage: node --import tsx scripts/test-mission-coordinator-goal-e2e.mjs <absolute-opencode-cli>
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { CODENOMAD_MISSIONS_RPC } from "../packages/server/src/missions/rpc.ts"
import { controlResumeAdmissionID } from "../packages/server/src/missions/receipt-identity.ts"
import { COORDINATOR_GOAL_WATCHDOG_NAME } from "../packages/server/src/opencode/missions/native-coordinator-goal.ts"
import { fixtureEnvironment, fixtureParent } from "./native-product-fixture.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass absolute OpenCode CLI path")

const bundlePath = path.resolve("packages/server/dist/plugins/missions/plugin.mjs")
const root = await mkdtemp(path.join(await fixtureParent(), "mission-coord-goal-e2e-"))
const presenceDir = path.join(root, "presence")
const presenceFile = path.join(presenceDir, `${randomUUID()}.lease`)
await mkdir(presenceDir, { recursive: true })
await writeFile(presenceFile, "{}", "utf8")

const password = randomUUID()
const env = await fixtureEnvironment(root, {
  OPENCODE_CONFIG_DIR: path.join(root, "config"),
  OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_FFF: "1",
  OPENCODE_SERVER_PASSWORD: password,
})

const pluginDir = path.join(env.OPENCODE_CONFIG_DIR, "plugins", "codenomad-missions")
await mkdir(pluginDir, { recursive: true })
await writeFile(path.join(pluginDir, "package.json"), JSON.stringify({
  name: "codenomad-missions-e2e-shim",
  type: "module",
  exports: { ".": "./index.mjs" },
  opencode: { server: "./index.mjs" },
}), "utf8")
await writeFile(path.join(pluginDir, "index.mjs"), `
import { desktopPlugin } from ${JSON.stringify(pathToFileURL(bundlePath).href)}
export default desktopPlugin(${JSON.stringify(presenceDir)})
`, "utf8")

let holdTurn = false
const provider = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const tools = Array.isArray(body.tools) ? body.tools : []
    res.setHeader("Content-Type", "text/event-stream")
    if (tools.length === 0) {
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "Fixture Title" }, null], [{}, "stop"]]) {
        res.write(`data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      }
      res.end("data: [DONE]\n\n")
      return
    }
    if (holdTurn) await delay(20_000)
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "E2E_TURN_REPLY" }, null], [{}, "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    }
    res.end("data: [DONE]\n\n")
  } catch (err) {
    res.destroy(err)
  }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))

// Minimal isolated automation bridge for `lifecycle` (`Play` / `Resume`) in this E2E test.
let activeClient = null
const bridgeToken = randomUUID()
const bridge = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    res.setHeader("Content-Type", "application/json")
    if (body.mode === "browser-claim") {
      res.end(JSON.stringify({ ok: true, result: { available: true } }))
      return
    }
    if (body.mode === "mission-input" && body.command?.kind === "lifecycle") {
      const { missionID, operationID, sessionID, startText } = body.command.input
      const admission = await activeClient.session.synthetic({
        sessionID,
        id: controlResumeAdmissionID(operationID, sessionID),
        text: startText ?? "Begin the mission.",
        description: "Mission start",
        metadata: { "codenomad.mission": { version: 1, missionID, operationID, kind: "lifecycle" } },
        delivery: "queue",
        resume: true,
      })
      res.end(JSON.stringify({ ok: true, result: { nativeAcknowledgement: { missionID, operationID, sessionID, action: "start", disposition: "start-admitted", admission } } }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, error: "Unsupported mock bridge mode" }))
  } catch (err) {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  }
})
await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve))

const bridgeDir = path.join(env.LOCALAPPDATA, "CodeNomad", "automation-bridges")
await mkdir(bridgeDir, { recursive: true })
const bridgeStartedAt = Date.now()
const bridgeFile = path.join(bridgeDir, `${bridgeStartedAt}-${process.pid}-e2e.json`)
await writeFile(bridgeFile, JSON.stringify({
  version: 1,
  pid: process.pid,
  startedAt: bridgeStartedAt,
  url: `http://127.0.0.1:${bridge.address().port}/api/opencode-plugin/automation`,
  token: bridgeToken,
}), "utf8")

env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  automations: true,
  plugins: [pluginDir],
  model: "fixture/fixture",
  providers: {
    fixture: {
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" },
      models: { fixture: {} },
    },
  },
})

async function startDaemon(label) {
  let output = "", spawnError
  const child = spawn(cli, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.on("error", err => { spawnError = err })
  child.stdout.on("data", d => { output += d })
  child.stderr.on("data", d => { output += d })
  const deadline = Date.now() + 30_000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`${label} failed:\n${output.slice(-2000)}`)
    await delay(25)
  }
  const file = path.join(env.XDG_STATE_HOME, "opencode/service.json")
  let endpoint
  while (!endpoint && Date.now() < deadline) {
    try {
      if (JSON.parse(await readFile(file, "utf8")).pid === child.pid) endpoint = await Service.discover({ file })
    } catch {}
    if (!endpoint) await delay(25)
  }
  assert(endpoint, `${label} did not register isolated service.json`)
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  activeClient = client
  const callOpts = { location: { directory: root }, headers: { "x-opencode-directory": root } }
  const getGoal = async sessionID => {
    const end = Date.now() + 15_000
    while (true) {
      try {
        return (await client.rpc.call({ rpcID: "opencode.goal", method: "get", input: { sessionID }, location: { directory: root } }, { headers: { "x-opencode-directory": root } })).output
      } catch (error) {
        if (error?._tag === "RpcError" && error?.type === "rpc.unavailable" && Date.now() < end) { await delay(100); continue }
        throw error
      }
    }
  }
  return {
    child, stopped, client, callOpts, getGoal,
    missionsRpc: () => client.rpc(CODENOMAD_MISSIONS_RPC),
    stop: async () => { await stopFixtureChild(child, stopped); await writeFile(path.join(root, `daemon-${label}.log`), output) },
  }
}

const readWatchdogs = () => {
  const db = new DatabaseSync(env.OPENCODE_DB, { open: true, readOnly: true })
  try {
    return db.prepare("SELECT id, name, status, run_count, last_outcome, last_output FROM automation WHERE name = ?").all(COORDINATOR_GOAL_WATCHDOG_NAME)
  } finally {
    db.close()
  }
}

let d1, d2
try {
  d1 = await startDaemon("1")
  const readyEnd = Date.now() + 20_000
  while (Date.now() < readyEnd) {
    try { await d1.missionsRpc().snapshot({}, d1.callOpts); break }
    catch { await delay(150) }
  }

  // 1. Prepared mission does NOT arm `/goal` or create watchdog.
  const created = await d1.missionsRpc().create({
    requestID: "req_goal_e2e_1",
    objective: "Keep working across restart",
    title: "Restart E2E",
    template: "custom",
    prepared: true,
    coordinatorGoal: true,
  }, d1.callOpts)
  const missionID = created.mission.id
  const coordSessionID = created.mission.coordinatorSessionId
  assert.equal(created.mission.coordinatorGoal, true)
  await delay(300)
  assert.equal(await d1.getGoal(coordSessionID), null, "Prepared mission must NOT arm /goal before Play")
  assert.equal(readWatchdogs().length, 0, "Prepared mission must NOT create watchdog before Play")
  console.log("PASS E2E 1 (prepared mission does not arm /goal or watchdog)")

  // 2. Play (`lifecycle: start`) arms `/goal` and creates the persistent Code Mode watchdog.
  holdTurn = true
  const played = await d1.missionsRpc().lifecycle({
    missionID,
    requestID: "play_1",
    expectedRevision: created.mission.revision,
    action: "start",
  }, d1.callOpts)
  let armedGoal = null
  const armEnd = Date.now() + 15_000
  while (Date.now() < armEnd) {
    armedGoal = await d1.getGoal(coordSessionID)
    if (armedGoal?.status === "active") break
    await delay(150)
  }
  assert.equal(armedGoal?.status, "active", "Play automatically armed /goal on coordinator")
  assert.ok(armedGoal.objective.includes("Restart E2E") && armedGoal.objective.includes("mission.report"))
  const watchdogsBefore = readWatchdogs()
  assert.equal(watchdogsBefore.length, 1, "Watchdog automation created after Play")
  assert.equal(watchdogsBefore[0].status, "active")
  console.log("PASS E2E 2 (Play auto-armed /goal + created Code Mode watchdog, boot=", armedGoal.boot, ")")

  // 3. Graceful Pause pauses owned `/goal`; Resume resumes it.
  const paused = await d1.missionsRpc().lifecycle({
    missionID,
    requestID: "pause_1",
    expectedRevision: played.mission.revision,
    action: "pause",
    graceful: true,
  }, d1.callOpts)
  const goalAfterPause = await d1.getGoal(coordSessionID)
  assert.equal(goalAfterPause?.status, "paused", "Graceful Pause paused owned /goal")

  const resumed = await d1.missionsRpc().lifecycle({
    missionID,
    requestID: "resume_1",
    expectedRevision: paused.mission.revision,
    action: "start",
  }, d1.callOpts)
  const goalAfterResume = await d1.getGoal(coordSessionID)
  assert.equal(goalAfterResume?.status, "active", "Mission Resume resumed owned /goal")
  console.log("PASS E2E 3 (Graceful Pause paused /goal and Resume resumed it)")

  // 4. Close CodeNomad (remove presence + bridge registration) and restart OpenCode `--service` cold!
  await rm(presenceFile, { force: true })
  await rm(bridgeFile, { force: true })
  await d1.stop(); d1 = null
  holdTurn = false
  d2 = await startDaemon("2")

  const pausedAfterRestart = await d2.getGoal(coordSessionID)
  assert.equal(pausedAfterRestart?.status, "paused")
  assert.equal(pausedAfterRestart?.boot, armedGoal.boot)
  assert.equal(pausedAfterRestart?.reason, "The server restarted while the goal was active")

  let recovered = null
  const watchStart = Date.now()
  const watchDeadline = watchStart + 85_000
  while (Date.now() < watchDeadline) {
    recovered = await d2.getGoal(coordSessionID)
    if (recovered && recovered.boot !== armedGoal.boot) break
    await delay(500)
  }
  console.log(`[E2E 4] unattended recovery took ${Date.now() - watchStart}ms:`, recovered)
  assert.ok(recovered && recovered.boot !== armedGoal.boot, "Bundled codenomad.missions watchdog resumed /goal unattended across restart!")
  console.log("PASS E2E 4 (unattended real plugin watchdog resumed /goal with CodeNomad closed!)")

  // 5. Restore presence, delete mission, and verify watchdog automation is removed cleanly.
  await writeFile(presenceFile, "{}", "utf8")
  const snapEnd = Date.now() + 20_000
  let snap
  while (Date.now() < snapEnd) {
    try { snap = await d2.missionsRpc().snapshot({}, d2.callOpts); break }
    catch { await delay(150) }
  }
  const live = snap.missions.find(m => m.id === missionID)
  await d2.missionsRpc().delete({
    missionID: live.id,
    requestID: "del_1",
    expectedRevision: live.revision,
    deleteManagedSessions: false,
  }, d2.callOpts)
  await delay(500)
  assert.equal(readWatchdogs().length, 0, "Watchdog automation removed automatically once no active goal missions remain")
  console.log("PASS E2E 5 (watchdog automation cleaned up automatically after mission deletion!)")
} finally {
  if (d1) await d1.stop().catch(() => {})
  if (d2) await d2.stop().catch(() => {})
  bridge.closeAllConnections()
  await new Promise(resolve => bridge.close(resolve))
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
}
