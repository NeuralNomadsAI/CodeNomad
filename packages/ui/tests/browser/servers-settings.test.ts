import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { once } from "node:events"
import { test, type TestContext } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { SettingsService } from "../../../server/src/settings/service"
import { resolveConfigLocation } from "../../../server/src/config/location"
import { registerSettingsRoutes } from "../../../server/src/server/routes/settings"
import { registerRemoteServerRoutes } from "../../../server/src/server/routes/remote-servers"
import { registerRemoteServerBrowseRoutes } from "../../../server/src/server/routes/remote-server-browse"
import { registerBackendRelayRoutes } from "../../../server/src/server/routes/backend-relay"
import { RemoteServerBrowseManager } from "../../../server/src/codenomad-servers/browse-manager"
import { startFakeCodeNomad } from "../../../server/src/codenomad-servers/test-support/fake-codenomad"
import type { RemoteServerProfile } from "../../../server/src/api-types"

const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function fixture(t: TestContext, flag: unknown = true, locale = "en", intent = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-servers-ui-")), logger = pino({ level: "silent" })
  const a = await startFakeCodeNomad(), b = await startFakeCodeNomad()
  const settings = new SettingsService(resolveConfigLocation(directory), undefined, logger)
  settings.mergePatchDoc("config", { ui: { settings: { ...(flag === "absent" ? {} : { multiBackend: flag }), locale } } })
  const stamp = new Date().toISOString()
  const rows: RemoteServerProfile[] = [a, b].map((remote, i) => ({ id: i ? "b" : "a", name: i ? "Beta" : "Alpha", baseUrl: remote.origin, skipTlsVerify: false, createdAt: stamp, updatedAt: stamp }))
  settings.mergePatchDoc("state", { ui: { remoteServers: rows } })
  const manager = new RemoteServerBrowseManager(settings), app = Fastify()
  let origin = "", selfOrigin = "", holdProbe: ReturnType<typeof deferred> | undefined, holdPatch: ReturnType<typeof deferred> | undefined
  let patchStatus = 200, probeFailure: string | undefined
  const gates = new Set<ReturnType<typeof deferred>>()
  const calls: Array<{ method: string; url: string; body: any }> = []
  app.addHook("preHandler", async (request, reply) => {
    calls.push({ method: request.method, url: request.url, body: request.body })
    if (request.url === "/api/remote-servers/probe") {
      const hold = holdProbe; holdProbe = undefined; await hold?.promise
      if (probeFailure) return reply.send({ ok: false, normalizedUrl: (request.body as any).baseUrl, errorCode: probeFailure, error: "raw-secret-do-not-display" })
    }
    if (request.method === "PATCH" && request.url === "/api/storage/state/ui") {
      const hold = holdPatch; holdPatch = undefined; await hold?.promise
      if (patchStatus !== 200) return reply.code(patchStatus).send({ error: "refused" })
    }
  })
  registerSettingsRoutes(app, { settings, logger })
  registerRemoteServerRoutes(app, { logger })
  registerRemoteServerBrowseRoutes(app, { manager, getSelfOrigins: () => new Set([origin, selfOrigin]) })
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => new Set([origin, selfOrigin]) })
  app.addHook("onResponse", async request => { if (request.method === "PATCH" && request.url === "/api/storage/state/ui") manager.reconcile() })
  app.get("/api/meta", async () => ({}))
  app.get("/api/speech/capabilities", async () => ({}))
  app.get("/api/auth/status", async () => ({ authenticated: true }))
  app.get("/api/remote-control/status", async () => ({ enabled: false, manageable: false, state: "stopped" }))
  app.get("/api/opencode/update", async () => ({ status: "idle" }))
  app.get("/api/events", (_request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    reply.raw.write(": host fixture\n\n")
  })
  origin = await app.listen({ host: "127.0.0.1", port: 0 })
  const borrowed = await borrowFixture({ name: "servers-settings", routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/servers-settings.tsx"></script></body></html>' }] })
  selfOrigin = new URL(borrowed.url).origin
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  t.after(async () => { for (const gate of gates) gate.release(); await browser.close(); manager.close(); app.server.closeAllConnections(); await app.close(); await Promise.all([a.close(), b.close()]); await borrowed.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  const errors: string[] = [], consoleErrors: string[] = [], forbidden: string[] = [], httpErrors: string[] = [], failedRequests: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()) })
  page.on("response", response => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  page.on("requestfailed", request => { if (!request.url().includes("/api/remote-servers/probe") || request.failure()?.errorText !== "net::ERR_ABORTED") failedRequests.push(`${request.failure()?.errorText} ${new URL(request.url()).pathname}`) })
  await page.addInitScript({ content: `{
    Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "preferences", electronAPI: {
      getPreferencesRequest: async () => ({ section: "servers" }), acceptPreferencesRequest: async () => {}, preferencesReady: async () => {},
      onPreferencesSection: () => () => {}, onPreferencesCloseRequested: () => () => {}, onPreferencesTransitionRequested: () => () => {}, closeWindow: async () => {},
      openRemoteWindow: () => { throw new Error("forbidden remote window") },
    } })
  }` })
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url())
    // Preferences already owns one local stream; only remote/new implicit streams are forbidden.
    if (url.pathname === "/api/events") return route.continue({ url: `${origin}${url.pathname}${url.search}` })
    if (url.origin !== selfOrigin || /\/workspaces|\/events|\/remote-proxy|view-session/.test(url.pathname)) { forbidden.push(request.url()); return route.abort() }
    const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: { ...request.headers(), origin: selfOrigin } })
    await route.fulfill({ response })
  })
  await page.goto(borrowed.url + "?preferences=servers" + (intent ? "&intent" : ""))
  await page.waitForFunction(() => (window as any).serversFixture?.config.isLoaded())
  const check = () => { assert.deepEqual(errors, []); assert.deepEqual(forbidden, []); assert.deepEqual(failedRequests, []); assert(consoleErrors.every(message => /Failed to load resource: the server responded with a status of (400|409|502)/.test(message)), httpErrors.join("\n") + "\n" + consoleErrors.join("\n")) }
  const profileRows = () => settings.getOwner("state", "ui").remoteServers as RemoteServerProfile[]
  return { page, app, origin, manager, a, b, settings, rows, calls, directory, check, profileRows,
    holdProbe: () => { holdProbe = deferred(); gates.add(holdProbe); return holdProbe }, holdPatch: () => { holdPatch = deferred(); gates.add(holdPatch); return holdPatch },
    failPatch: (status: number) => { patchStatus = status }, failProbe: (code?: string) => { probeFailure = code },
    sync: async () => page.evaluate(value => (window as any).serversFixture.dispatch([{ type: "storage.stateChanged", owner: "ui", value }]), settings.getOwner("state", "ui")),
  }
}
const field = (page: Page) => page.locator("[data-server-add-field]")
const edit = (page: Page, name: string) => page.getByRole("button", { name: `Edit server: ${name}`, exact: true }).click()

