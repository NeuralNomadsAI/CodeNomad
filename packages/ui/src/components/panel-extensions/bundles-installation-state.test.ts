import assert from "node:assert/strict"
import { test } from "node:test"
import { bundlesStateHostResultSchema } from "../../../../server/src/panel-extensions/bundles-contract"
import { PluginSourcesStore } from "../../stores/plugin-sources"
import { projectBundlesInstallationState } from "./bundles-installation-state"

test("public state needs exact observed declaration plus submission; receipts and old DTOs never invent installation", () => {
  let now = 0
  const store = new PluginSourcesStore({ addPluginSource: async () => assert.fail(), removePluginSource: async () => assert.fail() }, () => {}, () => now, () => {})
  const location = { directory: "/PRIVATE_DIRECTORY" }, target = "a".repeat(64)
  const attempt = store.begin("instance", location, "global", target, { integration: "fixture" })
  const raw = { catalog: { state: "fresh" }, tracking: { ...location, declaredTargets: [target], sources: [{ integration: "fixture", scope: "global", target }] },
    integrations: [{ id: "fixture", family: "api", configured: true, scopes: ["global"], state: "unsupported",
      activation: { global: "default", project: "default", effective: "default" }, plugin: { declared: true, runtime: "unloaded" } }] }
  const project = (response: unknown = raw) => projectBundlesInstallationState("instance", bundlesStateHostResultSchema.parse(response), store)
  const progress = () => project().integrations[0]!.plugin?.progress
  assert.equal(progress(), "unconfirmed")
  store.submitted(attempt)
  assert.equal(progress(), "pending")
  assert(!JSON.stringify(project()).includes("PRIVATE_")); assert(!JSON.stringify(project()).includes(target))
  for (const property of ["directory", "scope", "target"] as const) {
    const other = structuredClone(raw)
    if (property === "directory") other.tracking.directory = "/other"
    if (property === "scope") other.tracking.sources[0]!.scope = "project"
    if (property === "target") other.tracking.sources[0]!.target = "b".repeat(64)
    assert.equal(project(other).integrations[0]!.plugin?.progress, "unconfirmed", property)
  }
  const removed = structuredClone(raw); removed.tracking.declaredTargets = []
  project(removed); store.submitted(attempt)
  assert.equal(progress(), "unconfirmed", "complete declaration absence consumes the hint")
  const next = store.begin("instance", location, "global", target, { integration: "fixture" })
  store.submitted(next)
  assert.equal(progress(), "pending")
  now = 120_000; assert.equal(progress(), "pending")
  now++; store.submitted(next); assert.equal(progress(), "unconfirmed")
  raw.integrations[0]!.plugin.runtime = "active"
  assert.deepEqual(project().integrations[0]!.plugin, { declared: true, runtime: "active" })
  raw.integrations[0]!.plugin.runtime = "unloaded"
  assert.equal(progress(), "unconfirmed")
  const old = structuredClone(raw) as any
  delete old.tracking; delete old.integrations[0].plugin
  assert.equal(project(old).integrations[0]!.plugin, undefined)
  for (const runtime of ["unknown", "failed", "active"]) {
    raw.integrations[0]!.plugin.runtime = runtime
    assert.equal(progress(), undefined)
  }
  raw.integrations[0]!.plugin.runtime = "unloaded"
  raw.integrations[0]!.activation.effective = "disabled"
  assert.equal(progress(), undefined)
  raw.integrations[0]!.activation.effective = "default"; raw.integrations[0]!.plugin.declared = false
  assert.equal(progress(), undefined)
})

test("a bridge read of removal consumes a native hint even while Plugins is hidden", () => {
  const store = new PluginSourcesStore({ addPluginSource: async () => assert.fail(), removePluginSource: async () => assert.fail() }, () => {}, () => 0, () => {})
  const location = { directory: "/repo" }, target = "a".repeat(64)
  const attempt = store.begin("instance", location, "global", "package@1")
  store.submitted(attempt)
  const snapshot: any = { location, runtime: [], configured: { sources: [
    { target: "package@1", scope: "global", entryIndex: 0, hasOptions: false, trackingTarget: target },
  ] } }
  store.observeSnapshot("instance", snapshot)
  const response: any = { catalog: { state: "fresh" }, tracking: { ...location, declaredTargets: [], sources: [] }, integrations: [
    { id: "fixture", family: "api", configured: false, scopes: [], state: "absent",
      activation: { global: "default", project: "default", effective: "default" }, plugin: { declared: false, runtime: "unloaded" } },
  ] }
  projectBundlesInstallationState("instance", response, store)
  response.tracking.sources.push({ integration: "fixture", scope: "global", target })
  response.tracking.declaredTargets.push(target)
  response.integrations[0].plugin.declared = true
  assert.equal(projectBundlesInstallationState("instance", response, store).integrations[0]!.plugin?.progress, "unconfirmed")
})

test("a catalogue-only read never consumes unrelated native declarations", () => {
  const store = new PluginSourcesStore({ addPluginSource: async () => assert.fail(), removePluginSource: async () => assert.fail() }, () => {}, () => 0, () => {})
  const location = { directory: "/repo" }, token = "a".repeat(64)
  const attempt = store.begin("instance", location, "global", "generic-package")
  store.submitted(attempt)
  store.observeSnapshot("instance", { location, runtime: [], configured: { sources: [
    { target: "generic-package", scope: "global", entryIndex: 0, hasOptions: false, trackingTarget: token },
  ] } } as any)
  for (const tracking of [{ ...location, declaredTargets: [token], sources: [] }, { ...location, sources: [] }]) {
    projectBundlesInstallationState("instance", { catalog: { state: "unavailable" }, integrations: [], tracking } as any, store)
    assert.equal(store.state("instance", location, "generic-package"), "pending")
  }
})
