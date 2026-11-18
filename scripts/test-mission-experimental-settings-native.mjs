// Real native config discovery/watcher, no schedule creation or model request.
import assert from "node:assert/strict"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parse } from "jsonc-parser"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { SubagentDepthSettings } from "../packages/server/src/opencode/subagent-depth-settings.ts"
import { NativeScheduleCapabilityReader } from "../packages/server/src/opencode/native-schedule-capability.ts"
import { editMissionExperimental, inheritedMissionExperimental, nativeSettingExpectation } from "../packages/server/src/opencode/native-experimental-settings.ts"
import { NativeScheduleSettingsActivation } from "../packages/server/src/opencode/native-schedule-settings-activation.ts"
import { DesktopPluginLifecycle } from "../packages/server/src/opencode/desktop-plugin-lifecycle.ts"
import { resolveDesktopPluginPaths } from "../packages/server/src/opencode/desktop-plugin-paths.ts"
import { CODENOMAD_MISSIONS_RPC } from "../packages/server/src/missions/rpc.ts"

await withProductRuntime(process.argv[2], async ({ configDirectory }) => {
  await writeFile(path.join(configDirectory, "opencode.jsonc"), '{"experimental":{"subagent_depth":2,"schedules":true}}\n')
}, async ({ root, connection, requests }) => {
  assert.equal((await connection.client.server.info()).version, "2.3.0")
  const plugin = new DesktopPluginLifecycle("missions")
  const paths = await resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: process.argv[2] })
  assert.ok(paths.config.startsWith(root))
  await plugin.start(paths)
  try {
  const manager = {
    get: () => ({}), getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id, directory) => directory === root ? root : undefined,
    ownsLocation: async (_id, location) => location.directory === root,
    getWorktreeIdentityForPath: async () => "private-fixture-root",
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
  }
  const controls = new PluginControls({ workspaceManager: manager,
    worktreeDeletionFence: { enter: () => () => {} }, logger: {} })
  const depths = new SubagentDepthSettings(controls, manager)
  const schedules = new NativeScheduleCapabilityReader(controls, manager)
  const location = { directory: root }
  const until = async (check, description) => {
    const deadline = Date.now() + 10_000
    do { if (await check()) return; await delay(100) } while (Date.now() < deadline)
    throw Error(`Native watcher did not acknowledge ${description}`)
  }
  await until(async () => (await connection.client.plugin.list({ location })).data.some(entry =>
    entry.id === "codenomad.missions" && entry.state.status === "active"), "private Missions plugin")
  assert.deepEqual(await connection.client.rpc(CODENOMAD_MISSIONS_RPC).scheduleFlag({}, { location }),
    { enabled: true, provenance: "experimental-block" })
  const initial = await depths.read("fixture", location)
  assert.equal(initial.effectiveDepth, 2)
  assert.deepEqual((await schedules.read("fixture", location)).api, { available: true })
  await depths.update("fixture", location, 8, initial.project.expectation)
  const file = initial.project.path
  assert.deepEqual(parse(await readFile(file, "utf8")).experimental, { schedules: true, subagent_depth: 8 })
  await until(async () => (await schedules.read("fixture", location)).enabled && (await depths.read("fixture", location)).effectiveDepth === 8, "inherited schedules + depth 8")
  assert.equal((await schedules.read("fixture", location)).origin, file)
  await depths.update("fixture", location, 0, (await depths.read("fixture", location)).project.expectation)
  await depths.update("fixture", location, null, (await depths.read("fixture", location)).project.expectation)
  assert.deepEqual(parse(await readFile(file, "utf8")).experimental, { schedules: true })
  await until(async () => (await depths.read("fixture", location)).effectiveDepth === null && (await schedules.read("fixture", location)).enabled, "depth removal preserving schedules")
  // Depth-only project created before activation; prepare expectation before editing.
  await writeFile(file, '\uFEFF{\r\n\t// keep\r\n\t"experimental":{"subagent_depth":8,"todo":true}\r\n}\r\n')
  await until(async () => !(await schedules.read("fixture", location)).enabled, "project depth-only masking global")
  const acquired = await controls.readConfigDocuments("fixture", location)
  const project = acquired.documents.find(document => document.scope === "project")
  const expected = nativeSettingExpectation(project.document)
  await controls.editConfigDocument("fixture", location, "project", (document, current) => {
    assert.equal(nativeSettingExpectation(document), expected)
    return editMissionExperimental(document, "schedules", true,
      inheritedMissionExperimental(current.entries, current.path, current.location.directory))
  })
  const saved = await readFile(file, "utf8")
  assert.match(saved, /^\uFEFF/); assert.match(saved, /\r\n\t\/\/ keep/)
  assert.deepEqual(parse(saved.slice(1)).experimental, { subagent_depth: 8, todo: true, schedules: true })
  await until(async () => (await schedules.read("fixture", location)).enabled, "project activation")
  await writeFile(file, '{"experimental":{"schedules":false,"subagent_depth":0}}')
  await assert.rejects(controls.editConfigDocument("fixture", location, "project", document =>
    editMissionExperimental(document, "schedules", true, {})), /explicitly disabled/)
  const competing = path.join(path.dirname(file), "opencode.json")
  await writeFile(competing, "{}")
  await assert.rejects(depths.read("fixture", location), /JSON and JSONC/)
  await rm(competing)
  const globalFile = (await controls.readConfigDocuments("fixture", location)).documents.find(item => item.scope === "global").path
  await writeFile(globalFile, '{"experimental":{"schedules":false,"subagent_depth":2}}\n')
  await writeFile(file, '{"experimental":{"subagent_depth":8}}\n')
  await until(async () => (await connection.client.config.get({ location })).some(entry =>
    entry.type === "document" && entry.path === globalFile && entry.info.experimental?.schedules === false), "global OFF before activation")
  const activate = () => new NativeScheduleSettingsActivation(controls, manager)
  await assert.rejects(activate().prepare("fixture", location), error =>
    error.code === "schedule-activation-refused" && error.refusal.path === globalFile)
  await writeFile(globalFile, '{"experimental":{"subagent_depth":2}}\n')
  await until(async () => (await connection.client.config.get({ location })).some(entry =>
    entry.type === "document" && entry.path === globalFile && entry.info.experimental?.schedules === undefined), "global OFF cleared")
  const globalBefore = await readFile(globalFile, "utf8")
  const plan = await activate().prepare("fixture", location)
  assert.deepEqual(plan.targets.map(item => item.scope), ["project"])
  const intent = { ...plan, targets: plan.targets.map(target => ({ ...target, attempted: false, acknowledged: false })) }
  const intentFile = path.join(root, "activation-intent.json")
  const save = () => writeFile(intentFile, JSON.stringify(intent))
  await save()
  let ready = false, lose = true
  const journal = {
    prepared: async () => { await save() },
    attempting: async scope => { intent.targets.find(item => item.scope === scope).attempted = true; await save() },
    acknowledged: async scope => {
      if (scope === "project" && lose) { lose = false; throw Error("lost activation ACK") }
      intent.targets.find(item => item.scope === scope).acknowledged = true; await save()
    },
    ready: async origin => { assert.equal(origin, file); ready = true },
  }
  await assert.rejects(activate().apply("fixture", location, structuredClone(intent), journal), /lost activation ACK/)
  assert.equal(ready, false)
  assert.equal(await readFile(globalFile, "utf8"), globalBefore)
  assert.equal(parse(await readFile(file, "utf8")).experimental.schedules, true)
  await activate().apply("fixture", location, JSON.parse(await readFile(intentFile, "utf8")), journal)
  assert.equal(ready, true)
  assert.ok(intent.targets.every(target => target.acknowledged))
  assert.equal((await schedules.read("fixture", location)).enabled, true)
  // An existing project block already selects its own native depth default.
  // Enabling schedules in that block must not materialize the hidden global depth.
  await writeFile(file, '{"experimental":{"todo":true}}\n')
  await until(async () => !(await schedules.read("fixture", location)).enabled
    && (await depths.read("fixture", location)).effectiveDepth === null, "existing project block before schedule activation")
  const depthBefore = (await depths.read("fixture", location)).effectiveDepth
  await controls.editConfigDocument("fixture", location, "project", (document, current) =>
    editMissionExperimental(document, "schedules", true,
      inheritedMissionExperimental(current.entries, current.path, current.location.directory)))
  assert.deepEqual(parse(await readFile(file, "utf8")).experimental, { todo: true, schedules: true })
  await until(async () => (await schedules.read("fixture", location)).enabled, "schedule activation preserving existing depth default")
  assert.equal((await depths.read("fixture", location)).effectiveDepth, depthBefore)
  assert.equal(requests.length, 0)
  const enabledPlan = await activate().prepare("fixture", location)
  assert.deepEqual(enabledPlan.targets, [])
  assert.equal(await readFile(globalFile, "utf8"), globalBefore)
  console.log("PASS native 2.3.0 Flag RPC, whole-block precedence, both writer orders, depth 0/removal, effective watcher read, explicit global/project OFF, BOM/EOL/comments, ambiguous JSON/JSONC; zero provider HTTP")
  console.log("PASS project-only activation, durable intent/attempts, lost project ACK observation, positive native acknowledgement and zero-target already-ON plan")
  console.log("PASS schedule activation preserves the effective native depth of an existing project experimental block")
  } finally { await plugin.stop() }
}, { projectConfig: true })

