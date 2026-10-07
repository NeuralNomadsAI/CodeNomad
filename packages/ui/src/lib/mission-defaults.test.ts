import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { missionDefaultsFor, missionTaskModeFor, normalizeMissionDefaults, type MissionProfileDefault } from "./mission-defaults"

const coordinator = { agent: "general", model: { providerID: "openai", id: "coordinator", variant: "high" } }
const specialist = { agent: "explore", model: { providerID: "openai", id: "specialist", variant: "low" } }
const templateRoles = {
  custom: ["specialist"],
  "pocock-fix-bug": ["review-standards", "review-spec", "validator", "diagnostician", "implementer", "resolver"],
  wayfinder: ["cartographer", "research", "prototype", "grilling", "decision"],
} as const

describe("mission profile default normalization", () => {
  it("accepts all three templates with their exact roles and preserves selector identities", () => {
    const input = Object.entries(templateRoles).map(([template, roles]) => ({
      template, profiles: { coordinator, roles: Object.fromEntries(roles.map(role => [role, specialist])) },
    }))
    const snapshot = structuredClone(input)
    const result = normalizeMissionDefaults(input)
    assert.deepEqual(result, snapshot)
    assert.deepEqual(input, snapshot)
    result[0].profiles.coordinator!.model!.id = "changed"
    result[0].profiles.roles!.specialist.model!.variant = "changed"
    assert.deepEqual(input, snapshot, "normalization must not retain mutable profile references")
  })

  it("keeps deliberately empty profiles without injecting selectors", () => {
    assert.deepEqual(normalizeMissionDefaults([{ template: "custom", profiles: {} }]), [
      { template: "custom", profiles: {} },
    ])
    assert.deepEqual(normalizeMissionDefaults([{ template: "wayfinder", profiles: { roles: {} } }]), [
      { template: "wayfinder", profiles: { roles: {} } },
    ])
  })

  it("rejects malformed containers, duplicate templates and oversized lists as a whole", () => {
    const valid = { template: "custom", profiles: { coordinator } }
    for (const input of [undefined, null, {}, "custom", 1, [null], [false], ["custom"],
      [{ template: "unknown", profiles: {} }], [valid, valid],
      [valid, { template: "wayfinder", profiles: {} }, { template: "pocock-fix-bug", profiles: {} }, valid],
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
    assert.deepEqual(normalizeMissionDefaults([{ template: "pocock-fix-bug", profiles: { roles: { decision: specialist } } }]), [])
  })
})

describe("mission defaults for future creation", () => {
  it("resolves explicit task policy per scenario without inventing a global helper ban", () => {
    const defaults: MissionProfileDefault[] = [{ template: "custom", profiles: {}, taskMode: "independent" }, { template: "wayfinder", profiles: {}, taskMode: "native" }]
    assert.deepEqual(normalizeMissionDefaults(defaults), defaults)
    assert.equal(missionTaskModeFor([], "custom"), "native")
    assert.equal(missionTaskModeFor(defaults, "pocock-fix-bug"), "independent")
    assert.equal(missionTaskModeFor(defaults, "wayfinder"), "native")
    for (const taskMode of [null, "automatic", 0, true]) assert.deepEqual(normalizeMissionDefaults([{ template: "custom", profiles: {}, taskMode }]), [])
  })
  it("returns no profile when there are no applicable selectors", () => {
    assert.equal(missionDefaultsFor([], "custom"), undefined)
    assert.equal(missionDefaultsFor([{ template: "custom", profiles: {} }], "wayfinder"), undefined)
    assert.equal(missionDefaultsFor([{ template: "wayfinder", profiles: { coordinator } }], "pocock-fix-bug"), undefined)
  })

  it("expands the custom specialist fallback to every role of the selected playbook only", () => {
    const defaults: MissionProfileDefault[] = [{ template: "custom", profiles: { coordinator, roles: { specialist } } }]
    for (const template of ["custom", "pocock-fix-bug", "wayfinder"] as const) {
      const resolved = missionDefaultsFor(defaults, template)!
      assert.deepEqual(resolved.coordinator, coordinator)
      assert.deepEqual(resolved.roles, Object.fromEntries(templateRoles[template].map(role => [role, specialist])))
    }
  })

  it("uses template-specific selections over fallback without mixing execution fields", () => {
    const defaults: MissionProfileDefault[] = [
      { template: "custom", profiles: { coordinator, roles: { specialist } } },
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
      { template: "custom", profiles: { coordinator, roles: { specialist } } },
      { template: "pocock-fix-bug", profiles: { roles: { validator: {} } } },
    ]
    const resolved = missionDefaultsFor(defaults, "pocock-fix-bug")!
    assert.deepEqual(resolved.coordinator, coordinator)
    assert.deepEqual(resolved.roles!.validator, {}, "an explicit empty native selection is not missing")
    assert.deepEqual(resolved.roles!.implementer, specialist)
    assert.deepEqual(Object.keys(resolved.roles!), templateRoles["pocock-fix-bug"])
    assert.deepEqual(missionDefaultsFor([{ template: "wayfinder", profiles: { roles: { research: specialist } } }], "wayfinder"), {
      roles: { research: specialist },
    })
  })

  it("returns an independent deep copy on every resolution", () => {
    const defaults: MissionProfileDefault[] = [{ template: "custom", profiles: { coordinator: structuredClone(coordinator), roles: { specialist: structuredClone(specialist) } } }]
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
