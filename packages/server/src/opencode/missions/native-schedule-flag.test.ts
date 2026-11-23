import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect } from "effect"
import { readNativeScheduleFlag } from "./native-schedule-flag"
import { legacyAutomationsOff, nativeAutomationsSetting } from "./native-automations-setting"

test("native flag reader uses the acquired resolver and classifies only its bounded non-secret result", async () => {
  const location = { directory: "/fixture", project: { id: "project", canonical: "/fixture" } }
  let entries: any[] = [], state = { enabled: false, source: "default" }, closed = false
  const read = () => Effect.runPromise(readNativeScheduleFlag({ location } as any).pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Config"), { entries: () => Effect.succeed(entries) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Flag"), { resolve: (input: unknown) => {
      assert.equal(input, entries); return { automations: state, unrelated: { secret: "private" } }
    } }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location),
    Effect.provideService(Context.Service<never, unknown>("@opencode/LocationLifecycle"), { isClosed: () => closed }),
  ))
  for (const enabled of [true, false]) {
    state = { enabled, source: "default" }
    assert.deepEqual(await read(), { enabled, provenance: "channel-default", hiddenOff: [] })
    entries = [{ type: "document", info: { experimental: { schedules: !enabled } } }]
    state = { enabled, source: "env" }
    assert.deepEqual(await read(), { enabled, provenance: "environment", hiddenOff: [] })
    state.source = "config"
    assert.deepEqual(await read(), { enabled, provenance: "experimental-block", hiddenOff: [] })
  }
  entries = [{ type: "document", info: { experimental: { all_flags: true } } },
    { type: "document", info: { experimental: {} } }]
  state = { enabled: true, source: "config" }
  assert.deepEqual(await read(), { enabled: true, provenance: "all-flags", hiddenOff: [] })
  state.source = "unknown"; await assert.rejects(read(), /resolution unavailable/)
  state.source = "config"; entries = new Array(257).fill({ type: "directory", path: "/fixture" })
  await assert.rejects(read(), /configuration incomplete/)
  entries = []; closed = true; await assert.rejects(read(), /Location retired/)
})

