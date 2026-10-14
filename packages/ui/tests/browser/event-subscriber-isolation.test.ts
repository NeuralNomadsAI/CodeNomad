import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { EventBus } from "../../../server/src/events/bus"
import { ClientConnectionManager } from "../../../server/src/clients/connection-manager"
import { registerEventRoutes } from "../../../server/src/server/routes/events"

let backend: FastifyInstance, server: ViteDevServer, browser: Browser, connections: ClientConnectionManager, url: string
const bus = new EventBus()
const clients = new Set<() => void>()
before(async () => {
  const logger = pino({ level: "silent" })
  // Send a body frame immediately so the Vite proxy forwards idle stream headers.
  bus.publish({ type: "instance.eventStatus", instanceId: "fixture", status: "connected", generation: 1 })
  connections = new ClientConnectionManager(logger)
  backend = Fastify()
  registerEventRoutes(backend, { eventBus: bus, logger, connectionManager: connections,
    registerClient: close => { clients.add(close); return () => { clients.delete(close) } },
  })
  backend.get("/api/auth/status", async () => ({ authenticated: true }))
  await backend.listen({ host: "127.0.0.1", port: 0 })
  const target = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "event-subscriber-isolation", configureServer(s) {
      s.middlewares.use("/fixture", async (_request, response) => {
        response.setHeader("Content-Type", "text/html")
        response.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/event-subscriber-isolation.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, proxy: { "/api": { target } } },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => {
  await browser?.close()
  connections?.shutdown()
  for (const close of clients) close()
  await server?.close()
  await backend?.close()
})

function emit(id: string) {
  bus.publish({ type: "instance.event", instanceId: "fixture", event: {
    id, created: Date.now(), type: "session.renamed", data: { sessionID: "session", title: id },
    durable: { aggregateID: "session", seq: 1, version: 1 }, location: { directory: "/fixture" },
  } })
}
async function setup(page: Page, mode: string) {
  const pageErrors: string[] = []
  page.on("pageerror", error => pageErrors.push(error.message))
  await page.goto(`${url}?mode=${mode}`)
  await page.locator("[data-events]").waitFor()
  await page.waitForFunction(() => (window as any).fixture.snapshot().statuses.includes("connected"))
  return pageErrors
}

test("a failing wildcard subscriber cannot discard a valid SSE event before native and typed subscribers", async () => {
  const page = await browser.newPage()
  try {
    const pageErrors = await setup(page, "event")
    emit("first")
    emit("second")
    await page.waitForFunction(() => (window as any).fixture.snapshot().faults === 2)
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.deepEqual(state.native, ["first", "second"], "real SSEManager must receive both events despite another subscriber's error")
    assert.deepEqual(state.typed, ["first", "second"])
    assert.equal(state.errors.length, 2, "each failed callback is diagnosed, without replaying the event")
    assert.doesNotMatch(JSON.stringify(state.errors), /Failed to parse event/)
    assert.deepEqual(pageErrors, [])
  } finally { await page.close() }
})

test("a deferred Solid derivation error is diagnosed as dispatch, not malformed SSE, without replay", async () => {
  const page = await browser.newPage()
  try {
    const pageErrors = await setup(page, "derived")
    emit("first")
    await page.waitForFunction(() => (window as any).fixture.snapshot().errors.length === 1)
    emit("second")
    await page.waitForFunction(() => (window as any).fixture.snapshot().native.length === 2)
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.deepEqual(state.native, ["first", "second"])
    assert.deepEqual(state.typed, ["first", "second"])
    assert.equal(state.errors[0][0], "Failed to dispatch event")
    assert.doesNotMatch(JSON.stringify(state.errors), /Failed to parse event/)
    assert.deepEqual(pageErrors, [])
  } finally { await page.close() }
})

test("a failing open subscriber cannot suppress later reconnect reconciliation subscribers", async () => {
  const page = await browser.newPage()
  try {
    const pageErrors = await setup(page, "open")
    await page.waitForFunction(() => (window as any).fixture.snapshot().faults === 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().opens), 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.restart()), null)
    await page.waitForFunction(() => (window as any).fixture.snapshot().faults === 2)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().opens), 2)
    assert.deepEqual(pageErrors, [])
  } finally { await page.close() }
})

test("a failing status subscriber cannot abort restart or prevent later transport-status notifications", async () => {
  const page = await browser.newPage()
  try {
    const pageErrors = await setup(page, "status")
    assert.equal(await page.evaluate(() => (window as any).fixture.restart()), null, "restart must still close and replace its connection")
    await page.waitForFunction(() => (window as any).fixture.snapshot().opens === 2)
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.ok(state.statuses.includes("disconnected"))
    emit("after-restart")
    await page.waitForFunction(() => (window as any).fixture.snapshot().native.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.snapshot().native), ["after-restart"])
    assert.deepEqual(pageErrors, [])
  } finally { await page.close() }
})

test("normal subscribers retain SSE FIFO and unsubscribe removes only its own listener", async () => {
  const page = await browser.newPage()
  try {
    const pageErrors = await setup(page, "normal")
    emit("first")
    await page.waitForFunction(() => (window as any).fixture.snapshot().typed.length === 1)
    await page.evaluate(() => (window as any).fixture.unsubscribe())
    emit("second")
    await page.waitForFunction(() => (window as any).fixture.snapshot().native.length === 2)
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.deepEqual(state.native, ["first", "second"])
    assert.deepEqual(state.typed, ["first"])
    assert.deepEqual(state.errors, [])
    assert.deepEqual(pageErrors, [])
  } finally { await page.close() }
})
