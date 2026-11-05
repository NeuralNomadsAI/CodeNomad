import assert from "node:assert/strict"
import { test } from "node:test"
import * as server from "../../../server/src/missions/profile-defaults"
import * as ui from "../../src/lib/mission-defaults"
import { missionProfileRoles, missionRoleProfile } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"

test("the UI default API reexports the pure server implementation", () => {
  assert.deepEqual(Object.keys(ui).sort(), Object.keys(server).sort())
  for (const key of Object.keys(server) as (keyof typeof server)[]) assert.equal(ui[key], server[key])
})

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
  ]
  for (const preferences of cases) for (const template of templates) {
    const normalized = ui.normalizeMissionDefaults(preferences)
    const draft = ui.missionDefaultsFor(normalized, template)
    const result = server.resolveMissionCreationDefaults({ template, preferences })
    const roles = Object.fromEntries(missionProfileRoles[template].map(role => [role,
      draft?.roles?.[role] ?? (role === "comparator" ? missionRoleProfile(template, draft, role) : undefined) ?? {}]))
    assert.deepEqual(result.profiles, { coordinator: draft?.coordinator ?? {}, roles }, template)
    assert.equal(result.taskMode, ui.missionTaskModeFor(normalized, template), template)
    assert.deepEqual(ui.resolveMissionCreationDefaults({ template, preferences }), result)
  }
})
