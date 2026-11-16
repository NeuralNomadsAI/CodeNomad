import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parse } from "jsonc-parser"
import { PluginControls } from "./plugin-controls"
import { editMissionExperimental, inheritedMissionExperimental, nativeSettingExpectation } from "./native-experimental-settings"
import { nativeScheduleContractFixture } from "./native-schedule-capability-fixture"
import { NativeScheduleSettingsActivation, type NativeScheduleActivationIntent, type NativeScheduleActivationJournal } from "./native-schedule-settings-activation"

async function fixture(run: (value: any) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-activation-"))
  const global = path.join(root, "global"), project = path.join(root, "project")
  await mkdir(global); await mkdir(project)
  const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, "opencode.jsonc")
  await writeFile(globalFile, '{"experimental":{"subagent_depth":2}}\n')
  await writeFile(projectFile, '\uFEFF{\r\n\t// keep\r\n\t"experimental":{"subagent_depth":8,"todo":true}\r\n}\r\n')
  let current = true, extra: any[] = [], stale = false, selected: string | undefined, includeProject = true
  let flag: { enabled: boolean; provenance: string } | undefined
  const entries = async () => [{ type: "document", path: globalFile,
    info: stale ? { experimental: { subagent_depth: 2 } } : parse(await readFile(globalFile, "utf8")) },
  { type: "directory", path: global }, ...(includeProject ? [{ type: "document", path: projectFile,
    info: stale ? { experimental: { subagent_depth: 8 } } : parse((await readFile(projectFile, "utf8")).replace(/^\uFEFF/, "")) }]
    : await readFile(path.join(project, ".opencode", "opencode.jsonc"), "utf8").then(text => [{
      type: "document", path: path.join(project, ".opencode", "opencode.jsonc"), info: parse(text) }]).catch(() => [])), ...extra]
  const connection: any = { endpoint: { url: "http://127.0.0.1:1234" }, assertCurrent() { if (!current) throw Error("replaced") },
    fetch: async () => Response.json(nativeScheduleContractFixture()), client: { config: { get: entries }, plugin: { list: async () => ({ data: [] }) },
      rpc: () => ({ scheduleFlag: async () => {
        if (flag) return flag
        const documents = (await entries()).filter(entry => entry.type === "document")
        const block = [...documents].reverse().find(entry => entry.info.experimental !== undefined)?.info.experimental
        const all = [...documents].reverse().find(entry => entry.info.experimental?.all_flags !== undefined)?.info.experimental.all_flags
        return { enabled: block?.schedules ?? all === true,
          provenance: block?.schedules !== undefined ? "experimental-block" : all === true ? "all-flags" : "channel-default" }
      } }) } }
  const manager: any = { get: () => ({}), getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
    ownsLocation: async () => true, getWorktreeIdentityForPath: async () => "owned",
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id: string, value: string) => value }
  const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: {} as any })
  const activation = () => new NativeScheduleSettingsActivation(controls, { ...manager, getServiceWslDistro: () => selected })
  const location = { directory: project }
  const journalFile = path.join(root, "intent.json")
  let ready = false, stored: NativeScheduleActivationIntent
  const save = () => writeFile(journalFile, JSON.stringify(stored))
  const journal: NativeScheduleActivationJournal = {
    prepared: async plan => { assert.deepEqual(plan, { authority: stored.authority,
      targets: stored.targets.map(({ attempted: _a, acknowledged: _b, ...target }) => target) }); await save() },
    attempting: async scope => { stored.targets.find(target => target.scope === scope)!.attempted = true; await save() },
    acknowledged: async (scope, digest) => { const target = stored.targets.find(target => target.scope === scope)!
      assert.equal(target.resultDigest, digest); target.acknowledged = true; await save() },
    ready: async () => { assert.ok(stored.targets.every(target => target.acknowledged)); ready = true },
  }
  const prepare = async () => { const plan = await activation().prepare("w", location)
    stored = { ...plan, targets: plan.targets.map(target => ({ ...target, attempted: false, acknowledged: false })) }; await save(); return structuredClone(stored) }
  try { await run({ activation, controls, location, prepare, journal, globalFile, projectFile, global, project, root,
    reload: async () => JSON.parse(await readFile(journalFile, "utf8")), intent: () => stored, ready: () => ready,
    current: (value: boolean) => { current = value }, extra: (value: any[]) => { extra = value },
    stale: (value: boolean) => { stale = value }, selected: (value: string) => { selected = value },
    flag: (value: typeof flag) => { flag = value },
    missingProject: async () => { await rm(projectFile); includeProject = false } }) }
  finally { await chmod(globalFile, 0o600).catch(() => {}); await chmod(projectFile, 0o600).catch(() => {}); await rm(root, { recursive: true, force: true }) }
}

