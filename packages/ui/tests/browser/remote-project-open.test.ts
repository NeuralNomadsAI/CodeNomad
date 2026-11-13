import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Fastify from "fastify"
import { chromium, type Page } from "playwright"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"
import { RemoteServerBrowseManager } from "../../../server/src/codenomad-servers/browse-manager"
import { startFakeCodeNomad } from "../../../server/src/codenomad-servers/test-support/fake-codenomad"
import { registerBackendRelayRoutes } from "../../../server/src/server/routes/backend-relay"
import { registerRemoteServerBrowseRoutes } from "../../../server/src/server/routes/remote-server-browse"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

test("the real home/browser opens ordinary tabs on two relayed servers, with isolated refusal and cancellation", { timeout: 120_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-project-open-"))
  const a = await startFakeCodeNomad({ anonymous: true }), b = await startFakeCodeNomad({ anonymous: true })
  let refusal: "contract" | "426" | undefined, hold: (() => void) | undefined, holdCreate = false
  let createEntered: (() => void) | undefined, cancelEntered: (() => void) | undefined
  const mutations: string[] = [], paths: string[] = []
  const descriptor = (folder = "/same") => ({ id: "w", path: folder, status: "starting", proxyPath: "/workspaces/w/instance",
    binaryId: "fixture", binaryLabel: "Fixture", createdAt: "", updatedAt: "" })
  for (const [id, remote] of [["a", a], ["b", b]] as const) {
    remote.state.recents = [{ path: "/same", projectName: "Same", lastAccessed: 42, password: "must-not-leak" }]
    remote.state.handlers.set("/api/meta", (_request, response) => {
      response.writeHead(id === "b" && refusal === "426" ? 426 : 200, { "content-type": "application/json" })
      response.end(JSON.stringify({ apiContract: id === "b" && refusal === "contract" ? -1 : CODENOMAD_API_CONTRACT, serverId: `server-${id}` }))
    })
    for (const route of ["/api/storage/config/ui", "/api/storage/config/server"]) remote.state.handlers.set(route, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}")
    })
    remote.state.handlers.set("/api/workspaces", (request, response) => {
      if (request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end("[]"); return }
      mutations.push(`${id}:POST`)
      let body = ""
      request.on("data", chunk => { body += chunk })
      request.on("end", () => {
        const input = JSON.parse(body)
        paths.push(`${id}:${input.path ?? input.folder}`)
        const send = () => {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ ...descriptor(input.path ?? input.folder), ...(input.requestId ? { requestId: input.requestId } : {}) }))
        }
        if (holdCreate) { hold = send; createEntered?.() }
        else send()
      })
    })
    for (const suffix of ["/w", "/w/creation/release", "/creation/cancel"]) remote.state.handlers.set(`/api/workspaces${suffix}`, (request, response) => {
      mutations.push(`${id}:${suffix}:${request.method}`)
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}")
      if (suffix === "/creation/cancel") cancelEntered?.()
    })
    remote.state.handlers.set("/api/events", (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": ready\n\n")
    })
  }
  const profiles = ([["a", a], ["b", b]] as const).map(([id, remote]) => ({ id, name: id === "a" ? "Alpha" : "Beta",
    baseUrl: remote.origin, skipTlsVerify: false, createdAt: "", updatedAt: "" }))
  const app = Fastify(), origins = new Set<string>(), local: string[] = []
  const ui = { settings: { multiBackend: true, locale: "en" } }
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: profiles }),
    configYamlPathForAuthority: () => path.join(directory, "config.yaml") })
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => origins })
  registerRemoteServerBrowseRoutes(app, { manager, getSelfOrigins: () => origins })
  app.all("/*", async request => {
    local.push(`${request.method} ${request.url}`)
    if (request.url === "/api/meta") return { apiContract: CODENOMAD_API_CONTRACT, serverId: "local", localRequest: true }
    if (request.url === "/api/workspaces") return [descriptor()]
    if (request.url === "/api/storage/config/ui") {
      if (request.method === "PATCH") Object.assign(ui.settings, (request.body as any)?.settings)
      return ui
    }
    if (request.url === "/api/storage/state/ui") return { remoteServers: profiles }
    return {}
  })
  const target = await app.listen({ host: "127.0.0.1", port: 0 })
  origins.add(target)
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
    logLevel: "error", resolve: { dedupe: ["solid-js"] }, plugins: [shutdown.plugin, solid(), { name: "remote-project-open", configureServer(vite) {
      vite.middlewares.use("/fixture", async (_request, response) => {
        response.setHeader("content-type", "text/html")
        response.end(await vite.transformIndexHtml("/fixture", '<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/remote-project-open.tsx"></script></body></html>'))
      })
    } }], server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, proxy: { "/api": { target }, "/workspaces": { target } } },
  })
  shutdown.own(server); await server.listen()
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  origins.add(origin)
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  t.after(async () => {
    hold?.(); await browser.close(); manager.close(); await Promise.all([a.close(), b.close()])
    await server.close(); app.server.closeAllConnections(); await app.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const errors: string[] = []
  async function prepare(host: "electron" | "tauri" = "electron", native = false) {
    const page = await browser.newPage({ locale: "en-US" })
    page.on("pageerror", error => errors.push(error.message))
    await page.addInitScript("window.__name = value => value")
    await page.addInitScript(({ host, native }) => {
      ;(window as any).__CODENOMAD_RUNTIME_HOST__ = host
      window.__CODENOMAD_WINDOW_CONTEXT__ = native ? "preferences" : "local"
      ;(window as any).selections = []
      window.electronAPI = { selectServer: async intent => { (window as any).selections.push(intent) } } as any
      ;(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
        if (command === "preferences_select_server") (window as any).selections.push(args.intent)
      }, metadata: { currentWindow: { label: native ? "preferences" : "main" } } }
    }, { host, native })
    await page.goto(`${origin}/fixture${native ? "?preferences" : ""}`)
    await page.waitForFunction(() => !!(window as any).remoteOpenFixture)
    return page
  }
  const select = (page: Page, id: string) => page.evaluate(id => (window as any).remoteOpenFixture.select(id), id)
  const dialog = (page: Page) => page.getByRole("dialog")
  await t.test("home, navigation, typed path, recents, server labels and ordinary instance tabs", async () => {
    const page = await prepare()
    await page.getByRole("button", { name: /Servers/ }).click()
    await page.getByRole("button", { name: /^Alpha/ }).click()
    await dialog(page).getByRole("button", { name: "app", exact: true }).waitFor()
    await dialog(page).getByRole("button", { name: "app", exact: true }).focus()
    await page.keyboard.press("Enter")
    await dialog(page).getByRole("button", { name: /Parent/ }).waitFor()
    await dialog(page).getByRole("button", { name: /Parent/ }).click()
    await dialog(page).getByRole("textbox").fill("/same")
    await dialog(page).getByRole("textbox").press("Enter")
    await dialog(page).waitFor({ state: "detached" })
    await page.getByRole("tab", { name: /same — Alpha/ }).waitFor()
    await select(page, "b")
    await dialog(page).getByRole("button", { name: "Same", exact: true }).click()
    await dialog(page).waitFor({ state: "detached" })
    await page.getByRole("tab", { name: /same — Beta/ }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
      tabs: [{ id: "instance:w", kind: "instance" }, { id: "instance:a~w", kind: "instance" }, { id: "instance:b~w", kind: "instance" }],
      active: "instance:b~w",
    })
    assert.deepEqual(paths, ["a:/same", "b:/same"])
    assert.equal(local.includes("POST /api/workspaces"), false)
    assert.equal(await page.locator("webview, iframe").count(), 0)
    await select(page, "a"); await dialog(page).getByRole("button", { name: /Close/ }).click()
    assert.equal(await page.getByRole("tab").count(), 3)
    await page.close()
  })
  await t.test("Escape cancels only its in-flight opening and keeps the local occurrence", async () => {
    const page = await prepare(), before = mutations.length
    holdCreate = true
    const entered = new Promise<void>(resolve => { createEntered = resolve })
    const cancelled = new Promise<void>(resolve => { cancelEntered = resolve })
    try {
      await select(page, "a")
      await dialog(page).getByRole("button", { name: "Same", exact: true }).click()
      await entered
      await page.keyboard.press("Escape")
      await dialog(page).waitFor({ state: "detached" })
      await cancelled
      assert.equal(await page.getByRole("tab").count(), 1)
      assert.equal(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot().active), "instance:w")
      assert.deepEqual(mutations.slice(before), ["a:POST", "a:/creation/cancel:POST"])
      assert.equal(local.some(value => /^(POST|DELETE) \/api\/workspaces/.test(value)), false)
    } finally {
      holdCreate = false
      const send = hold; hold = undefined
      send?.()
      createEntered = cancelEntered = undefined
      await page.close()
    }
  })
  await t.test("incompatible metadata and HTTP 426 never provision or open a project", async () => {
    for (const verdict of ["contract", "426"] as const) {
      refusal = verdict
      const page = await prepare(), before = mutations.length
      await select(page, "b")
      await dialog(page).getByRole("button", { name: "Same", exact: true }).click()
      await dialog(page).getByRole("alert").filter({ hasText: "Incompatible CodeNomad server." }).waitFor()
      assert.equal(await page.evaluate(() => (window as any).remoteOpenFixture.state("b")), "refused")
      assert.equal(mutations.length, before)
      assert.equal(await page.locator("[role=tab]").count(), 1)
      await page.close()
    }
    refusal = undefined
  })
  await t.test("same-policy reselection retains its in-flight opening and releases the selected occurrence", async () => {
    const page = await prepare(), before = mutations.length
    holdCreate = true
    const entered = new Promise<void>(resolve => { createEntered = resolve })
    try {
      await select(page, "a")
      await dialog(page).getByRole("button", { name: "Same", exact: true }).click()
      await entered
      await select(page, "a")
      const released = page.waitForResponse(response => response.url().includes("/w/creation/release"))
      void released.catch(() => undefined)
      const send = hold; hold = undefined; send?.()
      await dialog(page).waitFor({ state: "detached", timeout: 3000 })
      await released
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
        tabs: [{ id: "instance:w", kind: "instance" }, { id: "instance:a~w", kind: "instance" }],
        active: "instance:a~w",
      })
      assert.deepEqual(mutations.slice(before), ["a:POST", "a:/w/creation/release:POST"])
    } finally {
      holdCreate = false
      const send = hold; hold = undefined; send?.()
      createEntered = undefined
      await page.close()
    }
  })
  for (const mode of ["different-server", "cancel-reselect"] as const) await t.test(`${mode} disposes the old dialog before opening only the current selection`, async () => {
    const page = await prepare(), before = mutations.length
    holdCreate = true
    const entered = new Promise<void>(resolve => { createEntered = resolve })
    const cancelled = new Promise<void>(resolve => { cancelEntered = resolve })
    const target = mode === "different-server" ? "b" : "a"
    try {
      await select(page, "a")
      await dialog(page).getByRole("button", { name: "Same", exact: true }).click()
      await entered
      await page.evaluate(() => {
        ;(window as any).oldBrowser = document.querySelector(".remote-server-browser")
        ;(window as any).oldDialog = document.querySelector("[role=dialog]")
      })
      if (mode === "different-server") await select(page, "b")
      else {
        await page.keyboard.press("Escape")
        await dialog(page).waitFor({ state: "detached" })
      }
      await cancelled
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
        tabs: [{ id: "instance:w", kind: "instance" }], active: "instance:w",
      })
      if (mode === "different-server") {
        await dialog(page).getByRole("heading", { name: "Beta", exact: true }).waitFor()
        await page.locator(".remote-server-browser").filter({ has: page.getByRole("heading", { name: "Beta", exact: true }) })
          .getByRole("button", { name: "Same", exact: true }).waitFor()
        assert.equal(await page.locator(".remote-server-browser").count(), 1)
        const ids = await dialog(page).locator("[id]").evaluateAll(nodes => nodes.map(node => node.id))
        assert.equal(new Set(ids).size, ids.length, "dialog IDs remain unique")
      }
      assert.equal(await page.evaluate(() => (window as any).oldBrowser.isConnected), false)
      assert.equal(await page.evaluate(() => (window as any).oldDialog.isConnected), false)
      holdCreate = false
      const send = hold; hold = undefined; send?.()
      if (mode === "cancel-reselect") await select(page, "a")
      const released = page.waitForResponse(response => response.url().includes(`/backends/${target}/api/workspaces/w/creation/release`))
      void released.catch(() => undefined)
      await dialog(page).getByRole("button", { name: "Same", exact: true }).click()
      await dialog(page).waitFor({ state: "detached" })
      await released
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
        tabs: [{ id: "instance:w", kind: "instance" }, { id: `instance:${target}~w`, kind: "instance" }],
        active: `instance:${target}~w`,
      })
      assert.deepEqual((await page.evaluate(() => (window as any).remoteOpenFixture.records())).sort(), ["w", `${target}~w`].sort())
      assert.deepEqual(mutations.slice(before), ["a:POST", "a:/creation/cancel:POST", `${target}:POST`, `${target}:/w/creation/release:POST`])
    } finally {
      holdCreate = false
      const send = hold; hold = undefined; send?.()
      createEntered = cancelEntered = undefined
      await page.close()
    }
  })
  await t.test("Preferences sends only the selection through each native adapter", async () => {
    for (const host of ["electron", "tauri"] as const) {
      const page = await prepare(host, true)
      await page.getByRole("button", { name: "Open: Alpha" }).click()
      assert.deepEqual(await page.evaluate(() => (window as any).selections), [{ id: "a", baseUrl: a.origin, skipTlsVerify: false }])
      assert.equal(await page.getByRole("dialog").count(), 0)
      await page.close()
    }
  })
  await t.test("credential recovery uses the saved server and clears the mounted password", async () => {
    a.state.overrides.set("/api/filesystem", { status: 401, body: { error: "Unauthorized" } })
    const page = await prepare(), logins = a.state.logins
    try {
      await select(page, "a")
      await dialog(page).getByLabel("Password", { exact: true }).fill("remote-password")
      a.state.overrides.delete("/api/filesystem")
      await dialog(page).getByRole("button", { name: "Sign in", exact: true }).click()
      await dialog(page).getByRole("button", { name: "app", exact: true }).waitFor()
      assert.equal(a.state.logins, logins + 1)
      assert.equal(await dialog(page).getByLabel("Password", { exact: true }).count(), 0)
      assert.equal((await page.locator("body").innerText()).includes("remote-password"), false)
    } finally { a.state.overrides.delete("/api/filesystem"); await page.close() }
  })
  await t.test("flag revocation cancels browsing without affecting a local tab", async () => {
    const page = await prepare()
    const before = mutations.length
    await select(page, "a")
    await dialog(page).getByRole("button", { name: "Same", exact: true }).waitFor()
    await page.evaluate(() => (window as any).remoteOpenFixture.disable())
    await dialog(page).waitFor({ state: "detached" })
    const rejected = await page.evaluate(intent => {
      try { window.__CODENOMAD_SELECT_SERVER__!(intent); return false }
      catch { return true }
    }, { id: "a", baseUrl: a.origin, skipTlsVerify: false })
    assert.equal(rejected, true, "stale native selection fails closed")
    assert.equal(mutations.length, before)
    assert.equal(await page.getByRole("tab").count(), 1)
    await page.close()
  })
  assert.deepEqual(errors, [])
  assert.equal(local.some(request => /install|provision|download/.test(request)), false)
})
