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
  await writeFile(globalFile, '{"experimental":{"subagent_depth":2},"private":"must-stay-out-of-document"}')
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
  let afterPhase: ((action: string) => Promise<void>) | undefined
  const connection: any = { endpoint: { url: "http://127.0.0.1:1234" }, assertCurrent() { if (!current) throw Error("retired") },
    fetch: async () => Response.json(nativeScheduleContractFixture()), client: {
      location: { get: async () => ({ directory: project, project: { id: "project", canonical: project, directory: project } }) },
      plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      config: { get: async () => [{ type: "document", path: globalFile, info: parse(await readFile(globalFile, "utf8")) },
        { type: "directory", path: global }, { type: "document", path: projectFile, info: parse(await readFile(projectFile, "utf8")) }] },
      rpc: () => ({ documentCapabilities: async () => ({ version: 1 }),
        // The highest document that sets the top-level setting decides; a block saved for an earlier runtime keeps it off.
        scheduleSetting: async () => {
          for (const file of [projectFile, globalFile]) {
            const info = parse(await readFile(file, "utf8"))
            if (typeof info.automations === "boolean") return { enabled: info.automations, provenance: "automations-setting", path: file, hiddenOff: [] }
            if ((info.experimental?.automations ?? info.experimental?.schedules) === false)
              return { enabled: false, provenance: "experimental-block", path: file, hiddenOff: [] }
          }
          return { enabled: true, provenance: "channel-default", hiddenOff: [] }
        },
        documentActivation: async (input: any) => {
        phases.push(input.action)
        const result = await applyMissionDocumentActivation(documents, input, () => true, project)
        await afterPhase?.(input.action)
        if (lose && input.action === "ready") { lose = false; throw Error("lost native reply") }
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
    afterPhase: (callback: typeof afterPhase) => { afterPhase = callback },
    owned: (value: boolean) => { owned = value }, current: (value: boolean) => { current = value }, lose: () => { lose = true } }) }
  finally { await app.close(); await chmod(globalFile, 0o600).catch(() => {}); await rm(root, { recursive: true, force: true }) }
}

test("HTTP preparation composes durable RPC phases, writes no configuration and keeps the mission paused", async () => fixture(async f => {
  const files = await Promise.all([f.globalFile, f.projectFile].map(file => readFile(file, "utf8")))
  const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(response.statusCode, 200, response.body)
  const doc = response.json().document
  assert.equal(doc.state, "paused"); assert.equal(doc.firstPlayedAt, null); assert.equal(doc.launchedCount, 0)
  assert.equal(doc.scheduleActivation.state, "ready")
  assert.deepEqual(doc.scheduleActivation.targets, [])
  assert.deepEqual(f.phases, ["read", "prepare", "ready", "read"])
  assert.deepEqual(await Promise.all([f.globalFile, f.projectFile].map(file => readFile(file, "utf8"))), files)
  assert.ok(!JSON.stringify([...f.values]).includes("must-stay-out-of-document"))
  const repeat = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(repeat.statusCode, 200, repeat.body)
  assert.equal(repeat.json().document.revision, doc.revision, "an exact completed replay makes no new publication")
  const before = JSON.stringify([...f.values])
  const status = await f.app.inject({ method: "GET", url: `${f.url}?requestID=activate-original&expectedDocumentRevision=0`, headers: f.headers })
  assert.equal(status.statusCode, 200)
  assert.equal(JSON.stringify([...f.values]), before, "status is read-only")
}))

test("a lost readiness reply leaves the request unconfirmed and its exact retry answers the recorded proof", async () => fixture(async f => {
  f.lose()
  const first = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(first.statusCode, 503)
  assert.equal(first.json().code, "schedule-activation-pending")
  const recorded = await f.documents.read("msn_scheduled")
  assert.equal(recorded.state, "paused"); assert.equal(recorded.scheduleActivation.state, "ready")
  const retry = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(retry.statusCode, 200, retry.body)
  assert.deepEqual(retry.json().document.scheduleActivation, recorded.scheduleActivation)
  assert.equal(retry.json().document.revision, recorded.revision)
}))

test("a ready proof is preserved read-only by a fresh preparation, and a later OFF refuses without replacing it", async () => fixture(async f => {
  const original = await readFile(f.projectFile, "utf8")
  const first = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(first.statusCode, 200, first.body)
  const before = first.json().document
  assert.equal(before.scheduleActivation.state, "ready")
  assert.deepEqual(before.scheduleActivation.targets, [])
  const next = await f.app.inject({ method: "POST", url: f.url, headers: f.headers,
    payload: { requestID: "fresh-request", expectedDocumentRevision: before.revision } })
  assert.equal(next.statusCode, 200, next.body)
  assert.deepEqual(next.json().document, before)
  assert.equal(await readFile(f.projectFile, "utf8"), original)
  await writeFile(f.projectFile, '{"automations":false}')
  const refused = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(refused.statusCode, 403, refused.body)
  assert.equal(refused.json().code, "schedule-activation-refused")
  assert.equal(refused.json().notApplied, undefined, "the ready original identity remains retained")
  assert.deepEqual((await f.documents.read("msn_scheduled")).scheduleActivation, before.scheduleActivation)
}))

test("an explicit hidden global OFF returns its layer/path without editor authorization or writes", async () => fixture(async f => {
  await writeFile(f.globalFile, '{"experimental":{"schedules":false}}')
  await writeFile(f.projectFile, '{"automations":true}')
  const before = await f.documents.read("msn_scheduled")
  const files = await Promise.all([f.globalFile, f.projectFile].map(file => readFile(file, "utf8")))
  const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(response.statusCode, 403, response.body)
  assert.equal(response.json().code, "schedule-activation-refused")
  assert.deepEqual(response.json().refusal, { reason: "explicit-off", provenance: "experimental-block",
    layer: "global", path: f.globalFile, openable: false })
  assert.deepEqual(response.json().notApplied, { requestID: f.payload.requestID, expectedRevision: 0 })
  assert.deepEqual(await f.documents.read("msn_scheduled"), before)
  assert.deepEqual(f.phases, ["read"], "no mutation is attempted for a definitive refusal")
  assert.deepEqual(await Promise.all([f.globalFile, f.projectFile].map(file => readFile(file, "utf8"))), files)
  await writeFile(f.globalFile, '{"experimental":{"subagent_depth":2}}')
  const next = await f.app.inject({ method: "POST", url: f.url, headers: f.headers,
    payload: { requestID: "explicit-after-correction", expectedDocumentRevision: 0 } })
  assert.equal(next.statusCode, 200, next.body)
  assert.equal(next.json().document.state, "paused")
}))

test("OFF after intent preparation and on its exact retry retains uncertainty without no-effect proof", async () => fixture(async f => {
  f.afterPhase(async (action: string) => {
    if (action === "prepare") await writeFile(f.projectFile, '{"automations":false}')
  })
  const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(response.statusCode, 403, response.body)
  assert.equal(response.json().code, "schedule-activation-refused")
  assert.equal(response.json().notApplied, undefined)
  const doc = await f.documents.read("msn_scheduled")
  assert.equal(doc.scheduleActivation.requestID, f.payload.requestID)
  assert.equal(doc.scheduleActivation.state, "failed")
  const retry = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(retry.statusCode, 403, retry.body)
  assert.equal(retry.json().notApplied, undefined)
}))

test("a ready proof stored with configuration targets retains its original identity and digests on fresh preparation", async () => fixture(async f => {
  const first = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(first.statusCode, 200, first.body)
  const doc = await f.documents.read("msn_scheduled")
  const legacy = await f.documents.change(doc.id, doc.revision, () => true, (next: any) => {
    next.scheduleActivation.targets = [
      { scope: "global", path: f.globalFile }, { scope: "project", path: f.projectFile },
    ].map(target => ({ ...target, expectation: "a".repeat(64), resultDigest: "b".repeat(64), attempted: true, acknowledged: true }))
  })
  const global = await readFile(f.globalFile, "utf8"), project = await readFile(f.projectFile, "utf8")
  const refreshed = await f.app.inject({ method: "POST", url: f.url, headers: f.headers,
    payload: { requestID: "new-ready-verification", expectedDocumentRevision: legacy.revision } })
  assert.equal(refreshed.statusCode, 200, refreshed.body)
  assert.deepEqual(refreshed.json().document.scheduleActivation, legacy.scheduleActivation)
  assert.equal(refreshed.json().document.revision, legacy.revision)
  assert.equal(await readFile(f.globalFile, "utf8"), global)
  assert.equal(await readFile(f.projectFile, "utf8"), project)
}))

test("an intent stored with an attempted configuration target is replaced by a fresh request", async () => fixture(async f => {
  const failed = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: f.payload })
  assert.equal(failed.statusCode, 200, failed.body)
  const doc = await f.documents.read("msn_scheduled")
  const stored = await f.documents.change(doc.id, doc.revision, () => true, (next: any) => {
    delete next.scheduleActivation.effectiveOrigin
    next.scheduleActivation = { ...next.scheduleActivation, state: "partial", targets: [{ scope: "project", path: f.projectFile,
      expectation: "a".repeat(64), resultDigest: "b".repeat(64), attempted: true, acknowledged: false }] }
  })
  const project = await readFile(f.projectFile, "utf8")
  const fresh = await f.app.inject({ method: "POST", url: f.url, headers: f.headers,
    payload: { requestID: "after-stored-target", expectedDocumentRevision: stored.revision } })
  assert.equal(fresh.statusCode, 200, fresh.body)
  assert.equal(fresh.json().document.scheduleActivation.state, "ready")
  assert.equal(fresh.json().document.scheduleActivation.requestID, "after-stored-target")
  assert.deepEqual(fresh.json().document.scheduleActivation.targets, [])
  assert.equal(await readFile(f.projectFile, "utf8"), project)
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