test("Preferences CRUD uses host profiles; rename offline, normalized duplicate, no implicit open, observable removal failure", { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f
  await page.locator('[data-remote-server="a"]').waitFor()
  assert.equal(await page.getByRole("button", { name: "Open: Alpha", exact: true }).isDisabled(), true)
  const probes = () => f.calls.filter(call => call.url.endsWith("/probe")).length
  const aCalls = f.a.state.requests.length
  await edit(page, "Alpha")
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Offline rename")
  await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter")
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  assert.equal(probes(), 0); assert.equal(f.a.state.requests.length, aCalls)
  assert.equal(f.profileRows().find(row => row.id === "a")?.name, "Offline rename")
  await field(page).fill(f.b.origin + "/")
  await field(page).press("Enter")
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-server-add-field]")?.value === "" && !document.querySelector<HTMLInputElement>("[data-server-add-field]")?.disabled)
  assert.equal(f.profileRows().length, 2)
  await page.getByRole("button", { name: "Remove saved server: Offline rename", exact: true }).click()
  assert.match(await page.locator(":focus").innerText(), /Cancel/)
  await page.keyboard.press("Enter")
  await page.locator(".alert-dialog").waitFor({ state: "hidden" })
  assert.equal(f.calls.filter(call => call.url.endsWith("/forget")).length, 0)
  // Real credentials are retained on B while removing A through the actual local routes.
  assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-servers/b/connect", headers: { origin: f.origin }, payload: { username: "codenomad", password: "remote-password" } })).statusCode, 200)
  f.failPatch(400)
  await page.getByRole("button", { name: "Remove saved server: Offline rename", exact: true }).click()
  await page.getByRole("button", { name: "Remove saved server", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: "Could not save the preference." }).waitFor()
  assert.equal(f.profileRows().length, 2)
  assert.equal(f.calls.filter(call => call.url.endsWith("/forget")).length, 1)
  f.failPatch(200)
  await page.getByRole("button", { name: "Remove saved server: Offline rename", exact: true }).click()
  await page.getByRole("button", { name: "Remove saved server", exact: true }).click()
  await page.locator('[data-remote-server="a"]').waitFor({ state: "hidden" })
  assert.deepEqual(f.profileRows().map(row => row.id), ["b"])
  assert.equal((await f.app.inject({ method: "POST", url: "/api/remote-servers/b/browse", headers: { origin: f.origin }, payload: {} })).statusCode, 200)
  f.check()
})

