// Real native config discovery/watcher, no schedule creation or model request.
import assert from "node:assert/strict"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parse } from "jsonc-parser"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { SubagentDepthSettings } from "../packages/server/src/opencode/subagent-depth-settings.ts"
import { NativeScheduleCapabilityReader } from "../packages/server/src/opencode/native-schedule-capability.ts"
import { readNativeScheduleFlag } from "../packages/server/src/opencode/native-schedule-flag.ts"
import { NativeScheduleSettingsActivation } from "../packages/server/src/opencode/native-schedule-settings-activation.ts"
import { DesktopPluginLifecycle } from "../packages/server/src/opencode/desktop-plugin-lifecycle.ts"
import { resolveDesktopPluginPaths } from "../packages/server/src/opencode/desktop-plugin-paths.ts"
import { isBelowOpenCodeMinimum } from "../packages/server/src/opencode/runtime-support.ts"
import { CODENOMAD_MISSIONS_RPC_ID } from "../packages/server/src/missions/rpc.ts"

const cli = process.argv[2]
const INLINE = "OPENCODE_CONFIG_CONTENT"

/** The product readers over one fixture daemon, with its private Missions plugin active. */
async function product({ root, connection }, run) {
  const plugin = new DesktopPluginLifecycle("missions"), location = { directory: root }
  const paths = await resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: cli })
  assert.ok(paths.config.startsWith(root))
  await plugin.start(paths)
  try {
    const manager = {
      get: () => ({}), getSharedServiceConnection: async () => connection,
      getServiceDirectoryForPath: async (_id, directory) => directory === root ? root : undefined,
      ownsLocation: async (_id, selected) => selected.directory === root,
      getWorktreeIdentityForPath: async () => "private-fixture-root",
      getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
    }
    const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: {} })
    const until = async (check, description) => {
      const deadline = Date.now() + 15_000
      do { if (await check()) return; await delay(100) } while (Date.now() < deadline)
      throw Error(`Native watcher did not acknowledge ${description}`)
    }
    await until(async () => (await connection.client.plugin.list({ location })).data.some(entry =>
      entry.id === CODENOMAD_MISSIONS_RPC_ID && entry.state.status === "active"), "private Missions plugin")
    const globalFile = path.join(paths.config, "opencode.jsonc")
    await run({ location, controls, manager, until, globalFile,
      depths: new SubagentDepthSettings(controls, manager), schedules: new NativeScheduleCapabilityReader(controls, manager),
      flag: () => readNativeScheduleFlag(connection, location),
      activate: () => new NativeScheduleSettingsActivation(controls, manager) })
  } finally { await plugin.stop() }
}
const refused = (expected) => error => {
  assert.equal(error.code, "schedule-activation-refused")
  assert.deepEqual(error.refusal, expected)
  return true
}