// Each case owns a fresh daemon: its environment is independent of the backend's.
for (const scenario of [
  { name: "environment OFF over configured ON", flags: "fixture,-schedules", global: { schedules: true },
    enabled: false, provenance: "environment", refused: true },
  { name: "environment ON", flags: "fixture,schedules", global: {},
    enabled: true, provenance: "environment" },
  { name: "all-flags below a project block", global: { all_flags: true }, project: { todo: true },
    enabled: true, provenance: "all-flags" },
  { name: "all-flags false falls through to the channel default", global: { all_flags: false }, project: {},
    enabled: false, provenance: "channel-default" },
]) {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
    await writeFile(path.join(configDirectory, "opencode.jsonc"), JSON.stringify({ experimental: scenario.global }))
    if (scenario.project) {
      await mkdir(path.join(root, ".opencode"))
      await writeFile(path.join(root, ".opencode", "opencode.jsonc"), JSON.stringify({ experimental: scenario.project }))
    }
  }, async ({ root, connection, requests }) => {
    const plugin = new DesktopPluginLifecycle("missions"), location = { directory: root }
    const paths = await resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: process.argv[2] })
    assert.ok(paths.config.startsWith(root))
    await plugin.start(paths)
    try {
      const deadline = Date.now() + 15_000
      while (!(await connection.client.plugin.list({ location })).data.some(entry =>
        entry.id === "codenomad.missions" && entry.state.status === "active")) {
        assert.ok(Date.now() < deadline, "Private flag plugin unavailable")
        await delay(100)
      }
      assert.deepEqual(await connection.client.rpc(CODENOMAD_MISSIONS_RPC).scheduleFlag({}, { location }),
        { enabled: scenario.enabled, provenance: scenario.provenance })
      const manager = { get: () => ({}), getSharedServiceConnection: async () => connection,
        getServiceDirectoryForPath: async (_id, directory) => directory === root ? root : undefined,
        ownsLocation: async (_id, selected) => selected.directory === root, getWorktreeIdentityForPath: async () => "flag-fixture",
        getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
        getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value }
      const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: {} })
      const activate = new NativeScheduleSettingsActivation(controls, manager)
      const globalFile = path.join(paths.config, "opencode.jsonc"), original = await readFile(globalFile, "utf8")
      if (scenario.refused) await assert.rejects(activate.prepare("fixture", location), error =>
        error.code === "schedule-activation-refused" && error.refusal.layer === "environment")
      else {
        const plan = await activate.prepare("fixture", location)
        assert.deepEqual(plan.targets.map(target => target.scope), scenario.enabled ? [] : ["project"])
      }
      assert.equal(await readFile(globalFile, "utf8"), original)
      assert.equal(requests.length, 0)
      console.log(`PASS native ${scenario.name}: exact provenance, correct plan/refusal, zero configuration writes/provider HTTP`)
    } finally { await plugin.stop() }
  }, { projectConfig: true, flags: scenario.flags })
}
