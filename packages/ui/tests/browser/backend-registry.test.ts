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

test("registry admits two real relayed backends and revalidates before reconnect resync", { timeout: 90_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-registry-"))
  const a = await startFakeCodeNomad(), b = await startFakeCodeNomad()
  const streams = new Map<string, ServerResponse>(), closed: string[] = [], reads: string[] = []
  let incompatible = false, hold: (() => void) | undefined
  let metadataHeld!: () => void, streamsClosed!: () => void
  const heldMetadata = new Promise<void>(resolve => { metadataHeld = resolve })
  const allStreamsClosed = new Promise<void>(resolve => { streamsClosed = resolve })
  for (const [id, remote] of [["a", a], ["b", b]] as const) {
    remote.state.handlers.set("/api/meta", (_request, response) => {
      const send = () => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({
        apiContract: incompatible && id === "b" ? -1 : CODENOMAD_API_CONTRACT, serverId: `server-${id}`,
      })) }
      if (incompatible && id === "b") { hold = send; metadataHeld() }
      else send()
    })
    remote.state.handlers.set("/api/workspaces", (_request, response) => {
      reads.push(id)
      response.writeHead(200, { "content-type": "application/json" }); response.end("[]")
    })
    remote.state.handlers.set("/api/events", (_request, response) => {
      streams.set(id, response)
      response.on("close", () => { closed.push(id); if (closed.length === 2) streamsClosed() })
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
      response.write(": connected\n\n")
    })
  }
  const app = Fastify(), origins = new Set<string>(), local: string[] = []
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
  const page = await browser.newPage(), errors: string[] = [], failed: string[] = [], streamAborts: string[] = []
  const expectedAborts = new Set<string>()
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  page.on("requestfailed", request => {
    const match = /^\/api\/backends\/([ab])\/api\/events$/.exec(new URL(request.url()).pathname)
    if (match && expectedAborts.delete(match[1]) && request.method() === "GET"
      && request.resourceType() === "eventsource" && request.failure()?.errorText === "net::ERR_ABORTED") streamAborts.push(match[1])
    else failed.push(request.url())
  })
  await page.goto(`${origin}/fixture`)
  await page.waitForFunction(() => (window as any).registryFixture)
  const tab = page.getByRole("tab"), before = await tab.evaluate(el => el.outerHTML)
  await page.evaluate(async () => {
    await (window as any).registryFixture.localRead()
    await Promise.all(["a", "b"].map(id => (window as any).registryFixture.ensure(id)))
    await (window as any).registryFixture.localRead()
  })
  assert.equal(a.state.requests.length + b.state.requests.length, 0)
  assert.deepEqual(local.filter(p => p === "GET /api/meta"), ["GET /api/meta", "GET /api/meta"])
  assert.equal(await tab.evaluate(el => el.outerHTML), before)
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
  await page.waitForFunction(() => (window as any).registryFixture.snapshot().opens.length === 2)
  assert.deepEqual(reads.sort(), ["a", "a", "b", "b"])
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