test("project-only activation journals its effect and requires native effective acknowledgement", async () => fixture(async f => {
  const before = await readFile(f.globalFile, "utf8")
  const intent = await f.prepare()
  assert.equal(await readFile(f.globalFile, "utf8"), before, "preparation creates no config effect")
  assert.deepEqual(intent.targets.map((target: any) => target.scope), ["project"])
  await f.activation().apply("w", f.location, intent, f.journal)
  assert.equal(f.ready(), true)
  assert.equal(await readFile(f.globalFile, "utf8"), before)
  const project = await readFile(f.projectFile, "utf8")
  assert.match(project, /^\uFEFF/); assert.match(project, /\r\n\t\/\/ keep/)
  assert.deepEqual(parse(project.slice(1)).experimental, { subagent_depth: 8, todo: true, schedules: true })
}))

test("a read-only project refuses before any effect", async () => fixture(async f => {
  await chmod(f.projectFile, 0o400)
  const intent = await f.prepare(), original = await readFile(f.globalFile, "utf8")
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /read-only|denied|permitted/i)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
  assert.ok(f.intent().targets.every((target: any) => !target.attempted))
  assert.equal(f.ready(), false)
}))

test("a read-only global file permits project-only activation", async () => fixture(async f => {
  await chmod(f.globalFile, 0o400)
  const intent = await f.prepare()
  const original = await readFile(f.globalFile, "utf8")
  await f.activation().apply("w", f.location, intent, f.journal)
  assert.equal(f.ready(), true)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
}))

test("a concurrent depth author cannot overwrite the activation companion", { timeout: 5_000 }, async () => fixture(async f => {
  const intent = await f.prepare()
  let entered!: () => void, release!: () => void, editing!: () => void
  const prepared = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const depthEntered = new Promise<void>(resolve => { editing = resolve })
  const active = f.activation().apply("w", f.location, intent, { ...f.journal,
    prepared: async (plan: any) => { await f.journal.prepared(plan); entered(); await gate },
  })
  await prepared
  const depth = f.controls.editConfigDocument("w", f.location, "project", (document: any, current: any) => {
    editing()
    return editMissionExperimental(document, "subagent_depth", 0,
      inheritedMissionExperimental(current.entries, current.path, current.location.directory))
  })
  const refused = assert.rejects(depth, /changed/)
  await depthEntered
  release()
  await active; await refused
  assert.deepEqual(parse((await readFile(f.projectFile, "utf8")).slice(1)).experimental,
    { subagent_depth: 8, todo: true, schedules: true })
}))

test("explicit OFF and changed targets refuse without a global side effect", async () => fixture(async f => {
  const intent = await f.prepare(), original = await readFile(f.globalFile, "utf8")
  await writeFile(f.projectFile, '{"experimental":{"schedules":false,"subagent_depth":0}}')
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), (error: any) => error.code === "schedule-activation-refused" && error.refusal.path === f.projectFile)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
  await writeFile(f.projectFile, '{"experimental":{"subagent_depth":0}}')
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /changed/)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
}))

