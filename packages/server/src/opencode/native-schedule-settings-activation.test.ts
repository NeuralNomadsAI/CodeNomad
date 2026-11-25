import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parse } from "jsonc-parser"
import { PluginControls } from "./plugin-controls"
import { nativeScheduleContractFixture } from "./native-schedule-capability-fixture"
import { NativeScheduleSettingsActivation, type NativeScheduleActivationJournal } from "./native-schedule-settings-activation"

type Flag = { enabled: boolean; provenance: string; path?: string; hiddenOff?: string[] }

async function fixture(run: (value: any) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-activation-"))
  const global = path.join(root, "global"), project = path.join(root, "project")
  await mkdir(global); await mkdir(project)
  const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, "opencode.jsonc")
  await writeFile(globalFile, '{"experimental":{"subagent_depth":2}}\n')
  await writeFile(projectFile, '﻿{\r\n\t// keep\r\n\t"experimental":{"subagent_depth":8}\r\n}\r\n')
  let current = true, extra: any[] = [], selected: string | undefined
  let flag: Flag = { enabled: true, provenance: "channel-default" }
  const entries = async () => [{ type: "document", path: globalFile, info: parse(await readFile(globalFile, "utf8")) },
    { type: "directory", path: global },
    { type: "document", path: projectFile, info: parse((await readFile(projectFile, "utf8")).replace(/^﻿/, "")) }, ...extra]
  const connection: any = { endpoint: { url: "http://127.0.0.1:1234" }, assertCurrent() { if (!current) throw Error("replaced") },
    fetch: async () => Response.json(nativeScheduleContractFixture()), client: { config: { get: entries }, plugin: { list: async () => ({ data: [] }) },
      rpc: () => ({ scheduleSetting: async () => ({ hiddenOff: [], ...flag }) }) } }
  const manager: any = { get: () => ({}), getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
    ownsLocation: async () => true, getWorktreeIdentityForPath: async () => "owned",
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id: string, value: string) => value }
  const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: {} as any })
  const activation = () => new NativeScheduleSettingsActivation(controls, { ...manager, getServiceWslDistro: () => selected })
  const phases: Array<string | null> = []
  const journal: NativeScheduleActivationJournal = {
    prepared: async plan => { phases.push(`prepared:${plan.authority}`) }, ready: async origin => { phases.push(origin) } }
  try { await run({ activation, location: { directory: project }, journal, phases, globalFile, projectFile, root,
    current: (value: boolean) => { current = value }, extra: (value: any[]) => { extra = value },
    selected: (value: string) => { selected = value }, flag: (value: Flag) => { flag = value } }) }
  finally { await chmod(globalFile, 0o600).catch(() => {}); await chmod(projectFile, 0o600).catch(() => {}); await rm(root, { recursive: true, force: true }) }
}
const refused = (expected: Record<string, unknown>) => (error: any) => {
  assert.equal(error.code, "schedule-activation-refused")
  assert.deepEqual(error.refusal, { reason: "explicit-off", ...expected })
  return true
}

test("an effective ON journals its plan then readiness and writes no configuration", async () => fixture(async f => {
  const global = await readFile(f.globalFile, "utf8"), project = await readFile(f.projectFile, "utf8")
  await chmod(f.projectFile, 0o400); await chmod(f.globalFile, 0o400)
  const plan = await f.activation().prepare("w", f.location)
  assert.match(plan.authority, /^[a-f0-9]{64}$/)
  await f.activation().apply("w", f.location, plan, f.journal)
  assert.deepEqual(f.phases, [`prepared:${plan.authority}`, null])
  await f.activation().verify("w", f.location, plan.authority)
  f.flag({ enabled: true, provenance: "automations-setting", path: f.projectFile })
  await f.activation().apply("w", f.location, plan, f.journal)
  assert.equal(f.phases.at(-1), f.projectFile, "readiness names the document that decides the setting")
  assert.equal(await readFile(f.projectFile, "utf8"), project)
  assert.equal(await readFile(f.globalFile, "utf8"), global)
}))