test("raw userinfo rejected at the hook boundary; pairing purged before probe and never persisted; TLS consent belongs to one target", { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f
  await field(page).waitFor()
  const before = f.calls.length
  const result = await page.evaluate(async () => {
    try { await (window as any).serversFixture.profiles.submitServer({ name: "", baseUrl: "https://user:secret@example.test/remote-pair#code", skipTlsVerify: false }); return "accepted" }
    catch (error) { return (error as Error).message }
  })
  assert.equal(result, "credentials")
  assert.equal(f.calls.length, before)
  const held = f.holdProbe()
  f.failProbe("pairing_expired")
  await field(page).fill("https://example.test/remote-pair#single-use-secret")
  await field(page).press("Enter")
  assert.equal(await field(page).inputValue(), "")
  assert.equal(await field(page).isDisabled(), true)
  held.release()
  await page.getByRole("alert").filter({ hasText: "Pairing link invalid or expired." }).waitFor()
  assert(!JSON.stringify(f.settings.getDoc("state")).includes("single-use-secret"))
  assert(!(await page.locator("body").innerText()).includes("raw-secret"))
  f.failProbe("tls_error")
  await field(page).fill("https://a.test")
  await field(page).press("Enter")
  await page.getByRole("checkbox", { name: "Skip TLS verification", exact: true }).waitFor()
  await page.getByRole("checkbox", { name: "Skip TLS verification", exact: true }).check()
  await field(page).fill("https://b.test")
  assert.equal(await page.getByRole("checkbox", { name: "Skip TLS verification", exact: true }).count(), 0)
  await field(page).press("Enter")
  await page.getByRole("checkbox", { name: "Skip TLS verification", exact: true }).waitFor()
  assert.equal(await page.getByRole("checkbox", { name: "Skip TLS verification", exact: true }).isChecked(), false)
  const last = f.calls.filter(call => call.url.endsWith("/probe")).at(-1)!
  assert.equal(last.body.skipTlsVerify, false)
  await page.getByRole("alert").locator('[tabindex="0"]').focus()
  assert(!(await page.locator("body").innerText()).includes("raw-secret"))
  f.check()
})

for (const refused of [false, true]) test(`save A → Escape → edit B ignores late ${refused ? "error" : "success"} and preserves durable dispatched writes`, { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f
  await edit(page, "Alpha")
  const held = f.holdPatch()
  if (refused) f.failPatch(400)
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Late A")
  await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter")
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[role="dialog"] .window-footer button:last-child')?.disabled)
  await page.keyboard.press("Escape")
  await edit(page, "Beta")
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("B draft")
  const heldB = f.holdProbe()
  f.failProbe("tls_error")
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(f.origin)
  await page.getByRole("textbox", { name: "URL", exact: true }).press("Enter")
  const save = page.getByRole("dialog").getByRole("button", { name: "Save", exact: true })
  assert.equal(await save.isDisabled(), true)
  const settledA = page.waitForResponse(response => response.url().endsWith("/api/storage/state/ui") && response.request().method() === "PATCH")
  held.release()
  await settledA
  assert.equal(await page.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "B draft")
  assert.equal(await page.getByRole("textbox", { name: "URL", exact: true }).evaluate(element => element === document.activeElement), true)
  assert.equal(await save.isDisabled(), true, "A's finally cannot release B's busy state")
  assert.equal(await page.getByRole("dialog").getByRole("alert").count(), 0)
  assert.equal(f.profileRows().find(row => row.id === "a")?.name, refused ? "Alpha" : "Late A")
  heldB.release()
  await page.getByRole("dialog").getByRole("alert").filter({ hasText: "Certificate check failed." }).waitFor()
  assert.equal(await save.isDisabled(), false)
  await page.keyboard.press("Escape")
  f.check()
})

