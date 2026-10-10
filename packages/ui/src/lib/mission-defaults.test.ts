import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { missionDefaultsFor, missionTaskModeFor, normalizeMissionDefaults, type MissionProfileDefault } from "./mission-defaults"
import { LEGACY_DEBUG_TEMPLATE_ID } from "../../../server/src/missions/template-id"

const coordinator = { agent: "general", model: { providerID: "openai", id: "coordinator", variant: "high" } }
const specialist = { agent: "explore", model: { providerID: "openai", id: "specialist", variant: "low" } }
const templateRoles = {
  custom: ["specialist"],
  debug: ["review-standards", "review-spec", "validator", "diagnostician", "implementer", "resolver"],
  wayfinder: ["cartographer", "research", "prototype", "grilling", "decision"],
} as const

describe("mission profile default normalization", () => {
  it("accepts all three templates with their exact roles and preserves selector identities", () => {
    const input = Object.entries(templateRoles).map(([template, roles]) => ({
      template, profiles: { coordinator, roles: Object.fromEntries(roles.map(role => [role, specialist])) },
    }))
    input.unshift({ template: "all", profiles: { coordinator, roles: { specialist } } })
    const snapshot = structuredClone(input)
    const result = normalizeMissionDefaults(input)
    assert.deepEqual(result, snapshot)
    assert.deepEqual(input, snapshot)
    result[0].profiles.coordinator!.model!.id = "changed"
    result[0].profiles.roles!.specialist.model!.variant = "changed"
    assert.deepEqual(input, snapshot, "normalization must not retain mutable profile references")
  })

  it("reads a saved legacy Debugging exception as debug", () => {
    assert.deepEqual(normalizeMissionDefaults([{ template: LEGACY_DEBUG_TEMPLATE_ID, profiles: { coordinator } }]),
      [{ template: "debug", profiles: { coordinator } }])
  })

  it("keeps deliberately empty profiles without injecting selectors", () => {
    assert.deepEqual(normalizeMissionDefaults([{ template: "all", profiles: {} }]), [
      { template: "all", profiles: {} },
    ])
    assert.deepEqual(normalizeMissionDefaults([{ template: "wayfinder", profiles: { roles: {} } }]), [
      { template: "wayfinder", profiles: { roles: {} } },
    ])
  })

  it("rejects malformed containers, duplicate templates and oversized lists as a whole", () => {
    const valid = { template: "custom", profiles: { coordinator } }
    for (const input of [undefined, null, {}, "custom", 1, [null], [false], ["custom"],
      [{ template: "unknown", profiles: {} }], [valid, valid],
      [valid, { template: "wayfinder", profiles: {} }, { template: "debug", profiles: {} }, valid],
      [{ template: "all", profiles: {} }, valid, { template: "wayfinder", profiles: {} }, { template: "debug", profiles: {} }, valid],
      [{ template: "all", profiles: { roles: { research: specialist } } }],
      [valid, { template: "wayfinder" }]]) {
      assert.deepEqual(normalizeMissionDefaults(input), [], JSON.stringify(input))
    }
  })

  it("rejects cross-template roles and malformed or authority-bearing profile fields", () => {
    const invalid = [
      null, [], { coordinator: null }, { coordinator: "general" },
      { sessionID: "session-owned-elsewhere" }, { coordinator: { agent: "" } },
      { coordinator: { agent: " ".repeat(2) } }, { coordinator: { agent: "a".repeat(241) } },
      { coordinator: { sessionID: "session-owned-elsewhere" } },
      { coordinator: { model: { providerID: "openai" } } },
      { coordinator: { model: { providerID: "openai", id: "model", apiKey: "not-a-selector" } } },
      { coordinator: { model: { providerID: "openai", id: "model", variant: "" } } },
      { roles: { unknown: specialist } }, { roles: { research: specialist } }, { roles: { specialist: null } },
    ]
    for (const profiles of invalid) {
      assert.deepEqual(normalizeMissionDefaults([
        { template: "wayfinder", profiles: { coordinator } }, { template: "custom", profiles },
      ]), [], JSON.stringify(profiles))
    }
    assert.deepEqual(normalizeMissionDefaults([{ template: "wayfinder", profiles: { roles: { specialist } } }]), [])
    assert.deepEqual(normalizeMissionDefaults([{ template: "debug", profiles: { roles: { decision: specialist } } }]), [])
  })
})