for (const layer of ["global", "inherited", "project"]) test(`an explicit ${layer} OFF refuses even when hidden by ON`, async () => fixture(async f => {
  f.flag({ enabled: true, provenance: "automations-setting", path: f.projectFile })
  const ancestor = path.join(f.root, "ancestor.jsonc")
  if (layer === "global") await writeFile(f.globalFile, '{"experimental":{"schedules":false}}')
  else if (layer === "project") await writeFile(f.projectFile, '{"experimental":{"automations":false}}')
  else f.extra([{ type: "document", path: ancestor, info: { experimental: { schedules: false } } }])
  const before = await readFile(f.globalFile, "utf8")
  await assert.rejects(f.activation().prepare("w", f.location), refused({ provenance: "experimental-block", layer,
    path: layer === "global" ? f.globalFile : layer === "project" ? f.projectFile : ancestor }))
  assert.equal(await readFile(f.globalFile, "utf8"), before)
}))

test("every OFF source refuses with its layer: setting, hidden, pathless, environment and unnamed", async () => fixture(async f => {
  const globalBefore = await readFile(f.globalFile, "utf8"), projectBefore = await readFile(f.projectFile, "utf8")
  const prepare = () => f.activation().prepare("w", f.location)
  f.flag({ enabled: false, provenance: "experimental-block", path: f.globalFile })
  await assert.rejects(prepare(), refused({ provenance: "experimental-block", layer: "global", path: f.globalFile }))
  f.flag({ enabled: false, provenance: "automations-setting", path: f.projectFile })
  await assert.rejects(prepare(), refused({ provenance: "automations-setting", layer: "project", path: f.projectFile }))
  f.flag({ enabled: true, provenance: "automations-setting" })
  await writeFile(f.globalFile, '{"automations":false}')
  await assert.rejects(prepare(), refused({ provenance: "automations-setting", layer: "global", path: f.globalFile }))
  await writeFile(f.globalFile, globalBefore)
  const ancestor = path.join(f.root, "ancestor.jsonc")
  f.flag({ enabled: true, provenance: "automations-setting", path: f.projectFile, hiddenOff: [ancestor] })
  await assert.rejects(prepare(), refused({ provenance: "experimental-block", layer: "inherited", path: ancestor }))
  f.flag({ enabled: true, provenance: "channel-default", hiddenOff: ["OPENCODE_CONFIG_CONTENT"] })
  await assert.rejects(prepare(), refused({ provenance: "experimental-block", layer: "imposed" }))
  f.flag({ enabled: false, provenance: "automations-setting", path: "well-known" })
  await assert.rejects(prepare(), refused({ provenance: "automations-setting", layer: "imposed" }))
  f.flag({ enabled: false, provenance: "environment" })
  await assert.rejects(prepare(), refused({ provenance: "environment", layer: "environment" }))
  f.flag({ enabled: false, provenance: "channel-default" })
  await assert.rejects(prepare(), refused({ provenance: "channel-default", layer: "imposed" }), "an OFF no source names is never turned on by a write")
  assert.equal(await readFile(f.projectFile, "utf8"), projectBefore)
  assert.equal(await readFile(f.globalFile, "utf8"), globalBefore)
}))

test("an OFF appearing after the journaled plan refuses before readiness", async () => fixture(async f => {
  const plan = await f.activation().prepare("w", f.location)
  await assert.rejects(f.activation().apply("w", f.location, plan, { ...f.journal,
    prepared: async (value: any) => { await f.journal.prepared(value); await writeFile(f.globalFile, '{"automations":false}') },
  }), refused({ provenance: "automations-setting", layer: "global", path: f.globalFile }))
  assert.deepEqual(f.phases, [`prepared:${plan.authority}`])
}))

test("another execution host, a replaced connection or a malformed plan never reaches readiness", async () => fixture(async f => {
  const plan = await f.activation().prepare("w", f.location)
  await assert.rejects(f.activation().apply("w", f.location, { authority: "not-a-digest" }, f.journal), /Invalid native schedule activation intent/)
  f.selected("another-distro")
  await assert.rejects(f.activation().apply("w", f.location, plan, f.journal), /authority changed/)
  await assert.rejects(f.activation().verify("w", f.location, plan.authority), /authority changed/)
  assert.deepEqual(f.phases, [])
  f.selected(undefined)
  await assert.rejects(f.activation().apply("w", f.location, plan, { ...f.journal,
    prepared: async (value: any) => { await f.journal.prepared(value); f.current(false) },
  }), (error: any) => /replaced|connection/.test(error.message) || error.cause?.message === "replaced")
  assert.deepEqual(f.phases, [`prepared:${plan.authority}`])
}))
