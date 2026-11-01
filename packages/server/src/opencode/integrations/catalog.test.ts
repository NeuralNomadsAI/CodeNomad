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
    /** Later pages of the list, linked from the previous one. */
    pages: [] as unknown[][],
    /** Status and headers answered instead of the list. */
    refuse: undefined as { status: number; headers: Record<string, string> } | undefined,
  }
  const server: Server = createServer((request, response) => {
    state.requests.push({ url: request.url ?? "", headers: request.headers })
    if (state.hang) return
    if (request.url?.startsWith("/repos/NeuralNomadsAI/opencode-integrations/releases?")) {
      if (state.refuse) return void response.writeHead(state.refuse.status, state.refuse.headers).end("{}")
      if (request.headers["if-none-match"] === state.etag) return void response.writeHead(304).end()
      const page = Number(new URL(request.url, "http://local").searchParams.get("page") ?? "1")
      const body = page === 1 ? state.releases : state.pages[page - 2] ?? []
      const host = `http://${request.headers.host}`
      const link = page <= state.pages.length ? { link: `<${host}/repos/NeuralNomadsAI/opencode-integrations/releases?per_page=100&page=${page + 1}>; rel="next"` } : {}
      response.writeHead(200, { "content-type": "application/json", ...(page === 1 ? { etag: state.etag } : {}), ...link }).end(JSON.stringify(body))
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

function release(origin: string, tag: string, assetId: string, extra: Record<string, unknown> = {}, updatedAt = "2026-10-31T00:00:00Z") {
  return { tag_name: tag, draft: false, prerelease: false,
    assets: [{ name: INTEGRATION_CATALOG_ASSET, url: `${origin}/assets/${assetId}`, size: 100, id: assetId.length, updated_at: updatedAt }], ...extra }
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
    fixture.state.pages = []
    fixture.state.refuse = undefined
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
    assert.match(await readFile(stateFile, "utf8"), /"revision":"catalog-v3#5@2026-10-31T00:00:00Z"/)
    const unreachable = new IntegrationCatalogSource({ releasesUrl: "http://127.0.0.1:9/releases", stateFile })
    assert.deepEqual(await unreachable.read(), { state: "stale", fetchedAt: fresh.fetchedAt, catalog })
    reset([release(origin, "catalog-v3", "three")], {})
    const restarted = await new IntegrationCatalogSource({ releasesUrl: url, stateFile }).read()
    assert.equal(restarted.state, "fresh", "the same release is not downloaded again")
    assert.equal(fixture.state.requests.length, 1)
  })

  it("downloads a catalog asset re-uploaded under the same release tag", async () => {
    reset([release(origin, "catalog-v4", "four")], { four: JSON.stringify(catalogOf(catalogEntry("fixture"))) })
    let now = 0
    const source = new IntegrationCatalogSource({ releasesUrl: url, now: () => now })
    await source.read()
    const replaced = catalogOf(catalogEntry("fixture"), catalogEntry("other"))
    reset([release(origin, "catalog-v4", "four", {}, "2026-11-01T00:00:00Z")], { four: JSON.stringify(replaced) })
    now += INTEGRATION_CATALOG_CACHE_MS
    assert.deepEqual((await source.read()).catalog, replaced)
    assert.deepEqual(fixture.state.requests.map(request => request.url.split("?")[0]), ["/repos/NeuralNomadsAI/opencode-integrations/releases", "/assets/four"])
  })

  it("finds the newest catalog release on a later page of the release list", async () => {
    const catalog = catalogOf(catalogEntry("fixture"))
    reset(Array.from({ length: 3 }, (_, index) => release(origin, `blender-v0.${index}.0`, "app")), { seven: JSON.stringify(catalog) })
    fixture.state.pages = [[release(origin, "blender-v0.0.1", "app")], [release(origin, "catalog-v7", "seven"), release(origin, "catalog-v6", "six")]]
    const view = await new IntegrationCatalogSource({ releasesUrl: url }).read()
    assert.equal(view.state, "fresh")
    assert.deepEqual(view.catalog, catalog)
    assert.deepEqual(fixture.state.requests.map(request => new URL(request.url, origin).searchParams.get("page")), [null, "2", "3", null])
  })

  it("reads later pages again for a release found there, so its re-uploaded asset is seen", async () => {
    reset([release(origin, "blender-v0.1.0", "app")], { seven: JSON.stringify(catalogOf(catalogEntry("fixture"))) })
    fixture.state.pages = [[release(origin, "catalog-v7", "seven")]]
    let now = 0
    const source = new IntegrationCatalogSource({ releasesUrl: url, now: () => now })
    await source.read()
    const replaced = catalogOf(catalogEntry("fixture"), catalogEntry("other"))
    fixture.state.pages = [[release(origin, "catalog-v7", "seven", {}, "2026-11-02T00:00:00Z")]]
    fixture.state.assets.set("seven", JSON.stringify(replaced))
    fixture.state.requests = []
    now += INTEGRATION_CATALOG_CACHE_MS
    assert.deepEqual((await source.read()).catalog, replaced)
    assert.equal(fixture.state.requests[0]!.headers["if-none-match"], undefined, "no conditional shortcut for a later-page release")
  })

  it("waits for GitHub's rate-limit reset before asking again, serving the last valid catalog", async () => {
    const catalog = catalogOf(catalogEntry("fixture"))
    reset([release(origin, "catalog-v1", "one")], { one: JSON.stringify(catalog) })
    let now = 1_000_000
    const source = new IntegrationCatalogSource({ releasesUrl: url, now: () => now })
    await source.read()
    fixture.state.refuse = { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 600_000) / 1000) } }
    now += INTEGRATION_CATALOG_CACHE_MS
    assert.equal((await source.read()).state, "stale")
    const refused = fixture.state.requests.length
    now += 300_000
    assert.deepEqual(await source.read(), { state: "stale", fetchedAt: new Date(1_000_000).toISOString(), catalog })
    assert.equal(fixture.state.requests.length, refused, "no request before the reset")
    fixture.state.refuse = undefined
    now += 300_000
    assert.equal((await source.read()).state, "fresh")
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
