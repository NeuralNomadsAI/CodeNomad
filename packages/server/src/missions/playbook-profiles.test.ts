import assert from "node:assert/strict"
import test from "node:test"
import { missionProfileRoles, parseMissionProfiles, sameMissionProfiles, validateMissionProfiles, validateMissionProfileCatalog } from "./playbook-profiles"
import { getMissionRecipe } from "./recipes"
import type { MissionProfiles } from "./playbook-profiles"

test("profile roles match every playbook's declared role catalog", () => {
  for (const template of ["custom", "debug", "wayfinder"] as const) {
    assert.deepEqual([...missionProfileRoles[template]].sort(), getMissionRecipe(template).roles.map(role => role.id).sort())
  }
})

test("profile codec preserves historical absence and every explicit agent/model/variant", () => {
  assert.equal(parseMissionProfiles(undefined), undefined)
  assert.deepEqual(parseMissionProfiles({}), {})
  const value = { coordinator: { agent: "root", model: { providerID: "p", id: "m", variant: "high" } }, roles: {
    "review-standards": { agent: "child" }, "review-spec": { model: { providerID: "p", id: "m" } }, validator: {},
  } }
  const parsed = parseMissionProfiles(value)!
  assert.deepEqual(parsed, value)
  value.coordinator.model.variant = "low"
  assert.equal(parsed.coordinator!.model!.variant, "high")
  assert.doesNotThrow(() => validateMissionProfiles("debug", parsed))
})

test("strict bounded profile codec rejects malformed, unknown, unsafe and misplaced keys", () => {
  for (const value of [null, [], "profiles", new Date(), { unknown: {} }, { coordinator: undefined },
    { roles: [] }, { roles: null }, { roles: { unknown: {} } }, JSON.parse('{"roles":{"__proto__":{}}}'),
    { coordinator: { executionMode: "native" } }, { coordinator: { agent: " " } }, { coordinator: { agent: "a".repeat(241) } },
    { coordinator: { model: { providerID: "p", id: "m", variant: "" } } },
    { roles: { validator: { model: { providerID: "p", id: "m", extra: true } } } },
  ]) assert.throws(() => parseMissionProfiles(value))
  assert.throws(() => validateMissionProfiles("wayfinder", parseMissionProfiles({ roles: { validator: {} } })), /playbook/)
  assert.throws(() => validateMissionProfiles("custom", parseMissionProfiles({ roles: { research: {} } })), /playbook/)
  assert.doesNotThrow(() => validateMissionProfiles("wayfinder", parseMissionProfiles({ roles: { research: {} } })))
  assert.doesNotThrow(() => validateMissionProfiles("custom", undefined))
})

test("retry comparator covers absence, role membership and exact variant without key-order dependence", () => {
  const a = parseMissionProfiles({ coordinator: { agent: "root" }, roles: { validator: {}, "review-spec": { model: { providerID: "p", id: "m", variant: "high" } } } })
  const b = parseMissionProfiles({ roles: { "review-spec": { model: { variant: "high", id: "m", providerID: "p" } }, validator: {} }, coordinator: { agent: "root" } })
  assert.equal(sameMissionProfiles(a, b), true)
  const different: Array<MissionProfiles | undefined> = [undefined, {}, { roles: {} }, { ...b, coordinator: { agent: "other" } },
    { ...b, roles: { validator: {} } }, { ...b, roles: { ...b!.roles, "review-spec": { model: { providerID: "p", id: "m", variant: "low" } } } },
  ]
  for (const other of different) assert.equal(sameMissionProfiles(a, other), false)
  assert.equal(sameMissionProfiles(undefined, {}), false)
  assert.equal(sameMissionProfiles({}, { coordinator: {} }), false)
  assert.equal(sameMissionProfiles({}, { roles: {} }), false)
})

test("native presets use child legality and coordinator root legality with a fresh filtered native catalog", () => {
  const catalog = { agents: [
    { id: "root", mode: "primary" }, { id: "child", mode: "subagent" }, { id: "both", mode: "all" }, { id: "hidden", mode: "all", hidden: true },
  ], models: [{ providerID: "p", id: "m", variants: ["high"] }] }
  validateMissionProfileCatalog({ coordinator: { agent: "root" }, roles: {
    "review-standards": { agent: "child" }, "review-spec": { agent: "both" }, validator: { model: { providerID: "p", id: "m", variant: "high" } },
  } }, catalog)
  for (const profiles of [{ coordinator: { agent: "child" } }, { roles: { validator: { agent: "root" } } },
    { coordinator: { agent: "hidden" } }, { roles: { validator: { model: { providerID: "p", id: "disabled" } } } },
    { roles: { validator: { model: { providerID: "p", id: "no-tools" } } } },
    { coordinator: { model: { providerID: "p", id: "m", variant: "absent" } } },
  ]) assert.throws(() => validateMissionProfileCatalog(profiles, catalog))
  assert.doesNotThrow(() => validateMissionProfileCatalog(undefined, catalog))
})
