import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PluginConfiguredSource, PluginRuntimeInventoryEntry } from "../../api-types"
import { catalogEntry, catalogOf, pluginSnapshot } from "./catalog-fixture"
import { integrationsForSpec, recognizeIntegrations } from "./recognition"
import { looksLikePath, readIntegrationStatuses, type IntegrationRpcCall } from "./status"

const GIT = "github:NeuralNomadsAI/opencode-integrations#"
const catalog = catalogOf(
  catalogEntry("fixture", { sources: { git: [GIT] } }),
  catalogEntry("drift"),
  catalogEntry("mail", { family: "api" }),
)
const source = (target: string, extra: Partial<PluginConfiguredSource> = {}): PluginConfiguredSource =>
  ({ target, scope: "global", entryIndex: 0, hasOptions: false, ...extra })
const runtime = (id: string, extra: Partial<PluginRuntimeInventoryEntry> = {}): PluginRuntimeInventoryEntry => ({
  key: id, id, source: { type: "package", target: `@neuralnomads/opencode-${id.split(".")[1]}@0.1.0`, version: "0.1.0" },
  features: { server: true, rpc: true }, state: { status: "active" }, ...extra,
})
const status = (id: string, family = "native", extra: Record<string, unknown> = {}) =>
  ({ contract: 1, integration: { id, version: "0.1.0", family, spec: 0 }, host: { state: "absent", action: "install" }, ...extra })