for (const flag of ["absent", false, "true", 1]) test(`strict off (${String(flag)}) forged Servers section falls back without mounting new IO`, { timeout: 90_000 }, async t => {
  const f = await fixture(t, flag), { page } = f
  assert.equal(await field(page).count(), 0)
  assert.equal(await page.getByRole("button", { name: "Servers", exact: true }).count(), 0)
  await page.getByRole("heading", { name: "General", exact: true }).waitFor()
  const result = await page.evaluate(async () => {
    try { await (window as any).serversFixture.profiles.submitServer({ name: "A", baseUrl: "http://example.test", skipTlsVerify: false }); return "accepted" }
    catch (error) { return (error as Error).name }
  })
  assert.equal(result, "AbortError")
  assert.equal(f.calls.filter(call => /\/remote-servers\//.test(call.url)).length, 0)
  await page.getByRole("button", { name: "Remote Access", exact: true }).click()
  await page.getByRole("button", { name: "Connect CodeNomad Server", exact: true }).click()
  await page.getByRole("textbox", { name: "Server name", exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "Connect", exact: true }).count(), 1)
  await page.keyboard.press("Escape")
  f.check()
})

test("turning the strict flag off during a probe fences persistence and all later connect/forget actions", { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f
  const held = f.holdProbe()
  await field(page).fill(f.a.origin)
  // A same-policy duplicate requires no probe; a new policy does.
  f.failProbe("tls_error")
  await field(page).fill("https://pending.test")
  await field(page).press("Enter")
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-server-add-field]")?.disabled)
  await page.evaluate(async () => { await (window as any).serversFixture.config.updatePreferences({ multiBackend: false }) })
  await field(page).waitFor({ state: "hidden" })
  held.release()
  const result = await page.evaluate(async () => {
    try { await (window as any).serversFixture.profiles.removeServer((window as any).serversFixture.config.remoteServers()[0]); return "accepted" }
    catch (error) { return (error as Error).name }
  })
  assert.equal(result, "AbortError")
  assert.equal(f.calls.filter(call => call.method === "PATCH" && call.url === "/api/storage/state/ui").length, 0)
  assert.equal(f.calls.filter(call => /\/(connect|forget)$/.test(call.url)).length, 0)
  assert.equal(f.profileRows().length, 2)
  f.check()
})

test("retarget/removal during probe and stale removal confirmation cannot mutate the replacement profile", { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f
  await edit(page, "Alpha")
  const held = f.holdProbe()
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(f.b.origin)
  await page.getByRole("textbox", { name: "URL", exact: true }).press("Enter")
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[role="dialog"] .window-footer button:last-child')?.disabled)
  const replacement = { ...f.rows[0], baseUrl: "http://127.0.0.1:2" }
  f.settings.mergePatchDoc("state", { ui: { remoteServers: [replacement, f.rows[1]] } })
  f.manager.reconcile(); await f.sync()
  const settled = page.waitForResponse(response => response.url().endsWith("/api/remote-servers/probe"))
  held.release()
  await settled
  await page.keyboard.press("Escape")
  assert.equal(f.profileRows()[0].baseUrl, replacement.baseUrl)
  assert.equal(f.calls.filter(call => call.method === "PATCH" && call.url === "/api/storage/state/ui").length, 0)
  await page.getByRole("button", { name: "Remove saved server: Alpha", exact: true }).click()
  const newest = { ...replacement, baseUrl: "http://127.0.0.1:3" }
  f.settings.mergePatchDoc("state", { ui: { remoteServers: [newest, f.rows[1]] } })
  f.manager.reconcile(); await f.sync()
  await page.getByRole("button", { name: "Remove saved server", exact: true }).click()
  assert.equal(f.calls.filter(call => call.url.endsWith("/forget")).length, 0)
  assert.equal(f.profileRows()[0].baseUrl, newest.baseUrl)
  f.check()
})

