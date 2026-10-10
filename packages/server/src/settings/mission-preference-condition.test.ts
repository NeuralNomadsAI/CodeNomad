import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyConditionalMissionPreferences, MissionPreferenceConflictError } from "./mission-preference-condition"

function fixture(rawSettings: unknown) {
  let writes = 0
  const service = {
    getRawConfigOwner: () => ({ settings: rawSettings }),
    mergePatchOwner: (_kind: unknown, _owner: unknown, patch: unknown) => {
      writes += 1
      return patch as Record<string, unknown>
    },
  }
  return { service, writes: () => writes }
}

function request(value: unknown, present = true) {
  return {
    patch: { settings: { missionModels: [] } },
    expected: [{ key: "missionModels", present, ...(present ? { value } : {}) }],
  }
}

describe("conditional mission preference checks", () => {
  it("compares nested JSON objects independently of key order, but preserves array order", () => {
    const { service, writes } = fixture({ missionModels: [{ a: 1, nested: { b: 2, c: 3 } }, null] })
    applyConditionalMissionPreferences(service, "ui", request([{ nested: { c: 3, b: 2 }, a: 1 }, null]))
    assert.equal(writes(), 1)
    assert.throws(() => applyConditionalMissionPreferences(service, "ui", request([null, { a: 1, nested: { b: 2, c: 3 } }])), MissionPreferenceConflictError)
    assert.equal(writes(), 1)
  })

  it("never treats inherited keys as present", () => {
    const { service, writes } = fixture(Object.create({ missionModels: [] }))
    assert.throws(() => applyConditionalMissionPreferences(service, "ui", request([])), MissionPreferenceConflictError)
    applyConditionalMissionPreferences(service, "ui", request(undefined, false))
    assert.equal(writes(), 1)
  })

  it("rejects malformed bodies and non-ui owners before reading or writing", () => {
    const service = {
      getRawConfigOwner: () => assert.fail("invalid requests must not read settings"),
      mergePatchOwner: () => assert.fail("invalid requests must not write settings"),
    }
    const good = request([])
    const invalid: unknown[] = [
      null, [], {}, { ...good, extra: true },
      { ...good, patch: { ...good.patch, theme: "dark" } },
      { ...good, patch: { settings: { missionModels: [], unrelated: true } } },
      { ...good, patch: { settings: {} } },
      { ...good, patch: { settings: null } },
      { ...good, expected: [] },
      { ...good, expected: [...good.expected, ...good.expected] },
      { ...good, expected: [...good.expected, ...good.expected, ...good.expected] },
      { ...good, expected: [{ key: "missionProfileDefaults", present: false }] },
      { ...good, expected: [{ key: "missionModels", present: true }] },
      { ...good, expected: [{ key: "missionModels", present: false, value: null }] },
      { ...good, expected: [{ key: "missionModels", present: "true", value: [] }] },
      { ...good, expected: [{ key: "missionModels", present: true, value: [], extra: true }] },
      { ...good, expected: [{ key: "theme", present: false }] },
    ]
    for (const body of invalid) assert.throws(() => applyConditionalMissionPreferences(service, "ui", body))
    assert.throws(() => applyConditionalMissionPreferences(service, "server", good))
  })
})
