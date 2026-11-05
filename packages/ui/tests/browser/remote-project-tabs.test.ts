import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"

// The real application (src/main.tsx) in three roles: the page a remote server
// serves inside a host tab (?codenomadEmbed=project), a web or Remote Control
// client, and a local Electron window hosting remote project tabs.
let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "remote-project-tabs",
    routes: [{ path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>" }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const BOX = "https://box.example"
const server = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id === "box" ? "Box" : id, baseUrl: id === "box" ? BOX : `https://${id}.example`, skipTlsVerify: false,
  createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", ...extra,
})

interface Scenario {
  context?: "local" | "remote"
  host?: "electron" | "web"
  uiState?: Record<string, unknown>
  /** A saved native session, restored by a local Electron window. */
  restore?: unknown
}

async function open(page: Page, path: string, scenario: Scenario) {
  const { context, host = "web", uiState = {}, restore } = scenario
  await page.addInitScript({ content: `{
    const w = window, context = ${JSON.stringify(context ?? null)}, host = ${JSON.stringify(host)}, restore = ${JSON.stringify(restore ?? null)}
    if (context) w.__CODENOMAD_WINDOW_CONTEXT__ = context
    if (host !== "web") w.__CODENOMAD_RUNTIME_HOST__ = host
    w.fixtureViews = { opened: [], updates: [], closed: [], listeners: [], windows: [] }
    w.EventSource = class extends EventTarget { close() {} }
    // Fixture shim: the session list's virtualizer reads defaultView from nodes the dev
    // server's templates create in an inert document before they are inserted.
    const defaultView = Object.getOwnPropertyDescriptor(Document.prototype, "defaultView")
    Object.defineProperty(Document.prototype, "defaultView", { configurable: true, get() { return defaultView.get.call(this) ?? w } })
    if (host === "electron" && context === "local") {
      const known = {
        claimClientStateAccess: async () => Boolean(restore),
        loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: restore }),
        openRemoteView: async (payload) => { w.fixtureViews.opened.push(payload) },
        updateRemoteView: async (payload) => { w.fixtureViews.updates.push(payload) },
        closeRemoteView: async (viewId) => { w.fixtureViews.closed.push(viewId) },
        onRemoteViewUpdated: (callback) => { w.fixtureViews.listeners.push(callback); return () => {} },
        openRemoteWindow: async (payload) => { w.fixtureViews.windows.push(payload) },
        getZoomFactor: () => 1,
      }
      // Every other host call resolves to nothing and every subscription to a no-op disposer.
      w.electronAPI = new Proxy(known, { get: (target, key) => key in target ? target[key]
        : typeof key !== "string" ? undefined : /^on[A-Z]/.test(key) ? () => () => {} : async () => undefined })
    }
  }` })
  const created: string[] = []
  let state = uiState
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (pathname === "/api/workspaces" && request.method() === "POST") {
      const body = request.postDataJSON() as { path: string }
      created.push(body.path)
      return route.fulfill({ json: {
        id: `ws-${created.length}`, path: body.path, status: "starting", proxyPath: `/workspaces/ws-${created.length}/instance`,
        binaryId: "fixture", binaryLabel: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      } })
    }
    if (pathname === "/api/remote-servers/probe") {
      const { baseUrl, skipTlsVerify } = request.postDataJSON() as { baseUrl: string; skipTlsVerify?: boolean }
      return route.fulfill({ json: { ok: true, reachable: true, normalizedUrl: baseUrl, skipTlsVerify: Boolean(skipTlsVerify), requiresAuth: true, authenticated: false } })
    }
    if (pathname === "/api/storage/state/ui" && request.method() === "PATCH") {
      state = { ...state, ...(request.postDataJSON() as Record<string, unknown>) }
      return route.fulfill({ json: state })
    }
    const body = pathname === "/api/workspaces" ? []
      : pathname === "/api/storage/config/ui" ? { settings: { locale: "en" } }
      : pathname === "/api/storage/state/ui" ? state : {}
    await route.fulfill({ json: body })
  })
  await page.goto(`${url}${path}`)
  return { created, state: () => state }
}