test("runtimes with the top-level setting keep a document's legacy OFF and default to on", async t => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), path = await import("node:path")
  const directory = await mkdtemp(path.join(tmpdir(), "codenomad-automations-")), legacy = path.join(directory, "global.jsonc"), project = path.join(directory, "project.json")
  t.after(() => rm(directory, { recursive: true, force: true }))
  // The legacy block, as saved for 2.3.2 and dropped from 2.4.0's normalized entries.
  await writeFile(legacy, '{\n  // saved before the upgrade\n  "experimental": { "automations": false, "todo": true },\n}\n')
  await writeFile(project, "{}")
  const location = { directory, project: { id: "project", canonical: directory } }
  let entries: any[] = []
  const read = () => Effect.runPromise(readNativeScheduleFlag({ location } as any).pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Config"), { entries: () => Effect.succeed(entries) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Flag"), { resolve: () => ({ todo: { enabled: true, source: "config" } }) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location),
    Effect.provideService(Context.Service<never, unknown>("@opencode/LocationLifecycle"), { isClosed: () => false }),
  ))
  assert.deepEqual(await read(), { enabled: true, provenance: "channel-default", hiddenOff: [] })
  entries = [{ type: "document", path: legacy, info: { experimental: { todo: true } } }, { type: "document", path: project, info: {} }]
  assert.deepEqual(await read(), { enabled: false, provenance: "experimental-block", path: legacy, hiddenOff: [] }, "no silent reactivation after the upgrade")
  entries[1].info = { automations: true }
  assert.deepEqual(await read(), { enabled: true, provenance: "automations-setting", path: project, hiddenOff: [legacy] }, "a higher top-level choice wins; the OFF it hides is reported")
  entries = [{ type: "document", path: project, info: { automations: true } }, { type: "document", path: legacy, info: { experimental: { todo: true } } }]
  assert.deepEqual(await read(), { enabled: false, provenance: "experimental-block", path: legacy, hiddenOff: [] }, "a higher legacy OFF wins")
  entries = [{ type: "document", info: { automations: false } }]
  assert.deepEqual(await read(), { enabled: false, provenance: "automations-setting", path: "well-known", hiddenOff: [] })
})
test("the top-level setting reader keeps inline, environment, inherited and unreadable legacy OFF closed", async () => {
  const legacyOff = '{"experimental":{"automations":false}}'
  const files: Record<string, string> = { "/g.json": legacyOff, "/p.json": "{}", "/both.json": '{"automations":true,"experimental":{"automations":false}}',
    "/broken.json": '{"experimental":', "/win.json": '{"experimental":{"automations":false},"shell":"{env:HOMEDIR}"}' }
  const readText = async (file: string) => { if (!(file in files)) throw new Error("Native automations setting unreadable"); return files[file] }
  const doc = (path?: string, info: any = {}) => ({ type: "document", ...(path ? { path } : {}), info }) as any
  const setting = (entries: any[], env: Record<string, string> = {}) => nativeAutomationsSetting(entries, { env, readText })
  assert.deepEqual(await setting([doc("/p.json"), doc()], { OPENCODE_CONFIG_CONTENT: legacyOff }),
    { enabled: false, source: "legacy-off", path: "OPENCODE_CONFIG_CONTENT", hiddenOff: [] }, "inline config saved for 2.3.2")
  assert.deepEqual(await setting([doc(undefined, { automations: true }), doc("/p.json")]),
    { enabled: true, source: "setting", path: "well-known", hiddenOff: [] }, "remote configuration is never labelled inline")
  for (const flags of ["-automations", "x,-schedules"])
    assert.deepEqual(await setting([doc("/p.json", { automations: true })], { OPENCODE_FLAGS: flags }),
      { enabled: false, source: "environment", hiddenOff: [] }, "a 2.3.2 environment override")
  assert.deepEqual(await setting([doc("/g.json"), doc("/p.json", { automations: true })]),
    { enabled: true, source: "setting", path: "/p.json", hiddenOff: ["/g.json"] })
  assert.deepEqual(await setting([doc("/both.json", { automations: true })]),
    { enabled: true, source: "setting", path: "/both.json", hiddenOff: ["/both.json"] }, "a staged migration keeps its legacy OFF visible")
  assert.deepEqual(await setting([doc("/managed.plist")]), { enabled: true, source: "default", hiddenOff: [] }, "managed preferences are not read as JSONC")
  assert.deepEqual(await setting([doc("/win.json")], { HOMEDIR: "C:\\Users\\me" }),
    { enabled: false, source: "legacy-off", path: "/win.json", hiddenOff: [] }, "the JSON-escaped {env:} fallback OpenCode applies")
  await assert.rejects(setting([doc("/missing.json")]), /unreadable/, "a source that cannot be read is unknown, never absent")
  await assert.rejects(setting([doc("/broken.json")]), /unreadable/)
  const legacy = (text: string, env: Record<string, string> = {}) => legacyAutomationsOff(text, "/", { env, readText })
  assert.equal(await legacy('{"experimental":{"automations":{env:OFF}}}', { OFF: "false" }), true, "{env:} substitution")
  assert.equal(await legacy('\uFEFF{ // c\n"experimental":{"schedules":false,},}'), true)
  assert.equal(await legacy('{"experimental":{"automations":"false","schedules":false}}'), true, "only booleans count, then the alias")
  assert.equal(await legacy('{"experimental":{"automations":true,"schedules":false}}'), false, "the canonical key before the alias")
})
test("a resolver result with no well-formed flag proves no top-level setting runtime", async () => {
  const location = { directory: "/fixture", project: { id: "project", canonical: "/fixture" } }
  for (const resolved of [{}, [], { todo: { enabled: "yes", source: "config" } }, null]) await assert.rejects(Effect.runPromise(readNativeScheduleFlag({ location } as any).pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Config"), { entries: () => Effect.succeed([]) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Flag"), { resolve: () => resolved }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location),
    Effect.provideService(Context.Service<never, unknown>("@opencode/LocationLifecycle"), { isClosed: () => false }),
  )), /resolution unavailable/)
})