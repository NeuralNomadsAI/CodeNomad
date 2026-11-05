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
  host?: "electron" | "tauri" | "web"
  uiState?: Record<string, unknown>
  /** A saved native session, restored by a local Electron window. */
  restore?: unknown
  sidecars?: unknown[]
}

async function open(page: Page, path: string, scenario: Scenario) {
  const { context, host = "web", uiState = {}, restore, sidecars = [] } = scenario
  await page.addInitScript({ content: `{
    const w = window, context = ${JSON.stringify(context ?? null)}, host = ${JSON.stringify(host)}, restore = ${JSON.stringify(restore ?? null)}
    if (context) w.__CODENOMAD_WINDOW_CONTEXT__ = context
    if (host !== "web") w.__CODENOMAD_RUNTIME_HOST__ = host
    w.fixtureViews = { opened: [], updates: [], closed: [], listeners: [], windows: [] }
    w.EventSource = class extends EventTarget { close() {} }
    if (host === "tauri") {
      w.__TAURI__ = { core: { invoke: async () => undefined } }
      w.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        if (command === "open_external_url") w.externalURLs.push(args.url)
      }, transformCallback: () => 1 }
    }
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
  const workspaces: Record<string, unknown>[] = []
  const probes: string[] = []
  let state = uiState
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (pathname === "/api/workspaces" && request.method() === "POST") {
      const body = request.postDataJSON() as { path: string }
      created.push(body.path)
      const workspace = {
        id: `ws-${created.length}`, path: body.path, status: "starting", proxyPath: `/workspaces/ws-${created.length}/instance`,
        binaryId: "fixture", binaryLabel: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      }
      workspaces.push(workspace)
      return route.fulfill({ json: workspace })
    }
    if (pathname === "/api/remote-servers/probe") {
      const { baseUrl, skipTlsVerify } = request.postDataJSON() as { baseUrl: string; skipTlsVerify?: boolean }
      probes.push(`${baseUrl} skipTls=${Boolean(skipTlsVerify)}`)
      // A self-signed server answers only once its certificate check is skipped.
      if (baseUrl.includes("selfsigned") && !skipTlsVerify) {
        return route.fulfill({ json: { ok: false, reachable: false, normalizedUrl: baseUrl, skipTlsVerify: false, requiresAuth: false,
          authenticated: false, error: "Certificate check failed while connecting to the remote server.", errorCode: "tls_error" } })
      }
      return route.fulfill({ json: { ok: true, reachable: true, normalizedUrl: baseUrl, skipTlsVerify: Boolean(skipTlsVerify), requiresAuth: true, authenticated: false } })
    }
    if (pathname === "/api/storage/state/ui" && request.method() === "PATCH") {
      state = { ...state, ...(request.postDataJSON() as Record<string, unknown>) }
      return route.fulfill({ json: state })
    }
    if (pathname === "/api/sidecars") return route.fulfill({ json: { sidecars } })
    const body = pathname === "/api/workspaces" ? workspaces
      : pathname === "/api/storage/config/ui" ? { settings: { locale: "en" } }
      : pathname === "/api/storage/state/ui" ? state : {}
    await route.fulfill({ json: body })
  })
  await page.goto(`${url}${path}`)
  return { created, probes, state: () => state }
}

// Shows Browse: the home page's tab, else the launcher's section, which stays unfolded once opened.
async function browse(page: Page) {
  const tab = page.getByRole("tab", { name: "Browse", exact: true })
  await tab.or(page.locator(".browse-menu-toggle")).first().waitFor()
  if (await tab.count()) return tab.click()
  const toggle = page.getByRole("button", { name: "Browse", exact: true })
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click()
}

// Browse's last row: the field that adds a server and opens it. Enter submits it.
async function addServer(page: Page, address: string) {
  await browse(page)
  const field = page.getByRole("textbox", { name: "Server address or link" })
  await field.fill(address)
  await field.press("Enter")
  return field
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
    assert.equal(await page.locator(".browse-menu").count(), 0)
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
      // A web client or Remote Control device browses only its own folders, never another server (no rebound).
      await browse(page)
      await page.getByRole("button", { name: "This computer", exact: true }).waitFor()
      assert.equal(await page.locator("[data-remote-server]").count(), 0)
      assert.equal(await page.getByRole("button", { name: "New server" }).count(), 0)
      assert.equal(await page.getByRole("textbox", { name: "Server address or link" }).count(), 0)
    } finally { await page.close() }
  }
})

test("a local window opens a saved server as a project tab whose view follows the project it shows", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box"), server("lab", { skipTlsVerify: true })] } })
    await browse(page)
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
    await page.getByRole("button", { name: "Home", exact: true }).click()
    await page.waitForFunction((viewId) => (window as any).fixtureViews.updates.some((update: { viewId: string; visible: boolean }) => update.viewId === viewId && !update.visible), opened.viewId)

    // A server with an unverified certificate keeps its separate window.
    await browse(page)
    await page.getByRole("button", { name: "Open a project on lab" }).click()
    await page.waitForFunction(() => (window as any).fixtureViews.windows.length === 1)
    assert.equal((await views(page)).windows[0].id, "lab")
    assert.equal((await views(page)).opened.length, 1)
  } finally { await page.close() }
})

test("Browse's field opens a pasted pairing link in its tab and refuses an address carrying credentials, without a dialog", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron" })
    const field = await addServer(page, "http://user:secret@box.example:4096")
    await page.getByRole("alert").getByText("Remove the user name and password from the address.").waitFor()
    assert.deepEqual(fixture.probes, [])

    // A pasted link is added at once; its tab opens and consumes the code.
    const tunnel = "https://desk.opentunnel.test"
    await field.fill("")
    await field.evaluate((input, link) => {
      const data = new DataTransfer()
      data.setData("text", link)
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
    }, `${tunnel}/remote-pair#single-use-code`)
    await page.locator(".tab-pill", { hasText: "desk.opentunnel.test" }).waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    const [opened] = (await views(page)).opened
    assert.equal(opened.url, `${tunnel}/remote-pair#single-use-code`)
    assert.equal(opened.baseUrl, tunnel)
    assert.equal(JSON.stringify(fixture.state()).includes("single-use-code"), false)
    assert.deepEqual((fixture.state() as { remoteServers: Array<{ baseUrl: string }> }).remoteServers.map((entry) => entry.baseUrl), [tunnel])
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

test("an address added in Browse opens its tab at once, named after its host; an address already saved reuses its server", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box")] } })
    await addServer(page, "https://lab.example:8443")
    await page.locator(".tab-pill", { hasText: "lab.example" }).waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    type Saved = { remoteServers: Array<{ id: string; name: string; baseUrl: string }> }
    const added = (fixture.state() as Saved).remoteServers.find((entry) => entry.baseUrl === "https://lab.example:8443")!
    assert.equal(added.name, "lab.example:8443", "saved under its host, shown as its host name")
    assert.deepEqual(fixture.probes, ["https://lab.example:8443 skipTls=false"])

    // The saved server opens again without a second profile or a probe.
    await page.getByRole("button", { name: "Home", exact: true }).click()
    await addServer(page, BOX)
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 2)
    assert.equal((await views(page)).opened[1].profileId, "box")
    assert.deepEqual((fixture.state() as Saved).remoteServers.map((entry) => entry.id).sort(), [added.id, "box"].sort())
    assert.equal(fixture.probes.length, 1)
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

test("Browse lists saved servers by name and a server's tab shows that name before a project is chosen", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    // An existing user's profiles, one saved under its pasted address.
    const pasted = server("pasted", { name: "127.0.0.1:9911", baseUrl: "http://127.0.0.1:9911" })
    await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box"), pasted] } })
    await page.locator(".folder-home-root").waitFor()
    await browse(page)
    assert.deepEqual(await page.locator(".browse-menu-row").allTextContents(), ["This computer", "Box", "127.0.0.1"])
    // Servers are managed in Settings, not from Browse.
    await page.getByRole("button", { name: "Open a project on Box" }).click({ button: "right" })
    assert.equal(await page.getByRole("menuitem").count(), 0)
    await page.getByRole("button", { name: "Open a project on 127.0.0.1" }).click()
    await page.locator(".tab-pill", { hasText: "127.0.0.1" }).waitFor()
    assert.equal(await page.locator(".tab-pill", { hasText: "127.0.0.1:9911" }).count(), 0)
  } finally { await page.close() }
})

test("a certificate that fails the check offers skipping it under the field; the server then opens in its own window", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron" })
    const field = await addServer(page, "https://selfsigned.example")
    await page.getByRole("alert").getByText("Certificate check failed while connecting to the remote server.").waitFor()
    const skip = page.getByRole("checkbox", { name: "Skip TLS verification" })
    await skip.check()
    await field.press("Enter")
    await page.waitForFunction(() => (window as any).fixtureViews.windows.length === 1)
    assert.equal((await views(page)).opened.length, 0, "an unverified certificate never opens a tab")
    assert.deepEqual(fixture.probes, ["https://selfsigned.example skipTls=false", "https://selfsigned.example skipTls=true"])
    const saved = (fixture.state() as { remoteServers: Array<{ baseUrl: string; skipTlsVerify: boolean }> }).remoteServers
    assert.deepEqual(saved.map((entry) => [entry.baseUrl, entry.skipTlsVerify]), [["https://selfsigned.example", true]])
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

const sidecar = (id: string, name: string, status: "running" | "stopped") => ({
  id, kind: "port", name, port: 3000, insecure: false, prefixMode: "strip", status,
  createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z",
})

test("+ opens disposable blank tabs; remote and SideCar choices replace their originating blank tab in place", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box")] },
      sidecars: [sidecar("docs", "Docs", "running")] })
    await browse(page)
    await page.getByRole("button", { name: "Open a project on Box" }).click()
    await page.locator('.tab-pill', { hasText: 'Box' }).waitFor()
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await blank.waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox')
    assert.equal(await page.locator('.tab-pill').count(), 2, await page.locator('.tab-strip-tabs').innerText())
    assert.equal(await blank.getByText('3 items', { exact: true }).count(), 1, 'Browse counts computer, server and SideCar')
    assert.equal(await blank.getByText('0 items', { exact: true }).count(), 1)
    assert.equal(await page.locator('.folder-home-root').count(), 0)
    assert.deepEqual(fixture.created, [], 'blank tabs create no backend workspace')
    assert.deepEqual(await blank.locator('.blank-tab-actions button').allTextContents(), ['Clone Git Repo', 'New temporary tab'])
    const columns = await blank.locator('.blank-tab-section').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })))
    assert.equal(columns[0].y, columns[1].y)
    assert.ok(columns[1].x > columns[0].x)
    await page.setViewportSize({ width: 480, height: 800 })
    const narrow = await blank.locator('.blank-tab-section').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y))
    assert.ok(narrow[1] > narrow[0])
    await page.setViewportSize({ width: 1200, height: 800 })

    // Open another blank, then fill the earlier one: its replacement keeps that earlier slot.
    const firstBlankId = await blank.getAttribute('data-tab-id')
    await page.locator('.new-instance-button').click()
    await page.locator(`[data-app-tab-id="${firstBlankId}"] [role=tab]`).click()
    await blank.getByRole('button', { name: 'Open a project on Box' }).click()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 1)
    assert.equal(await page.locator('.tab-pill').count(), 3)
    assert.match((await page.locator('.tab-strip-tabs > *').nth(1).getAttribute('data-app-tab-id'))!, /^remote-project:/)
    // Close the remaining blank: no saved record or resource is left.
    await page.locator('.tab-pill', { hasText: 'New tab' }).locator('.tab-pill-close').click()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
    assert.deepEqual(fixture.created, [])
    assert.equal(JSON.stringify(fixture.state()).includes('blank:'), false)

    await page.locator('.new-instance-button').click()
    await blank.locator('[data-sidecar="docs"]').click()
    await page.locator('.tab-pill', { hasText: 'Docs' }).waitFor()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
    assert.equal(await page.locator('.tab-pill').count(), 3)
  } finally { await page.close() }
})

