import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  MAX_MISSION_MODELS, normalizeMissionModels, parseMissionModel, removeMissionModelRecord, saveMissionModelRecord,
  type UserMissionModel,
} from "./mission-model-library"

function model(index = 1, overrides: Partial<UserMissionModel> = {}): UserMissionModel {
  return {
    version: 1, id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    name: `Model ${index}`, objective: "Investigate a bounded task", notes: "", template: "custom", ...overrides,
  }
}

const execution = { agent: "general", model: { providerID: "openai", id: "native-model", variant: "high" } }
const templateRoles = {
  custom: ["specialist"],
  "pocock-fix-bug": ["review-standards", "review-spec", "validator", "diagnostician", "implementer", "resolver"],
  wayfinder: ["cartographer", "research", "prototype", "grilling", "decision"],
} as const

describe("strict reusable Mission model records", () => {
  it("preserves a selected task policy in a reusable brief and rejects invented modes", () => {
    assert.equal(parseMissionModel(model(1, { taskMode: "independent" })).taskMode, "independent")
    assert.equal(parseMissionModel(model()).taskMode, undefined)
    assert.throws(() => parseMissionModel({ ...model(), taskMode: "automatic" }))
  })
  it("trims name and objective, preserves notes verbatim and leaves the input unchanged", () => {
    const input = model(1, { name: "  My investigation  ", objective: "\n  Investigate this task \n", notes: "  Keep this spacing\n" })
    const snapshot = structuredClone(input)
    assert.deepEqual(parseMissionModel(input), {
      ...input, name: "My investigation", objective: "Investigate this task",
    })
    assert.deepEqual(input, snapshot)
    assert.equal(Object.prototype.hasOwnProperty.call(parseMissionModel(input), "profiles"), false)
  })

  it("accepts exact text limits and UUID identifiers", () => {
    const input = model(1, { name: "n".repeat(80), objective: "o".repeat(20_000), notes: "x".repeat(20_000) })
    assert.deepEqual(parseMissionModel(input), input)
    const uppercase = model(15, { id: "ABCDEFAB-1234-4567-8ABC-ABCDEFABCDEF" })
    assert.equal(parseMissionModel(uppercase).id, uppercase.id)
  })

  it("rejects malformed records, missing required fields, unsupported versions and invalid identifiers", () => {
    for (const input of [undefined, null, false, 1, "{}", [], [model()]]) assert.throws(() => parseMissionModel(input))
    for (const field of ["version", "id", "name", "objective", "notes", "template"] as const) {
      const input: Record<string, unknown> = { ...model() }
      delete input[field]
      assert.throws(() => parseMissionModel(input), `${field} is required`)
    }
    const invalid: Record<string, unknown>[] = [
      { version: 0 }, { version: 2 }, { version: "1" },
      { id: "not-a-uuid" }, { id: "00000000-0000-4000-8000-000000000001-extra" }, { id: 1 },
      { name: "" }, { name: " \n\t" }, { name: "n".repeat(81) }, { name: null },
      { objective: "" }, { objective: " \n\t" }, { objective: "o".repeat(20_001) }, { objective: 1 },
      { notes: "n".repeat(20_001) }, { notes: null }, { notes: [] },
      { template: "unknown" }, { template: "Pocock" }, { template: null },
    ]
    for (const overrides of invalid) assert.throws(() => parseMissionModel({ ...model(), ...overrides }))
  })

  it("rejects unknown fields rather than preserving saved execution authority or credentials", () => {
    for (const field of ["extra", "missionID", "sessionID", "requestID", "authorization", "apiKey", "executionMode", "status"]) {
      assert.throws(() => parseMissionModel({ ...model(), [field]: "not-a-reusable-brief" }), field)
    }
  })

  it("accepts every exact playbook role with independent parsed native profile selections", () => {
    for (const template of ["custom", "pocock-fix-bug", "wayfinder"] as const) {
      const input = model(1, {
        template, profiles: { coordinator: structuredClone(execution), roles: Object.fromEntries(templateRoles[template].map(role => [role, structuredClone(execution)])) },
      })
      const snapshot = structuredClone(input)
      const parsed = parseMissionModel(input)
      assert.deepEqual(parsed, snapshot)
      parsed.profiles!.coordinator!.model!.id = "changed"
      parsed.profiles!.roles![templateRoles[template][0]].model!.variant = "changed"
      assert.deepEqual(input, snapshot)
    }
    assert.deepEqual(parseMissionModel(model(1, { profiles: {} })).profiles, {})
  })

  it("rejects other-playbook roles, unknown profile fields and invalid nested selectors", () => {
    for (const [template, foreignRole] of [["custom", "research"], ["pocock-fix-bug", "decision"], ["wayfinder", "specialist"]] as const) {
      assert.throws(() => parseMissionModel(model(1, { template, profiles: { roles: { [foreignRole]: execution } } })))
    }
    for (const profiles of [
      null, [], { sessionID: "foreign-session" }, { roles: { invented: execution } },
      { coordinator: { agent: "" } }, { coordinator: { agent: "a".repeat(241) } },
      { coordinator: { model: { providerID: "openai" } } },
      { coordinator: { model: { providerID: "openai", id: "native-model", variant: "" } } },
      { coordinator: { model: { providerID: "openai", id: "native-model", apiKey: "secret" } } },
      { coordinator: { agent: "general", sessionID: "foreign-session" } },
    ]) assert.throws(() => parseMissionModel({ ...model(), profiles }))
  })
})

