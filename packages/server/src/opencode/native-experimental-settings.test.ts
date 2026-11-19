import assert from "node:assert/strict"
import test from "node:test"
import { parse } from "jsonc-parser"
import type { ConfigEntry } from "@opencode/client"
import type { PluginControlDocument } from "./plugin-control-document"
import { editMissionExperimental, effectiveMissionExperimental, inheritedMissionExperimental } from "./native-experimental-settings"

const document = (text: string): PluginControlDocument => ({ requestedPath: "/project/.opencode/opencode.jsonc",
  writePath: "/project/.opencode/opencode.jsonc", exists: true, mode: 0o600, text, byteOrderMark: true, plugins: [] })
const value = (source: string) => parse(source.replace(/^\uFEFF/, ""))
const entry = (path: string, experimental?: unknown) => ({ type: "document", path, info: { experimental } }) as ConfigEntry

test("the two experimental authors preserve companions, false, zero, JSONC and unrelated keys", () => {
  const original = document('{\r\n\t// keep\r\n\t"experimental": {"todo":true},\r\n\t"model":"keep"\r\n}\r\n')
  const depth = editMissionExperimental(original, "subagent_depth", 0, { schedules: true })
  assert.ok(depth.startsWith("\uFEFF")); assert.match(depth, /\r\n\t\/\/ keep/)
  assert.deepEqual(value(depth), { experimental: { todo: true, automations: true, subagent_depth: 0 }, model: "keep" })
  const next = { ...original, text: depth.slice(1) }
  assert.deepEqual(value(editMissionExperimental(next, "subagent_depth", undefined, {})).experimental, { todo: true, automations: true })
  for (const inherited of [{}, { schedules: false }]) {
    assert.deepEqual(value(editMissionExperimental(document("{}"), "subagent_depth", 8, inherited)).experimental, { subagent_depth: 8 })
  }
  assert.deepEqual(value(editMissionExperimental(document('{"experimental":{"schedules":false}}'), "subagent_depth", 8,
    { schedules: true })).experimental, { schedules: false, subagent_depth: 8 })
  const activated = editMissionExperimental(document('{"experimental":{"subagent_depth":0}}'), "automations", true, { subagent_depth: 9 })
  assert.deepEqual(value(activated).experimental, { subagent_depth: 0, automations: true })
  assert.throws(() => editMissionExperimental(document('{"experimental":{"schedules":false}}'), "automations", true, {}), /explicitly disabled/)
  assert.deepEqual(value(editMissionExperimental(document('{"experimental":{"schedules":false}}'), "automations", true,
    { subagent_depth: 0 }, "global")).experimental, { schedules: false, automations: true })
  assert.deepEqual(value(editMissionExperimental(document("{}"), "automations", true,
    { subagent_depth: 0 }, "global")).experimental, { subagent_depth: 0, automations: true }, "a new block preserves inherited depth")
  assert.equal(value(editMissionExperimental(document('{"experimental":{"subagent_depth":8}}'), "subagent_depth", undefined, {})).experimental, undefined)
  assert.equal(value(editMissionExperimental(document('{"experimental":{"subagent_depth":8}}'), "subagent_depth", undefined,
    { schedules: true })).experimental, undefined, "sole-depth removal exposes the inherited block")
  assert.deepEqual(value(editMissionExperimental(document('{"experimental":{"subagent_depth":8,"todo":true}}'), "subagent_depth", undefined,
    { schedules: true })).experimental, { todo: true, automations: true }, "a surviving block keeps inherited schedule activation")
})

test("schedule activation preserves the depth default selected by an existing whole project block", () => {
  for (const experimental of [{ todo: true }, {}, { schedules: true }]) {
    const saved = value(editMissionExperimental(document(JSON.stringify({ experimental })), "automations", true,
      { subagent_depth: 8 }))
    assert.deepEqual(saved.experimental, { ...experimental, automations: true })
    assert.equal(saved.experimental.subagent_depth, undefined, "the existing block keeps the native depth default")
  }
  assert.deepEqual(value(editMissionExperimental(document("{}"), "automations", true, { subagent_depth: 8 })).experimental,
    { subagent_depth: 8, automations: true }, "only creating a block needs companion inheritance")
})

test("companion inheritance uses the block before the target, not the final project depth or a deep merge", () => {
  const entries = [entry("/base.json", { schedules: true, subagent_depth: 2 }),
    { type: "directory", path: "/global" } as ConfigEntry,
    entry("/project/opencode.jsonc", { subagent_depth: 8 }),
    entry("/project/.opencode/opencode.jsonc", { todo: true })]
  assert.deepEqual(inheritedMissionExperimental(entries, "/global/opencode.jsonc", "/project"), { schedules: true, subagent_depth: 2 })
  assert.deepEqual(inheritedMissionExperimental(entries, "/project/.opencode/opencode.jsonc", "/project"), { subagent_depth: 8 })
  assert.deepEqual(effectiveMissionExperimental(entries), { todo: true, origin: "/project/.opencode/opencode.jsonc" })
  assert.deepEqual(inheritedMissionExperimental(entries.slice(0, -1), "/project/.opencode/opencode.jsonc", "/project"), { subagent_depth: 8 })
  const globalWrite = editMissionExperimental(document("{}"), "automations", true,
    inheritedMissionExperimental(entries, "/global/opencode.jsonc", "/project"), "global")
  assert.deepEqual(value(globalWrite).experimental, { schedules: true, subagent_depth: 2, automations: true }, "project depth never leaks into global")
  assert.deepEqual(inheritedMissionExperimental([
    entry("C:\\global\\opencode.jsonc", { schedules: true }),
    { type: "directory", path: "C:\\global" } as ConfigEntry,
    entry("C:\\project\\opencode.jsonc", { subagent_depth: 0 }),
  ], "c:\\PROJECT\\.opencode\\opencode.jsonc", "C:\\project"), { subagent_depth: 0 })
  assert.deepEqual(inheritedMissionExperimental([
    { type: "directory", path: "/global" } as ConfigEntry,
    entry("/Project/opencode.jsonc", { subagent_depth: 8 }),
  ], "/project/.opencode/opencode.jsonc", "/project"), {}, "POSIX case remains significant")
})

test("creating an activation block preserves all effective inherited experimental options", () => {
  const inherited = { subagent_depth: 0, todo: true, all_flags: false,
    image_generate: { model: "fixture/image" }, location_idle_timeout: "4 hours" }
  const saved = editMissionExperimental(document('{\r\n\t// keep\r\n\t"model":"keep"\r\n}\r\n'), "automations", true, inherited)
  assert.deepEqual(value(saved), { model: "keep", experimental: { ...inherited, automations: true } })
  assert.match(saved, /\r\n\t\/\/ keep/)
})

test("both paths reject malformed or ambiguous parents and companion keys", () => {
  for (const text of ['{"experimental":false}', '{"experimental":null}', '{"experimental":{},"experimental":{}}',
    '{"experimental":{"schedules":true,"schedules":false}}', '{"experimental":{"subagent_depth":0,"subagent_depth":2}}',
    '{"experimental":{"schedules":"true"}}', '{"experimental":{"subagent_depth":-1}}'])
    assert.throws(() => editMissionExperimental(document(text), "subagent_depth", 8, {}), /object|duplicate|Invalid/)
})