test("a delayed server probe fills its originating blank tab, even after another blank opens", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box")] } })
    await browse(page)
    await page.getByRole("button", { name: "Open a project on Box" }).click()
    await page.locator(".new-instance-button").click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    const origin = await blank.getAttribute("data-tab-id")
    await page.route("**/api/remote-servers/probe", async route => { await held; await route.fallback() })
    const field = blank.getByRole("textbox", { name: "Server address or link" })
    await field.fill("https://slow.example")
    const pending = page.waitForRequest("**/api/remote-servers/probe")
    await field.press("Enter")
    await pending
    await page.locator(".new-instance-button").click()
    const other = await blank.getAttribute("data-tab-id")
    assert.notEqual(other, origin)
    release()
    await page.locator(".tab-pill", { hasText: "slow.example" }).waitFor()
    assert.equal(await page.locator(`[data-tab-id="${origin}"]`).count(), 0)
    assert.equal(await page.locator(`[data-tab-id="${other}"]`).count(), 1)
    assert.match((await page.locator(".tab-strip-tabs > *").nth(1).getAttribute("data-app-tab-id"))!, /^remote-project:/)
  } finally { release(); await page.close() }
})

for (const host of ['web', 'electron', 'tauri'] as const) test(`${host}: the logo opens Home; Sponsor uses the existing help URL; a local choice replaces a blank tab`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const fixture = await open(page, '', { context: 'local', host, uiState: { recentFolders: [{ path: '/srv/local', projectName: 'Local', lastAccessed: 2 }] },
      sidecars: [sidecar('docs', 'Docs', 'running')] })
    const sponsor = page.getByRole('link', { name: 'Sponsor', exact: true })
    assert.equal(await sponsor.getAttribute('href'), 'https://neuralnomadsai.github.io/CodeNomad/en/sponsor.html')
    await page.evaluate(() => { (window as any).externalURLs = []; window.open = ((url: string) => { (window as any).externalURLs.push(url); return null }) as any })
    await sponsor.click()
    await page.waitForFunction(() => (window as any).externalURLs.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).externalURLs), ['https://neuralnomadsai.github.io/CodeNomad/en/sponsor.html'])
    await page.getByRole('tab', { name: 'Browse', exact: true }).click()
    await page.locator('[data-sidecar="docs"]').click()
    await page.locator('.tab-pill', { hasText: 'Docs' }).waitFor()
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.locator('.folder-home-root').waitFor()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await blank.getByRole('option', { name: /Local/ }).click()
    await page.waitForFunction(() => !document.querySelector('[data-tab-kind="blank"]'))
    assert.deepEqual(fixture.created, ['/srv/local'])
    assert.equal(await page.locator('.tab-strip-tabs [role="tab"]').count(), 2)
  } finally { await page.close() }
})

