import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parse } from "jsonc-parser"
import { PluginControls } from "./plugin-controls"
import { editMissionExperimental, inheritedMissionExperimental } from "./native-experimental-settings"
import { nativeScheduleContractFixture } from "./native-schedule-capability-fixture"
import { NativeScheduleSettingsActivation, type NativeScheduleActivationIntent, type NativeScheduleActivationJournal } from "./native-schedule-settings-activation"

async function fixture(run: (value: any) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-activation-"))
  const global = path.join(root, "global"), project = path.join(root, "project")
  await mkdir(global); await mkdir(project)
  const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, "opencode.jsonc")
  await writeFile(globalFile, '{"experimental":{"schedules":false,"subagent_depth":2}}\n')
  await writeFile(projectFile, '\uFEFF{\r\n\t// keep\r\n\t"experimental":{"subagent_depth":8,"todo":true}\r\n}\r\n')
  let current = true, extra: any[] = [], stale = false, selected: string | undefined, includeProject = true
  const entries = async () => [{ type: "document", path: globalFile,
    info: stale ? { experimental: { schedules: false } } : parse(await readFile(globalFile, "utf8")) },
  { type: "directory", path: global }, ...(includeProject ? [{ type: "document", path: projectFile,
    info: stale ? { experimental: { subagent_depth: 8 } } : parse((await readFile(projectFile, "utf8")).replace(/^\uFEFF/, "")) }] : []), ...extra]
  const connection: any = { endpoint: { url: "http://127.0.0.1:1234" }, assertCurrent() { if (!current) throw Error("replaced") },
    fetch: async () => Response.json(nativeScheduleContractFixture()), client: { config: { get: entries }, plugin: { list: async () => ({ data: [] }) } } }
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
    ready: async origin => { assert.equal(origin, projectFile); assert.ok(stored.targets.every(target => target.acknowledged)); ready = true },
  }
  const prepare = async () => { const plan = await activation().prepare("w", location)
    stored = { ...plan, targets: plan.targets.map(target => ({ ...target, attempted: false, acknowledged: false })) }; await save(); return structuredClone(stored) }
  try { await run({ activation, controls, location, prepare, journal, globalFile, projectFile, global, project, root,
    reload: async () => JSON.parse(await readFile(journalFile, "utf8")), intent: () => stored, ready: () => ready,
    current: (value: boolean) => { current = value }, extra: (value: any[]) => { extra = value },
    stale: (value: boolean) => { stale = value }, selected: (value: string) => { selected = value },
    missingProject: async () => { await rm(projectFile); includeProject = false } }) }
  finally { await chmod(globalFile, 0o600).catch(() => {}); await chmod(projectFile, 0o600).catch(() => {}); await rm(root, { recursive: true, force: true }) }
}

test("two-document activation prepares both files, journals each effect and requires native effective acknowledgement", async () => fixture(async f => {
  const before = await readFile(f.globalFile, "utf8")
  const intent = await f.prepare()
  assert.equal(await readFile(f.globalFile, "utf8"), before, "preparation creates no config effect")
  assert.deepEqual(intent.targets.map((target: any) => target.scope), ["global", "project"])
  await f.activation().apply("w", f.location, intent, f.journal)
  assert.equal(f.ready(), true)
  assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).experimental, { schedules: true, subagent_depth: 2 })
  const project = await readFile(f.projectFile, "utf8")
  assert.match(project, /^\uFEFF/); assert.match(project, /\r\n\t\/\/ keep/)
  assert.deepEqual(parse(project.slice(1)).experimental, { subagent_depth: 8, todo: true, schedules: true })
}))

test("a read-only project refuses before the first global rename", async () => fixture(async f => {
  await chmod(f.projectFile, 0o400)
  const intent = await f.prepare(), original = await readFile(f.globalFile, "utf8")
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /read-only|denied|permitted/i)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
  assert.ok(f.intent().targets.every((target: any) => !target.attempted))
  assert.equal(f.ready(), false)
}))

test("a read-only global file and a newly required project target refuse the whole preparation", async () => fixture(async f => {
  await chmod(f.globalFile, 0o400)
  const intent = await f.prepare()
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /read-only|denied|permitted/i)
  await chmod(f.globalFile, 0o600)
  await writeFile(f.projectFile, "{}")
  const single = await f.prepare()
  assert.equal(single.targets.length, 1)
  await writeFile(f.projectFile, '{"experimental":{"subagent_depth":0}}')
  await assert.rejects(f.activation().apply("w", f.location, single, f.journal), /targets changed/)
  assert.equal(parse(await readFile(f.globalFile, "utf8")).experimental.schedules, false)
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
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /explicitly disabled/)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
  await writeFile(f.projectFile, '{"experimental":{"subagent_depth":0}}')
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /changed/)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
}))

test("an imposed higher block is refused; a different selected host cannot reuse the same native paths", async () => fixture(async f => {
  const intent = await f.prepare()
  f.extra([{ type: "document", info: { experimental: { subagent_depth: 4, schedules: false } } }])
  await assert.rejects(f.activation().prepare("w", f.location), /higher-priority/)
  f.extra([]); f.selected("another-distro")
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /authority changed/)
  assert.equal(f.ready(), false)
}))

test("the first imposed block after an absent project insertion point refuses before any write", async () => fixture(async f => {
  await f.missingProject()
  f.extra([{ type: "document", info: { experimental: { schedules: false } } }])
  const original = await readFile(f.globalFile, "utf8")
  await assert.rejects(f.activation().prepare("w", f.location), /higher-priority/)
  assert.equal(await readFile(f.globalFile, "utf8"), original)
  await assert.rejects(readFile(path.join(f.project, ".opencode", "opencode.jsonc")), /ENOENT/)
  assert.equal(f.ready(), false)
}))

test("lost global acknowledgement is adopted exactly after reload before the unattempted project write", async () => fixture(async f => {
  const intent = await f.prepare()
  await assert.rejects(f.activation().apply("w", f.location, intent, { ...f.journal,
    acknowledged: async (scope: "global" | "project", digest: string) => { if (scope === "global") throw Error("lost ACK"); await f.journal.acknowledged(scope, digest) },
  }), /lost ACK/)
  assert.equal(parse(await readFile(f.globalFile, "utf8")).experimental.schedules, true)
  assert.equal(parse((await readFile(f.projectFile, "utf8")).slice(1)).experimental.schedules, undefined)
  assert.equal(f.ready(), false)
  const persisted = await f.reload()
  assert.equal(persisted.targets[0].attempted, true); assert.equal(persisted.targets[0].acknowledged, false)
  assert.equal(persisted.targets[1].attempted, false)
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

test("connection retirement after the global write preserves a partial intention without rollback", async () => fixture(async f => {
  const intent = await f.prepare()
  await assert.rejects(f.activation().apply("w", f.location, intent, { ...f.journal,
    acknowledged: async (scope: "global" | "project", digest: string) => { await f.journal.acknowledged(scope, digest); f.current(false) },
  }), /replaced|connection/)
  assert.equal(parse(await readFile(f.globalFile, "utf8")).experimental.schedules, true)
  assert.equal(f.intent().targets[1].attempted, false)
  assert.equal(f.ready(), false)
}))

test("watcher lag expires at ten seconds and can never publish readiness later", async () => fixture(async f => {
  const intent = await f.prepare(); f.stale(true)
  const started = performance.now()
  await assert.rejects(f.activation().apply("w", f.location, intent, f.journal), /timed out/)
  assert.ok(performance.now() - started >= 10_000)
  f.stale(false)
  assert.equal(f.ready(), false)
}))
