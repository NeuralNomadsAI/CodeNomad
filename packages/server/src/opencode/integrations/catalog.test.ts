import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import {
  INTEGRATION_CATALOG_ASSET,
  INTEGRATION_CATALOG_CACHE_MS,
  INTEGRATION_CATALOG_RELEASES_URL,
  IntegrationCatalogSource,
  selectCatalogRelease,
} from "./catalog"
import { catalogEntry, catalogOf } from "./catalog-fixture"
import { INTEGRATION_CATALOG_MAX_BYTES } from "./contract"

/** A local GitHub releases API: `releases` is the list, `assets` the bytes served per asset ID. */
function releaseServer() {
  const state = {
    releases: [] as unknown[],
    assets: new Map<string, Buffer | string>(),
    etag: "\"list-1\"",
    requests: [] as Array<{ url: string; headers: IncomingMessage["headers"] }>,
    hang: false,
  }
  const server: Server = createServer((request, response) => {
    state.requests.push({ url: request.url ?? "", headers: request.headers })
    if (state.hang) return
    if (request.url?.startsWith("/repos/NeuralNomadsAI/opencode-integrations/releases?")) {
      if (request.headers["if-none-match"] === state.etag) return void response.writeHead(304).end()
      response.writeHead(200, { "content-type": "application/json", etag: state.etag }).end(JSON.stringify(state.releases))
      return
    }
    const asset = /^\/assets\/(\w+)$/.exec(request.url ?? "")
    const body = asset ? state.assets.get(asset[1]!) : undefined
    if (body === undefined) return void response.writeHead(404).end()
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(body)
  })
  return {
    state,
    async start() {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

function release(origin: string, tag: string, assetId: string, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, draft: false, prerelease: false,
    assets: [{ name: INTEGRATION_CATALOG_ASSET, url: `${origin}/assets/${assetId}`, size: 100 }], ...extra }
}

describe("integration catalog", () => {
  const fixture = releaseServer()
  let origin = ""
  let url = ""
  let stateDir = ""
  before(async () => {
    origin = await fixture.start()
    url = `${origin}/repos/NeuralNomadsAI/opencode-integrations/releases?per_page=100`
    stateDir = await mkdtemp(path.join(tmpdir(), "codenomad-catalog-"))
  })
  after(async () => {
    await fixture.close()
    await rm(stateDir, { recursive: true, force: true })
  })

  const reset = (releases: unknown[], assets: Record<string, Buffer | string>) => {
    fixture.state.releases = releases
    fixture.state.assets = new Map(Object.entries(assets))
    fixture.state.requests = []
    fixture.state.etag = `"list-${Math.random()}"`
    fixture.state.hang = false
  }

  it("names the real repository's releases and never its latest release", () => {
    assert.equal(new URL(INTEGRATION_CATALOG_RELEASES_URL).pathname, "/repos/NeuralNomadsAI/opencode-integrations/releases")
    assert.doesNotMatch(INTEGRATION_CATALOG_RELEASES_URL, /latest/)
  })

  it("reads the newest catalog release, ignoring other tags, drafts, prereleases and foreign assets", async () => {
    const wanted = catalogOf(catalogEntry("fixture"))
    reset([
      release(origin, "blender-v9.0.0", "app"),
      release(origin, "catalog-v12", "draft", { draft: true }),
      release(origin, "catalog-v11", "pre", { prerelease: true }),
      { ...release(origin, "catalog-v10", "foreign"), assets: [{ name: INTEGRATION_CATALOG_ASSET, url: "https://elsewhere.test/a", size: 1 }] },
      release(origin, "catalog-v9", "nine"),
      release(origin, "catalog-v2", "two"),
    ], { nine: JSON.stringify(wanted), two: JSON.stringify(catalogOf()) })
    const view = await new IntegrationCatalogSource({ releasesUrl: url }).read()
    assert.equal(view.state, "fresh")
    assert.deepEqual(view.catalog, wanted)
    assert.deepEqual(fixture.state.requests.map(request => request.url), [new URL(url).pathname + new URL(url).search, "/assets/nine"])
    assert.equal(fixture.state.requests[1]!.headers.accept, "application/octet-stream")
  })

  it("issues one remote request for reads within 30 s, then a conditional one", async () => {
    reset([release(origin, "catalog-v1", "one")], { one: JSON.stringify(catalogOf(catalogEntry("fixture"))) })
    let now = 1_000_000
    const source = new IntegrationCatalogSource({ releasesUrl: url, now: () => now })
    await Promise.all([source.read(), source.read()])
    now += INTEGRATION_CATALOG_CACHE_MS - 1
    await source.read()
    assert.equal(fixture.state.requests.length, 2, "one list and one asset request")
    now += 1
    const view = await source.read()
    assert.equal(view.state, "fresh")
    assert.equal(fixture.state.requests.length, 3, "the expired cache sends one conditional list request")
    assert.equal(fixture.state.requests[2]!.headers["if-none-match"], fixture.state.etag)
  })

  it("is unavailable with an empty list when no valid catalog is known", async () => {
    reset([release(origin, "blender-v0.1.0", "app")], {})
    const view = await new IntegrationCatalogSource({ releasesUrl: url }).read()
    assert.deepEqual(view, { state: "unavailable", catalog: { schemaVersion: 1, integrations: [] } })
  })

  for (const [name, body] of [
    ["larger than 256 KiB", Buffer.alloc(INTEGRATION_CATALOG_MAX_BYTES + 1, 0x20)],
    ["not JSON", "{ not json"],
    ["outside the schema", JSON.stringify({ schemaVersion: 1, integrations: [{ id: "x" }] })],
    ["with a duplicate id", JSON.stringify(catalogOf(catalogEntry("fixture"), catalogEntry("fixture", { package: "@neuralnomads/opencode-other",
      plugin: "neuralnomads.other", rpc: "neuralnomads.other" })))],
  ] as const) {
    it(`refuses a catalog ${name} and keeps the previous one`, async () => {
      const previous = catalogOf(catalogEntry("fixture"))
      reset([release(origin, "catalog-v1", "one")], { one: JSON.stringify(previous) })
      let now = 0
      const source = new IntegrationCatalogSource({ releasesUrl: url, now: () => now })
      const first = await source.read()
      reset([release(origin, "catalog-v2", "two")], { two: body })
      now += INTEGRATION_CATALOG_CACHE_MS
      const view = await source.read()
      assert.equal(view.state, "stale")
      assert.equal(view.fetchedAt, first.fetchedAt)
      assert.deepEqual(view.catalog, previous)
    })
  }

  it("serves the persisted catalog as stale after a restart while the releases are unreachable", async () => {
    const stateFile = path.join(stateDir, "catalog.json")
    const catalog = catalogOf(catalogEntry("fixture"))
    reset([release(origin, "catalog-v3", "three")], { three: JSON.stringify(catalog) })
    const fresh = await new IntegrationCatalogSource({ releasesUrl: url, stateFile }).read()
    assert.equal(fresh.state, "fresh")
    assert.match(await readFile(stateFile, "utf8"), /"tag":"catalog-v3"/)
    const unreachable = new IntegrationCatalogSource({ releasesUrl: "http://127.0.0.1:9/releases", stateFile })
    assert.deepEqual(await unreachable.read(), { state: "stale", fetchedAt: fresh.fetchedAt, catalog })
    reset([release(origin, "catalog-v3", "three")], {})
    const restarted = await new IntegrationCatalogSource({ releasesUrl: url, stateFile }).read()
    assert.equal(restarted.state, "fresh", "the same release is not downloaded again")
    assert.equal(fixture.state.requests.length, 1)
  })

  it("bounds a hanging refresh by its timeout", async () => {
    reset([], {})
    fixture.state.hang = true
    const started = Date.now()
    const view = await new IntegrationCatalogSource({ releasesUrl: url, timeoutMs: 100 }).read()
    assert.equal(view.state, "unavailable")
    assert(Date.now() - started < 5_000)
  })

  it("selects nothing from a list that is not an array of releases", () => {
    assert.throws(() => selectCatalogRelease({ message: "rate limited" }, origin))
    assert.equal(selectCatalogRelease([null, 1, { tag_name: "catalog-v01", draft: false, prerelease: false, assets: [] }], origin), null)
  })
})
