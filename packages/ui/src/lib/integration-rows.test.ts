import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { integrationForSources } from "./integration-rows"

const entry = (id: string, configuredSources: Array<{ scope: "global" | "project"; entryIndex: number }>, ambiguous?: true) =>
  ({ id, configuredSources, ...(ambiguous ? { ambiguous } : {}) })
const row = [{ scope: "global" as const, entryIndex: 0 }]

describe("integration rows", () => {
  it("attributes a row to its one unambiguous claimant only", () => {
    const fixture = entry("fixture", [{ scope: "global", entryIndex: 0 }])
    assert.equal(integrationForSources([entry("other", [{ scope: "project", entryIndex: 0 }]), fixture], row), fixture)
    assert.equal(integrationForSources([fixture], [{ scope: "global", entryIndex: 1 }]), undefined)
    assert.equal(integrationForSources([fixture], [{ scope: "project", entryIndex: 0 }]), undefined)
  })

  it("attributes a row claimed twice, or by an ambiguous integration, to none instead of the first match", () => {
    const claims = [{ scope: "global" as const, entryIndex: 0 }]
    assert.equal(integrationForSources([entry("first", claims), entry("second", claims)], row), undefined)
    assert.equal(integrationForSources([entry("first", claims, true)], row), undefined)
  })
})
