import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PluginControlsSnapshot } from "../../../server/src/api-types"
import { integrationDisplayPlugin, integrationPlugin } from "./integration-rows"

describe("integration plugin", () => {
  const path = "/config/opencode.jsonc"
  const sourceAssociation = { scope: "global" as const, entryIndex: 2, expectedRevision: "a".repeat(64) }
  const ruleAssociation = { scope: "project" as const, entryIndex: 0, expectedRevision: "b".repeat(64) }
  const associations = { configuredSources: [sourceAssociation], configuredRules: [ruleAssociation] }
  const runtime = { key: "b", id: "neuralnomads.blender", features: {}, state: { status: "active" as const },
    source: { type: "package" as const, target: "@neuralnomads/opencode-blender", version: "0.1.0" } }
  const snapshot = (): PluginControlsSnapshot => ({
    location: { directory: "/repo" }, runtime: [runtime],
    configured: {
      sources: [{ target: runtime.source.target, scope: "global", path, entryIndex: 2, hasOptions: false, pluginId: runtime.id }],
      rules: [{ selector: "neuralnomads.blender", enabled: false, scope: "project", path: "/repo/opencode.jsonc", entryIndex: 0, order: 1 }],
    },
    controls: [{ id: runtime.id, runtime, builtin: false, effective: "disabled", global: "default", project: "disabled" }],
    targets: [{ scope: "global", path, exists: true, expectedRevision: sourceAssociation.expectedRevision },
      { scope: "project", path: "/repo/opencode.jsonc", exists: true, expectedRevision: ruleAssociation.expectedRevision }],
  })

  it("finds the declarations, control and package of an integration through its correlations", () => {
    const value = snapshot()
    const plugin = integrationPlugin(value, { configuredSources: [sourceAssociation], configuredRules: [] })
    assert.deepEqual(plugin.sources, value.configured.sources)
    assert.equal(plugin.control, value.controls[0])
    assert.equal(plugin.source, runtime.source)
  })

  it("finds a disabled, unloaded plugin's control through its rule only", () => {
    const value = snapshot()
    value.runtime = []; value.controls[0] = { ...value.controls[0]!, runtime: undefined }
    value.configured.sources[0] = { ...value.configured.sources[0]!, pluginId: undefined }
    const plugin = integrationPlugin(value, associations)
    assert.equal(plugin.control?.id, "neuralnomads.blender")
    assert.equal(plugin.source, undefined)
    assert.equal(integrationPlugin(value, { configuredSources: [sourceAssociation], configuredRules: [] }).control, undefined)
  })

  it("shows no switch when two plugin IDs are correlated, and nothing without a snapshot", () => {
    const value = snapshot()
    value.configured.rules[0] = { ...value.configured.rules[0]!, selector: "another.plugin" }
    assert.equal(integrationPlugin(value, associations).control, undefined)
    assert.deepEqual(integrationPlugin(undefined, { configuredSources: [], configuredRules: [] }), { sources: [] })
  })

  it("rejects shifted or replaced source and rule indices across independent document reads", () => {
    const before = snapshot()
    const after = snapshot()
    after.targets = after.targets.map(target => ({ ...target, expectedRevision: "c".repeat(64) }))
    after.configured.sources[0] = { ...after.configured.sources[0]!, target: "other-package", pluginId: "other.plugin" }
    after.configured.rules[0] = { ...after.configured.rules[0]!, selector: "other.plugin" }
    after.runtime = [{ ...runtime, id: "other.plugin", source: { ...runtime.source, target: "other-package" } }]
    after.controls = [{ ...after.controls[0]!, id: "other.plugin", runtime: after.runtime[0] }]
    const newerAssociations = {
      configuredSources: [{ ...sourceAssociation, expectedRevision: after.targets[0]!.expectedRevision }],
      configuredRules: [{ ...ruleAssociation, expectedRevision: after.targets[1]!.expectedRevision }],
    }
    assert.deepEqual(integrationPlugin(after, associations), { sources: [] }, "old integration response, new Plugins snapshot")
    assert.deepEqual(integrationPlugin(before, newerAssociations), { sources: [] }, "new integration response, old Plugins snapshot")
    after.configured.sources[0]!.entryIndex++
    after.configured.rules[0]!.entryIndex++
    assert.deepEqual(integrationPlugin(after, newerAssociations), { sources: [] }, "a changed index never matches")
  })

  it("fails closed without either document revision, including legacy associations", () => {
    for (const missing of [undefined, ""] as const) {
      const legacy = {
        configuredSources: [{ ...sourceAssociation, expectedRevision: missing }],
        configuredRules: [{ ...ruleAssociation, expectedRevision: missing }],
      }
      assert.deepEqual(integrationPlugin(snapshot(), legacy), { sources: [] })
      const value = snapshot()
      value.targets.forEach(target => { target.expectedRevision = missing })
      assert.deepEqual(integrationPlugin(value, associations), { sources: [] })
    }
  })

  it("rejects inherited and inline entries even with matching scope, index and document revision", () => {
    for (const inheritedPath of ["/ancestor/opencode.jsonc", undefined]) {
      const value = snapshot()
      value.configured.sources[0]!.path = inheritedPath
      value.configured.rules[0]!.path = inheritedPath
      assert.deepEqual(integrationPlugin(value, associations), { sources: [] })
    }
  })

  it("does not borrow a revision from another scope or expose runtime-only controls", () => {
    const value = snapshot()
    value.targets[0]!.expectedRevision = ruleAssociation.expectedRevision
    value.targets[1]!.expectedRevision = sourceAssociation.expectedRevision
    assert.deepEqual(integrationPlugin(value, associations), { sources: [] })
    assert.deepEqual(integrationPlugin(snapshot(), { configuredSources: [], configuredRules: [] }), { sources: [] })
  })

  it("correlates a unique runtime for display without granting writable source authority", () => {
    const entry = { configuredSources: [], configuredRules: [], plugin: { declared: true, runtimeId: "acme.render" } }
    for (const origin of ["other", "virtual", "runtime-only"] as const) {
      const value = snapshot()
      const loaded = { ...runtime, id: "acme.render" }
      value.runtime = [loaded]
      value.controls = [{ ...value.controls[0]!, id: loaded.id, runtime: loaded }]
      value.configured.rules = []
      value.configured.sources = origin === "runtime-only" ? [] : [{ ...value.configured.sources[0]!,
        pluginId: loaded.id, scope: origin, path: origin === "other" ? "/ancestor/opencode.jsonc" : undefined }]
      value.targets = []
      assert.deepEqual(integrationPlugin(value, entry), { sources: [] }, origin)
      assert.deepEqual(integrationDisplayPlugin(value, entry), { sources: [], control: value.controls[0], source: loaded.source }, origin)
      assert.deepEqual(integrationDisplayPlugin(value, { ...entry, ambiguous: true }), { sources: [] })
      assert.deepEqual(integrationDisplayPlugin(value, { ...entry, plugin: { declared: true, runtimeId: "other.plugin" } }), { sources: [] })
      value.runtime.push(loaded)
      assert.deepEqual(integrationDisplayPlugin(value, entry), { sources: [] }, "duplicate runtime IDs are ambiguous")
    }
  })
})