describe("mission defaults for future creation", () => {
  it("resolves explicit task policy per scenario without inventing a global helper ban", () => {
    const defaults: MissionProfileDefault[] = [{ template: "all", profiles: {}, taskMode: "independent" }, { template: "wayfinder", profiles: {}, taskMode: "native" }]
    assert.deepEqual(normalizeMissionDefaults(defaults), defaults)
    assert.equal(missionTaskModeFor([], "custom"), "native")
    assert.equal(missionTaskModeFor(defaults, "debug"), "independent")
    assert.equal(missionTaskModeFor(defaults, "wayfinder"), "native")
    for (const taskMode of [null, "automatic", 0, true]) assert.deepEqual(normalizeMissionDefaults([{ template: "custom", profiles: {}, taskMode }]), [])
  })
  it("returns no profile when there are no applicable selectors", () => {
    assert.equal(missionDefaultsFor([], "custom"), undefined)
    assert.equal(missionDefaultsFor([{ template: "custom", profiles: {} }], "wayfinder"), undefined)
    assert.equal(missionDefaultsFor([{ template: "wayfinder", profiles: { coordinator } }], "debug"), undefined)
  })

  it("expands the custom specialist fallback to every role of the selected playbook only", () => {
    const defaults: MissionProfileDefault[] = [{ template: "all", profiles: { coordinator, roles: { specialist } } }]
    for (const template of ["custom", "debug", "wayfinder"] as const) {
      const resolved = missionDefaultsFor(defaults, template)!
      assert.deepEqual(resolved.coordinator, coordinator)
      assert.deepEqual(resolved.roles, Object.fromEntries(templateRoles[template].map(role => [role, specialist])))
    }
  })

  it("uses template-specific selections over fallback without mixing execution fields", () => {
    const defaults: MissionProfileDefault[] = [
      { template: "all", profiles: { coordinator, roles: { specialist } } },
      { template: "wayfinder", profiles: { coordinator: { agent: "web_developer" }, roles: { research: { agent: "general" } } } },
    ]
    assert.deepEqual(missionDefaultsFor(defaults, "wayfinder"), {
      coordinator: { agent: "web_developer" },
      roles: { cartographer: specialist, research: { agent: "general" }, prototype: specialist, grilling: specialist, decision: specialist },
    })
    assert.deepEqual(missionDefaultsFor(defaults, "custom"), defaults[0].profiles)
  })

  it("inherits coordinator and fills only missing roles in partial specific defaults", () => {
    const defaults: MissionProfileDefault[] = [
      { template: "all", profiles: { coordinator, roles: { specialist } } },
      { template: "debug", profiles: { roles: { validator: {} } } },
    ]
    const resolved = missionDefaultsFor(defaults, "debug")!
    assert.deepEqual(resolved.coordinator, coordinator)
    assert.deepEqual(resolved.roles!.validator, {}, "an explicit empty native selection is not missing")
    assert.deepEqual(resolved.roles!.implementer, specialist)
    assert.deepEqual(Object.keys(resolved.roles!), templateRoles["debug"])
    assert.deepEqual(missionDefaultsFor([{ template: "wayfinder", profiles: { roles: { research: specialist } } }], "wayfinder"), {
      roles: { research: specialist },
    })
  })

  it("reads a legacy Flexible entry without a global entry as the global default", () => {
    const legacy = [{ template: "custom", profiles: { coordinator, roles: { specialist } }, taskMode: "independent" }]
    const migrated = normalizeMissionDefaults(legacy)
    assert.deepEqual(migrated, [{ ...legacy[0], template: "all" }])
    assert.equal(legacy[0].template, "custom", "reading never mutates the saved document")
    for (const template of ["custom", "debug", "wayfinder"] as const) {
      assert.deepEqual(missionDefaultsFor(migrated, template)!.coordinator, coordinator)
      assert.equal(missionTaskModeFor(migrated, template), "independent")
    }
    const explicit = normalizeMissionDefaults([{ template: "all", profiles: { coordinator } }, { template: "custom", profiles: {} }])
    assert.deepEqual(explicit.map(item => item.template), ["all", "custom"], "an explicit global entry keeps Flexible as an exception")
  })

  it("lets Flexible carry its own exception over the global default", () => {
    const flexible = { agent: "flexible" }
    const defaults: MissionProfileDefault[] = [
      { template: "all", profiles: { coordinator, roles: { specialist } }, taskMode: "native" },
      { template: "custom", profiles: { roles: { specialist: flexible } }, taskMode: "independent" },
    ]
    assert.deepEqual(missionDefaultsFor(defaults, "custom"), { coordinator, roles: { specialist: flexible } })
    assert.deepEqual(missionDefaultsFor(defaults, "custom", false), { coordinator, roles: { specialist } }, "global-only resolution shows the inherited value")
    assert.deepEqual(missionDefaultsFor(defaults, "wayfinder")!.roles!.research, specialist)
    assert.equal(missionTaskModeFor(defaults, "custom"), "independent")
    assert.equal(missionTaskModeFor(defaults, "wayfinder"), "native")
    assert.equal(missionTaskModeFor([{ template: "custom", profiles: {}, taskMode: "independent" }, { template: "all", profiles: {} }], "wayfinder"), "native")
  })

  it("returns an independent deep copy on every resolution", () => {
    const defaults: MissionProfileDefault[] = [{ template: "all", profiles: { coordinator: structuredClone(coordinator), roles: { specialist: structuredClone(specialist) } } }]
    const snapshot = structuredClone(defaults)
    const first = missionDefaultsFor(defaults, "wayfinder")!
    const second = missionDefaultsFor(defaults, "wayfinder")!
    first.coordinator!.model!.variant = "changed"
    first.roles!.research.model!.id = "changed"
    assert.deepEqual(defaults, snapshot)
    assert.deepEqual(second.coordinator, coordinator)
    assert.deepEqual(second.roles!.research, specialist)
  })
})
