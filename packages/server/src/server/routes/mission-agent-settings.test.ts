import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse, stringify } from "yaml"
import { SettingsService } from "../../settings/service"
import { resolveConfigLocation } from "../../config/location"
import { MissionPreferenceConflictError } from "../../settings/mission-preference-condition"
import { missionSettingsInput } from "../../missions/settings-tool"
import { controlAgentMissionSettings } from "./mission-agent-settings"
import { setupMissionsBusiness } from "../../opencode/missions-plugin"
import Fastify from "fastify"
import { registerAutomationPluginRoute } from "./automation-plugin"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode", "mission-settings-")), file = path.join(root, "config.yaml")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const logger = { child() { return this }, warn() {}, info() {} }
  const settings = new SettingsService(resolveConfigLocation(file), undefined, logger as never)
  const state = { owned: true, current: true, moved: false, ambiguous: false, reads: 0 }
  const workspace = { id: "owned" }, location = { directory: root }
  const connection = { assertCurrent() { if (!state.current) throw new Error("Replaced") }, client: {
    session: { get: async ({ sessionID }: any) => { state.reads++; return { id: sessionID, projectID: "project",
      location: state.moved ? { directory: "foreign" } : location, parentID: sessionID === "ses_child" ? "ses_root" : undefined } } },
    location: { get: async () => ({ ...location, project: { id: "project" } }) },
  } }
  const manager: any = { list: () => state.ambiguous ? [workspace, { id: "other" }] : [workspace],
    get: () => workspace, getSharedServiceClient: async () => connection.client,
    getSharedServiceConnection: async (id: string) => id === "other" ? { ...connection } : connection,
    ownsLocation: async (_: string, selected: any) => state.owned && selected.directory === root }
  const nativeCalls: unknown[] = []
  const subagentDepth: any = {
    read: async (...args: unknown[]) => { nativeCalls.push(["read", ...args]); return { project: { expectation: "b".repeat(64), emptyExperimental: true } } },
    update: async (...args: unknown[]) => { nativeCalls.push(["update", ...args]) },
  }
  const deps = { workspaceManager: manager, settings, subagentDepth }
  const invoke = (input: unknown, sessionID = "ses_child") => controlAgentMissionSettings(deps, sessionID,
    { kind: "settings", input }, new AbortController().signal) as Promise<any>
  const store = (values: unknown) => writeFileSync(file, stringify(values))
  const saved = () => parse(readFileSync(file, "utf8"))
  return { root, file, settings, state, invoke, store, saved, nativeCalls, deps }
}
const configuration = { id: "00000000-0000-4000-8000-000000000001", name: "Saved", objective: "Inputs", notes: "  notes  ",
  template: "custom", profiles: { coordinator: {}, roles: { specialist: { agent: "general", model: { providerID: "p", id: "m", variant: "high" } } } }, taskMode: "native" }
const readLibrary = { scope: "configurations", action: "read" }
const readDefaults = { scope: "preferences", action: "read", field: "missionProfileDefaults" }

test("every owned conversation saves, replaces/renames, deletes and repairs the shared raw library", async t => {
  const f = fixture(t)
  f.store({ ui: { settings: { untouched: { enabled: true } } }, server: { external: "keep" } })
  for (const sessionID of ["ses_root", "ses_child", "ses_actor", "ses_passage"]) {
    const read = await f.invoke(readLibrary, sessionID)
    assert.deepEqual(read.principal, { kind: "agent", sessionID })
    assert.equal(read.scope, "codenomad-profile")
  }
  let read = await f.invoke(readLibrary)
  assert.equal(read.present, false)
  const command = { scope: "configurations", action: "save", configuration, expectation: read.expectation }
  assert.equal((await f.invoke(command)).saved, true)
  assert.deepEqual(f.saved().ui.settings.missionModels, [{ version: 1, ...configuration }])
  await assert.rejects(f.invoke(command), MissionPreferenceConflictError)
  read = await f.invoke(readLibrary)
  await f.invoke({ ...command, configuration: { ...configuration, name: "Renamed", objective: "Edited" }, expectation: read.expectation })
  assert.equal(f.saved().ui.settings.missionModels.length, 1)
  assert.equal(f.saved().ui.settings.missionModels[0].name, "Renamed")
  read = await f.invoke(readLibrary)
  await f.invoke({ scope: "configurations", action: "delete", configurationID: configuration.id, expectation: read.expectation })
  assert.deepEqual(f.saved().ui.settings.missionModels, [])
  f.store({ ...f.saved(), ui: { settings: { untouched: { enabled: true }, missionModels: { invalid: "raw" } } } })
  read = await f.invoke(readLibrary)
  assert.equal(read.valid, false)
  await assert.rejects(f.invoke({ ...command, expectation: read.expectation }), /reset/)
  await f.invoke({ scope: "configurations", action: "reset", expectation: read.expectation })
  assert.deepEqual(f.saved().ui.settings, { untouched: { enabled: true }, missionModels: [] })
  assert.equal(f.saved().server.external, "keep")
})

