import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type { NativePreferencesRequest } from "../../src/lib/native/preferences-window"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "preferences-startup", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'))
      })
    } }],
    resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture?preferences=chat`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function installHost(page: Page, host: "electron" | "tauri", request: NativePreferencesRequest) {
  await page.addInitScript({ content: `{
    const host = ${JSON.stringify(host)}, request = ${JSON.stringify(request)}
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = host
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.fixtureRequest = request
    w.fixtureEvents = []
    w.EventSource = class extends EventTarget {
      constructor() { super(); w.fixtureEvents.push(this) }
      close() {}
    }
    w.electronAPI = host === "electron" ? {
      getPreferencesRequest: async () => w.fixtureRequest,
      acceptPreferencesRequest: async (request) => { w.fixtureRequest = request },
      preferencesReady: async () => { w.fixtureReady = true },
      onPreferencesSection: (listener) => { w.fixtureOpen = listener; return () => {} },
      onPreferencesCloseRequested: () => () => {},
      onPreferencesTransitionRequested: () => () => {},
    } : undefined
    if (host === "tauri") {
      const callbacks = new Map()
      w.__TAURI_INTERNALS__ = {
        transformCallback: (callback) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id },
        invoke: async (command, args) => {
          if (command === "plugin:event|listen" && args.event === "preferences:section") {
            w.fixtureOpen = (payload) => callbacks.get(args.handler)?.({ event: args.event, payload })
          }
          if (command === "preferences_get_request") return w.fixtureRequest
          if (command === "preferences_accept_request") w.fixtureRequest = args.request
          if (command === "preferences_window_ready") w.fixtureReady = true
          return 1
        },
      }
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }` })
}

const workspace = (id: string, path = "D:/current-project", status = "ready") => ({
  id, path, status, proxyPath: `/workspaces/${id}/instance`, binaryId: "fixture", binaryLabel: "fixture",
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
})
const emit = (page: Page, event: unknown) => page.evaluate(event => {
  for (const source of (window as any).fixtureEvents) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }))
}, event)
const nativeRequest = (page: Page, request: NativePreferencesRequest) => page.evaluate(request => (window as any).fixtureOpen(request), request)

for (const host of ["electron", "tauri"] as const) {
  test(`${host} Preferences starts without hydrating workspaces and loads only its explicit provider context`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const workspaceRequests: string[] = []
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await installHost(page, host, { section: "chat", scrollTop: 300, instanceId: "current-project", location: { directory: "D:/current-project" } })
    await page.route(/\/(?:api|workspaces)\//, async route => {
      const path = new URL(route.request().url()).pathname
      if (!path.startsWith("/api/") && !path.startsWith("/workspaces/")) return route.continue()
      if (path.includes("/workspaces")) workspaceRequests.push(route.request().url())
      const body = path === "/api/workspaces" ? [workspace("current-project"), ...Array.from({ length: 20 }, (_, i) => workspace(`project-${i}`, `D:/project-${i}`))]
        : path === "/api/storage/config/ui" ? { settings: { locale: "en" } }
        : path.includes("/instance/api/") ? { location: { directory: "D:/current-project" }, data: [] }
        : path.endsWith("/websearch-settings") ? { location: { directory: "D:/current-project" }, scopes: [], effective: null } : {}
      await route.fulfill({ json: body })
    })
    try {
      await page.goto(url)
      await page.waitForFunction(() => (window as any).fixtureReady)
      await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")?.scrollTop === 300)
      assert.deepEqual(workspaceRequests, [], "startup must not load the project inventory")

      // Both reconnect reconciliation and live workspace events used to start
      // full session/catalog hydration in this secondary renderer.
      await page.evaluate(() => {
        for (const source of (window as any).fixtureEvents) {
          source.onopen?.(new Event("open"))
          for (let i = 0; i < 20; i++) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
            type: "workspace.started", workspace: { id: `project-${i}`, path: `D:/project-${i}`, status: "ready", port: 1234 },
          }) }))
          source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
            type: "storage.configChanged", owner: "ui", value: { settings: { locale: "fr" } },
          }) }))
        }
      })
      await page.getByRole("button", { name: "Fournisseurs", exact: true }).waitFor()
      assert.deepEqual(workspaceRequests, [], "reconnect/events must not hydrate unrelated projects")
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/integration")),
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/model")),
        page.getByRole("button", { name: "Fournisseurs", exact: true }).click(),
      ])
      // Web search is folded by default and reads its settings only once opened.
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/websearch-settings")),
        page.getByRole("heading", { name: "Recherche web", exact: true }).click(),
      ])
      assert.deepEqual(new Set(workspaceRequests.map(request => new URL(request).pathname)), new Set([
        "/api/workspaces",
        "/workspaces/current-project/instance/api/provider", "/workspaces/current-project/instance/api/model",
        "/workspaces/current-project/instance/api/integration", "/workspaces/current-project/instance/api/websearch/provider",
        "/api/workspaces/current-project/websearch-settings",
      ]))
      for (const request of workspaceRequests) {
        const target = new URL(request)
        if (target.pathname === "/api/workspaces") continue // metadata-only readiness lookup
        assert.equal(target.searchParams.get(target.pathname.startsWith("/api/") ? "directory" : "location[directory]"), "D:/current-project")
      }
      assert.deepEqual(errors, [])
    } catch (error) {
      console.error({ host, errors, workspaceRequests, content: (await page.locator("body").innerText()).slice(0, 500) })
      throw error
    } finally { await page.close() }
  })
}

/** Real Preferences/Settings and generated clients. Only HTTP/native host IO is simulated. */
async function restoredFixture(page: Page, host: "electron" | "tauri", request: NativePreferencesRequest) {
  const requests: string[] = [], errors: string[] = [], writes: string[] = []
  let inventory: ReturnType<typeof workspace>[] = [], reads = 0
  page.on("pageerror", error => errors.push(error.message))
  await installHost(page, host, request)
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith("/api/") && !path.startsWith("/workspaces/")) return route.continue()
    if (route.request().method() !== "GET") writes.push(path)
    if (path === "/api/workspaces") { reads++; return route.fulfill({ json: inventory }) }
    if (path.includes("/workspaces/")) requests.push(route.request().url())
    const directory = new URL(route.request().url()).searchParams.get("directory") ?? "D:/current-project"
    const data = path.endsWith("/websearch/provider") ? [{ id: "search", name: "Fixture search" }]
      : path.endsWith("/provider") ? [{ id: "ai", name: "Fixture AI", activation: "enabled" }]
        : path.endsWith("/integration") ? [{ id: "ai", name: "Fixture AI", methods: [{ type: "key", label: "API key" }], connections: [] }]
          : []
    const body = path === "/api/storage/config/ui" ? { settings: { locale: "en" } }
      : path.includes("/instance/api/") ? { data }
        : path.endsWith("/websearch-settings") ? { location: { directory }, effective: null,
          scopes: [{ scope: "global", path: "/fixture/global.jsonc", selection: null }, { scope: "project", path: `${directory}/opencode.jsonc`, selection: null }] }
          : path.endsWith("/subagent-depth") ? { location: { directory }, capability: { minimum: 0 }, effectiveDepth: 2,
            project: { path: `${directory}/opencode.jsonc`, depth: null, expectation: "fixture" } }
            : {}
    return route.fulfill({ json: body })
  })
  return { requests, errors, writes, reads: () => reads, inventory: (value: typeof inventory) => { inventory = value } }
}

for (const host of ["electron", "tauri"] as const) {
  test(`${host}: restored Providers waits for the same folder's new ready workspace and persists its identity`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const fixture = await restoredFixture(page, host, { section: "providers", instanceId: "old", location: { directory: "D:\\current-project", workspaceID: "old-native-id" } })
    try {
      await page.goto(url)
      await page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspaces")
      await page.waitForFunction(() => (window as any).fixtureReady)
      await page.getByRole("heading", { name: "Web search", exact: true }).click()
      assert.deepEqual(fixture.requests, [], "no provider/search calls with the obsolete ID")
      assert.equal(await page.getByRole("alert").count(), 0)
      const before = fixture.reads()
      await emit(page, { type: "workspace.started", workspace: workspace("unrelated", "D:/elsewhere") })
      await page.waitForTimeout(150)
      assert.equal(fixture.reads(), before, "unrelated startup traffic triggers no inventory/hydration")

      const starting = workspace("new", "d:/current-project/", "starting")
      fixture.inventory([starting])
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspaces"),
        emit(page, { type: "workspace.created", workspace: starting }),
      ])
      assert.deepEqual(fixture.requests, [], "a starting workspace still has no provider demand")
      const ready = { ...starting, status: "ready" }
      fixture.inventory([ready])
      await emit(page, { type: "workspace.started", workspace: ready })
      await page.getByLabel("Default search", { exact: true }).waitFor()
      await page.locator(".providers-card-title").filter({ hasText: "Fixture AI" }).waitFor()
      await page.waitForFunction(() => (window as any).fixtureRequest.instanceId === "new")
      const persisted = await page.evaluate(() => (window as any).fixtureRequest)
      assert.equal(persisted.section, "providers")
      assert.deepEqual(persisted.location, { directory: "D:\\current-project" }, "the old native workspace selector is not reused")
      assert.ok(fixture.requests.every(request => new URL(request).pathname.includes("/new/")))
      assert.equal(await page.getByRole("alert").count(), 0)

      // The shared project context also serves Missions, without opening a second project.
      await page.getByRole("button", { name: "Missions", exact: true }).click()
      await page.getByText("OpenCode effective depth: 2", { exact: true }).waitFor()
      assert.deepEqual(fixture.writes, [], "resolution is read-only")
      assert.deepEqual(fixture.errors, [])
    } finally { await page.close() }
  })

  test(`${host}: a delayed restored-project reply cannot override a newer explicit Preferences request`, async () => {
    const page = await browser.newPage()
    const fixture = await restoredFixture(page, host, { section: "providers", instanceId: "old", location: { directory: "D:/current-project" } })
    const hold = Promise.withResolvers<void>()
    let held = false
    await page.route("**/api/workspaces", async route => {
      if (held) return route.fallback()
      held = true; await hold.promise
      await route.fulfill({ json: [workspace("obsolete-replacement")] }).catch(() => {})
    })
    try {
      await Promise.all([page.waitForRequest(request => new URL(request.url()).pathname === "/api/workspaces"), page.goto(url)])
      await page.waitForFunction(() => (window as any).fixtureReady)
      fixture.inventory([workspace("other", "D:/other-project")])
      await nativeRequest(page, { section: "providers", instanceId: "other", location: { directory: "D:/other-project" } })
      await page.locator(".providers-card-title").filter({ hasText: "Fixture AI" }).waitFor()
      hold.resolve()
      await page.waitForTimeout(150)
      assert.ok(fixture.requests.length > 0 && fixture.requests.every(request => new URL(request).pathname.includes("/other/")))
      assert.equal(await page.evaluate(() => (window as any).fixtureRequest.instanceId), "other")
      assert.deepEqual(fixture.writes, [])
      assert.deepEqual(fixture.errors, [])
    } finally { hold.resolve(); await page.unrouteAll({ behavior: "wait" }); await page.close() }
  })

  test(`${host}: ambiguous restored folders stay unbound; an explicit occurrence keeps its worktree and is revoked on deletion`, async () => {
    const page = await browser.newPage()
    const fixture = await restoredFixture(page, host, { section: "providers", instanceId: "old", location: { directory: "D:/current-project" } })
    const first = workspace("first"), second = workspace("second")
    fixture.inventory([first, second])
    try {
      await page.goto(url)
      await page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspaces")
      await page.waitForFunction(() => (window as any).fixtureReady)
      assert.deepEqual(fixture.requests, [], "do not guess between two occurrences of the same project")
      const directory = "D:/worktrees/feature"
      await nativeRequest(page, { section: "providers", instanceId: "second", location: { directory } })
      await page.locator(".providers-card-title").filter({ hasText: "Fixture AI" }).waitFor()
      assert.ok(fixture.requests.length > 0 && fixture.requests.every(request => new URL(request).pathname.includes("/second/")
        && new URL(request).searchParams.get("location[directory]") === directory), "a valid explicit record preserves the selected worktree")
      // Deletion still revokes the bound occurrence when its Settings section is hidden.
      await page.getByRole("button", { name: "Chat", exact: true }).click()
      fixture.inventory([first])
      await emit(page, { type: "workspace.stopped", workspaceId: "second", reason: "deleted" })
      await page.getByRole("button", { name: "Providers", exact: true }).click()
      const count = fixture.requests.length
      await emit(page, { type: "workspace.started", workspace: first })
      await page.waitForTimeout(150)
      assert.equal(fixture.requests.length, count, "closing a project never binds to its surviving sibling")
      assert.deepEqual(fixture.errors, [])
    } finally { await page.close() }
  })

  test(`${host}: reconnect recovers a failed inventory read and lifecycle changes fence an older ready response`, async () => {
    const page = await browser.newPage()
    const fixture = await restoredFixture(page, host, { section: "providers", instanceId: "old", location: { directory: "D:/current-project" } })
    const hold = Promise.withResolvers<void>()
    let fail = true, held = false
    await page.route("**/api/workspaces", async route => {
      if (fail) return route.fulfill({ status: 503, json: { error: "starting" } })
      if (held) return route.fallback()
      held = true; await hold.promise
      await route.fulfill({ json: [workspace("old")] }).catch(() => {})
    })
    try {
      await Promise.all([page.waitForResponse(response => response.status() === 503), page.goto(url)])
      await page.waitForFunction(() => (window as any).fixtureReady)
      assert.deepEqual(fixture.requests, [])
      assert.equal(await page.getByRole("alert").count(), 0)
      fail = false
      await Promise.all([
        page.waitForRequest(request => new URL(request.url()).pathname === "/api/workspaces"),
        page.evaluate(() => { for (const source of (window as any).fixtureEvents) source.onopen?.(new Event("open")) }),
      ])
      const replacement = workspace("new", "D:/current-project", "starting")
      fixture.inventory([replacement])
      await emit(page, { type: "workspace.created", workspace: replacement })
      const trailing = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspaces")
      hold.resolve(); await trailing
      await page.waitForTimeout(150)
      assert.deepEqual(fixture.requests, [], "an old ready snapshot cannot unlock the provider requests")
      fixture.inventory([{ ...replacement, status: "ready" }])
      await emit(page, { type: "workspace.started", workspace: { ...replacement, status: "ready" } })
      await page.locator(".providers-card-title").filter({ hasText: "Fixture AI" }).waitFor()
      assert.ok(fixture.requests.every(request => new URL(request).pathname.includes("/new/")))
      assert.deepEqual(fixture.errors, [])
    } finally { hold.resolve(); await page.unrouteAll({ behavior: "wait" }); await page.close() }
  })
}
