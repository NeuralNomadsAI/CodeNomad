import assert from "node:assert/strict"
import { test } from "node:test"
import * as server from "../../../server/src/missions/profile-defaults"
import * as ui from "../../src/lib/mission-defaults"
import { freezeCompareProfiles, missionProfileRoles } from "../../../server/src/missions/playbook-profiles"
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
    // The mission editor's draft-loading effect resolves defaults; prepareMissionCreation freezes its Compare payload.
    const normalized = ui.normalizeMissionDefaults(preferences)
    const payload = freezeCompareProfiles(template, ui.missionDefaultsFor(normalized, template))
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
      const draft = source === "preference" ? ui.missionDefaultsFor(ui.normalizeMissionDefaults(preferences), "compare") : profiles
      const payload = freezeCompareProfiles("compare", draft)
      const resolved = server.resolveMissionCreationDefaults({ template: "compare", preferences,
        ...(source === "explicit" ? { profiles } : {}) })
      assert.deepEqual(resolved.profiles, payload)
      assert.equal(resolved.origins.roles.comparator, source)
      assert.deepEqual(resolved.profiles.roles.comparator.model, comparator.model ?? coordinator.model)
    }
  }
})
