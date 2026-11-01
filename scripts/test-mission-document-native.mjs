// Actual installed bundle, HTTP creation/control, native SQLite and local provider.
// Explicit private runtime only; no shared discovery, settings or daemon lifecycle.
import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import Fastify from "fastify"
import pino from "pino"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { WorkspaceManager } from "../packages/server/src/workspaces/manager.ts"
import { EventBus } from "../packages/server/src/events/bus.ts"
import { rememberRuntime } from "../packages/server/src/opencode/compatibility/runtime.ts"
import { DesktopPluginLifecycle } from "../packages/server/src/opencode/desktop-plugin-lifecycle.ts"
import { resolveDesktopPluginPaths } from "../packages/server/src/opencode/desktop-plugin-paths.ts"
import { createAutomationBridgeRegistration, publishAutomationBridge } from "../packages/server/src/opencode/automation-plugin.ts"
import { registerAutomationPluginRoute } from "../packages/server/src/server/routes/automation-plugin.ts"
import { registerMissionRoutes } from "../packages/server/src/server/routes/missions.ts"
import { WorktreeDeletionFence } from "../packages/server/src/workspaces/worktree-session-evacuation.ts"
import { CODENOMAD_MISSIONS_RPC } from "../packages/server/src/missions/rpc.ts"

