import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ServerResponse } from "node:http"
import test from "node:test"
import Fastify from "fastify"
import { chromium } from "playwright"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"
import { RemoteServerBrowseManager } from "../../../server/src/codenomad-servers/browse-manager"
import { startFakeCodeNomad } from "../../../server/src/codenomad-servers/test-support/fake-codenomad"
import { registerBackendRelayRoutes } from "../../../server/src/server/routes/backend-relay"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { RELAY_AUTHORITY_HEADER, RELAY_AUTHORITY_QUERY } from "../../../server/src/codenomad-servers/relay-authority"

test("registry admits two real relayed backends and revalidates before reconnect resync", { timeout: 90_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-registry-"))
  const a = await startFakeCodeNomad(), b = await startFakeCodeNomad()
  const streams = new Map<string, ServerResponse>(), closed: string[] = [], reads: string[] = []
  const mutations: string[] = []
  const bodies: unknown[] = []
  const requestId = "restore-11111111-1111-4111-8111-111111111111"
  const descriptor = { id: "w", requestId, path: "/same", status: "starting", proxyPath: "/workspaces/w/instance", binaryId: "fixture", binaryLabel: "Fixture", createdAt: "", updatedAt: "" }
  let respondA: (() => void) | undefined
  let incompatible = false, hold: (() => void) | undefined
  let metadataHeld!: () => void, streamsClosed!: () => void
  const heldMetadata = new Promise<void>(resolve => { metadataHeld = resolve })
  const allStreamsClosed = new Promise<void>(resolve => { streamsClosed = resolve })
  for (const [id, remote] of [["a", a], ["b", b]] as const) {
    for (const route of ["/api/storage/config/ui", "/api/storage/config/server", "/api/storage/state/ui"]) {
      remote.state.handlers.set(route, (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" }); response.end("{}")
      })
    }
    remote.state.handlers.set("/api/meta", (_request, response) => {
      const send = () => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({
        apiContract: incompatible && id === "b" ? -1 : CODENOMAD_API_CONTRACT, serverId: `server-${id}`,
      })) }
      if (incompatible && id === "b") { hold = send; metadataHeld() }
      else send()
    })
    remote.state.handlers.set("/api/workspaces", (request, response) => {
      if (request.method === "POST") {
        mutations.push(`${id}:POST`)
        let body = ""
        request.on("data", chunk => { body += chunk })
        request.on("end", () => {
          bodies.push(JSON.parse(body))
          const send = () => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(descriptor)) }
          if (id === "a") {
            respondA = send
            streams.get(id)!.write(`data: ${JSON.stringify({ type: "workspace.created", workspace: descriptor })}\n\n`)
          } else send()
        })
        return
      }
      reads.push(id)
      response.writeHead(200, { "content-type": "application/json" }); response.end("[]")
    })
    remote.state.handlers.set("/api/workspaces/w", (request, response) => {
      mutations.push(`${id}:${request.method}`)
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}")
    })
    remote.state.handlers.set("/api/workspaces/w/creation/release", (request, response) => {
      mutations.push(`${id}:release`)
      let body = ""
      request.on("data", chunk => { body += chunk })
      request.on("end", () => {
        assert.deepEqual(JSON.parse(body), { requestId })
        response.writeHead(200, { "content-type": "application/json" }); response.end("{}")
      })
    })
    remote.state.handlers.set("/api/events", (_request, response) => {
      streams.set(id, response)
      response.on("close", () => { closed.push(id); if (closed.length === 2) streamsClosed() })
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
      response.write(": connected\n\n")
    })
  }
  const app = Fastify(), origins = new Set<string>(), local: string[] = []
  const bound: { path: string; header: unknown; query: string | null }[] = []
  app.addHook("onRequest", async request => {
    if (request.url.startsWith("/api/backends/")) bound.push({ path: new URL(request.url, "http://fixture").pathname,
      header: request.headers[RELAY_AUTHORITY_HEADER], query: new URL(request.url, "http://fixture").searchParams.get(RELAY_AUTHORITY_QUERY) })
  })
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: [
    { id: "a", baseUrl: a.origin, skipTlsVerify: false }, { id: "b", baseUrl: b.origin, skipTlsVerify: false },
  ] }), configYamlPathForAuthority: () => path.join(directory, "config.yaml") })
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => origins })
  app.get("/api/events", (_request, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream" }); reply.raw.write(": local\n\n")
  })
  app.all("/*", async request => {
    local.push(request.method + " " + request.url)
    if (request.url === "/api/workspaces") return []
    if (request.url === "/api/meta") return { apiContract: CODENOMAD_API_CONTRACT, serverId: "local" }
    return {}
  })
  const target = await app.listen({ host: "127.0.0.1", port: 0 })
  origins.add(target)
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
    cacheDir: cache.cacheDir, logLevel: "error", resolve: { dedupe: ["solid-js"] },
    plugins: [shutdown.plugin, solid(), { name: "registry", configureServer(vite) {
      vite.middlewares.use("/fixture", async (_request, response) => {
        response.setHeader("content-type", "text/html")
        response.end(await vite.transformIndexHtml("/fixture", '<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-registry.tsx"></script></body></html>'))
      })
    } }], server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, proxy: { "/api": { target } } },
  }).catch(async error => { await cache.dispose(); throw error })
  shutdown.own(server)
  await server.listen()
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  origins.add(origin)
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  t.after(async () => {
    hold?.()
    await browser.close()
    manager.close()
    await server.close()
    app.server.closeAllConnections()
    await app.close()
    await Promise.all([a.close(), b.close()])
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const errors: string[] = [], failed: string[] = [], streamAborts: string[] = []
  const expectedAborts = new Set<string>()
  async function initializedPage(locale?: "de") {
    const page = await browser.newPage({ locale: "fr-FR" })
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    page.on("requestfailed", request => {
      const match = /^\/api\/backends\/([ab])\/api\/events$/.exec(new URL(request.url()).pathname)
      if (match && expectedAborts.delete(match[1]) && request.method() === "GET"
        && request.resourceType() === "eventsource" && request.failure()?.errorText === "net::ERR_ABORTED") streamAborts.push(match[1])
      else failed.push(request.url())
    })
    let releasePrefs!: () => void, releaseMessages!: () => void
    let prefsHeld!: () => void, messagesHeld!: () => void
    const prefsGate = new Promise<void>(resolve => { releasePrefs = resolve })
    const messagesGate = new Promise<void>(resolve => { releaseMessages = resolve })
    const prefsRequest = new Promise<void>(resolve => { prefsHeld = resolve })
    const messagesRequest = new Promise<void>(resolve => { messagesHeld = resolve })
    t.after(() => { releasePrefs(); releaseMessages() })
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const tab = document.querySelector("[role=tab]")
        if (tab && !(window as any).firstRegistryTab) (window as any).firstRegistryTab = tab.outerHTML
      })
      observer.observe(document, { subtree: true, childList: true })
    })
    await page.route("**/api/storage/config/ui", async route => {
      assert.equal(route.request().method(), "GET")
      prefsHeld()
      await prefsGate
      await route.fulfill({ json: locale ? { settings: { locale } } : {} })
    })
    await page.route(new RegExp(`/src/lib/i18n/messages/${locale ?? "fr"}(?:/index\\.ts)?(?:\\?.*)?$`), async route => {
      messagesHeld()
      await messagesGate
      await route.continue()
    })
    await page.goto(`${origin}/fixture`)
    async function assertUnrendered() {
      assert.deepEqual(await page.evaluate(() => ({
        ready: Boolean((window as any).registryFixture),
        first: (window as any).firstRegistryTab ?? null,
        root: document.getElementById("root")!.innerHTML,
      })), { ready: false, first: null, root: "" })
    }
    await prefsRequest
    await assertUnrendered()
    releasePrefs()
    await messagesRequest
    await assertUnrendered()
    releaseMessages()
    await page.waitForFunction(() => (window as any).registryFixture)
    const label = locale === "de" ? "Instanz schließen" : "Fermer l'instance"
    assert.equal(await page.locator(".tab-close").getAttribute("aria-label"), label)
    assert.match(await page.evaluate(() => (window as any).firstRegistryTab), new RegExp(label))
    return page
  }
  const page = await initializedPage()
  await page.waitForFunction(() => (window as any).registryFixture)
  const tab = page.getByRole("tab"), before = await tab.evaluate(el => el.outerHTML)
  let releaseLocalMeta!: () => void, localMetaHeld!: () => void
  const localMetaGate = new Promise<void>(resolve => { releaseLocalMeta = resolve })
  const localMetaRequest = new Promise<void>(resolve => { localMetaHeld = resolve })
  t.after(() => releaseLocalMeta())
  await page.route("**/api/meta", async route => {
    localMetaHeld()
    await localMetaGate
    await route.continue()
  })
  const localReads = page.evaluate(async () => {
    await (window as any).registryFixture.localRead()
    await Promise.all(["a", "b"].map(id => (window as any).registryFixture.ensure(id)))
    await (window as any).registryFixture.localRead()
  })
  await localMetaRequest
  assert.equal(await tab.evaluate(el => el.outerHTML), before)
  releaseLocalMeta()
  await localReads
  assert.equal(a.state.requests.length + b.state.requests.length, 0)
  assert.deepEqual(local.filter(p => p === "GET /api/meta"), ["GET /api/meta", "GET /api/meta"])
  assert.equal(await tab.evaluate(el => el.outerHTML), before)
  const german = await initializedPage("de")
  assert.equal(local.some(route => /^(POST|PUT|PATCH|DELETE) \/api\/storage\//.test(route)), false)
  await german.evaluate(() => (window as any).registryFixture.dispose())
  await german.close()
  await page.evaluate(async () => {
    for (const id of ["a", "b"]) {
      const response = await fetch(`/api/backends/${id}/api/auth/login`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "codenomad", password: "remote-password" }) })
      if (!response.ok) throw new Error("fixture login failed")
    }
    const fixture = (window as any).registryFixture
    fixture.setEnabled(true)
    await Promise.all([fixture.ensure("a"), fixture.ensure("a"), fixture.ensure("b")])
  })
  await page.waitForFunction(() => {
    const state = (window as any).registryFixture.snapshot()
    return state.opens.length === 2 && state.settled.length === 4
  })
  assert.deepEqual(reads.sort(), ["a", "a", "b", "b"])
  const proofs: string[] = []
  for (const id of ["a", "b"]) {
    const stream = bound.find(request => request.path === `/api/backends/${id}/api/events`)!
    assert.match(stream.query!, /^[A-Za-z0-9_-]{43}$/)
    proofs.push(stream.query!)
    const workspaces = bound.filter(request => request.path === `/api/backends/${id}/api/workspaces`)
    assert.equal(workspaces.length, 2)
    assert(workspaces.every(request => request.header === stream.query && request.query === stream.query))
    for (const request of (id === "a" ? a : b).state.requests) {
      assert.equal(request.headers[RELAY_AUTHORITY_HEADER], undefined)
      assert.equal(new URL(request.path, "http://fixture").searchParams.has(RELAY_AUTHORITY_QUERY), false)
    }
  }
  assert.notEqual(proofs[0], proofs[1])
  // Real lifecycle store, real relay and native SSE: event-before-response A, response-before-event B.
  const openA = page.evaluate(() => (window as any).registryFixture.open("a"))
  await page.waitForFunction(() => (window as any).registryFixture.workspaces().includes("a~w"))
  respondA!(); respondA = undefined
  assert.equal((await openA).instanceId, "a~w")
  assert.equal((await page.evaluate(() => (window as any).registryFixture.open("b"))).instanceId, "b~w")
  streams.get("b")!.write(`data: ${JSON.stringify({ type: "workspace.created", workspace: descriptor })}\n\n`)
  await page.waitForFunction(() => (window as any).registryFixture.snapshot().created.includes("b~w"))
  assert.deepEqual((await page.evaluate(() => (window as any).registryFixture.workspaces())).sort(), ["a~w", "b~w"])
  assert.deepEqual(bodies, [{ path: "/same", requestId }, { path: "/same", requestId }])
  await page.evaluate(async requestId => { const f = (window as any).registryFixture; await f.release("b~w", requestId); await f.release("b~w", requestId) }, requestId)
  assert.equal(await page.evaluate(async () => {
    const f = (window as any).registryFixture
    f.closeTab("b~w")
    const detached = !f.tabs().includes("b~w")
    await f.close("b~w")
    return detached
  }), true, "ordinary tab close detaches synchronously before its queued DELETE")
  assert.deepEqual(mutations, ["a:POST", "b:POST", "b:release", "b:DELETE"])
  assert.equal(local.some(route => /^(POST|DELETE) \/api\/workspaces/.test(route)), false)
  for (const id of ["a", "b"]) streams.get(id)!.write(`data: ${JSON.stringify({ type: "workspace.removed", workspaceId: "same" })}\n\n`)
  await page.waitForFunction(() => (window as any).registryFixture.snapshot().frames.length === 2)
  assert.deepEqual((await page.evaluate(() => (window as any).registryFixture.snapshot())).frames.sort(), ["a~same", "b~same"])
  incompatible = true
  expectedAborts.add("b")
  const meta = page.waitForRequest(request => new URL(request.url()).pathname === "/api/backends/b/api/meta")
  await page.evaluate(() => (window as any).registryFixture.restart("b"))
  await meta
  assert.deepEqual(reads.sort(), ["a", "a", "b", "b"], "no domain resync runs before fresh contract validation")
  await heldMetadata
  hold!(); hold = undefined
  await page.locator("[data-state-b]").filter({ hasText: "refused" }).waitFor()
  const state = await page.evaluate(() => (window as any).registryFixture.snapshot())
  assert.deepEqual(state.ids.sort(), ["a", "local"])
  assert.equal(state.opens.length, 2)
  expectedAborts.add("a")
  await page.evaluate(() => (window as any).registryFixture.dispose())
  await allStreamsClosed
  assert.deepEqual(closed.sort(), ["a", "b"])
  assert.deepEqual(errors, [])
  assert.deepEqual(failed, [])
  assert.deepEqual(streamAborts.sort(), ["a", "b"])
})