for (const locale of ["en", "fr", "he"]) test(`480px ${locale}: long names/URLs, reachable buttons, modal keyboard and associated errors`, { timeout: 90_000 }, async t => {
  const f = await fixture(t, true, locale), { page } = f
  const long = "שם Name Très long ".repeat(30)
  f.settings.mergePatchDoc("state", { ui: { remoteServers: [{ ...f.rows[0], name: long, baseUrl: `https://${"long-address-".repeat(12)}example.test` }, f.rows[1]] } })
  await f.sync()
  await page.setViewportSize({ width: 480, height: 760 })
  await page.waitForFunction(locale => document.documentElement.lang === locale, locale)
  const row = page.locator('[data-remote-server="a"]')
  await row.waitFor()
  assert.equal(await row.locator("bdi").getAttribute("dir"), "auto")
  assert.equal(await row.locator(".font-mono").getAttribute("dir"), "ltr")
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const screenshots = path.join(os.tmpdir(), "opencode", "mb-pr8c-servers-port", "screenshots")
  fs.mkdirSync(screenshots, { recursive: true })
  await page.screenshot({ path: path.join(screenshots, `servers-${locale}-480.png`) })
  const buttons = await row.locator("button").all()
  for (const button of buttons) {
    const rect = await button.boundingBox()
    assert(rect && rect.x >= 0 && rect.x + rect.width <= 480)
    assert((await button.getAttribute("aria-label"))?.includes(long.trim()))
  }
  await buttons[1].click()
  const dialog = page.getByRole("dialog")
  await dialog.waitFor()
  await dialog.locator('input[type="text"]').first().fill("")
  await dialog.locator('input[type="text"]').first().press("Enter")
  const error = dialog.getByRole("alert")
  await error.waitFor()
  assert.equal(await dialog.locator('input[type="text"]').first().getAttribute("aria-invalid"), "true")
  assert.equal(await dialog.locator('input[type="text"]').first().getAttribute("aria-describedby"), await error.getAttribute("id"))
  await page.screenshot({ path: path.join(screenshots, `editor-${locale}-480.png`) })
  await page.keyboard.press("Tab")
  assert.equal(await page.locator(":focus").evaluate(element => !!element.closest('[role="dialog"]')), true)
  await page.keyboard.press("Shift+Tab")
  assert.equal(await page.locator(":focus").evaluate(element => !!element.closest('[role="dialog"]')), true)
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  await field(page).focus()
  assert.equal(await page.locator(".server-add-field-row").evaluate(element => getComputedStyle(element).outlineStyle), "solid")
  f.check()
})

test("a provided Open callback receives a captured immutable profile selection and performs no IO", { timeout: 90_000 }, async t => {
  const f = await fixture(t, true, "en", true), { page } = f
  const button = page.getByRole("button", { name: "Open: Alpha", exact: true }).last()
  await button.waitFor()
  const before = f.calls.length
  await button.click()
  const intents = await page.evaluate(() => (window as any).serversFixture.intents)
  assert.deepEqual(intents, [{ id: "a", baseUrl: f.a.origin, skipTlsVerify: false }])
  assert.equal(f.calls.length, before)
  assert.equal(await page.evaluate(() => Object.isFrozen((window as any).serversFixture.intents[0])), true)
  f.check()
})

