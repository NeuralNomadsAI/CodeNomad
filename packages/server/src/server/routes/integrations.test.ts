import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"
import type { PluginControlsSnapshot } from "../../api-types"
import type { IntegrationsResponse } from "../../integration-types"
import { catalogEntry, catalogOf, pluginSnapshot } from "../../opencode/integrations/catalog-fixture"
import type { IntegrationCatalogView } from "../../opencode/integrations/catalog"
import { IntegrationsReader } from "../../opencode/integrations/integrations"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { registerIntegrationRoutes } from "./integrations"

const loadedSnapshot = (): PluginControlsSnapshot => ({ ...pluginSnapshot({
  sources: [
    { target: "@neuralnomads/opencode-fixture@0.1.0", scope: "global", path: "/config/opencode.jsonc", entryIndex: 0, hasOptions: false, pluginId: "neuralnomads.fixture" },
    { target: "@neuralnomads/opencode-slow", scope: "project", entryIndex: 0, hasOptions: false, pluginId: "neuralnomads.slow" },
  ],
  runtime: ["fixture", "slow"].map(id => ({ key: id, id: `neuralnomads.${id}`, features: { rpc: true as const },
    source: { type: "package" as const, target: `@neuralnomads/opencode-${id}`, version: "0.1.0" }, state: { status: "active" as const } })),
}), targets: [{ scope: "global", path: "/config/opencode.jsonc", exists: true, expectedRevision: "a".repeat(64) },
  { scope: "project", path: "/work/.opencode/opencode.jsonc", exists: true, expectedRevision: "b".repeat(64) }] })

function harness(options: {
  snapshot?: () => PluginControlsSnapshot
  catalog?: IntegrationCatalogView
  owns?: (call: number) => boolean
  assertCurrent?: () => void
  status?: unknown
} = {}) {
  const calls: Array<{ rpcID: string; method: string; input: unknown; location: unknown }> = []
  let ownership = 0
  const client = {
    rpc: {
      call: async (request: { rpcID: string; method: string; input: unknown; location: unknown }) => {
        calls.push(request)
        if (request.rpcID === "neuralnomads.slow") return new Promise(() => undefined)
        return { output: options.status ?? { contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 }, host: { state: "absent", action: "install" } } }
      },
    },
  }
  const reader = new IntegrationsReader({
    controls: { read: async () => (options.snapshot ?? loadedSnapshot)() },
    workspaceManager: {
      getSharedServiceConnection: async () => ({ client, assertCurrent: options.assertCurrent ?? (() => undefined) }) as never,
      ownsLocation: async () => options.owns?.(ownership++) ?? true,
    },
    catalog: { read: async () => options.catalog ?? { state: "fresh", fetchedAt: "2026-10-31T00:00:00.000Z",
      catalog: catalogOf(catalogEntry("fixture", { sources: { git: ["github:NeuralNomadsAI/opencode-integrations#"] } }), catalogEntry("slow"), catalogEntry("other")) } },
    timeoutMs: 50,
  })
  const app = Fastify()
  registerIntegrationRoutes(app, { integrations: reader })
  return { app, calls }
}

