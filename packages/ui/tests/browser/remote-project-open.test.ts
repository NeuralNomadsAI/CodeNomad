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
import { applyMergePatch } from "../../../server/src/settings/merge-patch"
import { readRemoteProjectHistory } from "../../src/lib/remote-project-recent-data"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

test("the real empty-tab browser opens ordinary tabs on two relayed servers, with isolated refusal and cancellation", { timeout: 300_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-project-open-"))
  const a = await startFakeCodeNomad({ anonymous: true }), b = await startFakeCodeNomad({ anonymous: true })
  let refusal: "contract" | "426" | undefined, hold: (() => void) | undefined, holdCreate = false
  let nextWorkspaceId = "w"
  let failInventory = false
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
      if (request.method === "GET") { response.writeHead(id === "a" && failInventory ? 503 : 200, { "content-type": "application/json" }); response.end(id === "a" && failInventory ? "{}" : "[]"); return }
      mutations.push(`${id}:POST`)
      const binaryLabel = holdCreate ? "held-previous" : "fresh-current"
      let body = ""
      request.on("data", chunk => { body += chunk })
      request.on("end", () => {
        const input = JSON.parse(body)
        paths.push(`${id}:${input.path ?? input.folder}`)
        const send = () => {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ ...descriptor(input.path ?? input.folder), id: nextWorkspaceId, binaryLabel, ...(input.requestId ? { requestId: input.requestId } : {}) }))
        }
        if (holdCreate) { hold = send; createEntered?.() }
        else send()
      })
    })
    for (const suffix of ["/w", "/w/creation/release", "/duplicate/creation/release", "/creation/cancel"]) remote.state.handlers.set(`/api/workspaces${suffix}`, (request, response) => {
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
  const state: { remoteServers: typeof profiles; remoteProjectRecents?: unknown; remoteProjectHistory?: unknown } = { remoteServers: profiles }
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: state.remoteServers }),
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
    if (request.url === "/api/storage/state/ui") {
      if (request.method === "PATCH") Object.assign(state, applyMergePatch(state, request.body))
      return state
    }
    return {}
  })
  const target = await app.listen({ host: "127.0.0.1", port: 0 })
  origins.add(target)
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
    logLevel: "error", resolve: { dedupe: ["solid-js"] }, plugins: [{
      name: "opening-boundary-observer", enforce: "pre", transform(source, id) {
        const file = id.replaceAll("\\", "/").split("?")[0]
        const gate = (phase: string, value: string) => `\nif ((window as any).__openingGate) await (window as any).__openingGate("${phase}", ${value}, signal);\n`
        if (file.endsWith("/src/stores/remote-project-open.ts")) {
          source = source.replaceAll("\r\n", "\n")
          const create = "const result = await createInstance(path, options?.projectName, {"
          assert(source.includes(create), "observe the real create callback")
          source = source.replace(create, `${create} onCreateCommit: id => (window as any).__onCreateCommit?.(id),`)
          const guard = /(\n\s*)(if \(!current\(\).*return false)(?=\n\s*(?:transferred = )?selectInstanceTab)/
          assert(guard.test(source), "observe the real post-create continuation")
          source = source.replace(guard, `$1${gate("post-create", "result")}$2`)
          source = source.replace("let client = await backendRegistry.ensure(intent.id)", `$&${gate("ensure", "client")}`)
          source = source.replace("client = await backendRegistry.retryWorkspaces(intent.id)", `$&;${gate("inventory", "client")}`)
          source = source.replace(/selectInstanceTab\(result\.instanceId(?:, creation)?\)/, "$&;\n(window as any).__afterTabSelection?.(result.instanceId)")
          return source
        }
        if (file.endsWith("/src/stores/instances.ts")) {
          const publication = "const id = instanceKey(receipt.backendId, response.id)"
          assert(source.includes(publication), "observe the real response before publication")
          return source.replace(publication, `${gate("pre-publication", "response")}${publication}`)
            + "\nexport function __openingReceipts() { return [...restoreCreationReceipts.values()].map(r => ({ backendId: r.backendId, requestId: r.requestId, instanceId: r.instanceId, aborted: r.signal.aborted })); }"
        }
      },
    }, shutdown.plugin, solid(), { name: "remote-project-open", configureServer(vite) {
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
  async function prepare(host: "electron" | "tauri" | "web" = "electron", native = false, beforeNavigation?: (page: Page) => Promise<void>) {
    const page = await browser.newPage({ locale: "en-US" })
    page.setDefaultTimeout(8_000)
    page.on("pageerror", error => errors.push(error.message))
    await page.addInitScript("window.__name = value => value")
    await page.addInitScript(({ host, native }) => {
      ;(window as any).__CODENOMAD_RUNTIME_HOST__ = host
      window.__CODENOMAD_WINDOW_CONTEXT__ = native ? "preferences" : host === "web" ? "remote" : "local"
      ;(window as any).selections = []
      if (host === "web") return
      window.electronAPI = { selectServer: async intent => { (window as any).selections.push(intent) } } as any
      ;(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
        if (command === "preferences_select_server") (window as any).selections.push(args.intent)
      }, metadata: { currentWindow: { label: native ? "preferences" : "main" }, currentWebview: { label: native ? "preferences" : "main" } } }
    }, { host, native })
    if (host === "web") await page.route("**/api/meta", route => {
      if (new URL(route.request().url()).pathname !== "/api/meta") return route.continue()
      return route.fulfill({ json: { apiContract: CODENOMAD_API_CONTRACT, serverId: "local",
        localRequest: false, serversUsable: true, serversManageable: true, secretEntryAllowed: true } })
    })
    await beforeNavigation?.(page)
    await page.goto(`${origin}/fixture${native ? "?preferences" : ""}`)
    await page.waitForFunction(() => !!(window as any).remoteOpenFixture)
    return page
  }
  const select = (page: Page, id: string) => page.evaluate(id => (window as any).remoteOpenFixture.select(id), id)
  const blank = (page: Page) => page.locator("[data-fixture-blank]:visible")
  const browserInBlank = (page: Page) => blank(page).locator(".remote-server-browser")
  const openSame = (page: Page) => blank(page).getByRole("button", { name: /^Same ·/ })
  const openFolder = (page: Page) => browserInBlank(page).getByRole("button", { name: "Open", exact: true })
  const serverName = (page: Page, name: string) => blank(page).locator(".remote-server-navigation bdi", { hasText: name })
  await t.test("the first remote project opened from the empty tab is saved in the host's recent tabs", async () => {
    const shortcuts = a.state.recents
    a.state.recents = []
    const page = await prepare("electron", false, async page => {
      await page.route(/\/api\/workspaces$/, route => {
        if (new URL(route.request().url()).pathname !== "/api/workspaces" || route.request().method() !== "GET") return route.continue()
        return route.fulfill({ json: [] })
      })
    })
    try {
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot().tabs.map((tab: { kind: string }) => tab.kind)), ["blank"])
      await page.locator('[data-remote-server="a"]').click()
      const browse = page.locator(".remote-server-browser")
      await browse.getByRole("button", { name: "app", exact: true }).click()
      await browse.getByRole("button", { name: "Open", exact: true }).click()
      await page.getByRole("tab", { name: /Alpha/ }).waitFor()
      assert.equal(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot().active), "instance:a~w")
      await select(page, "a")
      await page.waitForFunction(async () => (await import("/src/stores/preferences.tsx")).remoteProjectHistory().recents.length === 1)
      assert.deepEqual(readRemoteProjectHistory(undefined, state.remoteProjectHistory).recents.map(({ policy, path }) => [policy.id, path]), [["a", "/srv/projects/app"]])
      await blank(page).getByRole("region", { name: "Recent tabs", exact: true }).getByRole("button", { name: /^app · Alpha ·/ }).waitFor()
    } finally {
      a.state.recents = shortcuts
      await page.close()
      delete state.remoteProjectHistory
    }
  })
  await t.test("Browse lists the first opened project even when the chosen server has no recents", async () => {
    const shortcuts = a.state.recents
    a.state.recents = []
    let releaseMeta!: () => void
    const heldMeta = new Promise<void>(resolve => { releaseMeta = resolve })
    let releaseHistory!: () => void
    const heldHistory = new Promise<void>(resolve => { releaseHistory = resolve })
    let releaseBrowse!: () => void
    const heldBrowse = new Promise<void>(resolve => { releaseBrowse = resolve })
    let holdBrowse = false
    const page = await prepare("electron", false, async page => {
      await page.route(/\/api\/meta$/, async route => {
        if (new URL(route.request().url()).pathname === "/api/meta") await heldMeta
        await route.continue()
      })
      await page.route("**/api/storage/state/ui", async route => {
        if (route.request().method() === "PATCH") await heldHistory
        await route.continue()
      })
      await page.route("**/api/remote-servers/a/browse", async route => {
        if (holdBrowse) await heldBrowse
        await route.continue()
      })
    })
    try {
      await select(page, "a")
      const browse = blank(page).locator(".remote-server-browser")
      assert.equal(await browse.count(), 0, "the native selection waits for the host's capabilities")
      releaseMeta()
      await browse.getByRole("button", { name: "app", exact: true }).click()
      await browse.getByRole("button", { name: "Open", exact: true }).click()
      await page.getByRole("tab", { name: /Alpha/ }).waitFor()
      holdBrowse = true
      await select(page, "a")
      const recents = blank(page).getByRole("region", { name: "Recent tabs", exact: true })
      await recents.getByRole("button", { name: /^app · Alpha ·/ }).waitFor()
      assert.equal(await recents.locator(".folder-home-recent-item").count(), 1)
      assert.equal(state.remoteProjectHistory, undefined, "the new shortcut appears before the host history write")
    } finally {
      releaseMeta()
      releaseHistory()
      releaseBrowse()
      a.state.recents = shortcuts
      await page.close()
      delete state.remoteProjectHistory
    }
  })
  await t.test("a recent row opens another occurrence even if host history publishes during creation", async () => {
    const page = await prepare(), before = mutations.length
    let releaseHistory!: () => void
    const heldHistory = new Promise<void>(resolve => { releaseHistory = resolve })
    try {
      await select(page, "a")
      await openSame(page).click()
      await blank(page).waitFor({ state: "detached" })
      // The first opening's write precedes the next one in the owner queue.
      await page.waitForFunction(async () => !!(await import("/src/stores/preferences.tsx")).remoteProjectHistory().recents.length)
      await page.route("**/api/storage/state/ui", async route => {
        if (route.request().method() === "PATCH") await heldHistory
        await route.continue()
      })
      await select(page, "a")
      const oldTab = "instance:a~w"
      await blank(page).getByRole("button", { name: /^Switch to open project · Same ·/ }).click()
      assert.equal(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot().active), oldTab)
      assert.equal(mutations.slice(before).filter(value => value === "a:POST").length, 1)

      await select(page, "a")
      nextWorkspaceId = "duplicate"
      holdCreate = true
      const entered = new Promise<void>(resolve => { createEntered = resolve })
      await page.evaluate(() => {
        const w = window as any
        w.__openingGate = (phase: string, _value: unknown, signal: AbortSignal) => {
          if (phase === "ensure") w.duplicateSignal = signal
        }
      })
      await openSame(page).click()
      await entered
      const historyRequested = page.waitForRequest(request => request.method() === "PATCH" && request.url().endsWith("/api/storage/state/ui"))
      void historyRequested.catch(() => {})
      await page.evaluate(async () => {
        const { editRemoteProjectRecents } = await import("/src/stores/preferences.tsx")
        const { remoteProjectRecentKey } = await import("/src/lib/remote-project-recent-data.ts")
        ;(window as any).historyWrite = editRemoteProjectRecents(({ recents }) => ({
          [remoteProjectRecentKey(recents[0]!)]: { lastAccessed: Date.now() + 1000 },
        }))
      })
      await historyRequested
      const historyUpdated = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/api/storage/state/ui"))
      releaseHistory()
      await historyUpdated
      // Wait for the actual store publication before releasing the pending creation.
      await page.evaluate(() => (window as any).historyWrite)
      assert.equal(await page.evaluate(() => (window as any).duplicateSignal.aborted), false, "the history refresh did not dispose the opening row")
      const send = hold; hold = undefined; send?.()
      await blank(page).waitFor({ state: "detached" })
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
        tabs: [{ id: "instance:w", kind: "instance" }, { id: oldTab, kind: "instance" }, { id: "instance:a~duplicate", kind: "instance" }],
        active: "instance:a~duplicate",
      })
      await page.waitForFunction(async () => {
        const { __openingReceipts } = await import("/src/stores/instances.ts") as any
        return !__openingReceipts().some((receipt: { backendId: string }) => receipt.backendId === "a")
      })
      assert.deepEqual(mutations.slice(before), ["a:POST", "a:/w/creation/release:POST", "a:POST", "a:/duplicate/creation/release:POST"])
    } finally {
      releaseHistory()
      holdCreate = false
      nextWorkspaceId = "w"
      const send = hold; hold = undefined; send?.()
      createEntered = undefined
      await page.close()
      delete state.remoteProjectHistory
    }
  })
  await t.test("the Open action selects the restore placeholder without creation or implicit retry", async () => {
    const page = await prepare(), before = mutations.length
    try {
      await page.evaluate(() => (window as any).remoteOpenFixture.addWaiting("a"))
      await select(page, "a")
      const waiting = await page.evaluate(() => (window as any).remoteOpenFixture.waiting())
      await blank(page).getByRole("button", { name: /^Switch to open project · Same ·/ }).click()
      await blank(page).waitFor({ state: "detached" })
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
        tabs: [{ id: "instance:w", kind: "instance" }, { id: "waiting:a", kind: "remote-restore" }], active: "waiting:a",
      })
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.waiting()), waiting)
      assert.deepEqual(mutations.slice(before), [])
    } finally { await page.close() }
  })
  for (const boundary of ["commit-microtask", "post-create", "pre-publication", "ensure", "inventory"] as const) await t.test(`${boundary} settles stale A before any tab transfer`, async () => {
    const page = await prepare(), before = mutations.length
    failInventory = boundary === "inventory"
    try {
      await page.evaluate(boundary => {
        const w = window as any
        if (boundary === "commit-microtask") w.__onCreateCommit = () => queueMicrotask(() => w.remoteOpenFixture.select("b"))
        else w.__openingGate = (phase: string) => {
          if (phase !== boundary && !(boundary === "inventory" && phase === "ensure")) return
          return new Promise<void>(resolve => { w.__boundary = { phase, resume: resolve } })
        }
      }, boundary)
      await select(page, "a")
      const cancel = page.waitForResponse(response => response.url().includes("/backends/a/api/workspaces/creation/cancel"))
      void cancel.catch(() => undefined)
      await openSame(page).click()
      if (boundary !== "commit-microtask") {
        await page.waitForFunction(() => !!(window as any).__boundary)
        if (boundary === "inventory") {
          failInventory = false
          await page.evaluate(() => (window as any).__boundary.resume())
          await page.waitForFunction(() => (window as any).__boundary?.phase === "inventory")
          assert.equal(await page.evaluate(() => (window as any).remoteOpenFixture.state("a")), "compatible")
        }
        await select(page, "b")
        await page.evaluate(() => (window as any).__boundary.resume())
      }
      await serverName(page, "Beta").waitFor()
      const records = await page.evaluate(() => (window as any).remoteOpenFixture.records())
      assert.deepEqual(records, ["w"], "stale A leaves no orphan occurrence")
      if (boundary !== "ensure" && boundary !== "inventory") await cancel
      const snapshot = await page.evaluate(() => (window as any).remoteOpenFixture.snapshot())
      assert.deepEqual(snapshot.tabs.map((tab: { kind: string }) => tab.kind), ["instance", "blank"])
      assert.equal(snapshot.active, snapshot.tabs.at(-1).id)
      const receipts = await page.evaluate(async () => (await import("/src/stores/instances.ts") as any).__openingReceipts())
      assert.equal(receipts.some((r: any) => r.backendId === "a"), false, "the exact stale receipt is settled")
      assert.deepEqual(mutations.slice(before), boundary === "ensure" || boundary === "inventory" ? [] : ["a:POST", "a:/creation/cancel:POST"])
    } finally {
      failInventory = false
      await page.evaluate(() => { (window as any).__boundary?.resume(); (window as any).__openingGate = undefined })
      await page.close()
    }
  })
  await t.test("tab transfer retains A through a later intent while its captured release completes", async () => {
    const page = await prepare(), before = mutations.length
    try {
      await page.evaluate(async () => {
        ;(window as any).__openingReceipts = (await import("/src/stores/instances.ts") as any).__openingReceipts
      })
      await page.evaluate(() => { (window as any).__afterTabSelection = () => (window as any).remoteOpenFixture.select("b") })
      await select(page, "a")
      const released = page.waitForResponse(response => response.url().includes("/backends/a/api/workspaces/w/creation/release"))
      void released.catch(() => undefined)
      await openSame(page).click()
      await serverName(page, "Beta").waitFor()
      await released
      await page.waitForFunction(() => !(window as any).__openingReceipts().some((r: any) => r.backendId === "a"))
      const snapshot = await page.evaluate(() => (window as any).remoteOpenFixture.snapshot())
      assert.deepEqual(snapshot.tabs.map((tab: { kind: string }) => tab.kind), ["instance", "blank", "instance"])
      assert.equal(snapshot.tabs.at(-1).id, "instance:a~w")
      assert.equal(snapshot.active, snapshot.tabs[1].id)
      assert.deepEqual(mutations.slice(before), ["a:POST", "a:/w/creation/release:POST"])
    } finally { await page.close() }
  })
  for (const host of ["electron", "tauri"] as const) await t.test(`${host} late native reply owns only its selection, never a project occurrence`, async () => {
    const main = await prepare(), preferences = await prepare(host, true), before = mutations.length
    let accept!: () => void, entered!: () => void
    const accepted = new Promise<void>(resolve => { accept = resolve })
    const delivered = new Promise<void>(resolve => { entered = resolve })
    try {
      await preferences.exposeFunction("__nativeSelect", async (intent: unknown) => {
        await main.evaluate(intent => window.__CODENOMAD_SELECT_SERVER__!(intent), intent)
        entered(); await accepted
      })
      await preferences.evaluate(({ host, intent }) => {
        const w = window as any
        if (host === "electron") w.electronAPI.selectServer = (target: unknown) => w.__nativeSelect(target)
        else w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => command === "preferences_select_server" ? w.__nativeSelect(args.intent) : Promise.resolve()
        w.__reply = import("/src/lib/native/server-selection.ts").then(module => module.requestServerSelection(intent))
        void w.__reply.catch(() => undefined)
      }, { host, intent: { id: "a", baseUrl: a.origin, skipTlsVerify: false } })
      await delivered
      await serverName(main, "Alpha").waitFor()
      const released = main.waitForResponse(response => response.url().includes("/backends/a/api/workspaces/w/creation/release"))
      void released.catch(() => undefined)
      await openSame(main).click()
      await blank(main).waitFor({ state: "detached" })
      await released
      await select(main, "b")
      accept(); await preferences.evaluate(() => (window as any).__reply)
      await serverName(main, "Beta").waitFor()
      assert.equal(await main.locator(".remote-server-browser").count(), 1)
      assert.deepEqual(await main.evaluate(() => (window as any).remoteOpenFixture.records()), ["w", "a~w"])
      assert.match(await main.evaluate(() => (window as any).remoteOpenFixture.snapshot().active), /^blank:/)
      assert.deepEqual(mutations.slice(before), ["a:POST", "a:/w/creation/release:POST"])
    } finally { accept(); await preferences.close(); await main.close() }
  })
  for (const host of ["electron", "web"] as const) await t.test(`${host}: inline navigation, mixed recents, server labels and ordinary instance tabs`, async () => {
    delete state.remoteProjectRecents
    delete state.remoteProjectHistory
    const page = await prepare(host), pathStart = paths.length
    const aRequestStart = a.state.requests.length
    await page.evaluate(() => (window as any).remoteOpenFixture.openBlankTab())
    await page.getByRole("button", { name: "Open a project on Alpha" }).click()
    const inline = page.locator(".browse-menu")
    await page.getByRole("button", { name: /^Same · Alpha ·/ }).waitFor()
    await inline.getByRole("button", { name: "app", exact: true }).press("Enter")
    await inline.getByRole("button", { name: /Parent/ }).click()
    await inline.getByRole("button", { name: "Back to Browse" }).click()
    assert.equal(await page.getByRole("button", { name: /^Same · Alpha ·/ }).count(), 0, "returning restores mixed recents without importing the server's shortcuts")
    assert.equal(state.remoteProjectHistory, undefined, "browse does not record opened folders")
    assert.ok(a.state.requests.slice(aRequestStart).some(request => request.path === "/api/storage/state/ui"), "the chosen server supplies its own recents")
    const alpha = page.getByRole("button", { name: /^app · Alpha ·/ })
    const alphaRow = alpha.locator("xpath=ancestor::*[contains(@class,'folder-home-recent-item')][1]")
    const actions = alphaRow.locator(".action-overflow-trigger")
    await page.getByRole("button", { name: "Open a project on Alpha" }).click()
    await inline.getByRole("button", { name: "app", exact: true }).click()
    await inline.getByRole("button", { name: "Open", exact: true }).click()
    await page.waitForFunction(() => (window as any).remoteOpenFixture.snapshot().active === "instance:a~w", undefined, { timeout: 5_000 })
    const alphaTab = page.getByRole("tab", { name: /Alpha/ })
    await alphaTab.waitFor({ timeout: 5_000 })
    assert.equal(await alphaTab.locator(".tab-label").textContent(), "app")
    await page.evaluate(() => (window as any).remoteOpenFixture.openBlankTab())
    await page.getByRole("button", { name: "Open a project on Beta" }).click()
    await inline.getByRole("button", { name: "app", exact: true }).click()
    await inline.getByRole("button", { name: "Open", exact: true }).click()
    await page.getByRole("tab", { name: /Beta/ }).waitFor({ timeout: 5_000 })
    assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
      tabs: [{ id: "instance:w", kind: "instance" }, { id: "instance:a~w", kind: "instance" }, { id: "instance:b~w", kind: "instance" }],
      active: "instance:b~w",
    })
    assert.deepEqual(paths.slice(pathStart), ["a:/srv/projects/app", "b:/srv/projects/app"])
    assert.equal(local.includes("POST /api/workspaces"), false)
    assert.equal(await page.locator("webview, iframe").count(), 0)
    await page.getByRole("button", { name: "Fixture launcher" }).click()
    await page.locator(".new-instance-launcher").getByRole("button", { name: /^Switch to open project · app · Alpha ·/ }).click()
    await page.waitForFunction(() => (window as any).remoteOpenFixture.snapshot().active === "instance:a~w")
    await page.locator(".new-instance-launcher").waitFor({ state: "detached" })
    assert.deepEqual(paths.slice(pathStart), ["a:/srv/projects/app", "b:/srv/projects/app"], "launcher did not create a duplicate")
    await page.evaluate(() => (window as any).remoteOpenFixture.openBlankTab())
    await alpha.waitFor()
    assert.equal(await actions.count(), 1, "the persisted recent offers its actions")
    await page.getByRole("button", { name: /^app · Beta ·/ }).waitFor()
    await select(page, "a"); await blank(page).getByRole("button", { name: "Close new tab" }).click()
    assert.equal(await page.locator("[data-project-tabs]").getByRole("tab").count(), 3)
    const persisted = readRemoteProjectHistory(state.remoteProjectRecents, state.remoteProjectHistory).recents
    assert.ok(Array.isArray(persisted) && persisted.length === 2)
    assert.doesNotMatch(JSON.stringify(persisted), /must-not-leak/)
    const unsolicited: string[] = []
    page.on("request", request => { if (/\/api\/(?:remote-servers|backends)\//.test(request.url())) unsolicited.push(request.url()) })
    await page.reload()
    await page.waitForFunction(() => !!(window as any).remoteOpenFixture)
    await page.evaluate(() => (window as any).remoteOpenFixture.openBlankTab())
    await alpha.waitFor()
    await page.getByRole("button", { name: /^app · Beta ·/ }).waitFor()
    assert.deepEqual(unsolicited, [], "displaying persisted recents after reload does not dial a server")
    // The destination itself also remembers this exact folder, independently of the host shortcut.
    a.state.recents.push({ path: "/srv/projects/app", projectName: "app", lastAccessed: 42, password: "must-not-leak" })
    try {
      await actions.click()
      await page.getByRole("menuitem", { name: "Remove from recent", exact: true }).click()
      await alpha.waitFor({ state: "detached" })
      await page.getByRole("button", { name: "Open a project on Alpha" }).click()
      await inline.getByRole("button", { name: "app", exact: true }).click()
      const open = inline.getByRole("button", { name: "Open", exact: true })
      await inline.getByRole("button", { name: /Parent/ }).waitFor()
      assert.equal(readRemoteProjectHistory(state.remoteProjectRecents, state.remoteProjectHistory).recents.some(row => row.policy.id === "a"), false,
        "browsing the exact removed folder does not re-add it to the host history")
      await open.click()
      await page.getByRole("tab", { name: /Alpha/ }).waitFor({ timeout: 5_000 })
      await page.evaluate(() => (window as any).remoteOpenFixture.openBlankTab())
      await alpha.waitFor({ timeout: 5_000 })
    } finally {
      a.state.recents.pop()
    }
    await page.close()
  })
  const alphaPolicy = { id: "a", baseUrl: a.origin, skipTlsVerify: false }
  await t.test("server opens at the last path, with explicit recovery at its root", async () => {
    delete state.remoteProjectHistory
    state.remoteProjectRecents = [{ policy: alphaPolicy, path: "/moved", lastAccessed: 42 }]
    const page = await prepare()
    const reads: (string | null)[] = []
    try {
      let failure = 400
      a.state.handlers.set("/api/filesystem", (request, response) => {
        const folder = new URL(request.url!, a.origin).searchParams.get("path")
        reads.push(folder)
        response.writeHead(folder ? failure : 200, { "content-type": "application/json" })
        response.end(JSON.stringify(folder ? { error: "directory unavailable" } : {
          entries: [{ name: "Replacement", type: "directory", path: "/replacement" }],
          metadata: { scope: "unrestricted", currentPath: "/", displayPath: "/", rootPath: "/", homePath: "/", pathKind: "absolute" },
        }))
      })
      await page.evaluate(() => (window as any).remoteOpenFixture.openBlankTab())
      await page.getByRole("button", { name: "Open a project on Alpha" }).click()
      const root = page.getByRole("button", { name: "Server root" })
      await root.waitFor({ timeout: 5_000 })
      assert.deepEqual(reads, ["/moved"])
      await root.click()
      await page.getByRole("button", { name: "Replacement" }).waitFor({ timeout: 5_000 })
      assert.deepEqual(reads, ["/moved", null])
      for (const code of [426, 503]) {
        failure = code
        await page.getByRole("button", { name: "Back to Browse" }).click()
        await page.getByRole("button", { name: "Open a project on Alpha" }).click()
        await page.locator(".browse-menu [role=alert]").waitFor()
        assert.equal(await root.count(), 0, `HTTP ${code} is not a path failure`)
        assert.equal(reads.at(-1), "/moved")
      }
    } finally { a.state.handlers.delete("/api/filesystem"); await page.close(); delete state.remoteProjectRecents }
  })
  for (const phase of ["success", "failure"] as const) await t.test(`keyboard server add in Browse: ${phase}`, async () => {
    const page = await prepare()
    await page.evaluate(() => (window as any).remoteOpenFixture.openBlankTab())
    let release = () => {}
    let begin = () => {}
    const entered = new Promise<void>(resolve => { begin = resolve })
    try {
      await page.route("**/api/remote-servers/probe", async route => {
        begin()
        await new Promise<void>(resolve => { release = resolve })
        await route.fulfill({ json: phase === "failure"
          ? { ok: false, errorCode: "unreachable" }
          : { ok: true, normalizedUrl: "https://new.example" } }).catch(() => undefined)
      })
      const panel = page.locator(".browse-menu")
      const field = panel.locator("[data-server-add-field]")
      await field.fill("https://new.example")
      await field.press("Enter")
      await entered
      release()
      if (phase === "success") {
        const row = panel.getByRole("button", { name: "Open a project on new.example", exact: true })
        await row.waitFor()
        await page.waitForFunction(() => document.activeElement?.getAttribute("title") === "https://new.example")
        assert.equal(await panel.locator(".remote-server-browser").count(), 0, "saving focuses the row without opening the server")
      } else if (phase === "failure") {
        await panel.locator(".server-add-field-error").waitFor()
        assert.equal(await field.evaluate(el => el === document.activeElement), true)
      }
    } finally { release(); await page.close(); state.remoteServers = profiles }
  })
  for (const mode of ["button", "escape", "flag"] as const) await t.test(`direct recent opening is cancelled by ${mode}`, async () => {
    state.remoteProjectRecents = [{ policy: alphaPolicy, path: "/same", projectName: "Same", lastAccessed: 42 }]
    const page = await prepare()
    const start = mutations.length
    try {
      await page.evaluate(`window.__openingGate = async (phase, _value, signal) => {
        if (phase !== "ensure") return
        window.heldRecent = { signal }
        await new Promise(resolve => { window.heldRecent.resume = resolve })
      }`)
      const anchor = page.getByRole("button", { name: "Fixture launcher" })
      await anchor.click()
      const popup = page.locator(".new-instance-launcher")
      assert.equal(await popup.locator(".browse-menu").count(), 0)
      const search = popup.getByRole("searchbox")
      await search.fill("Same")
      const recent = popup.getByRole("button", { name: /^Same · Alpha ·/ })
      await recent.waitFor({ timeout: 5_000 })
      await search.press("Enter")
      await page.waitForFunction(`Boolean(window.heldRecent?.resume)`, undefined, { timeout: 5_000 })
      const cancel = popup.getByRole("button", { name: "Back to Browse", exact: true })
      await cancel.waitFor({ timeout: 5_000 })
      assert.equal(await cancel.evaluate(el => document.activeElement === el), true)
      if (mode === "flag") {
        await page.evaluate(() => (window as any).remoteOpenFixture.disable())
        await cancel.waitFor({ state: "detached" })
        await page.evaluate(() => (window as any).remoteOpenFixture.enable())
        await recent.waitFor()
      } else {
        if (mode === "button") await cancel.click()
        else await page.keyboard.press("Escape")
        assert.equal(await recent.evaluate(el => document.activeElement === el), true)
        await page.keyboard.press("Escape")
        await popup.waitFor({ state: "detached" })
        await page.waitForFunction(`document.activeElement?.textContent === "Fixture launcher"`, undefined, { timeout: 5_000 })
      }
      assert.equal(await page.evaluate(`window.heldRecent.signal.aborted`), true)
      await page.evaluate(`window.heldRecent.resume()`)
      assert.deepEqual(mutations.slice(start), [])
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
        tabs: [{ id: "instance:w", kind: "instance" }], active: "instance:w",
      })
    } finally {
      await page.evaluate(`window.heldRecent?.resume()`).catch(() => {})
      if (!ui.settings.multiBackend) await page.evaluate(() => (window as any).remoteOpenFixture.enable())
      await page.close()
      delete state.remoteProjectRecents
    }
  })
  await t.test("Escape returns to Browse, cancelling only its in-flight opening", async () => {
    const page = await prepare(), before = mutations.length
    holdCreate = true
    const entered = new Promise<void>(resolve => { createEntered = resolve })
    const cancelled = new Promise<void>(resolve => { cancelEntered = resolve })
    try {
      await select(page, "a")
      await openFolder(page).click()
      await entered
      await browserInBlank(page).getByRole("button", { name: "Back to Browse", exact: true }).press("Escape")
      await browserInBlank(page).waitFor({ state: "detached" })
      await cancelled
      assert.match(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot().active), /^blank:/)
      await blank(page).getByRole("button", { name: "Close new tab" }).click()
      assert.equal(await page.locator("[data-project-tabs]").getByRole("tab").count(), 1)
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
      const page = await prepare(), before = mutations.length
      try {
        await select(page, "b")
        await openFolder(page).waitFor()
        refusal = verdict
        await openFolder(page).click()
        await browserInBlank(page).getByRole("alert").filter({ hasText: "Incompatible CodeNomad server." }).waitFor()
        assert.equal(await page.evaluate(() => (window as any).remoteOpenFixture.state("b")), "refused")
        assert.equal(mutations.length, before)
        assert.equal(await page.locator("[data-project-tabs]").getByRole("tab").count(), 1)
      } finally { refusal = undefined; await page.close() }
    }
  })
  await t.test("same-policy reselection retains its in-flight opening and releases the selected occurrence", async () => {
    const page = await prepare(), before = mutations.length
    holdCreate = true
    const entered = new Promise<void>(resolve => { createEntered = resolve })
    try {
      await select(page, "a")
      await openFolder(page).click()
      await entered
      await select(page, "a")
      const released = page.waitForResponse(response => response.url().includes("/w/creation/release"))
      void released.catch(() => undefined)
      const send = hold; hold = undefined; send?.()
      await blank(page).waitFor({ state: "detached" })
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
  for (const mode of ["different-server", "cancel-reselect", "rapid-a-b-a"] as const) await t.test(`${mode} disposes the old browser before opening only the current selection`, async () => {
    const page = await prepare(), before = mutations.length
    holdCreate = true
    const entered = new Promise<void>(resolve => { createEntered = resolve })
    const cancelled = new Promise<void>(resolve => { cancelEntered = resolve })
    const target = mode === "different-server" ? "b" : "a"
    try {
      await select(page, "a")
      await openFolder(page).click()
      await entered
      await page.evaluate(() => {
        ;(window as any).oldBrowser = document.querySelector(".remote-server-browser")
      })
      const blankId = await page.evaluate(() => (window as any).remoteOpenFixture.snapshot().active)
      if (mode !== "cancel-reselect") {
        await select(page, "b")
        if (mode === "rapid-a-b-a") await select(page, "a")
      }
      else {
        await browserInBlank(page).getByRole("button", { name: "Back to Browse", exact: true }).press("Escape")
        await browserInBlank(page).waitFor({ state: "detached" })
      }
      await cancelled
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
        tabs: [{ id: "instance:w", kind: "instance" }, { id: blankId, kind: "blank" }], active: blankId,
      })
      if (mode !== "cancel-reselect") {
        const name = target === "b" ? "Beta" : "Alpha"
        await serverName(page, name).waitFor()
        await openFolder(page).waitFor()
        assert.equal(await page.locator(".remote-server-browser").count(), 1)
        const ids = await blank(page).locator("[id]").evaluateAll(nodes => nodes.map(node => node.id))
        assert.equal(new Set(ids).size, ids.length, "empty-tab IDs remain unique")
      }
      assert.equal(await page.evaluate(() => (window as any).oldBrowser.isConnected), false)
      holdCreate = false
      const send = hold; hold = undefined; send?.()
      if (mode === "cancel-reselect") await select(page, "a")
      const released = page.waitForResponse(response => response.url().includes(`/backends/${target}/api/workspaces/w/creation/release`))
      void released.catch(() => undefined)
      await openFolder(page).click()
      await blank(page).waitFor({ state: "detached" })
      await released
      assert.deepEqual(await page.evaluate(() => (window as any).remoteOpenFixture.snapshot()), {
        tabs: [{ id: "instance:w", kind: "instance" }, { id: `instance:${target}~w`, kind: "instance" }],
        active: `instance:${target}~w`,
      })
      assert.deepEqual((await page.evaluate(() => (window as any).remoteOpenFixture.records())).sort(), ["w", `${target}~w`].sort())
      assert.equal(await page.evaluate(target => (window as any).remoteOpenFixture.details(`${target}~w`).binaryLabel, target), "fresh-current")
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
      await page.evaluate(() => (window as any).remoteOpenFixture.openBlankTab())
      await page.getByRole("button", { name: "Open a project on Alpha" }).click()
      const inline = page.locator(".browse-menu")
      await inline.getByLabel("Password", { exact: true }).fill("remote-password")
      a.state.overrides.delete("/api/filesystem")
      await inline.getByRole("button", { name: "Sign in", exact: true }).click()
      await inline.getByRole("button", { name: "app", exact: true }).waitFor()
      assert.equal(a.state.logins, logins + 1)
      assert.equal(await inline.getByLabel("Password", { exact: true }).count(), 0)
      assert.equal((await page.locator("body").innerText()).includes("remote-password"), false)
    } finally { a.state.overrides.delete("/api/filesystem"); await page.close() }
  })
  await t.test("a remote browser can sign in to the second saved server and open a project", async () => {
    const logins = b.state.logins
    const status = b.state.handlers.get("/api/auth/status")
    b.state.handlers.set("/api/auth/status", (request, response) => {
      const cookie = request.headers.cookie?.match(/(?:^|; )codenomad_session=([^;]+)/)?.[1]
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ authenticated: !!cookie && b.state.sessions.has(cookie) }))
    })
    const page = await prepare("web")
    try {
      await page.evaluate(() => (window as any).remoteOpenFixture.openBlankTab())
      await page.getByRole("button", { name: "Open a project on Beta" }).click()
      const inline = page.locator(".browse-menu")
      const password = inline.getByLabel("Password", { exact: true })
      await password.fill("remote-password")
      const connected = page.waitForResponse(response => new URL(response.url()).pathname === "/api/remote-servers/b/connect")
      await password.press("Enter")
      assert.equal((await connected).status(), 200)
      await inline.getByRole("button", { name: "app", exact: true }).click()
      await inline.getByRole("button", { name: "Open", exact: true }).click()
      await page.getByRole("tab", { name: /Beta/ }).waitFor()
      assert.equal(b.state.logins, logins + 1)
      assert.equal(b.state.requests.findLast(request => request.path === "/api/auth/login")?.headers.origin, b.origin)
    } finally {
      if (status) b.state.handlers.set("/api/auth/status", status)
      else b.state.handlers.delete("/api/auth/status")
      await page.close()
    }
  })
  await t.test("flag revocation cancels browsing without affecting a local tab", async () => {
    const page = await prepare()
    const before = mutations.length
    await select(page, "a")
    await openFolder(page).waitFor()
    await page.evaluate(() => (window as any).remoteOpenFixture.disable())
    await browserInBlank(page).waitFor({ state: "detached" })
    await blank(page).getByRole("button", { name: "This computer", exact: true }).waitFor()
    const rejected = await page.evaluate(intent => {
      try { window.__CODENOMAD_SELECT_SERVER__!(intent); return false }
      catch { return true }
    }, { id: "a", baseUrl: a.origin, skipTlsVerify: false })
    assert.equal(rejected, true, "stale native selection fails closed")
    assert.equal(mutations.length, before)
    assert.equal(await page.locator("[data-project-tabs]").getByRole("tab").count(), 1)
    await page.close()
  })
  assert.deepEqual(errors, [])
  assert.equal(local.some(request => /install|provision|download/.test(request)), false)
})
