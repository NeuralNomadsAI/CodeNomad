import assert from "node:assert/strict"
import { test } from "node:test"
import { missionPreferenceExpectation } from "./mission-preferences-document"
import { validMissionDefaults, missionDefaultsFor, normalizeMissionDefaults } from "./mission-defaults"
import { validMissionModels } from "./mission-model-library"

test("missing preferences are genuinely empty; invalid preferences remain distinguishable", () => {
  for (const value of [undefined, []]) { assert.equal(validMissionDefaults(value), true); assert.equal(validMissionModels(value), true) }
  for (const value of [null, {}, false, [null], "bad"]) { assert.equal(validMissionDefaults(value), false); assert.equal(validMissionModels(value), false) }
  assert.deepEqual(missionPreferenceExpectation({}, "missionModels"), { key: "missionModels", present: false })
  assert.deepEqual(missionPreferenceExpectation({ settings: { missionModels: null } }, "missionModels"), { key: "missionModels", present: true, value: null })
})

test("CAS expectations copy exact raw arrays and omit unrelated preferences", () => {
  const owner = { settings: { missionModels: [{ corrupt: true }], unrelated: "keep" }, secrets: "not a condition" }
  const condition = missionPreferenceExpectation(owner, "missionModels")
  assert.deepEqual(condition, { key: "missionModels", present: true, value: [{ corrupt: true }] })
  owner.settings.missionModels[0].corrupt = false
  assert.deepEqual(condition, { key: "missionModels", present: true, value: [{ corrupt: true }] })
})

test("explicit empty scenario overrides request native defaults rather than inheriting global selections", () => {
  const global = { coordinator: { agent: "root" }, roles: { specialist: { agent: "child" } } }
  const input = normalizeMissionDefaults([{ template: "custom", profiles: global }, { template: "wayfinder", profiles: { coordinator: {}, roles: { research: {} } } }])
  const resolved = missionDefaultsFor(input, "wayfinder")!
  assert.deepEqual(resolved.coordinator, {})
  assert.deepEqual(resolved.roles!.research, {})
  assert.deepEqual(resolved.roles!.decision, global.roles.specialist)
})
