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

const loadedSnapshot = (): PluginControlsSnapshot => pluginSnapshot({
  sources: [
    { target: "@neuralnomads/opencode-fixture@0.1.0", scope: "global", path: "/config/opencode.jsonc", entryIndex: 0, hasOptions: false, pluginId: "neuralnomads.fixture" },
    { target: "@neuralnomads/opencode-slow", scope: "project", entryIndex: 0, hasOptions: false, pluginId: "neuralnomads.slow" },
  ],
  runtime: ["fixture", "slow"].map(id => ({ key: id, id: `neuralnomads.${id}`, features: { rpc: true as const },
    source: { type: "package" as const, target: `@neuralnomads/opencode-${id}`, version: "0.1.0" }, state: { status: "active" as const } })),
})

function harness(options: {
  snapshot?: () => PluginControlsSnapshot
  catalog?: IntegrationCatalogView
  owns?: (call: number) => boolean
  assertCurrent?: () => void
} = {}) {
  const calls: Array<{ rpcID: string; method: string; input: unknown; location: unknown }> = []
  let ownership = 0
  const client = {
    rpc: {
      call: async (request: { rpcID: string; method: string; input: unknown; location: unknown }) => {
        calls.push(request)
        if (request.rpcID === "neuralnomads.slow") return new Promise(() => undefined)
        return { output: { contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 }, host: { state: "absent", action: "install" } } }
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
    assert.deepEqual(body.integrations[0]!.configuredSources, [{ scope: "global", entryIndex: 0 }])
    assert.deepEqual(body.integrations[1]!.configuredSources, [], "only the scope's writable target is correlated")
    for (const field of ["plugin", "rpc", "sources", "package"]) assert.equal(field in body.integrations[0]!, false, `${field} stays on the server`)
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
    assert.deepEqual(body, { location: { directory: "/work" }, catalog: { state: "unavailable" }, integrations: [] })
    assert.equal(calls.length, 0)
    await app.close()
  })
})
