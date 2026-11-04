import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { integrationSectionId, integrationSectionIds } from "./integration-sections"

describe("integration Status sections", () => {
  it("exist iff declared or loaded/failed, never for a retained rule alone or an ambiguous source, in catalogue order", () => {
    const ids = integrationSectionIds([
      { id: "blender", plugin: { declared: true } },
      { id: "rule-only", plugin: { declared: false } },
      { id: "gaffer", plugin: { declared: false, runtime: "loaded" } },
      { id: "ambiguous", plugin: { declared: true, runtime: "loaded" }, ambiguous: true },
      { id: "failed", plugin: { declared: false, runtime: "failed" } },
      { id: "absent", plugin: { declared: false } },
    ])
    assert.deepEqual(ids, ["blender", "gaffer", "failed"])
  })

  it("use the catalogue ID, independent of version, scope and spec", () => {
    assert.equal(integrationSectionId("blender"), "integration:blender")
  })
})