test("raw presence, human concurrent edits, invalid repairs and unrelated settings remain fenced", async t => {
  const f = fixture(t)
  f.store({ ui: { settings: {} } })
  const absent = await f.invoke(readDefaults)
  f.store({ ui: { settings: { missionProfileDefaults: {} } } })
  const empty = await f.invoke(readDefaults)
  assert.notEqual(absent.expectation, empty.expectation)
  assert.equal(empty.valid, false)
  await assert.rejects(f.invoke({ ...readDefaults, action: "reset", expectation: absent.expectation }), MissionPreferenceConflictError)
  f.store({ ui: { settings: { missionProfileDefaults: { human: true } } } })
  await assert.rejects(f.invoke({ ...readDefaults, action: "reset", expectation: empty.expectation }), MissionPreferenceConflictError)
  const latest = await f.invoke(readDefaults)
  await f.invoke({ ...readDefaults, action: "save", defaults: [{ template: "all", profiles: { coordinator: {} } }], expectation: latest.expectation })
  assert.deepEqual(f.saved().ui.settings.missionProfileDefaults, [{ template: "all", profiles: { coordinator: {} } }])
  const read = await f.invoke(readDefaults)
  // A neighboring external edit between read and mutation survives.
  f.store({ ...f.saved(), ui: { ...f.saved().ui, settings: { ...f.saved().ui.settings, neighbor: "human" } } })
  await f.invoke({ ...readDefaults, action: "reset", expectation: read.expectation })
  assert.equal(f.saved().ui.settings.neighbor, "human")
  const good = await f.invoke(readDefaults)
  writeFileSync(f.file, "ui: [invalid yaml")
  const bytes = readFileSync(f.file, "utf8")
  await assert.rejects(f.invoke({ ...readDefaults, action: "reset", expectation: good.expectation }))
  assert.equal(readFileSync(f.file, "utf8"), bytes)
})

test("global/playbook role selectors, inheritance, task mode and profile-global deletion preference", async t => {
  const f = fixture(t)
  f.store({ ui: { settings: {} } })
  const defaults = [{ template: "all", profiles: configuration.profiles, taskMode: "independent" },
    { template: "debug", profiles: { coordinator: { agent: "build" }, roles: { implementer: {} } }, taskMode: "native" }]
  await f.invoke({ ...readDefaults, action: "save", defaults, expectation: (await f.invoke(readDefaults)).expectation })
  assert.deepEqual((await f.invoke(readDefaults)).value, defaults)
  // Whole-slot omission restores inheritance; an explicit {} remains stored.
  const next = [{ ...defaults[0], profiles: { coordinator: {} } }, { template: "debug", profiles: { roles: { implementer: {} } } }]
  await f.invoke({ ...readDefaults, action: "save", defaults: next, expectation: (await f.invoke(readDefaults)).expectation })
  assert.deepEqual(f.saved().ui.settings.missionProfileDefaults, next)
  const read = { scope: "preferences", field: "missionDeleteSessions", action: "read" }
  const before = await f.invoke(read)
  assert.equal(before.value, false)
  await f.invoke({ ...read, action: "save", deleteSessions: true, expectation: before.expectation })
  assert.equal((await f.invoke(read, "ses_passage")).value, true)
  await f.invoke({ ...read, action: "reset", expectation: (await f.invoke(read)).expectation })
  assert.equal(Object.hasOwn(f.saved().ui.settings, "missionDeleteSessions"), false)
  const unchanged = readFileSync(f.file, "utf8")
  for (const bad of [
    [{ template: "debug", profiles: { roles: { specialist: {} } } }],
    [{ template: "all", profiles: {} }, { template: "all", profiles: {} }],
  ]) await assert.rejects(f.invoke({ ...readDefaults, action: "save", defaults: bad, expectation: (await f.invoke(readDefaults)).expectation }))
  assert.equal(readFileSync(f.file, "utf8"), unchanged)
})

