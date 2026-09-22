import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import Fastify, { type FastifyInstance } from "fastify"
import type { ServerResponse } from "node:http"
import { AuthManager } from "../../../server/src/auth/manager"
import { sendUnauthorized } from "../../../server/src/auth/http-auth"
import { registerAuthRoutes } from "../../../server/src/server/routes/auth"

let server: ViteDevServer, backend: FastifyInstance, browser: Browser, url: string
let auth: AuthManager, mutationAttempts = 0, loginCount = 0, offline = false
const streams = new Set<ServerResponse>()
const logger: any = { debug() {}, warn() {}, child() { return this } }
const newAuth = () => new AuthManager({ configPath: fileURLToPath(new URL("./unused-auth-fixture/config.json", import.meta.url)),
  username: "fixture", password: "fixture-only", generateToken: false }, logger)
function restart() {
  auth = newAuth()
  for (const stream of streams) stream.end()
  streams.clear()
}
before(async () => {
  auth = newAuth()
  backend = Fastify()
  // Real auth routes and in-memory session manager; swapping the manager models
  // a backend restart without touching a daemon, profile or database.
  registerAuthRoutes(backend, { authManager: new Proxy({} as AuthManager, { get: (_target, key) => {
    const value = (auth as any)[key]
    return typeof value === "function" ? value.bind(auth) : value
  } }) })
  backend.addHook("preHandler", async (request, reply) => {
    if (request.url === "/api/workspaces" && request.method === "POST") mutationAttempts++
    if (request.url === "/api/auth/login") loginCount++
    if (offline) return reply.code(503).send({ error: "Unavailable" })
    if (request.url.startsWith("/api/auth/")) return
    if (!auth.getSessionFromRequest(request)) return sendUnauthorized(request, reply)
  })
  backend.get("/api/events", (_request, reply) => {
    reply.hijack()
    const stream = reply.raw
    stream.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    stream.write(": connected\n\n")
    streams.add(stream)
    stream.on("close", () => streams.delete(stream))
  })
  backend.get("/api/workspaces", async () => [])
  backend.post("/api/workspaces", async () => ({ id: "fixture" }))
  backend.get("/workspaces/fixture/instance/api/session", async (_request, reply) => reply.code(401).send({ error: "Upstream credentials" }))
  backend.all("/api/*", async () => ({}))
  await backend.listen({ host: "127.0.0.1", port: 0 })
  const target = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "auth-fixture", configureServer(s) {
      s.middlewares.use("/auth-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/auth-fixture", '<html><body><div id="root" style="margin:24px"></div><script type="module" src="/tests/browser/fixtures/auth-recovery.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, proxy: { "/api": target, "/workspaces": target } },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => {
  await browser?.close()
  for (const stream of streams) stream.end()
  await server?.close()
  await backend?.close()
})
async function setup(width = 1100) {
  offline = false
  restart()
  const page = await browser.newPage({ locale: "en-US", viewport: { width, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.request.post(`${url}/api/auth/login`, { data: { username: "fixture", password: "fixture-only" } })
  await page.goto(`${url}/auth-fixture`)
  await page.waitForFunction(() => (window as any).fixture?.opens() > 0)
  return { page, errors }
}

test("server restart opens recovery via SSE; real login preserves the composer and resumes events", async () => {
  const { page, errors } = await setup()
  try {
    const composer = page.locator(".prompt-input-container textarea").first()
    await composer.fill("UNSENT_DRAFT")
    await page.evaluate(() => (window as any).fixture.attach())
    const opens = await page.evaluate(() => (window as any).fixture.opens())
    const previousUrl = page.url()
    restart()
    const dialog = page.getByRole("dialog", { name: "Sign in to CodeNomad again" })
    await dialog.waitFor()
    await dialog.getByLabel("Username", { exact: true }).fill("fixture")
    await dialog.getByLabel("Password", { exact: true }).fill("wrong")
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click()
    await dialog.getByRole("alert").waitFor()
    assert.equal(await dialog.getByLabel("Password", { exact: true }).inputValue(), "")
    await dialog.getByLabel("Password", { exact: true }).fill("fixture-only")
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction(n => (window as any).fixture.opens() > n, opens)
    assert.equal(page.url(), previousUrl)
    assert.equal(await composer.inputValue(), "UNSENT_DRAFT")
    assert.equal(await page.evaluate(() => (window as any).fixture.attachments()), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("an upstream 401 and an offline server do not ask for CodeNomad credentials", async () => {
  const { page } = await setup()
  try {
    const checked = page.waitForResponse(response => response.url().endsWith("/api/auth/status"))
    await page.evaluate(() => (window as any).fixture.upstream401())
    await checked
    assert.equal(await page.getByRole("dialog").count(), 0)
    offline = true
    const unavailable = page.waitForResponse(response => response.url().endsWith("/api/auth/status") && response.status() === 503)
    for (const stream of streams) stream.end()
    await unavailable
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { offline = false; await page.close() }
})

test("API expiry recovery works above an error dialog and accepts login renewed in another tab", async () => {
  const { page } = await setup(360)
  try {
    // Leave SSE untouched to exercise API failure as the recovery trigger.
    auth = newAuth()
    const beforeLogin = loginCount
    const beforeMutations = mutationAttempts
    await page.evaluate(() => (window as any).fixture.openProject())
    const dialog = page.getByRole("dialog", { name: "Sign in to CodeNomad again" })
    await dialog.waitFor()
    await dialog.getByLabel("Username", { exact: true }).fill("fixture")
    const box = await dialog.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= 360)
    await page.keyboard.press("Escape")
    assert.equal(await dialog.isVisible(), true)
    if (process.env.CODENOMAD_AUTH_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_AUTH_CAPTURE })
    await page.request.post(`${url}/api/auth/login`, { data: { username: "fixture", password: "fixture-only" } })
    await dialog.getByRole("button", { name: "Check connection" }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.equal(loginCount, beforeLogin + 1)
    assert.equal(mutationAttempts, beforeMutations + 1, "Recovery must not replay the failed project creation")
  } finally { await page.close() }
})
