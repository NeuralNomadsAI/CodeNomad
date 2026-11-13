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
  const abortWaits: Promise<unknown>[] = []
  t.after(async () => {
    hold?.()
    await browser.close()
    await Promise.allSettled(abortWaits)
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
  const aborted = (id: "a" | "b") => {
    const pending = page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === `/api/backends/${id}/api/events`
      && request.method() === "GET" && request.resourceType() === "eventsource" && request.failure()?.errorText === "net::ERR_ABORTED")
    abortWaits.push(pending)
    void pending.catch(() => {})
    return pending
  }
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
  const localBeforeRetry = [...local]
  await page.evaluate(async () => {
    const fixture = (window as any).registryFixture
    await Promise.all([fixture.ensure("a"), fixture.ensure("a")])
  })
  assert.deepEqual(reads.sort(), ["a", "a", "b", "b"], "ensure retains its admission without polling")
  await page.evaluate(async () => {
    const fixture = (window as any).registryFixture
    await Promise.all([fixture.retry("a"), fixture.retry("a"), fixture.retry("a")])
  })
  assert.deepEqual(reads.sort(), ["a", "a", "a", "b", "b"], "explicit reads coalesce on A only")
  assert.deepEqual(local, localBeforeRetry)
  assert.equal(streams.size, 2)
  for (const id of ["a", "b"]) streams.get(id)!.write(`data: ${JSON.stringify({ type: "workspace.removed", workspaceId: "same" })}\n\n`)
  await page.waitForFunction(() => (window as any).registryFixture.snapshot().frames.length === 2)
  assert.deepEqual((await page.evaluate(() => (window as any).registryFixture.snapshot())).frames.sort(), ["a~same", "b~same"])
  incompatible = true
  expectedAborts.add("b")
  const bAborted = aborted("b")
  const meta = page.waitForRequest(request => new URL(request.url()).pathname === "/api/backends/b/api/meta")
  await page.evaluate(() => (window as any).registryFixture.restart("b"))
  await meta
  assert.deepEqual(reads.sort(), ["a", "a", "a", "b", "b"], "no domain resync runs before fresh contract validation")
  await heldMetadata
  hold!(); hold = undefined
  await page.locator("[data-state-b]").filter({ hasText: "refused" }).waitFor()
  const state = await page.evaluate(() => (window as any).registryFixture.snapshot())
  assert.deepEqual(state.ids.sort(), ["a", "local"])
  assert.equal(state.opens.length, 2)
  expectedAborts.add("a")
  const aAborted = aborted("a")
  await page.evaluate(() => (window as any).registryFixture.dispose())
  await allStreamsClosed
  await Promise.all([bAborted, aAborted])
  assert.deepEqual(closed.sort(), ["a", "b"])
  assert.deepEqual(errors, [])
  assert.deepEqual(failed, [])
  assert.deepEqual(streamAborts.sort(), ["a", "b"])
})