test("depth uses the existing Location owner and exact document expectation for override/inherit/repair", async t => {
  const f = fixture(t), read = await f.invoke({ scope: "depth", action: "read" })
  for (const depth of [1, 10, null]) await f.invoke({ scope: "depth", action: "save", depth, expectation: read.snapshot.project.expectation })
  assert.deepEqual(f.nativeCalls, [["read", "owned", { directory: f.root }],
    ...[1, 10, null].map(depth => ["update", "owned", { directory: f.root }, depth, "b".repeat(64)])])
  for (const depth of [0, 11, 1.5]) await assert.rejects(f.invoke({ scope: "depth", action: "save", depth, expectation: "b".repeat(64) }))
  for (const flag of ["owned", "current", "moved", "ambiguous"] as const) {
    const original = f.state[flag]
    f.state[flag] = !original
    await assert.rejects(f.invoke({ scope: "depth", action: "save", depth: 2, expectation: "b".repeat(64) }))
    await assert.rejects(f.invoke(readLibrary))
    f.state[flag] = original
  }
  assert.equal(f.nativeCalls.length, 4)
})

test("strict settings inputs reject cross-scope fields, principal injection and blind writes", () => {
  for (const input of [
    { scope: "depth", action: "save", depth: 1 },
    { ...readLibrary, principal: { kind: "human" } },
    { ...readDefaults, deleteSessions: true },
    { scope: "depth", action: "read", expectation: "b".repeat(64) },
    { ...readLibrary, configurationID: configuration.id },
    { ...readDefaults, action: "delete", expectation: "b".repeat(64) },
  ]) assert.equal(missionSettingsInput.safeParse(input).success, false)
})

test("the authenticated bridge supplies the agent principal, shares CAS and refuses forged or foreign writes", async t => {
  const f = fixture(t), app = Fastify({ logger: false })
  f.store({ ui: { settings: {} } })
  registerAutomationPluginRoute(app, { ...f.deps, authManager: { isLoopbackRequest: () => true },
    bridgeToken: "fixture", nativeParent: {}, developerCdp: {} } as never)
  t.after(() => app.close())
  const call = (input: unknown, token = "fixture") => app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": token }, payload: { mode: "mission-input", sessionID: "ses_child",
      command: { kind: "settings", input } } })
  const read = (await call(readLibrary)).json().result
  assert.deepEqual(read.principal, { kind: "agent", sessionID: "ses_child" })
  const command = { scope: "configurations", action: "save", configuration, expectation: read.expectation }
  assert.equal((await call(command)).json().result.saved, true)
  assert.deepEqual((await call(command)).json().result, { refused: true, code: "settings-conflict" })
  assert.deepEqual((await call({ ...command, principal: { kind: "human" } })).json().result, { refused: true, code: "settings-invalid" })
  assert.equal((await call(readLibrary, "wrong-token")).statusCode, 401)
  const bytes = readFileSync(f.file, "utf8")
  f.state.owned = false
  assert.equal((await call(command)).statusCode, 404)
  assert.equal(readFileSync(f.file, "utf8"), bytes)
})

test("the native settings tool carries the actual calling session without requiring a mission route", async () => {
  const tools = new Map<string, any>(), calls: unknown[] = [], registration = { dispose: async () => {} }
  const dispose = await setupMissionsBusiness({
    tool: { transform: async (use: any) => { use({ namespace() {}, add: (tool: any) => tools.set(tool.name, tool) }); return registration } },
    session: { hook: async () => registration },
  } as never, async () => assert.fail("Settings never selects a mission journal"), undefined, undefined, undefined,
  async (sessionID, input) => { calls.push({ sessionID, input }); return { saved: true } })
  try {
    const response = await tools.get("settings").execute(readLibrary, { sessionID: "ses_passage" })
    assert.deepEqual(JSON.parse(response.content), { saved: true })
    assert.deepEqual(calls, [{ sessionID: "ses_passage", input: readLibrary }])
  } finally { await dispose() }
})
