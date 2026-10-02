import assert from "node:assert/strict"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import Fastify from "fastify"
import replyFrom from "@fastify/reply-from"
import { OpenCode } from "@opencode/client"
import pino from "pino"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { EventBus } from "../../../server/src/events/bus"
import { ClientConnectionManager } from "../../../server/src/clients/connection-manager"
import { createRuntimeFetch } from "../../../server/src/opencode/compatibility/transport"
import { registerInstanceProxyRoutes, type InstanceProxyWorkspaceManager } from "../../../server/src/server/http-server"
import { registerEventRoutes } from "../../../server/src/server/routes/events"
import { registerMetaRoutes } from "../../../server/src/server/routes/meta"
import { WorktreeDeletionFence } from "../../../server/src/workspaces/worktree-session-evacuation"

let browser: Browser, assets: ViteDevServer, assetUrl: string
before(async () => {
  assets = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error", plugins: [solid()], resolve: { dedupe: ["solid-js"] },
    server: { host: "127.0.0.1", port: 0, cors: true, hmr: false, watch: null },
  })
  await assets.listen()
  assetUrl = `http://127.0.0.1:${(assets.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await assets?.close() })

async function until(predicate: () => boolean, description: string) {
  // Only a deadlock safety bound, never a responsiveness/performance threshold.
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Did not observe ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function harness() {
  // Reuse the production proxy/admission/fetch/fence as in the server disconnect
  // diagnostic; use a real upstream SDK instead of copying its fake client tree.
  const held = Promise.withResolvers<void>()
  let released = false, nativeObservers = 0, nativeHttpA = 0, aborted = 0, heldHandlers = 0
  let forwardsA = 0, environmentWrites = 0, invalidations = 0, catalogueRequests = 0
  const nativeHttpCatalogues = new Set<ServerResponse>()
  const heldMutations = new Set<ServerResponse>()
  const captured: Array<{ request: IncomingMessage; response: ServerResponse; abortedListeners: number }> = []
  const clients = new Set<() => void>(), sockets = new Set<Socket>()
  const backendErrors: string[] = []
  const versions = new Set<string>(), bus = new EventBus(), fence = new WorktreeDeletionFence()
  const logger = pino({ level: "silent" }), connections = new ClientConnectionManager(logger)
  let peakSockets = 0
  const upstream = Fastify({ forceCloseConnections: true })
  upstream.get("/api/session/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id
    if (id === "A") {
      nativeHttpA++
      reply.raw.once("close", () => nativeHttpA--)
      heldHandlers++
      try { await held.promise } // intentionally ignore disconnect; exercise late completion
      finally { heldHandlers-- }
    }
    return { data: { id, location: { directory: "/fixture" } } }
  })
  upstream.get("/api/agent/:id", async (_request, reply) => {
    catalogueRequests++
    nativeHttpCatalogues.add(reply.raw)
    reply.raw.once("close", () => nativeHttpCatalogues.delete(reply.raw))
    heldHandlers++
    try { await held.promise }
    finally { heldHandlers-- }
    return []
  })
  upstream.get("/api/location", async () => ({ directory: "/fixture" }))
  upstream.post("/api/session/:id/:action", async () => { forwardsA++; return {} })
  upstream.put("/api/session/:id/environment", async (_request, reply) => { environmentWrites++; return reply.code(204).send() })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}` }
  const runtimeFetch = createRuntimeFetch(endpoint)
  const native = OpenCode.make({ baseUrl: endpoint.url, fetch: runtimeFetch })
  const client = { ...native, session: { ...native.session, get: async (...args: Parameters<typeof native.session.get>) => {
    if (args[0].sessionID !== "A") return native.session.get(...args)
    nativeObservers++
    const signal = args[1]?.signal, onAbort = () => { aborted++ }
    signal?.addEventListener("abort", onAbort, { once: true })
    try { return await native.session.get(...args) }
    finally { nativeObservers--; signal?.removeEventListener("abort", onAbort) }
  } } }
  const connection = { endpoint, client, fetch: runtimeFetch, assertCurrent() {},
    invalidate() { invalidations++ }, profile: async () => "modern" as const }
  // Only workspace ownership is supplied here. Reads cross real SDK HTTP; no
  // daemon discovery, database, provider, filesystem or shared profile is used.
  const manager = {
    get: () => ({ id: "workspace", path: "/fixture" }),
    getSharedServiceConnection: async () => connection,
    getInstanceAuthorizationHeader: () => undefined,
    getServiceDirectory: () => "/fixture",
    getServiceDirectoryForPath: async () => "/fixture",
    getWorktreeIdentityForPath: async () => "/fixture",
    getSessionEnvironment: async () => ({}),
    ownsDirectory: async (_id: string, directory: string) => directory === "/fixture",
    ownsLocation: async (_id: string, location: { directory: string }, _client: unknown, signal?: AbortSignal) =>
      location.directory === "/fixture" && (await native.location.get({ location }, { signal })).directory === "/fixture",
  } as unknown as InstanceProxyWorkspaceManager
  const backend = Fastify({ forceCloseConnections: true })
  backend.addHook("onError", async (_request, _reply, error) => { backendErrors.push(error.stack ?? error.message) })
  backend.server.on("connection", socket => {
    sockets.add(socket); peakSockets = Math.max(peakSockets, sockets.size)
    socket.once("close", () => sockets.delete(socket))
  })
  backend.addHook("onRequest", async (request, reply) => {
    versions.add(request.raw.httpVersion)
    if (request.method === "POST" && /\/session\/A\/(prompt|compact)$/.test(request.url)) {
      captured.push({ request: request.raw, response: reply.raw, abortedListeners: request.raw.listenerCount("aborted") })
      heldMutations.add(reply.raw)
      reply.raw.once("close", () => { setImmediate(() => heldMutations.delete(reply.raw)) })
    }
  })
  await backend.register(replyFrom)
  registerInstanceProxyRoutes(backend, { workspaceManager: manager, logger, worktreeDeletionFence: fence })
  registerEventRoutes(backend, { eventBus: bus, logger, connectionManager: connections,
    registerClient: close => { clients.add(close); return () => { clients.delete(close) } },
  })
  backend.get("/api/auth/status", async () => ({ authenticated: true }))
  backend.get("/api/witness", async () => ({ witness: true }))
  // Business HTTP/SSE goes directly to Fastify, not through Vite's Node proxy.
  // Vite serves modules on a separate origin and cannot consume this HTTP budget.
  backend.get("/fixture", async (_request, reply) => reply.type("text/html").send(
    `<html><body><div id="root"></div><script type="module" src="${assetUrl}/tests/browser/fixtures/http-admission-responsiveness.tsx"></script></body></html>`,
  ))
  const meta = { localUrl: "", eventsUrl: "/api/events", host: "127.0.0.1", listeningMode: "local" as const,
    localPort: 0, hostLabel: "private fixture", workspaceRoot: "/fixture", addresses: [] }
  registerMetaRoutes(backend, { serverMeta: meta })
  await backend.listen({ host: "127.0.0.1", port: 0 })
  meta.localPort = (backend.server.address() as { port: number }).port
  const url = meta.localUrl = `http://127.0.0.1:${meta.localPort}`
  return {
    url, captured, fence,
    emit() { bus.publish({ type: "instance.eventStatus", instanceId: "workspace", status: "connected", generation: 1 }) },
    release() { released = true; held.resolve() },
    snapshot() { return { released, nativeObservers, nativeHttpA, aborted, heldHandlers, forwardsA, environmentWrites, invalidations,
      catalogueRequests, nativeHttpCatalogues: nativeHttpCatalogues.size, heldMutations: heldMutations.size,
      sse: clients.size, sockets: sockets.size, peakSockets, versions: [...versions], backendErrors } },
    async dispose() {
      held.resolve(); connections.shutdown(); for (const close of clients) close()
      await backend.close(); await upstream.close()
    },
  }
}