describe("integrations route", () => {
  it("reads every catalog integration, calling the catalog's RPC ID in the owned Location", async () => {
    const { app, calls } = harness()
    const response = await app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["cache-control"], "no-store")
    const body = response.json() as IntegrationsResponse
    assert.deepEqual(body.catalog, { state: "fresh", fetchedAt: "2026-10-31T00:00:00.000Z" })
    assert.deepEqual(body.integrations.map(item => [item.id, item.state, item.scopes]), [["fixture", "ok", ["global"]], ["slow", "unknown", ["project"]], ["other", "absent", []]])
    assert.deepEqual(body.integrations[0]!.status, { version: "0.1.0", host: { state: "absent", action: "install" } })
    assert.equal(body.integrations[0]!.version, "0.1.0")
    assert.deepEqual(body.integrations[0]!.configuredSources, [{ scope: "global", entryIndex: 0, expectedRevision: "a".repeat(64) }])
    assert.deepEqual(body.integrations[1]!.configuredSources, [], "only the scope's writable target is correlated")
    assert.deepEqual(body.integrations.map(item => item.plugin), [
      { declared: true, runtime: "loaded", runtimeId: "neuralnomads.fixture" },
      { declared: true, runtime: "loaded", runtimeId: "neuralnomads.slow" }, { declared: false },
    ])
    assert.deepEqual(body.integrations.map(item => item.ambiguous), [undefined, undefined, undefined])
    assert.deepEqual(body.ambiguousSources, [])
    assert.equal(body.integrations[0]!.docs, "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/fixture")
    for (const field of ["rpc", "sources", "package"]) assert.equal(field in body.integrations[0]!, false, `${field} stays on the server`)
    assert.deepEqual(Object.keys(body.integrations[0]!.plugin), ["declared", "runtime", "runtimeId"])
    assert.equal(JSON.stringify(body.integrations).includes("/config/"), false, "configuration paths stay on the server")
    assert.equal(JSON.stringify(body.integrations).includes("@neuralnomads/"), false, "source specs stay on the server")
    assert.deepEqual(calls.map(call => [call.rpcID, call.method, call.input, call.location]),
      [["neuralnomads.fixture", "status", {}, { directory: "/work" }], ["neuralnomads.slow", "status", {}, { directory: "/work" }]])
    await app.close()
  })

  it("never accepts an RPC ID or another field from the client", async () => {
    const { app, calls } = harness()
    for (const query of ["directory=%2Fwork&rpcID=neuralnomads.other", "directory=%2Fwork&method=installHost", ""]) {
      assert.equal((await app.inject({ method: "GET", url: `/api/workspaces/w1/integrations?${query}` })).statusCode, 400, query)
    }
    assert.equal(calls.length, 0)
    await app.close()
  })

  it("separates declarations, retained rules, native loading and failures from the ambiguity flag", async () => {
    for (const kind of ["rule", "runtime-only", "failed", "ambiguous", "marker-mismatch"] as const) {
      const snapshot = loadedSnapshot()
      snapshot.runtime = snapshot.runtime.filter(item => item.id === "neuralnomads.fixture")
      snapshot.configured.sources = snapshot.configured.sources.filter(item => item.pluginId === "neuralnomads.fixture")
      if (kind === "rule" || kind === "runtime-only") snapshot.configured.sources = []
      if (kind === "rule") {
        snapshot.runtime = []
        snapshot.configured.rules = [{ selector: "neuralnomads.fixture", enabled: false, scope: "global", entryIndex: 0, order: 0 }]
      }
      if (kind === "failed") {
        snapshot.runtime[0] = { ...snapshot.runtime[0]!, id: undefined, source: { type: "package", target: snapshot.configured.sources[0]!.target },
          state: { status: "failed", error: "private failure" } }
        delete snapshot.configured.sources[0]!.pluginId
      }
      if (kind === "ambiguous") snapshot.runtime.push(snapshot.runtime[0]!)
      const { app, calls } = harness({ snapshot: () => snapshot, ...(kind === "marker-mismatch" ? { status: { contract: 1,
        integration: { id: "fixture-other", version: "0.1.0", family: "native", spec: 0 } } } : {}) })
      const item = (await app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).json().integrations[0]
      assert.deepEqual(item.plugin, { declared: kind !== "rule" && kind !== "runtime-only",
        ...(kind === "rule" || kind === "ambiguous" ? {} : { runtime: kind === "failed" ? "failed" : "loaded" }),
        ...(kind === "runtime-only" || kind === "marker-mismatch" ? { runtimeId: "neuralnomads.fixture" } : {}) }, kind)
      assert.equal(item.configured, true, kind)
      assert.equal(item.ambiguous, kind === "ambiguous" ? true : undefined, kind)
      assert.equal(item.state, kind === "rule" ? "inactive" : kind === "failed" ? "failed"
        : kind === "ambiguous" || kind === "marker-mismatch" ? "non-conforming" : "ok", kind)
      assert.equal(calls.length, kind === "runtime-only" || kind === "marker-mismatch" ? 1 : 0, kind)
      await app.close()
    }
  })

  it("projects the recognized runtime ID for inherited, virtual and runtime-only display independently of writable authority", async () => {
    for (const origin of ["other", "virtual", "runtime-only"] as const) {
      const snapshot = loadedSnapshot()
      snapshot.runtime = [{ ...snapshot.runtime[0]!, id: "acme.render" }]
      snapshot.configured.sources = origin === "runtime-only" ? [] : [{ ...snapshot.configured.sources[0]!,
        pluginId: "acme.render", scope: origin, path: origin === "other" ? "/ancestor/opencode.jsonc" : undefined }]
      const { app } = harness({ snapshot: () => snapshot, catalog: { state: "fresh",
        catalog: catalogOf(catalogEntry("fixture", { plugin: "acme.render" })) } })
      const item = (await app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).json().integrations[0]
      assert.equal(item.state, "ok")
      assert.deepEqual(item.plugin, { declared: origin !== "runtime-only", runtime: "loaded", runtimeId: "acme.render" })
      assert.deepEqual(item.configuredSources, [])
      assert.deepEqual(item.configuredRules, [])
      await app.close()
    }
  })

  it("correlates only the writable activation rules of a non-ambiguous integration's plugin", async () => {
    const snapshot = loadedSnapshot()
    snapshot.configured.rules = [
      { selector: "neuralnomads.fixture", enabled: false, scope: "global", path: "/config/opencode.jsonc", entryIndex: 3, order: 0 },
      { selector: "neuralnomads.fixture", enabled: true, scope: "project", path: "/elsewhere/opencode.jsonc", entryIndex: 1, order: 1 },
      { selector: "neuralnomads.other", enabled: false, scope: "global", path: "/config/opencode.jsonc", entryIndex: 4, order: 0 },
    ]
    const { app } = harness({ snapshot: () => snapshot })
    const items = (await app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).json().integrations as IntegrationsResponse["integrations"]
    assert.deepEqual(items.map(item => item.configuredRules), [[{ scope: "global", entryIndex: 3, expectedRevision: "a".repeat(64) }], [],
      [{ scope: "global", entryIndex: 4, expectedRevision: "a".repeat(64) }]])
    await app.close()
    snapshot.runtime.push(snapshot.runtime[0]!)
    const ambiguous = harness({ snapshot: () => snapshot })
    const first = (await ambiguous.app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).json().integrations[0]
    assert.deepEqual([first.ambiguous, first.configuredRules], [true, []])
    await ambiguous.app.close()
  })

  it("projects the exact target revision for both correlations, leaving unverifiable documents without authority", async () => {
    const snapshot = loadedSnapshot()
    snapshot.configured.rules = [
      { selector: "neuralnomads.fixture", enabled: false, scope: "global", path: "/config/opencode.jsonc", entryIndex: 3, order: 0 },
      { selector: "neuralnomads.fixture", enabled: false, scope: "project", path: "/ancestor/opencode.jsonc", entryIndex: 3, order: 1 },
    ]
    for (const revision of ["c".repeat(64), undefined]) {
      snapshot.targets[0]!.expectedRevision = revision
      const { app } = harness({ snapshot: () => snapshot })
      const item = (await app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).json().integrations[0]
      const authority = revision ? { expectedRevision: revision } : {}
      assert.deepEqual(item.configuredSources, [{ scope: "global", entryIndex: 0, ...authority }])
      assert.deepEqual(item.configuredRules, [{ scope: "global", entryIndex: 3, ...authority }])
      assert.equal(JSON.stringify(item).includes("/opencode.jsonc"), false)
      await app.close()
    }
  })

  it("never projects an aggregate binding state or count", async () => {
    const status = (family: string, connection: unknown) => ({ contract: 1, integration: { id: "fixture", version: "0.1.0", family, spec: 0 },
      ...(family === "native" ? { host: { state: "ok" } } : {}), connection })
    for (const [family, connection, expected] of [
      ["native", { state: "attached", offers: 2, attachedSessions: 7 }, { offers: 2 }],
      ["native", { state: "none" }, {}],
      ["vendor-mcp", { state: "connected", attachedSessions: 3 }, { state: "connected" }],
      ["api", { state: "signed_out" }, { state: "signed_out" }],
      ["api", { state: "attached", offers: 1 }, {}],
    ] as const) {
      const { app } = harness({ status: status(family, connection), catalog: { state: "fresh",
        catalog: catalogOf(catalogEntry("fixture", { family })) } })
      const response = await app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })
      const item = response.json().integrations[0]
      assert.equal(item.state, "ok", `${family} ${JSON.stringify(connection)}`)
      assert.deepEqual(item.status.connection, expected, `${family} ${JSON.stringify(connection)}`)
      assert.equal(response.body.includes("attachedSessions"), false)
      await app.close()
    }
  })

  it("reports neither a declaration, a runtime nor a row association for a source shared by two integrations", async () => {
    const snapshot = pluginSnapshot({
      sources: [{ target: "@neuralnomads/opencode-slow", scope: "global", path: "/config/opencode.jsonc", entryIndex: 0, hasOptions: false, pluginId: "neuralnomads.fixture" }],
      runtime: [{ key: "x", id: "neuralnomads.fixture", features: { rpc: true }, source: { type: "package", target: "@neuralnomads/opencode-slow", version: "0.1.0" }, state: { status: "active" } }],
    })
    const { app, calls } = harness({ snapshot: () => snapshot })
    const body = (await app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).json()
    const items = body.integrations
    assert.deepEqual(body.ambiguousSources, [{ scope: "global", entryIndex: 0 }], "the shared row is marked non-conforming once")
    for (const item of items.slice(0, 2)) {
      assert.deepEqual([item.ambiguous, item.plugin, item.configuredSources, item.scopes, item.state, item.configured],
        [true, { declared: false }, [], [], "non-conforming", true], item.id)
      assert.equal("version" in item, false, item.id)
    }
    assert.equal(calls.length, 0)
    await app.close()
  })

  it("omits a documentation link outside the integration's reviewed GitHub page", async () => {
    const tree = "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/fixture"
    for (const [docs, kept] of [
      [tree, true], ["https://github.com/NeuralNomadsAI/opencode-integrations/blob/main/integrations/fixture/plugin/README.md", true],
      [tree.replace("/fixture", "/other"), false], [`${tree}?next=https://evil.test`, false], ["https://evil.test/docs", false],
      [tree.replace("https:", "http:"), false], [tree.replace("github.com", "user@github.com"), false],
    ] as const) {
      const { app } = harness({ catalog: { state: "fresh", catalog: catalogOf(catalogEntry("fixture", { docs })) } })
      const item = (await app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).json().integrations[0]
      assert.equal(item.docs, kept ? docs : undefined, docs)
      assert.equal("docs" in item, kept, docs)
      await app.close()
    }
  })

  it("refuses a Location the workspace does not own, before and after the RPC calls", async () => {
    const before = harness({ snapshot: () => { throw new PluginControlsError("Location is not owned by this workspace", "forbidden") } })
    assert.equal((await before.app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Felsewhere" })).statusCode, 403)
    assert.equal(before.calls.length, 0)
    await before.app.close()
    const after = harness({ owns: () => false })
    assert.equal((await after.app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).statusCode, 403)
    await after.app.close()
    const reconnected = harness({ assertCurrent: () => { throw new Error("connection replaced") } })
    assert.equal((await reconnected.app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).statusCode, 503)
    await reconnected.app.close()
  })

  it("lists nothing while the catalog is unavailable", async () => {
    const { app, calls } = harness({ catalog: { state: "unavailable", catalog: catalogOf() } })
    const body = (await app.inject({ method: "GET", url: "/api/workspaces/w1/integrations?directory=%2Fwork" })).json() as IntegrationsResponse
    assert.deepEqual(body, { location: { directory: "/work" }, catalog: { state: "unavailable" }, ambiguousSources: [], integrations: [] })
    assert.equal(calls.length, 0)
    await app.close()
  })
})