describe("Mission model document normalization", () => {
  it("normalizes an ordered array without mutating its source", () => {
    const input = [model(1, { name: "  First  " }), model(2, { template: "wayfinder" })]
    const snapshot = structuredClone(input)
    assert.deepEqual(normalizeMissionModels(input), [{ ...input[0], name: "First" }, input[1]])
    assert.deepEqual(input, snapshot)
    assert.deepEqual(normalizeMissionModels([]), [])
  })

  it("rejects invalid, oversized and duplicate-ID arrays entirely instead of keeping partial records", () => {
    assert.equal(MAX_MISSION_MODELS, 20)
    const full = Array.from({ length: MAX_MISSION_MODELS }, (_, index) => model(index + 1))
    assert.deepEqual(normalizeMissionModels(full), full)
    for (const input of [undefined, null, {}, "[]", 1, [model(), null], [model(), { ...model(2), extra: true }],
      [model(), model(1, { name: "Same ID, different label" })], [...full, model(21)]]) {
      assert.deepEqual(normalizeMissionModels(input), [])
    }
  })
})

describe("immutable Mission model library edits", () => {
  it("adds a new ID and replaces a matching ID without duplicating it or mutating inputs", () => {
    const current = [model(), model(2)]
    const snapshot = structuredClone(current)
    const addedInput = model(3, { name: "  Third  " })
    const addedSnapshot = structuredClone(addedInput)
    const added = saveMissionModelRecord(current, addedInput)
    assert.equal(added.length, 3)
    assert.deepEqual(added.find(item => item.id === addedInput.id), { ...addedInput, name: "Third" })
    const replacement = model(1, { name: "Replacement", template: "wayfinder", profiles: { roles: { research: execution } } })
    const replaced = saveMissionModelRecord(current, replacement)
    assert.equal(replaced.length, 2)
    assert.deepEqual(replaced.find(item => item.id === replacement.id), replacement)
    assert.deepEqual(replaced.find(item => item.id === current[1].id), current[1])
    assert.equal(replaced.filter(item => item.id === replacement.id).length, 1)
    assert.deepEqual(current, snapshot)
    assert.deepEqual(addedInput, addedSnapshot)
  })

  it("allows same-ID replacement at capacity but rejects only a new addition at capacity", () => {
    const current = Array.from({ length: MAX_MISSION_MODELS }, (_, index) => model(index + 1))
    const snapshot = structuredClone(current)
    const replacement = model(10, { name: "Updated at capacity" })
    const replaced = saveMissionModelRecord(current, replacement)
    assert.equal(replaced.length, MAX_MISSION_MODELS)
    assert.deepEqual(replaced.find(item => item.id === replacement.id), replacement)
    assert.throws(() => saveMissionModelRecord(current, model(21)))
    assert.deepEqual(current, snapshot)
    assert.equal(saveMissionModelRecord(current.slice(0, -1), model(21)).length, MAX_MISSION_MODELS)
  })

  it("revalidates a record on save rather than trusting a typed caller", () => {
    const current = [model()]
    const snapshot = structuredClone(current)
    assert.throws(() => saveMissionModelRecord(current, model(2, { name: "" })))
    assert.throws(() => saveMissionModelRecord(current, { ...model(2), sessionID: "foreign-session" } as UserMissionModel))
    assert.deepEqual(current, snapshot)
  })

  it("removes only the exact ID, retains survivor order and frees one capacity slot", () => {
    const current = Array.from({ length: MAX_MISSION_MODELS }, (_, index) => model(index + 1))
    const snapshot = structuredClone(current)
    const removed = removeMissionModelRecord(current, current[9].id)
    assert.deepEqual(removed, current.filter((_, index) => index !== 9))
    assert.equal(saveMissionModelRecord(removed, model(21)).length, MAX_MISSION_MODELS)
    assert.deepEqual(removeMissionModelRecord(current, model(21).id), current)
    assert.deepEqual(removeMissionModelRecord([], model().id), [])
    assert.deepEqual(current, snapshot)
  })
})