await withProductRuntime(cli, async ({ configDirectory }) => {
  await writeFile(path.join(configDirectory, "opencode.jsonc"), '{"experimental":{"subagent_depth":2}}\n')
}, fixture => product(fixture, async ({ location, controls, until, globalFile, depths, schedules, flag, activate }) => {
  const { connection, requests } = fixture
  const version = (await connection.client.server.info()).version
  assert.ok(!isBelowOpenCodeMinimum(version), `This fixture qualifies a supported OpenCode, not ${version}`)

  // Automations are on unless a source turns them off: nothing to activate, nothing written.
  assert.deepEqual(await flag(), { enabled: true, provenance: "channel-default", hiddenOff: [] })
  const first = await schedules.read("fixture", location)
  assert.deepEqual({ api: first.api, enabled: first.enabled, provenance: first.provenance, origin: first.origin },
    { api: { available: true }, enabled: true, provenance: "channel-default", origin: null })
  const globalBefore = await readFile(globalFile, "utf8")
  const ready = []
  const journal = { prepared: async () => {}, ready: async origin => { ready.push(origin) } }
  const plan = await activate().prepare("fixture", location)
  await activate().apply("fixture", location, plan, journal)
  assert.deepEqual(ready, [null])
  await activate().verify("fixture", location, plan.authority)
  assert.equal(await readFile(globalFile, "utf8"), globalBefore)

  // The project depth: both edit directions, read back through the native watcher.
  const initial = await depths.read("fixture", location)
  assert.equal(initial.effectiveDepth, 2)
  const file = initial.project.path
  await depths.update("fixture", location, 8, initial.project.expectation)
  assert.equal(parse(await readFile(file, "utf8")).experimental.subagent_depth, 8)
  await until(async () => (await depths.read("fixture", location)).effectiveDepth === 8, "project depth 8")
  await depths.update("fixture", location, 0, (await depths.read("fixture", location)).project.expectation)
  await until(async () => (await depths.read("fixture", location)).effectiveDepth === 0, "project depth 0")
  await depths.update("fixture", location, null, (await depths.read("fixture", location)).project.expectation)
  assert.equal(parse(await readFile(file, "utf8")).experimental, undefined)
  await until(async () => (await depths.read("fixture", location)).effectiveDepth === 2, "inherited depth after removal")
  // A project block without a depth hides the inherited one: OpenCode reads one whole block.
  await writeFile(file, '﻿{\r\n\t// keep\r\n\t"experimental":{"part_rows":true}\r\n}\r\n')
  await until(async () => (await depths.read("fixture", location)).effectiveDepth === null, "project block hiding the inherited depth")
  await depths.update("fixture", location, 3, (await depths.read("fixture", location)).project.expectation)
  const saved = await readFile(file, "utf8")
  assert.match(saved, /^﻿/); assert.match(saved, /\r\n\t\/\/ keep/)
  assert.deepEqual(parse(saved.slice(1)).experimental, { part_rows: true, subagent_depth: 3 })
  await until(async () => (await depths.read("fixture", location)).effectiveDepth === 3, "depth in the existing project block")
  assert.equal((await flag()).enabled, true, "depth edits leave automations on")
  const competing = path.join(path.dirname(file), "opencode.json")
  await writeFile(competing, "{}")
  await assert.rejects(depths.read("fixture", location), /JSON and JSONC/)
  await rm(competing)

  // The top-level setting: the highest document that sets it decides, and any explicit OFF refuses activation.
  const setting = async (expected, description) => {
    await until(async () => { try { assert.deepEqual(await flag(), expected); return true } catch { return false } }, description)
    return schedules.read("fixture", location)
  }
  await writeFile(file, '{"automations":false}\n')
  assert.equal((await setting({ enabled: false, provenance: "automations-setting", path: file, hiddenOff: [] }, "project OFF")).origin, file)
  await assert.rejects(activate().prepare("fixture", location),
    refused({ reason: "explicit-off", provenance: "automations-setting", layer: "project", path: file }))
  await writeFile(globalFile, '{"automations":false,"experimental":{"subagent_depth":2}}\n')
  await writeFile(file, '{"automations":true}\n')
  assert.equal((await setting({ enabled: true, provenance: "automations-setting", path: file, hiddenOff: [globalFile] }, "project ON over global OFF")).origin, file)
  await assert.rejects(activate().prepare("fixture", location),
    refused({ reason: "explicit-off", provenance: "automations-setting", layer: "global", path: globalFile }))
  await assert.rejects(activate().verify("fixture", location, plan.authority), error => error.code === "schedule-activation-refused")
  // A block saved for a runtime that read `experimental.automations` keeps schedules off.
  await writeFile(globalFile, globalBefore)
  await writeFile(file, '{"experimental":{"automations":false}}\n')
  assert.equal((await setting({ enabled: false, provenance: "experimental-block", path: file, hiddenOff: [] }, "legacy project OFF")).origin, file)
  await assert.rejects(activate().prepare("fixture", location),
    refused({ reason: "explicit-off", provenance: "experimental-block", layer: "project", path: file }))
  await writeFile(file, "{}\n")
  await setting({ enabled: true, provenance: "channel-default", hiddenOff: [] }, "default after clearing every OFF")
  await activate().verify("fixture", location, plan.authority)
  assert.equal(await readFile(globalFile, "utf8"), globalBefore)
  assert.equal(requests.length, 0)
  console.log(`PASS native ${version} automations setting: default ON with a zero-write ready plan, project/global/legacy OFF with exact refusals, hidden OFF under a higher ON; zero provider HTTP`)
  console.log("PASS project depth through the native watcher: set, 0, removal, whole-block precedence, BOM/EOL/comments, ambiguous JSON/JSONC")
}), { projectConfig: true })

// Each case owns a fresh daemon: its environment is independent of the backend's.
for (const scenario of [
  { name: "environment OFF over a configured ON", flags: "fixture,-automations", global: { automations: true },
    flag: { enabled: false, provenance: "environment", hiddenOff: [] },
    refusal: { reason: "explicit-off", provenance: "environment", layer: "environment" } },
  { name: "environment OFF by its former name", flags: "-schedules", global: {},
    flag: { enabled: false, provenance: "environment", hiddenOff: [] },
    refusal: { reason: "explicit-off", provenance: "environment", layer: "environment" } },
  { name: "inline configuration OFF over a configured ON", inline: { automations: false }, global: { automations: true },
    flag: { enabled: false, provenance: "automations-setting", path: INLINE, hiddenOff: [] },
    refusal: { reason: "explicit-off", provenance: "automations-setting", layer: "imposed" } },
]) {
  await withProductRuntime(cli, async ({ configDirectory }) => {
    await writeFile(path.join(configDirectory, "opencode.jsonc"), JSON.stringify(scenario.global))
    return scenario.inline
  }, fixture => product(fixture, async ({ location, globalFile, schedules, flag, activate }) => {
    assert.deepEqual(await flag(), scenario.flag)
    assert.equal((await schedules.read("fixture", location)).origin, null)
    const original = await readFile(globalFile, "utf8")
    await assert.rejects(activate().prepare("fixture", location), refused(scenario.refusal))
    assert.equal(await readFile(globalFile, "utf8"), original)
    assert.equal(fixture.requests.length, 0)
    console.log(`PASS native ${scenario.name}: exact source and refusal, zero configuration writes/provider HTTP`)
  }), { projectConfig: true, flags: scenario.flags })
}
