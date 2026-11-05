import assert from "node:assert/strict"
import { test } from "node:test"
import { missionProfileRoles, type MissionProfiles } from "./playbook-profiles"
import { MissionPreferencesError, resolveMissionCreationDefaults, type MissionProfileDefault } from "./profile-defaults"
import type { MissionTemplateId } from "./model"

const coordinator = { agent: "coordinator", model: { providerID: "p", id: "coordinator", variant: "high" } }
const specialist = { agent: "worker", model: { providerID: "p", id: "worker", variant: "low" } }
const preferences: MissionProfileDefault[] = [{ template: "all", profiles: { coordinator, roles: { specialist } }, taskMode: "independent" }]
const templates = Object.keys(missionProfileRoles) as MissionTemplateId[]

test("missing preferences resolve complete native profiles and origins for every template", () => {
  for (const template of templates) for (const preferences of [undefined, []]) {
    assert.deepEqual(resolveMissionCreationDefaults({ template, preferences }), {
      profiles: { coordinator: {}, roles: Object.fromEntries(missionProfileRoles[template].map(role => [role, {}])) },
      taskMode: "native",
      origins: { coordinator: "opencode-default", taskMode: "opencode-default",
        roles: Object.fromEntries(missionProfileRoles[template].map(role => [role, "opencode-default"])) },
    })
  }
})

test("global specialist expands only to the exact template roles, except the Compare judge", () => {
  for (const template of templates) {
    const result = resolveMissionCreationDefaults({ template, preferences })
    assert.deepEqual(result.profiles.coordinator, coordinator)
    assert.deepEqual(Object.keys(result.profiles.roles), missionProfileRoles[template])
    for (const role of missionProfileRoles[template]) {
      assert.deepEqual(result.profiles.roles[role], role === "comparator" ? { model: coordinator.model } : specialist)
      assert.equal(result.origins.roles[role], "preference")
    }
    assert.equal(result.origins.coordinator, "preference")
    assert.equal(result.taskMode, "independent")
    assert.equal(result.origins.taskMode, "preference")
  }
})

test("partial preferences and explicit profiles leave only missing slots on defaults", () => {
  const result = resolveMissionCreationDefaults({ template: "wayfinder",
    preferences: [{ template: "wayfinder", profiles: { roles: { research: specialist } } }],
    profiles: { coordinator: { agent: "explicit" }, roles: { prototype: specialist } },
  })
  assert.deepEqual(result.profiles, { coordinator: { agent: "explicit" },
    roles: { cartographer: {}, research: specialist, prototype: specialist, grilling: {}, decision: {} } })
  assert.deepEqual(result.origins, { coordinator: "explicit", taskMode: "opencode-default",
    roles: { cartographer: "opencode-default", research: "preference", prototype: "explicit", grilling: "opencode-default", decision: "opencode-default" } })
})

test("explicit empty and agent-only selections replace whole slots; empty profile containers inherit", () => {
  const baseline = resolveMissionCreationDefaults({ template: "debug", preferences })
  for (const profiles of [{}, { roles: {} }]) {
    assert.deepEqual(resolveMissionCreationDefaults({ template: "debug", preferences, profiles }), baseline)
  }
  for (const selection of [{}, { agent: "explicit" }]) {
    const result = resolveMissionCreationDefaults({ template: "debug", preferences,
      profiles: { coordinator: selection, roles: { validator: selection } } })
    assert.deepEqual(result.profiles.coordinator, selection)
    assert.deepEqual(result.profiles.roles.validator, selection)
    assert.deepEqual(result.profiles.roles.implementer, specialist)
    assert.equal(result.origins.coordinator, "explicit")
    assert.equal(result.origins.roles.validator, "explicit")
    assert.equal(result.origins.roles.implementer, "preference")
  }
})

test("template preferences override global whole slots while empty containers inherit", () => {
  for (const selection of [{}, { agent: "typed" }]) {
    const result = resolveMissionCreationDefaults({ template: "debug", preferences: [...preferences,
      { template: "debug", profiles: { coordinator: selection, roles: { validator: selection } }, taskMode: "native" }] })
    assert.deepEqual(result.profiles.coordinator, selection)
    assert.deepEqual(result.profiles.roles.validator, selection)
    assert.deepEqual(result.profiles.roles.implementer, specialist)
    assert.equal(result.taskMode, "native")
    assert.equal(result.origins.coordinator, "preference")
    assert.equal(result.origins.roles.validator, "preference")
    assert.equal(result.origins.taskMode, "preference")
  }
  assert.deepEqual(resolveMissionCreationDefaults({ template: "debug", preferences: [...preferences,
    { template: "debug", profiles: {} }] }), resolveMissionCreationDefaults({ template: "debug", preferences }))
  const custom = resolveMissionCreationDefaults({ template: "custom", preferences: [...preferences,
    { template: "custom", profiles: { roles: { specialist: {} } } }] })
  assert.deepEqual(custom.profiles.roles.specialist, {})
})

test("task mode resolves explicit, template, global, then native with the matching origin", () => {
  for (const taskMode of ["native", "independent"] as const) {
    const result = resolveMissionCreationDefaults({ template: "debug", preferences, taskMode })
    assert.equal(result.taskMode, taskMode)
    assert.equal(result.origins.taskMode, "explicit")
    const typed = resolveMissionCreationDefaults({ template: "debug", preferences: [...preferences,
      { template: "debug", profiles: {}, taskMode }] })
    assert.equal(typed.taskMode, taskMode)
    assert.equal(typed.origins.taskMode, "preference")
  }
})

