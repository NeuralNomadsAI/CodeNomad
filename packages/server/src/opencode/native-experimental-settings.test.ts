import assert from "node:assert/strict"
import test from "node:test"
import type { PluginControlDocument } from "./plugin-control-document"
import { configuredMissionAutomation, readMissionExperimental } from "./native-experimental-settings"

const document = (text: string): PluginControlDocument => ({ requestedPath: "/project/.opencode/opencode.jsonc",
  writePath: "/project/.opencode/opencode.jsonc", exists: true, mode: 0o600, text, byteOrderMark: false, plugins: [] })

test("the Missions settings of an experimental block read with comments, and an explicit OFF under either name", () => {
  assert.deepEqual(readMissionExperimental(document("{}")), { automations: undefined, schedules: undefined, subagent_depth: undefined })
  const block = readMissionExperimental(document('{\r\n\t// keep\r\n\t"experimental": {"schedules":false,"subagent_depth":0,"part_rows":true}\r\n}\r\n'))
  assert.equal(block.subagent_depth, 0)
  assert.equal(configuredMissionAutomation(block), false)
  assert.equal(configuredMissionAutomation(readMissionExperimental(document('{"experimental":{"automations":true,"schedules":false}}'))), true,
    "the canonical key decides before its alias")
  assert.equal(configuredMissionAutomation(readMissionExperimental(document('{"experimental":{"subagent_depth":3}}'))), undefined)
})

test("malformed or ambiguous parents and settings are refused", () => {
  for (const text of ['{"experimental":false}', '{"experimental":null}', '{"experimental":{},"experimental":{}}',
    '{"experimental":{"schedules":true,"schedules":false}}', '{"experimental":{"subagent_depth":0,"subagent_depth":2}}',
    '{"experimental":{"schedules":"true"}}', '{"experimental":{"subagent_depth":-1}}'])
    assert.throws(() => readMissionExperimental(document(text)), /object|duplicate|Invalid/, text)
})