test("failed inventory recovery composes with restore cancellation and user opening", { timeout: 120_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-inventory-lifecycle-"))
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-inventory-evidence-"))
  t.diagnostic(`Interaction captures: ${evidence}`)
  const a = await startFakeCodeNomad({ anonymous: true }), b = await startFakeCodeNomad({ anonymous: true })
  const streams = new Map<string, ServerResponse>()
  const requests: string[] = [], bodies: unknown[] = [], local: string[] = []
  const requestId = "restore-11111111-1111-4111-8111-111111111111"
  const descriptor = { id: "w", requestId, path: "/same", status: "starting", proxyPath: "/workspaces/w/instance", binaryId: "fixture", binaryLabel: "restore", createdAt: "", updatedAt: "" }
  let failedRead = false, holdRead = false, holdPost = true, listResponse: ServerResponse | undefined
  let releaseMode: "normal" | "hold" | "invalid" = "normal", releaseResponse: ServerResponse | undefined
  let releaseEntered!: () => void
  let postResponse: ServerResponse | undefined, cancelResponse: ServerResponse | undefined
  let listEntered!: () => void, postEntered!: () => void, cancelEntered!: () => void
  let listing = Promise.resolve(), posting = Promise.resolve(), cancelling = Promise.resolve()
  const json = (response: ServerResponse, value: unknown) => {
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value))
  }
  for (const [id, remote] of [["a", a], ["b", b]] as const) {
    for (const route of ["/api/storage/config/ui", "/api/storage/config/server", "/api/storage/state/ui"]) remote.state.handlers.set(route, (_request, response) => json(response, {}))
    remote.state.handlers.set("/api/meta", (_request, response) => json(response, { apiContract: CODENOMAD_API_CONTRACT, serverId: `server-${id}` }))
    remote.state.handlers.set("/api/events", (_request, response) => {
      streams.set(id, response)
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }); response.write(": connected\n\n")
    })
    remote.state.handlers.set("/api/workspaces", (request, response) => {
      requests.push(`${id}:${request.method} /api/workspaces`)
      if (request.method === "GET") {
        if (id === "a" && failedRead) {
          failedRead = false
          response.writeHead(200, { "content-type": "application/json" }); response.end("invalid-json")
        } else if (id === "a" && holdRead) { listResponse = response; listEntered() }
        else json(response, [])
        return
      }
      let body = ""
      request.on("data", chunk => { body += chunk })
      request.on("end", () => {
        const input = JSON.parse(body); bodies.push({ backend: id, ...input })
        if (id === "a" && input.requestId && holdPost) { postResponse = response; postEntered() }
        else json(response, { ...descriptor, requestId: input.requestId, binaryLabel: input.requestId ? "restore" : "user" })
      })
    })
    remote.state.handlers.set("/api/workspaces/creation/cancel", (request, response) => {
      requests.push(`${id}:POST /api/workspaces/creation/cancel`)
      let body = ""
      request.on("data", chunk => { body += chunk })
      request.on("end", () => { assert.deepEqual(JSON.parse(body), { requestId }); cancelResponse = response; cancelEntered() })
    })
    for (const route of ["/api/workspaces/w", "/api/workspaces/w/creation/release"]) remote.state.handlers.set(route, (request, response) => {
      requests.push(`${id}:${request.method} ${route}`)
      if (id === "a" && route.endsWith("/release") && releaseMode !== "normal") {
        if (releaseMode === "hold") releaseResponse = response
        else { response.writeHead(200, { "content-type": "application/json" }); response.end("invalid-json") }
        releaseEntered()
      } else json(response, {})
    })
  }
  const app = Fastify(), origins = new Set<string>()
  const profiles = [
    { id: "a", baseUrl: a.origin, skipTlsVerify: false }, { id: "b", baseUrl: b.origin, skipTlsVerify: false },
  ]
  const relayed: { method: string; path: string; proof: unknown }[] = []
  app.addHook("onRequest", async request => {
    relayed.push({ method: request.method, path: new URL(request.url, "http://fixture").pathname, proof: request.headers[RELAY_AUTHORITY_HEADER] })
  })
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(directory, "config.yaml") })
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => origins })
  app.get("/api/events", (_request, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream" }); reply.raw.write(": local\n\n")
  })
  app.all("/*", async request => { local.push(`${request.method} ${request.url}`); return request.url === "/api/workspaces" ? [] : {} })
  const target = await app.listen({ host: "127.0.0.1", port: 0 }); origins.add(target)
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
    logLevel: "error", resolve: { dedupe: ["solid-js"] }, plugins: [shutdown.plugin, solid(), { name: "inventory-lifecycle", configureServer(vite) {
      vite.middlewares.use("/fixture", async (_request, response) => {
        response.setHeader("content-type", "text/html")
        response.end(await vite.transformIndexHtml("/fixture", '<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-registry.tsx"></script></body></html>'))
      })
    } }], server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, proxy: { "/api": { target } } },
  }).catch(async error => { await cache.dispose(); throw error })
  shutdown.own(server); await server.listen()
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`; origins.add(origin)
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined }); armFixtureNavigationBudget(browser)
  t.after(async () => {
    listResponse?.end("[]"); postResponse?.end("{}"); cancelResponse?.end("{}"); releaseResponse?.end("{}")
    await browser.close(); manager.close(); await server.close(); app.server.closeAllConnections(); await app.close()
    await Promise.all([a.close(), b.close()]); fs.rmSync(directory, { recursive: true, force: true })
  })
  for (const order of ["cancel-before-observation", "user-before-ACK", "user-after-ACK"] as const) await t.test(order, async () => {
    const page = await browser.newPage(), errors: string[] = [], failures: string[] = [], aborts: string[] = []
    const expectedAborts = new Set<string>()
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    page.on("requestfailed", request => {
      const key = `${request.method()} ${new URL(request.url()).pathname}`
      if (request.failure()?.errorText === "net::ERR_ABORTED" && expectedAborts.delete(key)) aborts.push(key)
      else failures.push(`${key} ${request.failure()?.errorText}`)
    })
    try {
      requests.length = 0; bodies.length = 0; streams.clear()
      await page.goto(`${origin}/fixture`)
      await page.waitForFunction(() => !!(window as any).registryFixture)
      await page.evaluate(async () => { const f = (window as any).registryFixture; f.setEnabled(true); await Promise.all([f.ensure("a"), f.ensure("b")]) })
      await page.waitForFunction(() => (window as any).registryFixture.snapshot().settled.length === 4)
      assert.equal(streams.size, 2)
      failedRead = true
      assert.equal(await page.evaluate(() => (window as any).registryFixture.retry("a").then(() => false, () => true)), true)
      await page.locator("[data-state-a]").filter({ hasText: "unreachable" }).waitFor()
      holdRead = true; listing = new Promise(resolve => { listEntered = resolve })
      posting = new Promise(resolve => { postEntered = resolve }); cancelling = new Promise(resolve => { cancelEntered = resolve })
      const retry = page.evaluate(() => { const f = (window as any).registryFixture; return Promise.all([f.retry("a"), f.retry("a"), f.retry("a")]) })
      await listing
      await page.locator("[data-state-a]").filter({ hasText: "unreachable" }).waitFor()
      await page.getByRole("tab").filter({ hasText: "local" }).focus()
      await page.evaluate(() => {
        const w = window as any; w.restoreController = new AbortController()
        w.restoreResult = w.registryFixture.create("a", w.restoreController.signal).then((value: unknown) => ({ value }), () => ({ aborted: true }))
      })
      await posting
      const bResult = await page.evaluate(() => (window as any).registryFixture.open("b"))
      assert.equal(bResult.instanceId, "b~w")
      streams.get("b")!.write(`data: ${JSON.stringify({ type: "workspace.created", workspace: descriptor })}\n\n`)
      await page.waitForFunction(() => (window as any).registryFixture.snapshot().created.includes("b~w"))
      assert.deepEqual(bodies, [{ backend: "a", path: "/same", requestId }, { backend: "b", path: "/same", requestId }])
      expectedAborts.add("POST /api/backends/a/api/workspaces")
      await page.evaluate(() => (window as any).restoreController.abort())
      await cancelling
      if (order === "user-before-ACK") assert.equal((await page.evaluate(() => (window as any).registryFixture.create("a"))).instanceId, "a~w")
      json(cancelResponse!, {}); cancelResponse = undefined
      assert.deepEqual(await page.evaluate(() => (window as any).restoreResult), { aborted: true })
      if (order === "user-after-ACK") assert.equal((await page.evaluate(() => (window as any).registryFixture.create("a"))).instanceId, "a~w")
      streams.get("a")!.write(`data: ${JSON.stringify({ type: "workspace.created", workspace: descriptor })}\n\n`)
      await page.waitForFunction(() => (window as any).registryFixture.snapshot().created.includes("a~w"))
      await page.evaluate(async requestId => {
        const f = (window as any).registryFixture
        await f.release("b~w", requestId); f.closeTab("b~w"); await f.close("b~w")
      }, requestId)
      assert.equal(await page.evaluate(() => (window as any).registryFixture.tabs().includes("b~w")), false)
      json(listResponse!, [descriptor]); listResponse = undefined; holdRead = false
      await retry
      await page.locator("[data-state-a]").filter({ hasText: "compatible" }).waitFor()
      if (order === "cancel-before-observation") {
        assert.equal(await page.evaluate(() => (window as any).registryFixture.workspaces().includes("a~w")), false)
        assert.equal(await page.evaluate(() => (window as any).registryFixture.tabs().includes("a~w")), false)
        assert.equal(await page.locator('[role="tab"][title="/same"]').count(), 0)
      } else {
        assert.equal(await page.evaluate(() => (window as any).registryFixture.details("a~w").binaryLabel), "user")
        assert.equal(await page.locator('[role="tab"][title="/same"]').count(), 1)
      }
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("title")), "/local")
      json(postResponse!, descriptor); postResponse = undefined
      assert.equal((await page.evaluate(() => (window as any).registryFixture.create("b"))).instanceId, "b~w")
      assert.deepEqual(requests.filter(route => route.includes("GET")).sort(), ["a:GET /api/workspaces", "a:GET /api/workspaces", "a:GET /api/workspaces", "a:GET /api/workspaces", "b:GET /api/workspaces", "b:GET /api/workspaces"])
      assert.equal(requests.filter(route => route === "a:POST /api/workspaces/creation/cancel").length, 1)
      assert.deepEqual(requests.filter(route => route.includes("DELETE")), ["b:DELETE /api/workspaces/w"])
      assert.equal(local.some(route => /^(POST|DELETE) \/api\/workspaces/.test(route)), false)
      assert.equal([...a.state.requests, ...b.state.requests].some(request => /location.*(?:evict|delete)/i.test(request.path)), false)
      await page.screenshot({ path: path.join(evidence, `${order}.png`) })
      fs.writeFileSync(path.join(evidence, `${order}.json`), JSON.stringify({ requests, bodies, local, html: await page.locator("#root").innerHTML() }, null, 2))
      expectedAborts.add("GET /api/backends/a/api/events"); expectedAborts.add("GET /api/backends/b/api/events")
      await page.evaluate(() => (window as any).registryFixture.dispose())
      await page.close()
      assert.deepEqual(errors, []); assert.deepEqual(failures, [])
      assert.deepEqual([...expectedAborts], [])
      assert.deepEqual(aborts.sort(), ["GET /api/backends/a/api/events", "GET /api/backends/b/api/events", "POST /api/backends/a/api/workspaces"])
    } finally { await page.close() }
  })
  for (const change of ["retarget", "ABA", "off", "dispose"] as const) await t.test(`pending inventory ${change}`, async () => {
    const page = await browser.newPage(), errors: string[] = [], failures: string[] = [], aborts: string[] = []
    const expectedAborts = new Set<string>()
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    page.on("requestfailed", request => {
      const key = `${request.method()} ${new URL(request.url()).pathname}`
      if (request.failure()?.errorText === "net::ERR_ABORTED" && expectedAborts.delete(key)) aborts.push(key)
      else failures.push(`${key} ${request.failure()?.errorText}`)
    })
    try {
      requests.length = 0; bodies.length = 0; streams.clear()
      await page.goto(`${origin}/fixture`)
      await page.waitForFunction(() => !!(window as any).registryFixture)
      await page.evaluate(async () => { const f = (window as any).registryFixture; f.setEnabled(true); await Promise.all([f.ensure("a"), f.ensure("b")]); (window as any).oldClient = f.client("a") })
      await page.waitForFunction(() => (window as any).registryFixture.snapshot().settled.length === 4)
      assert.equal((await page.evaluate(() => (window as any).registryFixture.create("b"))).instanceId, "b~w")
      await page.getByRole("tab").filter({ hasText: "local" }).focus()
      holdRead = true; listing = new Promise(resolve => { listEntered = resolve })
      const retry = page.evaluate(() => (window as any).registryFixture.retry("a").then(() => false, () => true))
      await listing
      expectedAborts.add("GET /api/backends/a/api/workspaces")
      expectedAborts.add("GET /api/backends/a/api/events")
      if (change === "retarget" || change === "ABA") {
        await page.evaluate(() => (window as any).registryFixture.setTarget("a", true))
        profiles[0].skipTlsVerify = true; manager.reconcile()
        if (change === "ABA") {
          profiles[0].skipTlsVerify = false; manager.reconcile()
          await page.evaluate(() => (window as any).registryFixture.setTarget("a", false))
        }
      } else {
        expectedAborts.add("GET /api/backends/b/api/events")
        await page.evaluate(change => { const f = (window as any).registryFixture; if (change === "off") f.setEnabled(false); else f.dispose() }, change)
      }
      assert.equal(await retry, true)
      json(listResponse!, [{ ...descriptor, id: "obsolete" }]); listResponse = undefined; holdRead = false
      assert.equal(await page.evaluate(() => (window as any).registryFixture.workspaces().includes("a~obsolete")), false)
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("title")), "/local")
      assert.deepEqual(requests.filter(route => /:(POST|DELETE)/.test(route)), ["b:POST /api/workspaces"])
      assert.equal(local.some(route => /^(POST|DELETE) \/api\/workspaces/.test(route)), false)
      if (change !== "dispose") {
        if (change === "off") await page.evaluate(() => (window as any).registryFixture.setEnabled(true))
        await page.evaluate(async change => { const f = (window as any).registryFixture; await f.ensure("a"); if (change === "off") await f.ensure("b") }, change)
        assert.equal(await page.evaluate(() => (window as any).registryFixture.client("a") !== (window as any).oldClient), true)
        assert.equal((await page.evaluate(() => (window as any).registryFixture.create("a"))).instanceId, "a~w")
        assert.equal((await page.evaluate(() => (window as any).registryFixture.create("b"))).instanceId, "b~w")
        assert.equal(await page.evaluate(() => (window as any).registryFixture.workspaces().includes("a~obsolete")), false)
        await page.locator('[role="tab"][title="/same"]').first().waitFor()
        expectedAborts.add("GET /api/backends/a/api/events"); expectedAborts.add("GET /api/backends/b/api/events")
      }
      await page.screenshot({ path: path.join(evidence, `${change}.png`) })
      fs.writeFileSync(path.join(evidence, `${change}.json`), JSON.stringify({ requests, bodies, local, html: await page.locator("#root").innerHTML() }, null, 2))
      await page.evaluate(() => (window as any).registryFixture.dispose())
      await page.close()
      assert.deepEqual(errors, []); assert.deepEqual(failures, []); assert.deepEqual([...expectedAborts], [])
      assert.equal(aborts.filter(key => key === "GET /api/backends/a/api/workspaces").length, 1)
    } finally {
      await page.close()
      profiles[0].skipTlsVerify = false; manager.reconcile()
    }
  })
  for (const change of ["retarget", "ABA", "off", "dispose", "unknown", "revoked-proof"] as const) await t.test(`pending inventory and cleanup ${change}`, async () => {
    const page = await browser.newPage(), errors: string[] = [], failures: string[] = []
    const refused: number[] = [], refusedConsole: string[] = []
    const releasePath = "/api/backends/a/api/workspaces/w/creation/release"
    const expectedAborts = new Set<string>()
    page.on("pageerror", error => errors.push(error.message))
    page.on("response", response => {
      if (change === "revoked-proof" && new URL(response.url()).pathname === releasePath && response.request().method() === "POST" && response.status() === 502) refused.push(response.status())
    })
    page.on("console", message => {
      if (message.type() !== "error") return
      if (change === "revoked-proof" && new URL(message.location().url || "about:blank").pathname === releasePath
        && /^Failed to load resource: the server responded with a status of 502 \(Bad Gateway\)$/.test(message.text())) refusedConsole.push(message.text())
      else errors.push(message.text())
    })
    page.on("requestfailed", request => {
      const key = `${request.method()} ${new URL(request.url()).pathname}`
      if (request.failure()?.errorText !== "net::ERR_ABORTED" || !expectedAborts.delete(key)) failures.push(`${key} ${request.failure()?.errorText}`)
    })
    try {
      requests.length = 0; bodies.length = 0; relayed.length = 0; streams.clear(); holdPost = false
      await page.goto(`${origin}/fixture`)
      await page.waitForFunction(() => !!(window as any).registryFixture)
      await page.evaluate(async () => { const f = (window as any).registryFixture; f.setEnabled(true); await Promise.all([f.ensure("a"), f.ensure("b")]) })
      await page.waitForFunction(() => (window as any).registryFixture.snapshot().settled.length === 4)
      const oldTag = await page.evaluate(() => (window as any).registryFixture.clientTag("a"))
      assert.equal((await page.evaluate(() => (window as any).registryFixture.open("a"))).instanceId, "a~w")
      assert.equal((await page.evaluate(() => (window as any).registryFixture.create("b"))).instanceId, "b~w")
      holdRead = true; listing = new Promise(resolve => { listEntered = resolve })
      const retry = page.evaluate(() => (window as any).registryFixture.retry("a").then(() => false, () => true))
      await listing
      const releasing = new Promise<void>(resolve => { releaseEntered = resolve })
      releaseMode = change === "unknown" ? "invalid" : "hold"
      const release = page.evaluate(requestId => (window as any).registryFixture.release("a~w", requestId).then(() => "settled", () => "unknown"), requestId)
      await releasing
      if (change === "unknown") assert.equal(await release, "unknown")
      await page.getByRole("tab").filter({ hasText: "local" }).focus()
      expectedAborts.add("GET /api/backends/a/api/workspaces"); expectedAborts.add("GET /api/backends/a/api/events")
      if (change === "off" || change === "dispose") {
        expectedAborts.add("GET /api/backends/b/api/events")
        await page.evaluate(change => { const f = (window as any).registryFixture; if (change === "off") f.setEnabled(false); else f.dispose() }, change)
      } else {
        await page.evaluate(() => (window as any).registryFixture.setTarget("a", true))
        if (change === "ABA") await page.evaluate(() => (window as any).registryFixture.setTarget("a", false))
        if (change === "revoked-proof") { profiles[0].skipTlsVerify = true; manager.reconcile() }
      }
      assert.equal(await retry, true)
      json(listResponse!, [{ ...descriptor, id: "obsolete" }]); listResponse = undefined; holdRead = false
      if (change !== "dispose") {
        if (change === "off") await page.evaluate(() => (window as any).registryFixture.setEnabled(true))
        await page.evaluate(async change => { const f = (window as any).registryFixture; await f.ensure("a"); if (change === "off") await f.ensure("b") }, change)
        assert.notEqual(await page.evaluate(() => (window as any).registryFixture.clientTag("a")), oldTag)
        assert.equal((await page.evaluate(() => (window as any).registryFixture.create("a"))).instanceId, "a~w")
        assert.equal((await page.evaluate(() => (window as any).registryFixture.create("b"))).instanceId, "b~w")
      }
      const metadataBeforeSettlement = a.state.requests.filter(request => request.path === "/api/meta").length
      releaseMode = "normal"
      if (change === "unknown") await page.evaluate(requestId => (window as any).registryFixture.release("a~w", requestId), requestId)
      else if (change === "revoked-proof") {
        assert.equal(await release, "unknown")
        assert.equal(await page.evaluate(requestId => (window as any).registryFixture.release("a~w", requestId).then(() => "settled", () => "unknown"), requestId), "unknown")
        releaseResponse?.end("{}"); releaseResponse = undefined
      }
      else { json(releaseResponse!, {}); releaseResponse = undefined; assert.equal(await release, "settled") }
      const releaseCalls = await page.evaluate(() => (window as any).registryFixture.releases())
      assert.deepEqual(releaseCalls, Array.from({ length: change === "unknown" ? 5 : change === "revoked-proof" ? 8 : 1 }, () => ({ backend: "a", client: oldTag })))
      assert.equal(a.state.requests.filter(request => request.path === "/api/meta").length, metadataBeforeSettlement, "old cleanup never reacquires metadata/proof")
      assert.equal(requests.filter(route => route === "a:POST /api/workspaces/w/creation/release").length, change === "unknown" ? 5 : 1)
      if (change === "revoked-proof") {
        const attempts = relayed.filter(request => request.path === releasePath && request.method === "POST")
        assert.equal(attempts.length, 8)
        assert(attempts.every(request => request.proof === attempts[0].proof), "all refused retries retain the original proof")
        assert.notEqual(relayed.filter(request => request.path === "/api/backends/a/api/workspaces" && request.method === "POST").at(-1)!.proof, attempts[0].proof)
        assert.deepEqual(refused, Array(8).fill(502))
        assert.equal(refusedConsole.length, 8)
      }
      assert.equal(await page.evaluate(() => (window as any).registryFixture.workspaces().includes("a~obsolete")), false)
      if (change !== "dispose") assert.equal(await page.evaluate(() => (window as any).registryFixture.details("a~w").binaryLabel), "user")
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("title")), "/local")
      assert.equal(local.some(route => /^(POST|DELETE) \/api\/workspaces/.test(route)), false)
      assert.equal(requests.some(route => route.includes("DELETE")), false)
      assert.deepEqual(bodies.filter((body: any) => body.backend === "a" && body.requestId), [{ backend: "a", path: "/same", requestId }], "restore POST is never replayed")
      await page.screenshot({ path: path.join(evidence, `cleanup-${change}.png`) })
      fs.writeFileSync(path.join(evidence, `cleanup-${change}.json`), JSON.stringify({ requests, bodies, releaseCalls, refused, refusedConsole, oldTag, html: await page.locator("#root").innerHTML() }, null, 2))
      if (change !== "dispose") { expectedAborts.add("GET /api/backends/a/api/events"); expectedAborts.add("GET /api/backends/b/api/events") }
      await page.evaluate(() => (window as any).registryFixture.dispose()); await page.close()
      assert.deepEqual(errors, []); assert.deepEqual(failures, []); assert.deepEqual([...expectedAborts], [])
    } finally { await page.close(); holdPost = true; releaseMode = "normal"; profiles[0].skipTlsVerify = false; manager.reconcile() }
  })
})
