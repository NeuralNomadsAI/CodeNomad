import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PluginControlsSnapshot } from "../../../server/src/api-types"
import { integrationForSources, integrationPlugin } from "./integration-rows"

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

describe("integration plugin", () => {
  const path = "/config/opencode.jsonc"
  const runtime = { key: "b", id: "neuralnomads.blender", features: {}, state: { status: "active" as const },
    source: { type: "package" as const, target: "@neuralnomads/opencode-blender", version: "0.1.0" } }
  const snapshot = (): PluginControlsSnapshot => ({
    location: { directory: "/repo" }, runtime: [runtime],
    configured: {
      sources: [{ target: runtime.source.target, scope: "global", path, entryIndex: 2, hasOptions: false, pluginId: runtime.id }],
      rules: [{ selector: "neuralnomads.blender", enabled: false, scope: "project", path: "/repo/opencode.jsonc", entryIndex: 0, order: 1 }],
    },
    controls: [{ id: runtime.id, runtime, builtin: false, effective: "disabled", global: "default", project: "disabled" }],
    targets: [{ scope: "global", path, exists: true }],
  })

  it("finds the declarations, control and package of an integration through its correlations", () => {
    const value = snapshot()
    const plugin = integrationPlugin(value, { configuredSources: [{ scope: "global", entryIndex: 2 }], configuredRules: [] })
    assert.deepEqual(plugin.sources, value.configured.sources)
    assert.equal(plugin.control, value.controls[0])
    assert.equal(plugin.source, runtime.source)
  })

  it("finds a disabled, unloaded plugin's control through its rule only", () => {
    const value = snapshot()
    value.runtime = []; value.controls[0] = { ...value.controls[0]!, runtime: undefined }
    value.configured.sources[0] = { ...value.configured.sources[0]!, pluginId: undefined }
    const plugin = integrationPlugin(value, { configuredSources: [{ scope: "global", entryIndex: 2 }], configuredRules: [{ scope: "project", entryIndex: 0 }] })
    assert.equal(plugin.control?.id, "neuralnomads.blender")
    assert.equal(plugin.source, undefined)
    assert.equal(integrationPlugin(value, { configuredSources: [{ scope: "global", entryIndex: 2 }], configuredRules: [] }).control, undefined)
  })

  it("shows no switch when two plugin IDs are correlated, and nothing without a snapshot", () => {
    const value = snapshot()
    value.configured.rules[0] = { ...value.configured.rules[0]!, selector: "another.plugin" }
    assert.equal(integrationPlugin(value, { configuredSources: [{ scope: "global", entryIndex: 2 }], configuredRules: [{ scope: "project", entryIndex: 0 }] }).control, undefined)
    assert.deepEqual(integrationPlugin(undefined, { configuredSources: [], configuredRules: [] }), { sources: [] })
  })
})
