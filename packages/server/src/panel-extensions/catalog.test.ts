import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { createPanelExtensionCatalog, PANEL_EXTENSION_CATALOG_URL } from "./catalog"
import { fixtureArchive, fixtureManifest } from "./archive-fixture"
import { PanelExtensionStore } from "./store"
import { registerPanelExtensionRoutes } from "../server/routes/panel-extensions"

const archive = fixtureArchive()
const digest = createHash("sha256").update(archive).digest("hex")
const entry = { manifest: fixtureManifest, description: "Example panel", digest, release: { tag: "v1.0.0", asset: "example.session-1.0.0.zip" } }
const index = (entries: unknown[] = [entry]) => JSON.stringify({ schemaVersion: 1, extensions: entries })
const binary = (bytes: Buffer) => new Uint8Array(bytes).buffer
const fetcher = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
  ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch

test("catalogue discovery fetches metadata only, coalesces display reads and shows unsupported APIs safely", async () => {
  const calls: string[] = []
  const catalog = createPanelExtensionCatalog(fetcher((url, init) => {
    calls.push(url)
    assert.equal(init?.redirect, "manual"); assert.equal(init?.credentials, "omit")
    assert.equal(new Headers(init?.headers).has("Authorization"), false)
    return new Response(index([entry, { ...entry, manifest: { ...fixtureManifest, id: "other.example", apiVersion: 2 } }]))
  }))
  const [first, second] = await Promise.all([catalog.list(), catalog.list()])
  assert.equal(first, second)
  assert.deepEqual(first.entries.map(value => value.compatible), [true, false])
  await catalog.list()
  assert.deepEqual(calls, [PANEL_EXTENSION_CATALOG_URL])
  await assert.rejects(catalog.inspect("other.example", digest), { code: "invalid" })
  assert.equal(calls.length, 2)
})

test("inspection verifies exact manifest/hash and allows only bounded HTTPS GitHub release redirects", async () => {
  const calls: string[] = []
  const asset = "https://release-assets.githubusercontent.com/github-production-release-asset/test?signature=public"
  const catalog = createPanelExtensionCatalog(fetcher(url => {
    calls.push(url)
    if (url === PANEL_EXTENSION_CATALOG_URL) return new Response(index())
    if (url === asset) return new Response(binary(archive))
    return new Response(null, { status: 302, headers: { location: asset } })
  }))
  const pkg = await catalog.inspect(fixtureManifest.id, digest)
  assert.equal(pkg.html, "<p>Example</p>")
  assert.deepEqual(calls, [PANEL_EXTENSION_CATALOG_URL, "https://github.com/example/session/releases/download/v1.0.0/example.session-1.0.0.zip", asset])
  for (const location of ["http://github.com/a", "https://127.0.0.1/private", "https://github.com.evil.test/a", "https://github.com:444/a", "https://user:secret@github.com/a"]) {
    const seen: string[] = []
    const blocked = createPanelExtensionCatalog(fetcher(url => {
      seen.push(url)
      return url === PANEL_EXTENSION_CATALOG_URL ? new Response(index()) : new Response(null, { status: 302, headers: { location } })
    }))
    await assert.rejects(blocked.inspect(fixtureManifest.id, digest), { code: "invalid" })
    assert.equal(seen.length, 2, "Forbidden redirect is never requested")
  }
})

test("warm display snapshots never authorize withdrawn, changed or tampered packages", async () => {
  let current = index(), bytes = archive
  const catalog = createPanelExtensionCatalog(fetcher(url => new Response(url === PANEL_EXTENSION_CATALOG_URL ? current : binary(bytes))))
  await catalog.list()
  current = index([])
  await assert.rejects(catalog.inspect(fixtureManifest.id, digest), { code: "missing" })
  current = index([{ ...entry, digest: "0".repeat(64) }])
  await assert.rejects(catalog.inspect(fixtureManifest.id, digest), { code: "conflict" })
  current = index(); bytes = fixtureArchive("<p>Wrong bytes</p>")
  await assert.rejects(catalog.inspect(fixtureManifest.id, digest), { code: "conflict" })
  bytes = fixtureArchive("<p>Example</p>", { author: "Different author" })
  const changedDigest = createHash("sha256").update(bytes).digest("hex")
  current = index([{ ...entry, digest: changedDigest }])
  await assert.rejects(catalog.inspect(fixtureManifest.id, changedDigest), { code: "conflict" })
})

test("invalid catalogues, duplicate identities, oversized bodies and redirect loops fail closed", async () => {
  for (const body of ["invalid", index([entry, entry]), index([{ ...entry, release: { ...entry.release, asset: "../outside.zip" } }]),
    JSON.stringify({ schemaVersion: 2, extensions: [] }), index([{ ...entry, url: "https://evil.test" }])]) {
    const catalog = createPanelExtensionCatalog(fetcher(() => new Response(body)))
    await assert.rejects(catalog.list())
  }
  await assert.rejects(createPanelExtensionCatalog(fetcher(() => new Response("x".repeat(256 * 1024 + 1)))).list(), { code: "limit" })
  const huge = createPanelExtensionCatalog(fetcher(url => new Response(url === PANEL_EXTENSION_CATALOG_URL ? index() : binary(Buffer.alloc(2 * 1024 * 1024 + 1)))))
  await assert.rejects(huge.inspect(fixtureManifest.id, digest), { code: "limit" })
  let calls = 0
  const loop = createPanelExtensionCatalog(fetcher(url => {
    calls++
    return url === PANEL_EXTENSION_CATALOG_URL ? new Response(index()) : new Response(null, { status: 302, headers: { location: url } })
  }))
  await assert.rejects(loop.inspect(fixtureManifest.id, digest), { code: "invalid" })
  assert.equal(calls, 5)
})

test("catalogue routes require exact selection and consent, revalidate at install, and never accept URLs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-catalog-route-")), store = new PanelExtensionStore(root)
  let current = index()
  const app = Fastify()
  registerPanelExtensionRoutes(app, { store, workspaceManager: { get: () => undefined },
    catalog: createPanelExtensionCatalog(fetcher(url => new Response(url === PANEL_EXTENSION_CATALOG_URL ? current : binary(archive)))) })
  try {
    assert.equal((await app.inject("/api/panel-extensions/catalog")).json().entries[0].compatible, true)
    const selection = { id: fixtureManifest.id, digest }
    assert.equal((await app.inject({ method: "POST", url: "/api/panel-extensions/catalog/inspect", payload: selection })).statusCode, 200)
    assert.deepEqual(await store.list("/repo"), [])
    assert.equal((await app.inject({ method: "POST", url: "/api/panel-extensions/catalog/install", payload: selection })).statusCode, 400)
    assert.equal((await app.inject({ method: "POST", url: "/api/panel-extensions/catalog/install", payload: { ...selection, acknowledged: true, url: "http://localhost/secret" } })).statusCode, 400)
    current = index([])
    assert.equal((await app.inject({ method: "POST", url: "/api/panel-extensions/catalog/install", payload: { ...selection, acknowledged: true } })).statusCode, 404)
    assert.deepEqual(await store.list("/repo"), [])
    current = index()
    assert.equal((await app.inject({ method: "POST", url: "/api/panel-extensions/catalog/install", payload: { ...selection, acknowledged: true } })).statusCode, 200)
    assert.equal((await store.list("/repo"))[0].enabled, false)
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