describe("integration recognition", () => {
  it("recognises a registry spec, an npm alias, a Git build by plugin ID or prefix, and a disabled plugin", () => {
    const cases = [
      { name: "registry name", snapshot: pluginSnapshot({ sources: [source("@neuralnomads/opencode-fixture@^0.1")] }), ways: ["package"] },
      { name: "npm alias", snapshot: pluginSnapshot({ sources: [source("fx@npm:@neuralnomads/opencode-fixture@0.1.0")] }), ways: ["package"] },
      { name: "Git build loaded as the plugin", snapshot: pluginSnapshot({
        sources: [source("git+https://example.test/fork.git#main", { pluginId: "neuralnomads.fixture" })], runtime: [runtime("neuralnomads.fixture")] }), ways: ["plugin"] },
      { name: "Git prefix", snapshot: pluginSnapshot({ sources: [source(`${GIT}path:/integrations/fixture`)] }), ways: ["git"] },
      { name: "disabled by its exact rule", snapshot: pluginSnapshot({
        sources: [source("file:///builds/fixture")],
        // The snapshot normalizes `-neuralnomads.fixture` into the selector and `enabled: false`.
        rules: [{ selector: "neuralnomads.fixture", enabled: false, scope: "project", entryIndex: 1, order: 1 }] }), ways: ["plugin"] },
    ]
    for (const { name, snapshot, ways } of cases) {
      const [fixture] = recognizeIntegrations(catalog, snapshot)
      assert.deepEqual(fixture!.ways, ways, name)
      assert.equal(fixture!.ambiguous, false, name)
    }
    const disabled = recognizeIntegrations(catalog, cases[4]!.snapshot)[0]!
    assert.deepEqual(disabled.scopes, ["project"])
    assert.equal(disabled.runtime, undefined)
  })

  it("leaves unrelated sources and other rules unrecognised", () => {
    const recognitions = recognizeIntegrations(catalog, pluginSnapshot({
      sources: [source("@neuralnomads/opencode-fixture-extra"), source("github:someone/opencode-integrations#main")],
      rules: [{ selector: "neuralnomads.fixture", enabled: true, scope: "global", entryIndex: 2, order: 2 }],
    }))
    assert.deepEqual(recognitions.map(recognition => recognition.ways), [[], [], []])
  })

  it("marks a source that designates two integrations, or loads another plugin ID, as ambiguous", () => {
    const two = recognizeIntegrations(catalog, pluginSnapshot({ sources: [source("@neuralnomads/opencode-drift", { pluginId: "neuralnomads.fixture" })] }))
    assert.deepEqual(two.slice(0, 2).map(recognition => recognition.ambiguous), [true, true])
    const other = recognizeIntegrations(catalog, pluginSnapshot({ sources: [source("@neuralnomads/opencode-mail", { pluginId: "neuralnomads.other" })] }))
    assert.equal(other[2]!.ambiguous, true)
  })

  it("recognises a disabled plugin by its normalized rule only, never by an enabling or raw `-id` selector", () => {
    const rule = (selector: string, enabled: boolean) => ({ selector, enabled, scope: "global" as const, entryIndex: 0, order: 0 })
    const read = (rules: ReturnType<typeof rule>[]) => recognizeIntegrations(catalog, pluginSnapshot({ rules }))[0]!
    const disabled = read([rule("neuralnomads.fixture", false)])
    assert.deepEqual(disabled.ways, ["plugin"])
    assert.deepEqual(disabled.sources, [])
    assert.deepEqual(disabled.scopes, ["global"])
    assert.deepEqual(read([rule("neuralnomads.fixture", true)]).ways, [])
    assert.deepEqual(read([rule("-neuralnomads.fixture", false)]).ways, [], "snapshots never carry a raw `-id` selector")
  })

  it("attributes a package that failed before exporting its ID through exactly one source of its exact target", async () => {
    const target = "@neuralnomads/opencode-fixture@^0.1"
    const failed = runtime("unused", { id: undefined, source: { type: "package", target }, state: { status: "failed", error: "private" } })
    const read = (entries: PluginRuntimeInventoryEntry[], targets = [target]) => recognizeIntegrations(catalog,
      pluginSnapshot({ sources: targets.map(item => source(item)), runtime: entries }))
    assert.equal(read([failed])[0]!.runtime, failed)
    assert.equal(read([failed])[0]!.ambiguous, false)
    assert.equal((await readIntegrationStatuses(read([failed]), async () => assert.fail("failed packages have no RPC")))[0]!.state, "failed")
    assert.equal(read([{ ...failed, source: { type: "package", target: `${target}-other` } }])[0]!.runtime, undefined)
    assert.equal(read([{ ...failed, state: { status: "active" } }])[0]!.runtime, undefined, "only a failure can lack its ID")
    const shared = read([failed], [target, target])[0]!
    assert.equal(shared.runtime, undefined, "a failure shared by two sources is attributed to neither")
    assert.equal(shared.ambiguous, true)
  })

  it("marks two runtime candidates as ambiguous, without any status call", async () => {
    const target = "@neuralnomads/opencode-fixture@^0.1"
    const failed = runtime("unused", { id: undefined, source: { type: "package", target }, state: { status: "failed", error: "private" } })
    for (const [name, entries, targets] of [
      ["two failures", [failed, failed], [target]],
      ["two loaded plugins", [runtime("neuralnomads.fixture"), runtime("neuralnomads.fixture")], [target]],
      ["runtime only", [runtime("neuralnomads.fixture"), runtime("neuralnomads.fixture")], []],
    ] as const) {
      const recognition = recognizeIntegrations(catalog, pluginSnapshot({ sources: targets.map(item => source(item)), runtime: [...entries] }))
      assert.equal(recognition[0]!.ambiguous, true, name)
      assert.equal(recognition[0]!.runtime, undefined, name)
      assert.deepEqual(recognition[0]!.ways.includes("plugin"), true, name)
      assert.equal((await readIntegrationStatuses(recognition, async () => assert.fail("ambiguous packages have no RPC")))[0]!.state, "non-conforming", name)
    }
  })

  it("attributes neither a shared source nor its runtime entry to an ambiguous integration", () => {
    // One package loaded under another integration's plugin ID designates both.
    const loaded = runtime("neuralnomads.fixture", { source: { type: "package", target: "@neuralnomads/opencode-mail" } })
    const crossed = recognizeIntegrations(catalog, pluginSnapshot({
      sources: [source("@neuralnomads/opencode-mail", { pluginId: "neuralnomads.fixture" })], runtime: [loaded] }))
    for (const recognition of [crossed[0]!, crossed[2]!]) {
      assert.equal(recognition.ambiguous, true, recognition.entry.id)
      assert.equal(recognition.runtime, undefined, recognition.entry.id)
      assert.deepEqual(recognition.sources, [], recognition.entry.id)
      assert.notDeepEqual(recognition.ways, [], `${recognition.entry.id} stays configured`)
    }
    // One Git source designating two integrations, failing before exporting an ID.
    const git = catalogOf(catalogEntry("fixture", { sources: { git: [GIT] } }), catalogEntry("mail", { sources: { git: [GIT] } }))
    const target = `${GIT}main::path:integrations/fixture/plugin`
    const failed = runtime("unused", { id: undefined, source: { type: "package", target }, state: { status: "failed", error: "private" } })
    for (const recognition of recognizeIntegrations(git, pluginSnapshot({ sources: [source(target)], runtime: [failed] }))) {
      assert.deepEqual([recognition.ambiguous, recognition.runtime, recognition.sources], [true, undefined, []], recognition.entry.id)
    }
  })

  it("designates integrations for a spec being added by package name or Git prefix only", () => {
    assert.deepEqual(integrationsForSpec(catalog, "@neuralnomads/opencode-fixture").map(entry => entry.id), ["fixture"])
    assert.deepEqual(integrationsForSpec(catalog, `${GIT}fixture-v0.1.0::path:/integrations/fixture`).map(entry => entry.id), ["fixture"])
    assert.deepEqual(integrationsForSpec(catalog, "alias@npm:@neuralnomads/opencode-mail@1").map(entry => entry.id), ["mail"])
    assert.deepEqual(integrationsForSpec(catalog, "neuralnomads.fixture"), [])
  })
})