const views = (page: Page) => page.evaluate(() => (window as any).fixtureViews as {
  opened: Array<{ viewId: string; profileId: string; baseUrl: string; url: string; bounds: { width: number; height: number } }>
  updates: Array<{ viewId: string; visible: boolean }>; closed: string[]; windows: Array<{ id: string }>
})

test("the embedded page shows no tab bar or home, only a folder picker that opens one project", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  try {
    const fixture = await open(page, "?codenomadEmbed=project", {
      context: "remote", host: "electron",
      uiState: { recentFolders: [{ path: "/srv/app", projectName: "App", lastAccessed: 2 }] },
    })
    const picker = page.locator("[data-embedded-project-picker]")
    await picker.waitFor()
    assert.equal(await page.locator(".tab-bar-instance").count(), 0)
    assert.equal(await page.locator(".folder-home-root").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Remotes" }).count(), 0)
    await picker.getByRole("button", { name: "Browse Folders" }).waitFor()
    await picker.getByRole("button", { name: /App/ }).click()
    await page.waitForFunction(() => document.title === "App")
    assert.deepEqual(fixture.created, ["/srv/app"])
    const search = new URL(page.url()).searchParams
    assert.equal(search.get("codenomadEmbed"), "project")
    assert.equal(search.get("folder"), "/srv/app")
    assert.equal(await page.locator(".tab-bar-instance").count(), 0)
  } finally { await page.close() }
})

test("an embedded entry with a folder opens that project directly and reselects its remembered session", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  try {
    // The view's storage persists with the server's remote window across host restarts.
    await page.addInitScript(() => localStorage.setItem("codenomad:embedded-session:/srv/other", "ses_saved"))
    const sessionReads: string[] = []
    page.on("request", request => { if (request.url().includes("ses_saved")) sessionReads.push(request.url()) })
    const fixture = await open(page, `?codenomadEmbed=project&folder=${encodeURIComponent("/srv/other")}`, { context: "remote", host: "electron" })
    await page.waitForFunction(() => document.title === "other")
    assert.deepEqual(fixture.created, ["/srv/other"])
    assert.equal(await page.locator("[data-embedded-project-picker]").count(), 0)
    // The remembered session is read back for selection, as a restored local tab's is.
    for (let attempt = 0; attempt < 50 && !sessionReads.length; attempt++) await page.waitForTimeout(100)
    assert.ok(sessionReads.length > 0, "the remembered session is hydrated")
    assert.equal(await page.evaluate(() => localStorage.getItem("codenomad:embedded-session:/srv/other")), "ses_saved",
      "the empty startup selection does not overwrite the remembered session")
  } finally { await page.close() }
})

test("an embedded project without a remembered session reads none", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  try {
    const sessionReads: string[] = []
    page.on("request", request => { if (/\/session\/ses_/.test(request.url())) sessionReads.push(request.url()) })
    await open(page, `?codenomadEmbed=project&folder=${encodeURIComponent("/srv/fresh")}`, { context: "remote", host: "electron" })
    await page.waitForFunction(() => document.title === "fresh")
    await page.waitForTimeout(500)
    assert.deepEqual(sessionReads, [])
  } finally { await page.close() }
})

test("without the parameter a remote page keeps its full interface and lists no remote servers", async () => {
  for (const scenario of [{ context: "remote", host: "electron" }, {}] as Scenario[]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
    try {
      await open(page, "", { ...scenario, uiState: { remoteServers: [server("box")] } })
      await page.locator(".folder-home-root").waitFor()
      // A web client or Remote Control device never opens another server (no rebound).
      assert.equal(await page.getByRole("button", { name: "Remotes" }).count(), 0)
    } finally { await page.close() }
  }
})