test("Browse opens a running SideCar, which then joins the recent tabs of the home page and the launcher", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", {
      context: "local", host: "electron", uiState: { remoteServers: [server("box")] },
      sidecars: [sidecar("docs", "Docs", "running"), sidecar("wiki", "Wiki", "stopped")],
    })
    await page.locator(".folder-home-root").waitFor()
    // The former Open SideCar button and its window are gone.
    assert.equal(await page.getByRole("button", { name: "Open SideCar" }).count(), 0)
    assert.equal(await page.getByRole("dialog").count(), 0)

    await browse(page)
    const rows = page.locator(".browse-menu-row")
    await page.locator('[data-sidecar="docs"]').waitFor()
    assert.deepEqual(await rows.allTextContents(), ["This computer", "Box", "DocsRunning", "WikiStopped"])
    // A stopped SideCar shows its state and cannot open.
    assert.equal(await page.locator('[data-sidecar="wiki"]').isDisabled(), true)
    await page.locator('[data-sidecar="docs"]').click()
    await page.locator(".tab-pill", { hasText: "Docs" }).waitFor()
    assert.equal(await page.locator(".folder-home-root").count(), 0)

    // Only its id is remembered, never its address or a proxy token.
    type Saved = { sidecarRecents?: Array<Record<string, unknown>> }
    for (let attempt = 0; attempt < 50 && !(fixture.state() as Saved).sidecarRecents?.length; attempt++) await page.waitForTimeout(100)
    const saved = (fixture.state() as Saved).sidecarRecents!
    assert.deepEqual(saved.map((entry) => Object.keys(entry).sort()), [["lastAccessed", "sidecarId"]])
    assert.equal(saved[0].sidecarId, "docs")

    await page.getByRole("button", { name: "Home", exact: true }).click()
    const recent = page.locator('.folder-home-recent-item[data-sidecar="docs"]')
    await recent.waitFor()
    assert.match(await recent.innerText(), /Docs[\s\S]*SideCar/)
    await recent.locator(".folder-home-recent-primary-action").click()
    await page.waitForFunction(() => document.querySelectorAll(".tab-pill").length === 2)

    // The launcher lists the same recent tab and the same Browse rows.
    await page.locator(".new-instance-button").click({ button: "right" })
    const launcher = page.locator(".new-instance-launcher")
    await launcher.getByRole("option", { name: /Docs/ }).waitFor()
    await launcher.getByRole("button", { name: "Browse", exact: true }).click()
    assert.deepEqual(await launcher.locator(".browse-menu-row").allTextContents(), ["This computer", "Box", "DocsRunning", "WikiStopped"])
  } finally { await page.close() }
})

test("New SideCar opens the SideCar form in Settings on its name field", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    // A web client shows Settings in the window; servers stay out of it.
    await open(page, "", {})
    await page.locator(".folder-home-root").waitFor()
    assert.equal(await page.getByRole("button", { name: "New server" }).count(), 0)
    await page.getByRole("button", { name: "New SideCar", exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.id === "sidecar-add")
    assert.equal(await page.locator('.settings-nav-button[aria-current="page"]').innerText(), "SideCars")
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