describe("integration status", () => {
  const loaded = (...ids: string[]) => recognizeIntegrations(catalog, pluginSnapshot({
    sources: ids.map(id => source(`@neuralnomads/opencode-${id}`, { pluginId: `neuralnomads.${id}` })),
    runtime: ids.map(id => runtime(`neuralnomads.${id}`)),
  }))

  it("distinguishes absent, inactive, failed, unsupported, non-conforming and ok", async () => {
    const recognitions = recognizeIntegrations(catalog, pluginSnapshot({
      sources: [source("@neuralnomads/opencode-fixture", { pluginId: "neuralnomads.fixture" }), source("@neuralnomads/opencode-drift")],
      runtime: [runtime("neuralnomads.fixture")],
    }))
    const calls: string[] = []
    const call: IntegrationRpcCall = async rpcID => { calls.push(rpcID); return status("fixture") }
    assert.deepEqual((await readIntegrationStatuses(recognitions, call)).map(read => read.state), ["ok", "inactive", "absent"])
    assert.deepEqual(calls, ["neuralnomads.fixture"], "only loaded integrations are called, under the catalog's RPC ID")

    const failed = loaded("fixture")
    failed[0]!.runtime = runtime("neuralnomads.fixture", { state: { status: "failed", error: "boom" } })
    assert.equal((await readIntegrationStatuses(failed, call))[0]!.state, "failed")
    for (const type of ["rpc.unavailable", "rpc.method_not_found"]) {
      const unregistered: IntegrationRpcCall = async () => { throw { _tag: "RpcError", type } }
      assert.equal((await readIntegrationStatuses(loaded("fixture"), unregistered))[0]!.state, "unsupported", type)
    }
    const broken: IntegrationRpcCall = async () => { throw { _tag: "RpcError", type: "rpc.invalid_output" } }
    assert.equal((await readIntegrationStatuses(loaded("fixture"), broken))[0]!.state, "non-conforming")
    const failing: IntegrationRpcCall = async () => { throw new Error("socket closed") }
    assert.equal((await readIntegrationStatuses(loaded("fixture"), failing))[0]!.state, "unknown")
  })

  it("refuses a marker mismatch, another family, an output outside the contract and a path-like application version", async () => {
    const outputs: unknown[] = [
      status("fixture-other"),
      status("fixture", "api"),
      { ...status("fixture"), contract: 2 },
      status("fixture", "native", { host: { state: "ok", appVersion: "C:Program" } }),
      status("fixture", "native", { host: { state: "ok", appVersion: "~ user build" } }),
      status("fixture", "native", { host: { state: "ok", appVersion: "5.2/scene" } }),
    ]
    for (const output of outputs) {
      const [read] = await readIntegrationStatuses(loaded("fixture"), async () => output)
      assert.equal(read!.state, "non-conforming", JSON.stringify(output))
    }
    const [read] = await readIntegrationStatuses(loaded("fixture"), async () => status("fixture", "native", { host: { state: "ok", appVersion: "5.2.0 Alpha" }, extra: "dropped" }))
    assert.equal(read!.state, "ok")
    assert.equal("extra" in (read as { status: object }).status, false)
  })

  it("answers unknown for one integration past 8 s without failing the others, with at most 4 calls in flight", async () => {
    const many = recognizeIntegrations(catalogOf(...Array.from({ length: 9 }, (_, index) => catalogEntry(`app${index}`))), pluginSnapshot({
      sources: Array.from({ length: 9 }, (_, index) => source(`@neuralnomads/opencode-app${index}`, { pluginId: `neuralnomads.app${index}` })),
      runtime: Array.from({ length: 9 }, (_, index) => runtime(`neuralnomads.app${index}`)),
    }))
    let inFlight = 0
    let peak = 0
    const reads = await readIntegrationStatuses(many, async rpcID => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        // app0 never answers and ignores its signal.
        if (rpcID === "neuralnomads.app0") return await new Promise(() => undefined)
        await new Promise(resolve => setTimeout(resolve, 5))
        return status(rpcID.split(".")[1]!)
      } finally { inFlight -= 1 }
    }, { timeoutMs: 50 })
    assert.equal(peak, 4)
    assert.deepEqual(reads.map(read => read.state), ["unknown", ...Array(8).fill("ok")])
  })

  it("recognises path-like display text", () => {
    for (const value of ["a/b", "a\\b", "D:", "scene on C:", "~", "home ~user"]) assert.equal(looksLikePath(value), true, value)
    for (const value of ["Blender 5.2", "Note: draft", "build (hash: 1a)", "5.2~beta"]) assert.equal(looksLikePath(value), false, value)
  })
})