async function setup(page: Page, h: Awaited<ReturnType<typeof harness>>) {
  const errors: string[] = [], protocols = new Map<string, string>()
  page.on("pageerror", error => errors.push(error.message))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Network.enable")
  cdp.on("Network.responseReceived", ({ response }) => {
    if (response.url.startsWith(h.url)) protocols.set(new URL(response.url).pathname, response.protocol)
  })
  await page.goto(`${h.url}/fixture`)
  await page.getByRole("button", { name: "Switch to B" }).waitFor()
  await page.waitForFunction(() => (window as any).fixture.snapshot().opens === 1)
  await until(() => h.snapshot().sse === 1, "one real SSE subscription")
  const previousEvents = await page.evaluate(() => (window as any).fixture.snapshot().events)
  h.emit()
  await page.waitForFunction(previous => (window as any).fixture.snapshot().events > previous, previousEvents)
  return { errors, protocols }
}

for (const scenario of [
  { action: "prompt", close: "page", background: false },
  { action: "compact", close: "page", background: false },
  { action: "prompt", close: "context", background: false },
  { action: "compact", close: "context", background: false },
  { action: "compact", close: "context", background: true },
] as const) {
  test(`HTTP/1 SSE + held ${scenario.action}: ${scenario.close} reconnect${scenario.background ? " with separate backgroundReads(2) occupancy" : ""}`,
    { timeout: 60_000 }, async t => {
      const h = await harness(), context = await browser.newContext()
      let reconnectContext = context
      try {
        const page = await context.newPage(), diagnostics = await setup(page, h)
        await page.evaluate(action => (window as any).fixture.start(action), scenario.action)
        await until(() => h.snapshot().nativeHttpA === 1, "actual SDK session A HTTP preflight")
        if (scenario.background) {
          await page.evaluate(() => (window as any).fixture.catalogues())
          await until(() => h.snapshot().catalogueRequests === 2, "two admitted background catalogue reads")
        }
        const started = performance.now()
        await page.getByRole("textbox", { name: "Draft" }).fill("draft while A is held")
        await page.getByRole("button", { name: "Switch to B" }).click()
        await page.waitForFunction(() => (window as any).fixture.snapshot().loaded === "B" || (window as any).fixture.snapshot().errors.length > 0)
        assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).loaded, "B", JSON.stringify({ backend: h.snapshot(), browser: await page.evaluate(() => (window as any).fixture.snapshot()) }))
        const info = await page.evaluate(() => (window as any).fixture.info())
        const witness = await page.evaluate(() => (window as any).fixture.witness())
        assert.deepEqual(info.system, { platform: process.platform, arch: process.arch })
        assert.deepEqual(witness, { witness: true })
        const state = await page.evaluate(() => (window as any).fixture.snapshot())
        assert.equal(state.draft, "draft while A is held")
        assert.equal(state.selected, "B")
        assert.equal(state.pending, true)
        assert.deepEqual(state.errors, [])
        const during = h.snapshot()
        assert.equal(during.released, false)
        assert.equal(during.nativeObservers, 1)
        assert.equal(during.sse, 1)
        assert.equal(during.forwardsA, 0)
        assert.equal(during.heldHandlers, scenario.background ? 3 : 1)
        assert.deepEqual(during.backendErrors, [])
        if (scenario.background) {
          assert.equal(during.catalogueRequests, 2, "three catalogue intents must remain queued, not occupy HTTP sockets")
          assert.equal(during.nativeHttpCatalogues, 2)
          assert.equal(state.catalogueSettled, 0)
        }
        for (const path of ["/api/events", "/api/witness", "/api/meta", "/workspaces/workspace/instance/api/session/B"]) {
          assert.equal(diagnostics.protocols.get(path), "http/1.1", `${path} must use real Chromium HTTP/1.1`)
        }
        t.diagnostic(`browser=${browser.version()} platform=${process.platform}; held-progress=${Math.round(performance.now() - started)} ms; during=${JSON.stringify(during)}`)
        assert.deepEqual(diagnostics.errors, [])

        const closing = performance.now()
        if (scenario.close === "page") await page.close()
        else { await context.close(); reconnectContext = await browser.newContext() }
        await until(() => {
          const state = h.snapshot()
          return state.sse === 0 && state.heldMutations === 0 && state.nativeHttpA === 0
            && state.nativeObservers === 0 && state.nativeHttpCatalogues === 0
        }, "downstream/SSE/upstream observers retired before releasing the held handler")
        assert.equal(h.snapshot().aborted, 1)
        for (const entry of h.captured) {
          assert.equal(entry.request.listenerCount("aborted"), entry.abortedListeners)
          assert.equal(entry.response.listeners("close").some(listener => ["close", "disconnect"].includes(listener.name)), false)
        }
        await h.fence.run("/fixture", ["/fixture"], async () => {})
        assert.equal(h.snapshot().heldHandlers, scenario.background ? 3 : 1, "upstream handlers stay deliberately held after HTTP observers leave")
        t.diagnostic(`close-cleanup=${Math.round(performance.now() - closing)} ms; before-release=${JSON.stringify(h.snapshot())}; deletion fence drained`)

        const next = await reconnectContext.newPage(), reconnected = await setup(next, h)
        await next.getByRole("button", { name: "Switch to B" }).click()
        await next.waitForFunction(() => (window as any).fixture.snapshot().loaded === "B")
        assert.deepEqual(await next.evaluate(() => (window as any).fixture.witness()), { witness: true })
        assert.equal(h.snapshot().released, false, "new page must progress before the old upstream handler is released")
        assert.equal(h.snapshot().sse, 1)
        const beforeRelease = h.snapshot()
        h.release()
        await until(() => h.snapshot().heldHandlers === 0, "all deliberately held upstream continuations finished")
        await new Promise<void>(resolve => setImmediate(resolve))
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(h.snapshot().forwardsA, 0, "late preflight completion must not forward/replay the abandoned mutation")
        assert.equal(h.snapshot().environmentWrites, 0)
        assert.equal(h.snapshot().invalidations, 0)
        assert.equal(h.snapshot().catalogueRequests, beforeRelease.catalogueRequests, "destroyed page cannot restart queued catalogue intents")
        assert.deepEqual(h.snapshot().versions, ["1.1"])
        assert.deepEqual(h.snapshot().backendErrors, [])
        assert.deepEqual(reconnected.errors, [])
        t.diagnostic(`reconnected-before-release=${JSON.stringify(beforeRelease)}; no late mutation/environment/invalidation`)
      } finally { await reconnectContext.close(); await context.close(); await h.dispose() }
    })
}
