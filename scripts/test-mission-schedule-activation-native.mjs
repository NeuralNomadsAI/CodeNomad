// Production HTTP preparation + production native RPC/CAS, private service only.
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
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { NativeScheduleSettingsActivation } from "../packages/server/src/opencode/native-schedule-settings-activation.ts"
import { registerMissionRoutes } from "../packages/server/src/server/routes/missions.ts"
import { WorktreeDeletionFence } from "../packages/server/src/workspaces/worktree-session-evacuation.ts"
import { NativeMissionDocumentStore } from "../packages/server/src/missions/mission-document-store.ts"

const scratch = process.argv[3]
assert.ok(scratch && path.isAbsolute(scratch), "Pass the approved activation scratch")
await mkdir(scratch, { recursive: true })
Object.assign(process.env, { TEMP: scratch, TMP: scratch, LOCALAPPDATA: scratch, APPDATA: scratch })
await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) process.env[key] = root
  await writeFile(path.join(configDirectory, "opencode.jsonc"), '{"experimental":{"schedules":false,"subagent_depth":2},"fixturePrivate":"DO-NOT-PERSIST"}\n')
  await mkdir(path.join(root, ".opencode"))
  await writeFile(path.join(root, ".opencode", "opencode.jsonc"), '{"experimental":{"subagent_depth":8}}\n')
  return { update: "disable", snapshots: false, permissions: [{ action: "*", resource: "*", effect: "allow" }] }
}, async ({ client, root, requests, connection }) => {
  const info = await client.server.info()
  assert.equal(info.version, "2.2.3")
  rememberRuntime(connection.endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  const manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(),
    settings: { getOwner: () => ({ environmentVariables: {} }), readEnvironmentForAdmission: async () => ({}) },
    binaryResolver: { resolveDefault: () => ({ path: process.argv[2], label: "Private activation fixture" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => connection.endpoint, ensure: async () => connection.endpoint }),
  })
  const app = Fastify(), plugin = new DesktopPluginLifecycle("missions"), receipt = { runtime: info.version, root, status: "running" }
  try {
    const { workspace } = await manager.create(root), current = await manager.getSharedServiceConnection(workspace.id)
    const paths = await resolveDesktopPluginPaths(current, { kind: "host", platform: process.platform, binary: process.argv[2] })
    assert.ok(paths.config.startsWith(root))
    await plugin.start(paths)
    const location = manager.getServiceLocation(workspace.id), placed = await client.location.get({ location })
    const end = Date.now() + 30_000
    while (!(await client.plugin.list({ location })).data.some(entry => entry.id === "codenomad.missions" && entry.state.status === "active")) {
      if (Date.now() > end) throw Error("Private Missions plugin unavailable")
      await delay(100)
    }
    // Controlled bootstrap of a paused scheduled document, using the domain codec.
    // Scheduled creation/arming is CORE; every phase after this seed uses the real RPC.
    const db = new DatabaseSync(path.join(root, "fixture.db"))
    const nativeKey = key => `plugin:${Array.from("codenomad.missions").map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
    try {
      const documents = new NativeMissionDocumentStore({
        get: async key => { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(nativeKey(key)); return row && JSON.parse(row.value) },
        compareAndSet: async (key, value, expected, guard) => {
          db.exec("BEGIN IMMEDIATE")
          try {
            guard(); const prior = db.prepare("SELECT value FROM kv WHERE key=?").get(nativeKey(key))
            assert.equal(prior ? JSON.parse(prior.value).revision : null, expected)
            db.prepare("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?)").run(nativeKey(key), JSON.stringify(value), Date.now(), Date.now())
            db.exec("COMMIT")
          } catch (error) { db.exec("ROLLBACK"); throw error }
        },
      }, placed.project.id, placed.project.canonical)
      const selected = { agent: "build", model: { providerID: "fixture", id: "fixture" } }
      await documents.create("msn_activation_native", { title: "Prepared schedule", objective: "Fixture preparation only", template: "custom",
        taskMode: "native", profileID: "fixture-profile", executionHost: "host", roots: [{ mode: "directory-only", directory: placed.directory }],
        profiles: { coordinator: selected, roles: { specialist: selected } }, watchedConversationIDs: [],
        launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { at: null, afterMs: null, maxLaunches: null } },
      }, Date.now(), () => true)
    } finally { db.close() }
    const fence = new WorktreeDeletionFence(), controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: fence, logger: pino({ level: "silent" }) })
    const executor = new NativeScheduleSettingsActivation(controls, manager)
    let lose = true
    registerMissionRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence, scheduleSettingsActivation: {
      prepare: (...args) => executor.prepare(...args), apply: (id, loc, intent, journal) => executor.apply(id, loc, intent, {
        ...journal, acknowledged: async (scope, digest) => {
          await journal.acknowledged(scope, digest)
          if (scope === "global" && lose) { lose = false; throw Error("lost native activation reply") }
        },
      }),
    } })
    const url = `/api/workspaces/${workspace.id}/missions/msn_activation_native/schedule-settings`
    const payload = { requestID: "activate-original", expectedDocumentRevision: 0 }
    const first = await app.inject({ method: "POST", url, payload })
    assert.equal(first.statusCode, 503, first.body)
    const read = await app.inject({ method: "GET", url: `${url}?requestID=activate-original&expectedDocumentRevision=0` })
    assert.equal(read.statusCode, 200, read.body)
    receipt.partial = read.json().document
    assert.equal(receipt.partial.state, "paused"); assert.equal(receipt.partial.scheduleActivation.state, "failed")
    assert.equal(receipt.partial.scheduleActivation.targets[0].acknowledged, true)
    assert.equal(receipt.partial.scheduleActivation.targets[1].attempted, false)
    const retry = await app.inject({ method: "POST", url, payload })
    assert.equal(retry.statusCode, 200, retry.body)
    receipt.ready = retry.json().document
    assert.equal(receipt.ready.state, "paused"); assert.equal(receipt.ready.firstPlayedAt, null); assert.equal(receipt.ready.launchedCount, 0)
    assert.equal(receipt.ready.scheduleActivation.state, "ready")
    const repeated = await app.inject({ method: "POST", url, payload })
    assert.equal(repeated.statusCode, 200, repeated.body)
    assert.equal(repeated.json().document.revision, receipt.ready.revision)
    assert.equal(requests.length, 0)
    assert.ok(!JSON.stringify(receipt).includes("DO-NOT-PERSIST"))
    receipt.status = "passed"
    console.log("PASS production HTTP + native document RPC/CAS: both config files, durable attempts/ACKs, lost reply reconciliation, positive native read, paused throughout, zero model HTTP")
  } catch (error) { receipt.status = "failed"; receipt.error = error.message; throw error }
  finally { await plugin.stop(); await app.close(); await manager.shutdown()
    await writeFile(path.join(root, "schedule-activation-receipt.json"), JSON.stringify(receipt, null, 2)) }
}, { projectConfig: true })