test("an imposed higher block is refused; a different selected host cannot reuse the same native paths", async () => fixture(async f => {
  const intent = await f.prepare()
  f.extra([{ type: "document", info: { experimental: { subagent_depth: 4 } } }])
  await assert.rejects(f.activation().prepare("w", f.location), (error: any) => error.refusal.reason === "masked")
  f.extra([]); f.selected("another-distro")
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /authority changed/)
  assert.equal(f.ready(), false)
}))

test("the first imposed block after an absent project insertion point refuses before any write", async () => fixture(async f => {
  await f.missingProject()
  f.extra([{ type: "document", info: { experimental: {} } }])
  const original = await readFile(f.globalFile, "utf8")
  await assert.rejects(f.activation().prepare("w", f.location), (error: any) => error.refusal.reason === "masked")
  assert.equal(await readFile(f.globalFile, "utf8"), original)
  await assert.rejects(readFile(path.join(f.project, ".opencode", "opencode.jsonc")), /ENOENT/)
  assert.equal(f.ready(), false)
}))

test("lost project acknowledgement is adopted exactly after reload without rewriting", async () => fixture(async f => {
  const intent = await f.prepare()
  await assert.rejects(f.activation().apply("w", f.location, intent, { ...f.journal,
    acknowledged: async () => { throw Error("lost ACK") },
  }), /lost ACK/)
  assert.equal(parse(await readFile(f.globalFile, "utf8")).experimental.schedules, undefined)
  assert.equal(parse((await readFile(f.projectFile, "utf8")).slice(1)).experimental.schedules, true)
  assert.equal(f.ready(), false)
  const persisted = await f.reload()
  assert.equal(persisted.targets[0].attempted, true); assert.equal(persisted.targets[0].acknowledged, false)
  await f.activation().apply("w", f.location, persisted, f.journal)
  assert.equal(f.ready(), true)
}))

test("an uncertain attempted effect with original bytes is never resent", async () => fixture(async f => {
  const intent = await f.prepare(), original = await readFile(f.globalFile, "utf8")
  await assert.rejects(f.activation().apply("w", f.location, intent, { ...f.journal,
    attempting: async (scope: "global" | "project", digest: string) => { await f.journal.attempting(scope, digest); throw Error("attempt ACK lost") },
  }), /ACK lost/)
  await assert.rejects(f.activation().apply("w", f.location, await f.reload(), f.journal), /uncertain/)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
  assert.equal(f.ready(), false)
}))

test("connection retirement after the project write preserves its intention without rollback", async () => fixture(async f => {
  const intent = await f.prepare()
  await assert.rejects(f.activation().apply("w", f.location, intent, { ...f.journal,
    acknowledged: async (scope: "global" | "project", digest: string) => { await f.journal.acknowledged(scope, digest); f.current(false) },
  }), (error: any) => /replaced|connection/.test(error.message) || error.cause?.message === "replaced")
  assert.equal(parse((await readFile(f.projectFile, "utf8")).slice(1)).experimental.schedules, true)
  assert.equal(f.intent().targets[0].attempted, true)
  assert.equal(f.ready(), false)
}))

test("already ON produces zero targets and zero file writes", async () => fixture(async f => {
  await writeFile(f.projectFile, '{"experimental":{"schedules":true}}')
  const original = await readFile(f.projectFile, "utf8"), global = await readFile(f.globalFile, "utf8")
  const intent = await f.prepare()
  assert.deepEqual(intent.targets, [])
  await chmod(f.projectFile, 0o400); await chmod(f.globalFile, 0o400)
  await f.activation().apply("w", f.location, intent, f.journal)
  assert.equal(f.ready(), true)
  await f.activation().verify("w", f.location, intent.authority)
  assert.equal(await readFile(f.projectFile, "utf8"), original)
  assert.equal(await readFile(f.globalFile, "utf8"), global)
}))