test("Compare's missing judge inherits only the coordinator model and its origin", () => {
  for (const selection of [coordinator, {}, { agent: "coordinator-only" }]) {
    const result = resolveMissionCreationDefaults({ template: "compare", preferences, profiles: { coordinator: selection } })
    assert.deepEqual(result.profiles.roles.comparator, "model" in selection ? { model: selection.model } : {})
    assert.equal(result.origins.roles.comparator, "explicit")
    assert.deepEqual(result.profiles.roles["model-a"], specialist)
    assert.deepEqual(result.profiles.roles["model-b"], specialist)
  }
  const withoutCoordinator = resolveMissionCreationDefaults({ template: "compare",
    preferences: [{ template: "all", profiles: { roles: { specialist } } }] })
  assert.deepEqual(withoutCoordinator.profiles.roles.comparator, {})
  assert.equal(withoutCoordinator.origins.roles.comparator, "opencode-default")
})

test("Compare's selected judge stays whole even when empty or agent-only", () => {
  for (const comparator of [{}, { agent: "judge" }, specialist]) {
    const explicit = resolveMissionCreationDefaults({ template: "compare", preferences, profiles: { roles: { comparator } } })
    assert.deepEqual(explicit.profiles.roles.comparator, comparator)
    assert.equal(explicit.origins.roles.comparator, "explicit")
    const preferred = resolveMissionCreationDefaults({ template: "compare", preferences: [...preferences,
      { template: "compare", profiles: { roles: { comparator } } }] })
    assert.deepEqual(preferred.profiles.roles.comparator, comparator)
    assert.equal(preferred.origins.roles.comparator, "preference")
  }
})

test("invalid raw preferences throw a typed error before normalization or explicit overrides", () => {
  const valid = { template: "all", profiles: { coordinator } }
  for (const preferences of [null, {}, false, "bad", [null], [valid, valid],
    [{ template: "unknown", profiles: {} }], [{ template: "debug" }],
    [{ template: "all", profiles: {}, extra: true }], [{ template: "all", profiles: {}, taskMode: "bad" }],
    [{ template: "all", profiles: { coordinator: { model: { providerID: "p" } } } }],
    [{ template: "all", profiles: { roles: { research: specialist } } }],
    [{ template: "debug", profiles: { roles: { decision: specialist } } }],
    [{ template: "all", profiles: { coordinator: { apiKey: "invalid" } } }], Array(7).fill(valid)]) {
    assert.throws(() => resolveMissionCreationDefaults({ template: "debug", preferences, profiles: { coordinator }, taskMode: "native" }),
      error => error instanceof Error && error instanceof MissionPreferencesError && error.code === "mission-preferences-invalid")
  }
})

test("explicit profiles and task modes retain strict boundary validation", () => {
  for (const profiles of [null, { coordinator: null }, { roles: { decision: specialist } }, { extra: true }]) {
    assert.throws(() => resolveMissionCreationDefaults({ template: "debug", preferences, profiles: profiles as MissionProfiles }))
  }
  for (const taskMode of [null, "bad", false]) {
    assert.throws(() => resolveMissionCreationDefaults({ template: "debug", preferences, taskMode: taskMode as "native" }))
  }
})

test("legacy custom preferences migrate to all without changing the input", () => {
  const legacy = [{ ...preferences[0], template: "custom" }]
  const snapshot = structuredClone(legacy)
  for (const template of templates) {
    assert.deepEqual(resolveMissionCreationDefaults({ template, preferences: legacy }), resolveMissionCreationDefaults({ template, preferences }))
  }
  assert.deepEqual(legacy, snapshot)
})

test("an omitted Compare judge freezes a known coordinator model without completing selected judge slots", () => {
  const coordinatorModel = { providerID: "p", id: "known", variant: "default" }
  const inherited = resolveMissionCreationDefaults({ template: "compare", preferences: [], coordinatorModel })
  assert.deepEqual(inherited.profiles.coordinator, {})
  assert.deepEqual(inherited.profiles.roles.comparator, { model: { providerID: "p", id: "known" } })
  assert.equal(inherited.origins.roles.comparator, "opencode-default")
  for (const comparator of [{}, { agent: "judge" }]) {
    const explicit = resolveMissionCreationDefaults({ template: "compare", preferences: [], coordinatorModel, profiles: { roles: { comparator } } })
    assert.deepEqual(explicit.profiles.roles.comparator, comparator)
    assert.equal(explicit.origins.roles.comparator, "explicit")
    const preference = resolveMissionCreationDefaults({ template: "compare", coordinatorModel,
      preferences: [{ template: "compare", profiles: { roles: { comparator } } }] })
    assert.deepEqual(preference.profiles.roles.comparator, comparator)
    assert.equal(preference.origins.roles.comparator, "preference")
  }
})

test("every resolution is an independent copy of preferences and explicit inputs", () => {
  const input = { template: "compare" as const, preferences: structuredClone(preferences), profiles: { coordinator: structuredClone(coordinator) } }
  const snapshot = structuredClone(input)
  const first = resolveMissionCreationDefaults(input), second = resolveMissionCreationDefaults(input)
  first.profiles.coordinator.model!.id = "changed"
  first.profiles.roles["model-a"].model!.variant = "changed"
  first.origins.roles.comparator = "opencode-default"
  assert.deepEqual(input, snapshot)
  assert.deepEqual(second, resolveMissionCreationDefaults(input))
})
