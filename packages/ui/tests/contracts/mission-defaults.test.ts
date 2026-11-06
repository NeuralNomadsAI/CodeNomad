import assert from "node:assert/strict"
import { test } from "node:test"
import * as server from "../../../server/src/missions/profile-defaults"
import * as ui from "../../src/lib/mission-defaults"
import { missionProfileRoles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"

test("UI creation defaults and server resolution agree for all five templates, including the inherited Compare judge", () => {
  const coordinator = { agent: "coordinator", model: { providerID: "p", id: "coordinator", variant: "high" } }
  const specialist = { agent: "worker", model: { providerID: "p", id: "worker" } }
  const templates = Object.keys(missionProfileRoles) as MissionTemplateId[]
  const cases: unknown[] = [undefined, [],
    [{ template: "all", profiles: { coordinator, roles: { specialist } }, taskMode: "independent" }],
    [{ template: "custom", profiles: { coordinator, roles: { specialist } }, taskMode: "independent" }],
    [{ template: "all", profiles: { coordinator, roles: { specialist } }, taskMode: "independent" },
      ...templates.map(template => ({ template, profiles: { coordinator: { agent: "typed" },
        roles: { [missionProfileRoles[template][0]]: {} } }, taskMode: "native" }))],
    [{ template: "all", profiles: { coordinator } }, { template: "compare", profiles: { roles: { comparator: specialist } } }],
    ...[{}, { agent: "judge" }].map(comparator => [
      { template: "all", profiles: { coordinator } }, { template: "compare", profiles: { roles: { comparator } } },
    ]),
  ]
  for (const preferences of cases) for (const template of templates) {
    const normalized = ui.normalizeMissionDefaults(preferences)
    const { payload } = ui.effectiveMissionProfiles(template, { defaults: normalized })
    const result = server.resolveMissionCreationDefaults({ template, preferences })
    const roles = Object.fromEntries(missionProfileRoles[template].map(role => [role,
      payload?.roles?.[role] ?? {}]))
    assert.deepEqual(result.profiles, { coordinator: payload?.coordinator ?? {}, roles }, template)
    assert.equal(result.taskMode, ui.missionTaskModeFor(normalized, template), template)
  }
})

test("effective editor and server Compare payloads agree for explicit and preferred judge slots", () => {
  const coordinator = { model: { providerID: "p", id: "coordinator", variant: "high" } }
  const runs = { "model-a": { model: { providerID: "p", id: "a" } }, "model-b": { model: { providerID: "p", id: "b" } } }
  for (const comparator of [{}, { agent: "judge" }, { agent: "judge", model: { providerID: "p", id: "own" } }]) {
    for (const source of ["explicit", "preference"] as const) {
      const profiles = { coordinator, roles: { ...runs, comparator } }
      const preferences = source === "preference" ? [{ template: "compare", profiles }] : []
      const { payload } = ui.effectiveMissionProfiles("compare", source === "preference"
        ? { defaults: ui.normalizeMissionDefaults(preferences) } : { profiles })
      const resolved = server.resolveMissionCreationDefaults({ template: "compare", preferences,
        ...(source === "explicit" ? { profiles } : {}) })
      assert.deepEqual(resolved.profiles, payload)
      assert.equal(resolved.origins.roles.comparator, source)
      assert.deepEqual(resolved.profiles.roles.comparator.model, comparator.model ?? coordinator.model)
    }
  }
})

test("editor defaults keep the judge inherited while explicit whole drafts never reapply preferences", () => {
  const coordinator = { model: { providerID: "p", id: "coordinator" } }
  for (const comparator of [undefined, {}, { agent: "judge" }, { model: { providerID: "p", id: "own" } }]) {
    const preferences = ui.normalizeMissionDefaults([{ template: "all", profiles: { coordinator } },
      { template: "compare", profiles: { roles: comparator === undefined ? {} : { comparator } } }])
    const before = structuredClone(preferences)
    const { draft, payload } = ui.effectiveMissionProfiles("compare", { defaults: preferences })
    assert.ok(draft)
    assert.deepEqual(draft.roles?.comparator, comparator, "loading keeps the judge's editable slot unfrozen")
    draft.coordinator = { model: { providerID: "p", id: "changed" } }
    const updated = ui.effectiveMissionProfiles("compare", { profiles: draft }).payload
    assert.deepEqual(updated?.roles?.comparator?.model, comparator?.model ?? draft.coordinator.model)
    assert.deepEqual(payload?.roles?.comparator?.model, comparator?.model ?? coordinator.model, "earlier payloads remain frozen")
    assert.deepEqual(preferences, before)
  }
  for (const profiles of [undefined, {}, { coordinator: {} }, { roles: { comparator: {} } }]) {
    const result = ui.effectiveMissionProfiles("compare", { profiles })
    assert.equal(result.draft, profiles)
    assert.deepEqual(result.payload, profiles, "explicit empty choices stay empty without a known coordinator model")
  }
})
