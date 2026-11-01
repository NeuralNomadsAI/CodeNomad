import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { parse } from "jsonc-parser"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { applyMissionDocumentActivation } from "../../missions/mission-document-activation-rpc"
import type { MissionJsonValue } from "../../missions/model"
import { PluginControls } from "../../opencode/plugin-controls"
import { nativeScheduleContractFixture } from "../../opencode/native-schedule-capability-fixture"
import { NativeScheduleSettingsActivation } from "../../opencode/native-schedule-settings-activation"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionScheduleActivation } from "./mission-schedule-activation"

async function fixture(run: (f: any) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "activation-route-")), app = Fastify()
  const global = path.join(root, "global"), project = path.join(root, "project")
  await mkdir(global); await mkdir(project)
  const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, "opencode.jsonc")
  await writeFile(globalFile, '{"experimental":{"schedules":false,"subagent_depth":2},"private":"must-stay-out-of-document"}')
  await writeFile(projectFile, '{"experimental":{"subagent_depth":8}}')
  const values = new Map<string, MissionJsonValue>(), phases: string[] = []
  const documents = new NativeMissionDocumentStore({ get: async key => structuredClone(values.get(key)),
    compareAndSet: async (key, value, expected, current) => {
      current(); const prior = values.get(key) as { revision: number } | undefined
      if ((prior?.revision ?? null) !== expected) throw Error("CAS conflict")
      values.set(key, structuredClone(value))
    },
  }, "project", project)
  const selection = { agent: "worker", model: { providerID: "fixture", id: "fixture" } }
  await documents.create("msn_scheduled", { title: "Prepared schedule", objective: "Work", template: "custom", taskMode: "native",
    profileID: "fixture-profile", executionHost: "host", roots: [{ mode: "directory-only", directory: project }],
    watchedConversationIDs: [], profiles: { coordinator: selection, roles: { specialist: selection } },
    launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { at: null, afterMs: null, maxLaunches: null } },
  }, Date.now(), () => true)
  let owned = true, current = true, lose = false
  const connection: any = { endpoint: { url: "http://127.0.0.1:1234" }, assertCurrent() { if (!current) throw Error("retired") },
    fetch: async () => Response.json(nativeScheduleContractFixture()), client: {
      location: { get: async () => ({ directory: project, project: { id: "project", canonical: project, directory: project } }) },
      plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      config: { get: async () => [{ type: "document", path: globalFile, info: parse(await readFile(globalFile, "utf8")) },
        { type: "directory", path: global }, { type: "document", path: projectFile, info: parse(await readFile(projectFile, "utf8")) }] },
      rpc: () => ({ documentCapabilities: async () => ({ version: 1 }), documentActivation: async (input: any) => {
        phases.push(input.action)
        const result = await applyMissionDocumentActivation(documents, input, () => true, project)
        if (lose && input.action === "acknowledged" && input.scope === "global") { lose = false; throw Error("lost native reply") }
        return result
      } }),
    } }
  const workspace = { id: "w" }, fence = new WorktreeDeletionFence()
  const manager: any = { get: () => workspace, getSharedServiceConnection: async () => connection,
    getServiceLocation: () => ({ directory: project }), getServiceDirectoryForPath: async (_id: string, dir: string) => dir === project ? dir : undefined,
    ownsLocation: async () => owned, getWorktreeIdentityForPath: async () => "owned-physical-root",
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix", getServiceWslDistro: () => undefined,
    getHostPathForServicePath: async (_id: string, value: string) => value }
  const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: fence, logger: {} as any })
  app.addHook("onRequest", async (request, reply) => { if (request.headers.authorization !== "Bearer fixture") return reply.code(401).send() })
  registerMissionScheduleActivation(app, { workspaceManager: manager, worktreeDeletionFence: fence,
    scheduleSettingsActivation: new NativeScheduleSettingsActivation(controls, manager) })
  const url = "/api/workspaces/w/missions/msn_scheduled/schedule-settings"
  const headers = { authorization: "Bearer fixture" }, payload = { requestID: "activate-original", expectedDocumentRevision: 0 }
  try { await run({ app, url, headers, payload, documents, values, phases, globalFile, projectFile,
    owned: (value: boolean) => { owned = value }, current: (value: boolean) => { current = value }, lose: () => { lose = true } }) }
  finally { await app.close(); await chmod(globalFile, 0o600).catch(() => {}); await rm(root, { recursive: true, force: true }) }
}

test("HTTP preparation composes actual durable RPC phases with both config effects and keeps the mission paused", async () => fixture(async f => {
  const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(response.statusCode, 200, response.body)
  const doc = response.json().document
  assert.equal(doc.state, "paused"); assert.equal(doc.firstPlayedAt, null); assert.equal(doc.launchedCount, 0)
  assert.equal(doc.scheduleActivation.state, "ready")
  assert.ok(doc.scheduleActivation.targets.every((target: any) => target.attempted && target.acknowledged))
  assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).experimental, { schedules: true, subagent_depth: 2 })
  assert.deepEqual(parse(await readFile(f.projectFile, "utf8")).experimental, { subagent_depth: 8, schedules: true })
  assert.ok(!JSON.stringify([...f.values]).includes("must-stay-out-of-document"))
  const repeat = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(repeat.statusCode, 200, repeat.body)
  assert.equal(repeat.json().document.revision, doc.revision, "an exact completed replay makes no new publication")
  const before = JSON.stringify([...f.values])
  const status = await f.app.inject({ method: "GET", url: `${f.url}?requestID=activate-original&expectedDocumentRevision=0`, headers: f.headers })
  assert.equal(status.statusCode, 200)
  assert.equal(JSON.stringify([...f.values]), before, "status is read-only")
}))

test("lost native acknowledgement exposes a partial intention and explicit same-request reconciliation finishes only the remaining write", async () => fixture(async f => {
  f.lose()
  const first = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(first.statusCode, 503)
  const partial = await f.documents.read("msn_scheduled")
  assert.equal(partial.state, "paused"); assert.equal(partial.scheduleActivation.state, "failed")
  assert.equal(partial.scheduleActivation.targets[0].acknowledged, true)
  assert.equal(partial.scheduleActivation.targets[1].attempted, false)
  assert.equal(parse(await readFile(f.projectFile, "utf8")).experimental.schedules, undefined)
  const retry = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(retry.statusCode, 200, retry.body)
  assert.equal(retry.json().document.scheduleActivation.state, "ready")
}))

test("route ownership, authentication, revision and input boundaries refuse before any config effect", async () => fixture(async f => {
  const before = await readFile(f.globalFile, "utf8")
  assert.equal((await f.app.inject({ method: "POST", url: f.url, payload: f.payload })).statusCode, 401)
  assert.equal((await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: { ...f.payload, path: "/foreign" } })).statusCode, 400)
  assert.equal((await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: { ...f.payload, expectedDocumentRevision: 99 } })).statusCode, 409)
  f.owned(false)
  assert.equal((await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })).statusCode, 403)
  assert.equal(await readFile(f.globalFile, "utf8"), before)
  assert.equal((await f.documents.read("msn_scheduled")).scheduleActivation, null)
}))