test("a local window opens a saved server as a project tab whose view follows the project it shows", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box"), server("lab", { skipTlsVerify: true })] } })
    await page.getByRole("button", { name: "Remotes" }).click()
    await page.getByRole("button", { name: "Open a project on Box" }).click()
    const tab = page.locator(".tab-pill", { hasText: "Box" })
    await tab.waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    const [opened] = (await views(page)).opened
    assert.equal(opened.profileId, "box")
    assert.equal(opened.baseUrl, BOX)
    assert.equal(opened.url, `${BOX}/?codenomadEmbed=project`)
    assert.ok(opened.bounds.width > 100 && opened.bounds.height > 100)

    // The embedded page reports its project: the tab takes its name and the host remembers it.
    await page.evaluate(({ viewId, base }) => {
      for (const listener of (window as any).fixtureViews.listeners) listener({ viewId, url: `${base}/?codenomadEmbed=project&folder=%2Fsrv%2Fapp`, title: "App" })
      // An older server's own title never relabels the tab.
      for (const listener of (window as any).fixtureViews.listeners) listener({ viewId, url: `${base}/?codenomadEmbed=project`, title: "CodeNomad" })
    }, { viewId: opened.viewId, base: BOX })
    const projectTab = page.locator(".tab-pill", { hasText: "App" })
    await projectTab.waitFor()
    // The server icon marks a remote project.
    assert.equal(await projectTab.locator("svg").count() >= 1, true)
    type Saved = { remoteProjectRecents?: Array<{ profileId: string; folder: string; projectName?: string }> }
    for (let attempt = 0; attempt < 50 && !(fixture.state() as Saved).remoteProjectRecents?.length; attempt++) await page.waitForTimeout(100)
    const recents = (fixture.state() as Saved).remoteProjectRecents
    assert.deepEqual(recents?.map(({ profileId, folder, projectName }) => ({ profileId, folder, projectName })), [{ profileId: "box", folder: "/srv/app", projectName: "App" }])

    // A local overlay (the home page) hides the native view; it never covers local dialogs.
    await page.locator(".new-instance-button").click()
    await page.waitForFunction((viewId) => (window as any).fixtureViews.updates.some((update: { viewId: string; visible: boolean }) => update.viewId === viewId && !update.visible), opened.viewId)

    // A server with an unverified certificate keeps its separate window.
    await page.getByRole("button", { name: "Remotes" }).click()
    await page.getByRole("button", { name: "Open a project on lab" }).click()
    await page.waitForFunction(() => (window as any).fixtureViews.windows.length === 1)
    assert.equal((await views(page)).windows[0].id, "lab")
    assert.equal((await views(page)).opened.length, 1)
  } finally { await page.close() }
})

test("a pasted pairing link adds the server and pairs in its new tab; other text is refused", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron" })
    await page.getByRole("button", { name: "Remotes" }).click()
    const field = page.getByRole("textbox", { name: "Add server" })
    await field.fill("http://user:secret@box.example:4096")
    await field.press("Enter")
    await page.getByRole("alert").waitFor()
    assert.equal((await views(page)).opened.length, 0)

    const tunnel = "https://desk.opentunnel.test"
    await field.fill(`${tunnel}/remote-pair#single-use-code`)
    await field.press("Enter")
    await page.locator(".tab-pill", { hasText: "desk.opentunnel.test" }).waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    const [opened] = (await views(page)).opened
    // The code is consumed by the view's first load and never saved with the server.
    assert.equal(opened.url, `${tunnel}/remote-pair#single-use-code`)
    assert.equal(opened.baseUrl, tunnel)
    assert.equal(JSON.stringify(fixture.state()).includes("single-use-code"), false)
    assert.deepEqual((fixture.state() as { remoteServers: Array<{ baseUrl: string }> }).remoteServers.map((entry) => entry.baseUrl), [tunnel])
  } finally { await page.close() }
})

test("a restored window reopens its remote project tabs on their server and folder", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    await open(page, "", {
      context: "local", host: "electron",
      uiState: { remoteServers: [server("box")] },
      restore: { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
        activeTabIndex: 0,
        tabs: [{ kind: "remote-project", profileId: "box", folder: "/srv/app" }, { kind: "remote-project", profileId: "removed" }],
      } },
    })
    await page.locator(".tab-pill", { hasText: "Box" }).waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    const [opened] = (await views(page)).opened
    assert.equal(opened.url, `${BOX}/?codenomadEmbed=project&folder=%2Fsrv%2Fapp`)
    // A removed server's tab is dropped.
    assert.equal(await page.locator(".tab-pill").count(), 1)
  } finally { await page.close() }
})