for (const layer of ["global", "inherited", "project"]) test(`explicit ${layer} OFF refuses even when hidden by ON`, async () => fixture(async f => {
  await writeFile(f.projectFile, '{"experimental":{"schedules":true}}')
  if (layer === "global") await writeFile(f.globalFile, '{"experimental":{"schedules":false}}')
  else if (layer === "project") await writeFile(f.projectFile, '{"experimental":{"schedules":false}}')
  else f.extra([{ type: "document", path: path.join(f.root, "ancestor.jsonc"), info: { experimental: { schedules: false } } },
    { type: "document", info: { experimental: { schedules: true } } }])
  const before = await readFile(f.globalFile, "utf8")
  await assert.rejects(f.prepare(), (error: any) => error.code === "schedule-activation-refused" && error.refusal.layer === layer)
  assert.equal(await readFile(f.globalFile, "utf8"), before)
}))

test("environment OFF refuses; channel defaults and all_flags:false permit a project activation", async () => fixture(async f => {
  f.flag({ enabled: false, provenance: "environment" })
  await assert.rejects(f.prepare(), (error: any) => error.refusal.layer === "environment" && error.refusal.path === undefined)
  f.flag({ enabled: false, provenance: "channel-default" })
  await writeFile(f.globalFile, '{"experimental":{"all_flags":false}}')
  assert.deepEqual((await f.prepare()).targets.map((target: any) => target.scope), ["project"])
  for (const provenance of ["environment", "channel-default", "all-flags"]) {
    f.flag({ enabled: true, provenance })
    assert.deepEqual((await f.prepare()).targets, [])
  }
}))

test("a global OFF appearing after preparation refuses before the project write attempt", async () => fixture(async f => {
  const intent = await f.prepare(), original = await readFile(f.projectFile, "utf8")
  await assert.rejects(f.activation().apply("w", f.location, intent, { ...f.journal,
    prepared: async (plan: any) => {
      await f.journal.prepared(plan)
      await writeFile(f.globalFile, '{"experimental":{"schedules":false}}')
    },
  }), (error: any) => error.code === "schedule-activation-refused")
  assert.equal(await readFile(f.projectFile, "utf8"), original)
  assert.equal(f.intent().targets[0].attempted, false)
}))

test("an absent project config inherits all effective options into its new activation block", async () => fixture(async f => {
  await f.missingProject()
  const inherited = { subagent_depth: 0, todo: true, background_compaction: false, all_flags: false }
  await writeFile(f.globalFile, JSON.stringify({ experimental: inherited }))
  const intent = await f.prepare()
  assert.deepEqual(intent.targets.map((target: any) => target.scope), ["project"])
  await f.activation().apply("w", f.location, intent, f.journal)
  assert.deepEqual(parse(await readFile(intent.targets[0].path, "utf8")).experimental, { ...inherited, schedules: true })
}))

test("legacy global intentions observe attempted bytes only and never write an unattempted target", async () => fixture(async f => {
  const single = await f.prepare()
  const view = await f.controls.readConfigDocuments("w", f.location, undefined, true)
  const global = view.documents.find((item: any) => item.scope === "global")
  const updated = editMissionExperimental(global.document, "schedules", true, {}, "global")
  const target = { scope: "global" as const, path: global.path, expectation: nativeSettingExpectation(global.document),
    resultDigest: createHash("sha256").update(updated).digest("hex"), attempted: false, acknowledged: false }
  const intent = { ...single, targets: [target, ...single.targets] }
  const original = await readFile(f.globalFile, "utf8")
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /observation/)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
  await writeFile(f.globalFile, updated); target.attempted = true
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /observation/)
  assert.equal(parse((await readFile(f.projectFile, "utf8")).slice(1)).experimental.schedules, undefined)
  target.attempted = false
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /before this activation attempt/)
}))

test("watcher lag expires at ten seconds and can never publish readiness later", async () => fixture(async f => {
  const intent = await f.prepare(); f.stale(true)
  const started = performance.now()
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /timed out/)
  assert.ok(performance.now() - started >= 10_000)
  f.stale(false)
  assert.equal(f.ready(), false)
}))