for (const action of ["remove", "retarget"]) test(`UI ${action} of A revokes only A's real relay stream while B continues`, { timeout: 90_000 }, async t => {
  const f = await fixture(t), upstream = new Map<string, ServerResponse>()
  for (const [id, remote] of [["a", f.a], ["b", f.b]] as const) {
    remote.state.handlers.set("/api/events", (_request, response) => {
      upstream.set(id, response)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${id}-first\n\n`)
    })
    assert.equal((await f.app.inject({ method: "POST", url: `/api/remote-servers/${id}/connect`, headers: { origin: f.origin }, payload: { username: "codenomad", password: "remote-password" } })).statusCode, 200)
  }
  async function stream(id: string) {
    const frames: string[] = []
    let closed = false
    let incoming: IncomingMessage | undefined
    const request = httpRequest(`${f.origin}/api/backends/${id}/api/events`, { headers: { origin: f.origin } })
    t.after(() => request.destroy())
    const ready = new Promise<void>((resolve, reject) => {
      request.on("response", response => {
        incoming = response
        assert.equal(response.statusCode, 200)
        response.on("data", chunk => { frames.push(String(chunk)); resolve() })
        response.on("close", () => { closed = true })
        response.on("error", reject)
      })
      request.on("error", reject)
    })
    request.end(); await ready
    return { request, response: incoming!, frames, closed: () => closed }
  }
  const a = await stream("a"), b = await stream("b")
  if (action === "remove") {
    await f.page.getByRole("button", { name: "Remove saved server: Alpha", exact: true }).click()
    await f.page.getByRole("button", { name: "Remove saved server", exact: true }).click()
    await f.page.locator('[data-remote-server="a"]').waitFor({ state: "hidden" })
  } else {
    await edit(f.page, "Alpha")
    await f.page.getByRole("textbox", { name: "URL", exact: true }).fill(f.b.origin)
    await f.page.getByRole("textbox", { name: "URL", exact: true }).press("Enter")
    await f.page.getByRole("dialog").waitFor({ state: "hidden" })
  }
  if (!a.closed()) await once(a.request, "close", { signal: AbortSignal.timeout(5000) })
  assert.equal(b.closed(), false)
  const next = once(b.response, "data", { signal: AbortSignal.timeout(5000) })
  // The existing B response remains live: observe bytes on its original socket.
  upstream.get("b")!.write("data: b-after\n\n")
  assert.match(String((await next)[0]), /b-after/)
  assert.equal(upstream.get("b")!.writableEnded, false)
  assert.equal(f.profileRows().find(row => row.id === "b")?.baseUrl, f.b.origin)
  f.check()
})

test("pasting a server address submits exactly once through the real inline field and hook", { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f
  await field(page).waitFor()
  await field(page).evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData("text", text)
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
  }, f.a.origin)
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-server-add-field]")?.value === "" && !document.querySelector<HTMLInputElement>("[data-server-add-field]")?.disabled)
  assert.equal(f.calls.filter(call => call.method === "PATCH" && call.url === "/api/storage/state/ui").length, 1)
  assert.equal(f.profileRows().length, 2)
  f.check()
})

test("two concurrent new additions share the normalized profile and keep both existing profiles", { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f
  const ids = await page.evaluate(async baseUrl => {
    const hook = (window as any).serversFixture.profiles
    const input = { name: "Concurrent", baseUrl, skipTlsVerify: false }
    const first = hook.submitServer(input), second = hook.submitServer({ ...input, baseUrl: baseUrl + "/" })
    input.baseUrl = "http://must-not-retarget.invalid"
    return [(await first).id, (await second).id]
  }, f.origin)
  assert.equal(ids[0], ids[1])
  assert.equal(f.profileRows().length, 3)
  assert.equal(f.profileRows().filter(profile => profile.baseUrl === f.origin).length, 1)
  assert.equal(f.profileRows().filter(profile => ["a", "b"].includes(profile.id)).length, 2)
  assert(f.calls.filter(call => call.url.endsWith("/probe")).every(call => call.body.baseUrl === f.origin))
  f.check()
})

test("renaming an existing exact URL preserves it offline even when it contains a saved path", { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f
  const saved = { ...f.rows[0], baseUrl: f.a.origin + "/saved-path" }
  f.settings.mergePatchDoc("state", { ui: { remoteServers: [saved, f.rows[1]] } })
  await f.sync()
  await edit(page, "Alpha")
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Path rename")
  await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter")
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  assert.equal(f.profileRows().find(row => row.id === "a")?.baseUrl, saved.baseUrl)
  assert.equal(f.calls.filter(call => call.url.endsWith("/probe")).length, 0)
  assert.equal(f.a.state.requests.length, 0)
  f.check()
})
