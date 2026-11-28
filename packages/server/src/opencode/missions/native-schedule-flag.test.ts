import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect } from "effect"
import { readNativeScheduleFlag } from "./native-schedule-flag"
import { legacyAutomationsOff, nativeAutomationsSetting } from "./native-automations-setting"

test("native flag reader uses the acquired resolver and refuses another contract, unbounded entries and a retired Location", async () => {
  const location = { directory: "/fixture", project: { id: "project", canonical: "/fixture" } }
  let entries: any[] = [], flags: Record<string, unknown> = { part_rows: { enabled: true, source: "default" } }, closed = false
  const read = () => Effect.runPromise(readNativeScheduleFlag({ location } as any).pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Config"), { entries: () => Effect.succeed(entries) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Flag"), { resolve: (input: unknown) => { assert.equal(input, entries); return flags } }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location),
    Effect.provideService(Context.Service<never, unknown>("@opencode/LocationLifecycle"), { isClosed: () => closed }),
  ))
  assert.deepEqual(await read(), { enabled: true, provenance: "channel-default", hiddenOff: [] })
  // A resolver that lists the flag reads it from the experimental block: another contract.
  for (const other of [{ automations: { enabled: true, source: "config" } }, {}, { part_rows: { enabled: true, source: "unknown" } },
    { part_rows: { secret: "private" } }]) {
    flags = other
    await assert.rejects(read(), /resolution unavailable/)
  }
  flags = { part_rows: { enabled: true, source: "default" } }
  entries = new Array(257).fill({ type: "directory", path: "/fixture" })
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
const path = await import("node:path")
test("the top-level setting reader keeps inline, environment, inherited and unreadable legacy OFF closed", async () => {
  const legacyOff = '{"experimental":{"automations":false}}'
  const files: Record<string, string> = { "/g.json": legacyOff, "/p.json": "{}", "/both.json": '{"automations":true,"experimental":{"automations":false}}',
    "/broken.json": '{"experimental":', "/managed.plist": '<?xml version="1.0"?><plist><dict/></plist>', "/chosen.plist": legacyOff,
    [path.resolve("/worktree", "switch")]: "false", [path.resolve("/daemon", "switch")]: "true", "/win.json": '{"experimental":{"automations":false},"shell":"{env:HOMEDIR}"}' }
  const readText = async (file: string) => { if (!(file in files)) throw new Error("Native automations setting unreadable"); return files[file] }
  const doc = (path?: string, info: any = {}) => ({ type: "document", ...(path ? { path } : {}), info }) as any
  const setting = (entries: any[], env: Record<string, string> = {}, directory = "/work") => nativeAutomationsSetting(entries, directory, { env, readText })
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
  assert.deepEqual(await setting([doc("/chosen.plist")]), { enabled: false, source: "legacy-off", path: "/chosen.plist", hiddenOff: [] },
    "a JSONC file is read whatever its name")
  const inlineFile = { OPENCODE_CONFIG_CONTENT: '{"experimental":{"automations":{file:switch}}}' }
  assert.deepEqual(await setting([doc()], inlineFile, "/worktree"), { enabled: false, source: "legacy-off", path: "OPENCODE_CONFIG_CONTENT", hiddenOff: [] },
    "inline {file:} resolves from the Location")
  assert.deepEqual(await setting([doc()], inlineFile, "/daemon"), { enabled: true, source: "default", hiddenOff: [] })
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
test("real reads are bounded to 1 MiB on one handle", async t => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), path = await import("node:path")
  const directory = await mkdtemp(path.join(tmpdir(), "codenomad-automations-bound-")), file = path.join(directory, "big.json")
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(file, `{"experimental":{"automations":false},"pad":"${"x".repeat(1024 * 1024)}"}`)
  await assert.rejects(nativeAutomationsSetting([{ type: "document", path: file, info: {} } as any], directory), /unreadable/)
  await writeFile(file, '{"experimental":{"automations":false}}')
  assert.equal((await nativeAutomationsSetting([{ type: "document", path: file, info: {} } as any], directory)).enabled, false)
})
test("one flag read bounds its expanded text and references", async () => {
  const big = "y".repeat(1024 * 1024), readText = async (file: string) => file.endsWith("big") ? big : "x"
  const config = (count: number, name: string) => `{"experimental":{"automations":false},"a":[${Array.from({ length: count }, () => `"{file:${name}}"`).join(",")}]}`
  const inline = (text: string) => nativeAutomationsSetting([{ type: "document", info: {} } as any], "/work", { env: { OPENCODE_CONFIG_CONTENT: text }, readText })
  assert.equal((await inline(config(2, "big"))).enabled, false)
  await assert.rejects(inline(config(9, "big")), /unreadable/, "a small config repeating a large reference")
  await assert.rejects(inline(config(65, "small")), /unreadable/, "too many references")
})
test("environment substitutions count against the read budget in bytes", async () => {
  const env = { OPENCODE_CONFIG_CONTENT: `{"experimental":{"automations":false},"a":[${Array.from({ length: 10 }, () => '"{env:BIG}"').join(",")}]}`,
    BIG: "é".repeat(512 * 1024) }
  await assert.rejects(nativeAutomationsSetting([{ type: "document", info: {} } as any], "/work", { env, readText: async () => "" }), /unreadable/,
    "ten 1 MiB (UTF-8) values in a compact config")
  assert.equal((await nativeAutomationsSetting([{ type: "document", info: {} } as any], "/work", { env: { ...env, BIG: "x" }, readText: async () => "" })).enabled, false)
})