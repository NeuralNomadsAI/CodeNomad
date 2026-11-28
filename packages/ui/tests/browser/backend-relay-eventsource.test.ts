import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { IncomingHttpHeaders, ServerResponse } from "node:http"
import test from "node:test"
import Fastify from "fastify"
import { chromium } from "playwright"
import { RemoteServerBrowseManager } from "../../../server/src/codenomad-servers/browse-manager"
import { startFakeCodeNomad } from "../../../server/src/codenomad-servers/test-support/fake-codenomad"
import { registerBackendRelayRoutes } from "../../../server/src/server/routes/backend-relay"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

test("real same-origin EventSource without Origin passes the local relay guard and streams remote frames", { timeout: 30_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-relay-browser-"))
  const remote = await startFakeCodeNomad()
  const manager = new RemoteServerBrowseManager({
    getOwner: () => ({ remoteServers: [{ id: "saved", baseUrl: remote.origin, skipTlsVerify: false }] }),
    configYamlPathForAuthority: () => path.join(directory, "config.yaml"),
  })
  const app = Fastify()
  let origin = ""
  let streamHeaders: IncomingHttpHeaders | undefined
  let upstream: ServerResponse | undefined
  app.addHook("onRequest", async request => {
    if (request.url === "/api/backends/saved/api/events") streamHeaders = request.headers
  })
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => new Set([origin]) })
  app.get("/", async (_request, reply) => reply.type("text/html").send("<!doctype html><title>Relay fixture</title>"))
  remote.state.handlers.set("/api/events", (_request, response) => {
    upstream = response
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
    response.write("data: first\n\n")
  })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  t.after(async () => {
    await browser.close()
    manager.close()
    app.server.closeAllConnections()
    await app.close()
    await remote.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  origin = await app.listen({ host: "127.0.0.1", port: 0 })
  const page = await browser.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", error => pageErrors.push(error.message))
  await page.goto(origin)
  const login = await page.evaluate(async () => {
    const response = await fetch("/api/backends/saved/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "codenomad", password: "remote-password" }),
    })
    return response.status
  })
  assert.equal(login, 200)
  await page.evaluate(() => {
    const state = window as any
    state.relayFrames = []
    state.source = new EventSource("/api/backends/saved/api/events")
    state.source.onmessage = (event: MessageEvent) => state.relayFrames.push(event.data)
  })
  await page.waitForFunction(() => (window as any).relayFrames.length === 1)
  assert.ok(streamHeaders)
  assert.equal(streamHeaders.origin, undefined, "Chromium sends no Origin on a same-origin EventSource")
  assert.equal(streamHeaders["sec-fetch-site"], "same-origin")
  assert.equal(new URL(streamHeaders.referer!).origin, origin)
  assert.equal(upstream!.writableEnded, false, "the first frame arrives before upstream completion")
  upstream!.write("data: second\n\n")
  await page.waitForFunction(() => (window as any).relayFrames.length === 2)
  assert.deepEqual(await page.evaluate(() => (window as any).relayFrames), ["first", "second"])
  const forwarded = remote.state.requests.find(request => request.path === "/api/events")!
  assert.match(forwarded.headers.cookie!, /^codenomad_session=/)
  for (const header of ["origin", "referer", "sec-fetch-site"]) assert.equal(forwarded.headers[header], undefined)
  await page.evaluate(() => (window as any).source.close())
  const before = remote.state.requests.length
  assert.equal((await page.request.get(`${origin}/api/backends/saved/api/events`)).status(), 403,
    "an originless non-browser request has no same-origin provenance")
  assert.equal(remote.state.requests.length, before)
  assert.deepEqual(pageErrors, [])
})