const scratch = process.argv[3]
assert.ok(scratch && path.isAbsolute(scratch), "Pass the explicit approved schema scratch directory")
await mkdir(scratch, { recursive: true })
Object.assign(process.env, { TEMP: scratch, TMP: scratch, LOCALAPPDATA: scratch, APPDATA: scratch })
await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) process.env[key] = root
  await writeFile(path.join(configDirectory, "opencode.json"), '{}\n')
  return { update: "disable", snapshots: false, experimental: { schedules: false }, permissions: [{ action: "*", resource: "*", effect: "allow" }] }
}, async ({ client, root, requests, connection }) => {
  const info = await client.server.info()
  assert.equal(info.version, "2.2.3", "This fixture qualifies the requested isolated runtime")
  rememberRuntime(connection.endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  const manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(),
    settings: { getOwner: () => ({ environmentVariables: {} }), readEnvironmentForAdmission: async () => ({}) },
    binaryResolver: { resolveDefault: () => ({ path: process.argv[2], label: "Private document fixture" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => connection.endpoint, ensure: async () => connection.endpoint }),
  })
  const bridge = Fastify(), plugin = new DesktopPluginLifecycle("missions")
  let removeBridge
  const receipt = { runtime: { version: info.version, pid: info.pid }, root, status: "running", gates: [] }
  try {
    const { workspace } = await manager.create(root)
    const current = await manager.getSharedServiceConnection(workspace.id)
    const paths = await resolveDesktopPluginPaths(current, { kind: "host", platform: process.platform, binary: process.argv[2] })
    assert.ok(paths.config.startsWith(root), "Provision only the private config")
    const configFile = path.join(paths.config, "opencode.json"), configBefore = await readFile(configFile, "utf8")
    const fence = new WorktreeDeletionFence(), registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
    registerMissionRoutes(bridge, { workspaceManager: manager, worktreeDeletionFence: fence })
    registerAutomationPluginRoute(bridge, { workspaceManager: manager, worktreeDeletionFence: fence,
      authManager: { isLoopbackRequest: () => true }, bridgeToken: registration.token, nativeParent: {}, developerCdp: {} })
    await bridge.listen({ host: "127.0.0.1", port: 0 })
    registration.url = `http://127.0.0.1:${bridge.server.address().port}/api/opencode-plugin/automation`
    removeBridge = await publishAutomationBridge(registration)
    await plugin.start(paths)
    const location = manager.getServiceLocation(workspace.id), rpc = client.rpc(CODENOMAD_MISSIONS_RPC)
    const until = async check => {
      const end = Date.now() + 30_000
      do { if (await check()) return; await delay(100) } while (Date.now() < end)
      throw new Error("Private document fixture timed out")
    }
    await until(async () => (await client.plugin.list({ location })).data.some(entry => entry.id === "codenomad.missions" && entry.state.status === "active"))
    const url = `/api/workspaces/${workspace.id}/missions`, input = { requestId: "document-create-original", objective: "Perform the original mission", template: "custom" }
    const response = await bridge.inject({ method: "POST", url, payload: input })
    assert.equal(response.statusCode, 200, response.body)
    const created = response.json().mission
    assert.equal(created.runState, "prepared")
    assert.equal(created.document.state, "paused")
    assert.equal(created.document.firstPlayedAt, null)
    assert.equal(created.document.launchedCount, 0)
    assert.deepEqual(created.document.launch.timing, { kind: "immediate" })
    assert.equal(created.document.scheduleActivation, null)
    const activationIdentity = { missionID: created.id, requestID: "activation-is-not-immediate", expectedRevision: created.document.revision }
    const activationRead = await rpc.documentActivation({ ...activationIdentity, action: "read" }, { location })
    assert.equal(activationRead.document.scheduleActivation, null)
    await assert.rejects(rpc.documentActivation({ ...activationIdentity, action: "prepare", authority: "a".repeat(64), targets: [] }, { location }))
    await delay(250)
    assert.equal(requests.length, 0, "Creation causes zero provider requests")
    const db = new DatabaseSync(path.join(root, "fixture.db"), { readOnly: true })
    try {
      const records = db.prepare("SELECT value FROM kv WHERE instr(key,'codenomad-missions/documents-v1/project/')>0").all()
      const saved = records.map(row => JSON.parse(row.value)).find(value => value.id === created.id)
      assert.equal(saved.oneTime.creationRequestID, input.requestId)
      assert.equal(saved.state, "paused")
      assert.equal(saved.oneTime.firstPlay, null)
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%schedule%'").all())
        assert.equal(db.prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count, 0)
    } finally { db.close() }
    receipt.gates.push("HTTP creation is paused in native KV; zero provider requests/calendars/activation")
    const replay = await bridge.inject({ method: "POST", url, payload: input })
    assert.equal(replay.statusCode, 200, replay.body)
    assert.equal(replay.json().mission.coordinatorSessionId, created.coordinatorSessionId)
    const command = { action: "start", requestId: "document-play-original", expectedRevision: created.revision }
    const played = await bridge.inject({ method: "POST", url: `${url}/${created.id}/control`, payload: command })
    assert.equal(played.statusCode, 200, played.body)
    assert.equal(played.json().mission.document.launchedCount, 1)
    await until(() => requests.some(request => JSON.stringify(request.messages).includes(`Start or resume existing mission ${created.id}`)))
    await client.session.wait({ sessionID: created.coordinatorSessionId }, { signal: AbortSignal.timeout(20_000) })
    const count = requests.length
    const playReplay = await bridge.inject({ method: "POST", url: `${url}/${created.id}/control`, payload: command })
    assert.equal(playReplay.statusCode, 200, playReplay.body)
    await delay(250)
    assert.equal(requests.length, count, "Exact Play replay adds no native turn")
    const read = await bridge.inject({ method: "GET", url: `${url}/${created.id}` })
    assert.equal(read.statusCode, 200, read.body)
    assert.equal(read.json().mission.document.firstPlay.requestID, command.requestId)
    assert.equal(read.json().mission.document.launchedCount, 1)
    assert.ok(read.json().mission.document.firstPlay.admittedAt !== null)
    assert.equal((await rpc.snapshot({}, { location })).missions[0].document.firstPlay.messageID,
      read.json().mission.document.firstPlay.messageID)
    assert.equal(await readFile(configFile, "utf8"), configBefore, "Immediate Play leaves config activation untouched")
    receipt.gates.push("HTTP Play uses original native message once; replay/reopen/RPC reads preserve identity and count")
    receipt.status = "passed"
    console.log(`PASS native ${info.version}: unified create/Play via installed bundle, native CAS, original requests, config schedules OFF, zero pre-Play provider calls`)
  } catch (error) { receipt.status = "failed"; receipt.error = error.message; throw error }
  finally {
    await removeBridge?.(); await plugin.stop(); await bridge.close(); await manager.shutdown()
    await writeFile(path.join(root, "mission-document-receipt.json"), JSON.stringify(receipt, null, 2))
  }
})
