import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { mkdir } from "node:fs/promises"

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
const captures = process.env.CODENOMAD_REMOTE_UX_CAPTURE_DIR
async function capture(page: Page, name: string) {
  if (!captures) return
  await mkdir(captures, { recursive: true })
  await page.screenshot({ path: `${captures}/${name}.png` })
}
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
  remoteNeedsPassword?: boolean
  pairingWorks?: boolean
  pairingError?: string
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
  let remoteAuthenticated = !scenario.remoteNeedsPassword
  const remoteReads: string[] = []
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    const remote = pathname.match(/^\/api\/remote-servers\/([^/]+)\/(browse|connect|forget)$/)
    if (remote) {
      const body = request.postDataJSON() ?? {}
      if (remote[2] === 'forget') return route.fulfill({ json: { ok: true } })
      if (remote[2] === 'connect') {
        if (body.pairingLink && !scenario.pairingWorks) return route.fulfill({ status: 409, json: { error: scenario.pairingError ?? 'pairing_unavailable' } })
        if (body.pairingLink) { remoteAuthenticated = true; return route.fulfill({ json: { ok: true } }) }
        if (body.password !== 'fixture-password') return route.fulfill({ status: 409, json: { error: 'auth' } })
        remoteAuthenticated = true
        return route.fulfill({ json: { ok: true } })
      }
      if (!remoteAuthenticated) return route.fulfill({ status: 409, json: { error: 'needs_credentials' } })
      const current = body.path ?? '/'
      remoteReads.push(current)
      return route.fulfill({ json: { listing: { metadata: { currentPath: current, displayPath: current, rootPath: '/', homePath: '/', scope: 'unrestricted', pathKind: 'absolute', ...(current === '/' ? {} : { parentPath: '/' }) },
        entries: current === '/' ? [{ name: 'app', path: '/srv/app', absolutePath: '/srv/app', type: 'directory' }] : [] },
        recents: [{ path: '/srv/recent', projectName: 'Remote recent', lastAccessed: 1 }] } })
    }
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
      : pathname === "/api/storage/config/ui" ? { settings: { locale: "en" }, theme: 'dark' }
      : pathname === "/api/storage/state/ui" ? state : {}
    await route.fulfill({ json: body })
  })
  await page.goto(`${url}${path}`)
  return { created, probes, remoteReads, state: () => state }
}

// Home and blank tabs share the canonical Browse tab.
async function browse(page: Page) {
  await page.getByRole("tab", { name: "Browse", exact: true }).click()
}

// Browse's last row: the field that saves a server. Enter submits it.
async function addServer(page: Page, address: string) {
  await browse(page)
  const field = page.getByRole("textbox", { name: "Server address or link" })
  await field.fill(address)
  await field.press("Enter")
  return field
}

const views = (page: Page) => page.evaluate(() => (window as any).fixtureViews as {
  opened: Array<{ viewId: string; profileId: string; baseUrl: string; url: string; bounds: { width: number; height: number } }>
  updates: Array<{ viewId: string; visible: boolean }>; closed: string[]; windows: Array<{ id: string; entryUrl?: string }>
})

async function chooseRemoteRoot(page: Page) {
  await page.getByRole('button', { name: /^(Open this folder|Open in a separate window)$/ }).click()
}

for (const surface of ['Home', 'blank'] as const) test(`${surface}: named remote browsing signs in inline and opens only the chosen folder`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const fixture = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true,
      uiState: { remoteServers: [server('box')] }, sidecars: [sidecar('docs', 'Docs', 'running')] })
    await browse(page)
    if (surface !== 'Home') {
      await page.locator('[data-sidecar="docs"]').click()
      await page.locator('.tab-pill', { hasText: 'Docs' }).waitFor()
      await page.locator('.new-instance-button').click()
      await browse(page)
    }
    const root = surface === 'blank' ? page.locator('[data-tab-kind="blank"][data-tab-visible="true"]') : page.locator('.folder-home-root')
    const beforeTabs = await page.locator('.tab-pill').count()
    const blankId = surface === 'blank' ? await root.getAttribute('data-tab-id') : null
    await root.getByRole('button', { name: 'Open a project on Box' }).click()
    const password = root.getByRole('textbox', { name: 'Password', exact: true }).or(root.locator('input[type="password"]'))
    await password.waitFor()
    assert.equal(await root.getByRole('textbox', { name: 'Username', exact: true }).inputValue(), 'codenomad')
    assert.equal(await page.getByRole('dialog').count(), 0, 'sign-in creates no floating dialog')
    assert.equal(await root.locator('.remote-server-navigation').innerText(), 'Box')
    assert.deepEqual(await root.locator('.remote-server-label > span').allTextContents(), ['Username', 'Password'])
    if (surface === 'Home') {
      await capture(page, '03-password')
      await page.setViewportSize({ width: 480, height: 800 })
      await capture(page, 'A-auth-narrow')
      await page.setViewportSize({ width: 1200, height: 800 })
    }
    if (surface === 'blank') {
      await capture(page, 'A-auth')
      await page.setViewportSize({ width: 480, height: 800 })
      await capture(page, 'A-auth-blank-narrow')
      await page.setViewportSize({ width: 1200, height: 800 })
    }
    assert.equal(await page.locator('.tab-pill').count(), beforeTabs)
    assert.deepEqual((await views(page)).opened, [])
    assert.deepEqual((await views(page)).windows, [])
    await password.fill('wrong-password')
    await root.getByRole('button', { name: 'Sign in', exact: true }).click()
    await root.getByRole('alert').getByText('The username or password is incorrect.').waitFor()
    assert.equal(await password.inputValue(), '')
    assert.equal(await page.getByRole('dialog').count(), 0, 'failed sign-in stays inline')
    assert.equal(await password.getAttribute('aria-invalid'), 'true')
    assert.equal(await password.getAttribute('aria-describedby'), await root.getByRole('alert').getAttribute('id'))
    if (surface === 'Home') await capture(page, '04-password-error')
    await password.fill('fixture-password')
    await root.getByRole('button', { name: 'Sign in', exact: true }).click()
    await root.locator('[data-remote-folder]').waitFor()
    assert.equal(await root.locator('input[type="password"]').count(), 0)
    assert.equal(JSON.stringify(fixture.state()).includes('fixture-password'), false)
    if (surface === 'Home') await capture(page, '05-server-browse')
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-remote-folder'))
    await page.keyboard.press('Home')
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Back to Browse')
    await page.keyboard.press('End')
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-remote-folder'))
    await page.keyboard.press('Enter')
    await root.locator('.remote-server-path').getByText('/srv/app', { exact: true }).waitFor()
    assert.deepEqual((await views(page)).opened, [])
    await root.getByRole('button', { name: 'Parent folder', exact: true }).click()
    await root.locator('[data-remote-folder]').waitFor()
    await root.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-remote-server') === 'box')
    await page.keyboard.press('Enter')
    await root.locator('[data-remote-folder]').waitFor()
    await page.keyboard.press('Escape')
    await root.getByRole('button', { name: 'This computer', exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-remote-server') === 'box')
    assert.equal(await page.locator('.tab-pill').count(), beforeTabs)
    await page.keyboard.press('Enter')
    await root.getByRole('button', { name: 'app', exact: true }).click()
    await root.locator('.remote-server-path').getByText('/srv/app', { exact: true }).waitFor()
    assert.equal(await root.locator('.remote-server-navigation').innerText(), 'Box')
    assert.deepEqual(await root.locator('.remote-server-section').allTextContents(), ['Recent', 'Folders'])
    await root.getByRole('button', { name: 'Open this folder', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    assert.equal((await views(page)).opened[0].url, `${BOX}/?codenomadEmbed=project&folder=%2Fsrv%2Fapp`)
    assert.equal(await page.locator('.tab-pill').count(), beforeTabs + (surface === 'blank' ? 0 : 1))
    if (blankId) assert.equal(await page.locator(`[data-tab-id="${blankId}"]`).count(), 0)
    assert.equal(await page.locator('.new-instance-launcher').count(), 0)
    assert.deepEqual(fixture.created, [])
    assert.deepEqual(fixture.remoteReads, ['/', '/srv/app', '/', '/', '/', '/srv/app'])
  } finally { await page.close() }
})

for (const pending of ['browse', 'connect'] as const) test(`returning to Browse fences a delayed remote ${pending} response and its focus`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let settled!: () => void
  const finished = new Promise<void>(resolve => { settled = resolve })
  try {
    await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: pending === 'connect', uiState: { remoteServers: [server('box')] } })
    await browse(page)
    await page.route(`**/api/remote-servers/box/${pending}`, async route => {
      await held
      try { await route.fulfill({ json: pending === 'connect' ? { ok: true } : {
        listing: { metadata: { currentPath: '/late', displayPath: '/late', pathKind: 'absolute' }, entries: [{ name: 'late', path: '/late', type: 'directory' }] }, recents: [],
      } }) } finally { settled() }
    })
    const request = page.waitForRequest(`**/api/remote-servers/box/${pending}`)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    if (pending === 'connect') {
      await page.getByRole('textbox', { name: 'Username', exact: true }).waitFor()
      await page.locator('input[type="password"]').fill('fixture-password')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      assert.equal(await page.locator('input[type="password"]').inputValue(), '', 'cleared while connect is pending')
    }
    await request
    await page.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-remote-server') === 'box')
    release()
    await finished
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(await page.locator('.remote-server-browser').count(), 0)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-remote-server')), 'box')
    assert.deepEqual((await views(page)).opened, [])
    assert.deepEqual((await views(page)).windows, [])
  } finally { release(); await page.close() }
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
    await chooseRemoteRoot(page)
    const tab = page.locator(".tab-pill", { hasText: "Box" })
    await tab.waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    const [opened] = (await views(page)).opened
    assert.equal(opened.profileId, "box")
    assert.equal(opened.baseUrl, BOX)
    assert.equal(opened.url, `${BOX}/?codenomadEmbed=project&folder=%2F`)
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
    await chooseRemoteRoot(page)
    await page.waitForFunction(() => (window as any).fixtureViews.windows.length === 1)
    assert.equal((await views(page)).windows[0].id, "lab")
    assert.equal((await views(page)).windows[0].entryUrl, 'https://lab.example/?codenomadEmbed=project&folder=%2F')
    assert.equal((await views(page)).opened.length, 1)
  } finally { await page.close() }
})

test("a pairing-link profile browses with the backend's device and fills its blank tab only on project selection", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const f = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true, pairingWorks: true,
      sidecars: [sidecar('docs', 'Docs', 'running')] })
    await browse(page)
    await page.locator('[data-sidecar="docs"]').click()
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await blank.getByRole('tab', { name: 'Browse', exact: true }).click()
    const code = 'p'.repeat(32)
    const field = blank.getByRole('textbox', { name: 'Server address or link' })
    await field.fill(`https://paired.example.test/remote-pair#${code}`)
    await field.press('Enter')
    const row = blank.getByRole('button', { name: 'Open a project on paired.example.test' })
    await row.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === 'paired.example.test')
    assert.equal(await field.inputValue(), '')
    assert.equal((await views(page)).opened.length, 0)
    assert.equal(JSON.stringify(f.state()).includes(code), false)
    await row.click()
    const recent = blank.getByRole('button', { name: /Remote recent/ })
    await recent.waitFor()
    assert.equal(await blank.getByRole('textbox', { name: 'Password', exact: true }).count(), 0)
    assert.equal((await views(page)).opened.length, 0)
    await recent.click()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
    assert.equal((await views(page)).opened[0].url, 'https://paired.example.test/?codenomadEmbed=project&folder=%2Fsrv%2Frecent')
    assert.equal(JSON.stringify(f.state()).includes(code), false)
  } finally { await page.close() }
})

for (const [code, message] of [
  ['pairing_unavailable', 'Server-side Remote Control pairing unavailable.'],
  ['pairing_expired', 'Pairing link invalid or expired.'],
  ['pairing_rate_limited', 'Too many pairing attempts. Try again later.'],
] as const) test(`${code}: a refused exchange clears its link and permits inline password recovery`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const f = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true, pairingError: code })
    const field = await addServer(page, `https://older.example.test/remote-pair#${'x'.repeat(32)}`)
    await page.getByRole('alert').getByText(message, { exact: true }).waitFor()
    if (code === 'pairing_unavailable') await capture(page, '13-pairing-error')
    assert.equal(await field.inputValue(), '')
    assert.equal(JSON.stringify(f.state()).includes('x'.repeat(32)), false)
    const serverRow = page.getByRole('button', { name: 'Open a project on older.example.test' })
    await serverRow.getByText('Sign-in required', { exact: true }).waitFor()
    await serverRow.click()
    await page.getByRole('textbox', { name: 'Password', exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal((await views(page)).opened.length, 0)
    await page.locator('input[type="password"]').fill('fixture-password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('button', { name: 'Open this folder', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    assert.equal(await serverRow.getByText('Sign-in required', { exact: true }).count(), 0)
  } finally { await page.close() }
})

test("Browse refuses address credentials and saves a pairing server while reporting unavailable pairing", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron" })
    const field = await addServer(page, "http://user:secret@box.example:4096")
    await page.getByRole("alert").getByText("Remove the user name and password from the address.").waitFor()
    assert.deepEqual(fixture.probes, [])

    // A pasted link saves its origin and attempts backend pairing without opening a native view.
    const tunnel = "https://desk.opentunnel.test"
    await field.fill("")
    await field.evaluate((input, link) => {
      const data = new DataTransfer()
      data.setData("text", link)
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
    }, `${tunnel}/remote-pair#single-use-code`)
    const row = page.getByRole("button", { name: "Open a project on desk.opentunnel.test" })
    await row.waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-remote-server"))
    assert.equal((await views(page)).opened.length, 0)
    assert.equal((await views(page)).windows.length, 0)
    await page.getByRole('alert').getByText('Server-side Remote Control pairing unavailable.').waitFor()
    assert.equal((await views(page)).opened.length, 0)
    assert.equal(JSON.stringify(fixture.state()).includes("single-use-code"), false)
    assert.deepEqual((fixture.state() as { remoteServers: Array<{ baseUrl: string }> }).remoteServers.map((entry) => entry.baseUrl), [tunnel])
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

test("an address added in Browse receives focus; choosing a folder opens its tab", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box")] } })
    await addServer(page, "https://lab.example:8443")
    const row = page.getByRole("button", { name: "Open a project on lab.example" })
    await row.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === "lab.example")
    assert.equal((await views(page)).opened.length, 0)
    assert.equal((await views(page)).windows.length, 0)
    await row.click()
    await chooseRemoteRoot(page)
    await page.locator(".tab-pill", { hasText: "lab.example" }).waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    type Saved = { remoteServers: Array<{ id: string; name: string; baseUrl: string }> }
    const added = (fixture.state() as Saved).remoteServers.find((entry) => entry.baseUrl === "https://lab.example:8443")!
    assert.equal(added.name, "lab.example:8443", "saved under its host, shown as its host name")
    assert.deepEqual(fixture.probes, ["https://lab.example:8443 skipTls=false"])

    // The saved server opens again without a second profile or a probe.
    await page.getByRole("button", { name: "Home", exact: true }).click()
    await addServer(page, BOX)
    await page.waitForFunction(() => document.activeElement?.textContent === "Box")
    assert.equal((await views(page)).opened.length, 1)
    await page.getByRole("button", { name: "Open a project on Box" }).click()
    await chooseRemoteRoot(page)
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 2)
    assert.equal((await views(page)).opened[1].profileId, "box")
    assert.deepEqual((fixture.state() as Saved).remoteServers.map((entry) => entry.id).sort(), [added.id, "box"].sort())
    assert.equal(fixture.probes.length, 1)
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

test("Browse lists saved servers by name and the selected root tab shows its server name", async () => {
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
    await chooseRemoteRoot(page)
    await page.locator(".tab-pill", { hasText: "127.0.0.1" }).waitFor()
    assert.equal(await page.locator(".tab-pill", { hasText: "127.0.0.1:9911" }).count(), 0)
  } finally { await page.close() }
})

test("a certificate that fails the check offers skipping it under the field; the server then opens in its own window", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron" })
    const field = await addServer(page, "https://selfsigned.example")
    await page.getByRole("alert").getByText("Certificate check failed.", { exact: true }).waitFor()
    await capture(page, '12-tls')
    const skip = page.getByRole("checkbox", { name: "Skip TLS verification" })
    await skip.check()
    await field.press("Enter")
    const row = page.getByRole("button", { name: "Open a project on selfsigned.example" })
    await row.waitFor()
    assert.equal((await views(page)).windows.length, 0, "TLS confirmation saves only")
    await row.click()
    await page.getByRole('button', { name: 'Open in a separate window', exact: true }).waitFor()
    await chooseRemoteRoot(page)
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
    await chooseRemoteRoot(page)
    await page.locator('.tab-pill', { hasText: 'Box' }).waitFor()
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await blank.waitFor()
    assert.equal(await page.locator('.tab-pill').count(), 2, await page.locator('.tab-strip-tabs').innerText())
    assert.deepEqual(await blank.locator('[role=tablist] .badge-shape').allTextContents(), ['0', '3'])
    assert.equal(await blank.locator('.folder-home-root--blank').count(), 1)
    assert.deepEqual(fixture.created, [], 'blank tabs create no backend workspace')
    assert.deepEqual(await blank.locator('.folder-home-creation-actions button').allTextContents(), ['Clone Git Repo', 'New temporary tab', 'New SideCar'])
    const layout = await blank.locator('.folder-home-creation-actions').boundingBox()
    const panel = await blank.getByRole('tabpanel').boundingBox()
    assert.ok(layout!.y >= panel!.y + panel!.height, 'creation stays below the selector')
    await page.setViewportSize({ width: 480, height: 800 })
    assert.equal(await blank.locator('.folder-home-root').evaluate(node => node.scrollWidth <= node.clientWidth), true)
    await page.setViewportSize({ width: 1200, height: 800 })

    // Open another blank, then fill the earlier one: its replacement keeps that earlier slot.
    const firstBlankId = await blank.getAttribute('data-tab-id')
    await page.locator('.new-instance-button').click()
    await page.locator(`[data-app-tab-id="${firstBlankId}"] [role=tab]`).click()
    await blank.getByRole('tab', { name: 'Browse', exact: true }).click()
    await blank.getByRole('button', { name: 'Open a project on Box' }).click()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 2, 'browsing preserves both blanks')
    await blank.getByRole('button', { name: 'Remote recent /srv/recent', exact: true }).click()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 1)
    assert.equal(await page.locator('.tab-pill').count(), 3)
    assert.match((await page.locator('.tab-strip-tabs > *').nth(1).getAttribute('data-app-tab-id'))!, /^remote-project:/)
    // Close the remaining blank: no saved record or resource is left.
    await page.locator('.tab-pill', { hasText: 'New tab' }).locator('.tab-pill-close').click()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
    assert.deepEqual(fixture.created, [])
    assert.equal(JSON.stringify(fixture.state()).includes('blank:'), false)

    await page.locator('.new-instance-button').click()
    await blank.getByRole('tab', { name: 'Browse', exact: true }).click()
    await blank.locator('[data-sidecar="docs"]').click()
    await page.locator('.tab-pill', { hasText: 'Docs' }).waitFor()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
    assert.equal(await page.locator('.tab-pill').count(), 3)
  } finally { await page.close() }
})

for (const kind of ['remote recent', 'SideCar'] as const) test(`Browse ${kind}: Open joins separately while the primary action creates another occurrence`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const fixture = await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')] },
      sidecars: [sidecar('docs', 'Docs', 'running')] })
    const choose = async () => {
      await browse(page)
      if (kind === 'remote recent') await page.getByRole('button', { name: 'Open a project on Box' }).click()
      return kind === 'remote recent'
        ? page.getByRole('button', { name: 'Remote recent /srv/recent', exact: true })
        : page.locator('[data-sidecar="docs"]')
    }
    await (await choose()).click()
    const original = await page.locator('.tab-strip-tabs > [data-app-tab-id]').first().getAttribute('data-app-tab-id')
    assert.ok(original)
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    const blankId = await blank.getAttribute('data-tab-id')
    await choose()
    const join = page.getByRole('button', { name: /^Switch to open project ·/ })
    await join.waitFor()
    await join.focus()
    await join.press('Enter')
    await page.locator(`[data-tab-id="${original}"][data-tab-visible="true"]`).waitFor()
    assert.equal(await page.locator('.tab-pill').count(), 2, 'joining creates no occurrence')
    assert.equal(await page.locator(`[data-tab-id="${blankId}"]`).count(), 1, 'joining preserves the blank slot')
    await page.locator(`[data-app-tab-id="${blankId}"] [role=tab]`).click()
    await join.click()
    await page.locator(`[data-tab-id="${original}"][data-tab-visible="true"]`).waitFor()
    assert.equal(await page.locator('.tab-pill').count(), 2, 'pointer join also creates no occurrence')
    await page.locator(`[data-app-tab-id="${blankId}"] [role=tab]`).click()
    const primary = kind === 'remote recent'
      ? blank.getByRole('button', { name: 'Remote recent /srv/recent', exact: true })
      : blank.locator('[data-sidecar="docs"]')
    await primary.click()
    await blank.waitFor({ state: 'hidden' })
    assert.equal(await page.locator(`[data-tab-id="${blankId}"]`).count(), 0, 'primary replaces the blank slot')
    assert.equal(await page.locator('.tab-pill').count(), 2)
    assert.equal(await page.locator(`[data-tab-id="${original}"]`).count(), 1, 'the original occurrence remains')
    assert.notEqual(await page.locator('[data-tab-visible="true"]').getAttribute('data-tab-id'), original)
    assert.deepEqual(fixture.created, [])
  } finally { await page.close() }
})

test("a delayed server add preserves both blank tabs; clicking its row fills the chosen blank", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box")] } })
    await browse(page)
    await page.getByRole("button", { name: "Open a project on Box" }).click()
    await chooseRemoteRoot(page)
    await page.locator(".new-instance-button").click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    const origin = await blank.getAttribute("data-tab-id")
    await blank.getByRole('tab', { name: 'Browse', exact: true }).click()
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
    const originView = page.locator(`[data-tab-id="${origin}"]`)
    await originView.locator('.browse-menu-row', { hasText: 'slow.example' }).waitFor({ state: "attached" })
    assert.equal(await page.locator(`[data-tab-id="${origin}"]`).count(), 1)
    assert.equal(await page.locator(`[data-tab-id="${other}"]`).count(), 1)
    await page.locator(`[data-app-tab-id="${origin}"] [role=tab]`).click()
    await originView.getByRole('tab', { name: 'Browse', exact: true }).click()
    await originView.getByRole("button", { name: "Open a project on slow.example" }).click()
    await chooseRemoteRoot(page)
    assert.equal(await page.locator(`[data-tab-id="${origin}"]`).count(), 0)
    assert.match((await page.locator(".tab-strip-tabs > *").nth(1).getAttribute("data-app-tab-id"))!, /^remote-project:/)
  } finally { release(); await page.close() }
})

test("Home and blank share their canonical selector and secondary actions; blank keeps a compact identity", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    await open(page, "", { context: "local", host: "electron", uiState: {
      remoteServers: [server("box")],
      recentFolders: [{ path: "/srv/local", projectName: "Local", lastAccessed: Date.now() - 60000 }],
      remoteProjectRecents: [{ profileId: "box", folder: "/srv/remote", projectName: "Remote", lastAccessed: Date.now() - 120000 }],
      sidecarRecents: [{ sidecarId: "docs", lastAccessed: Date.now() - 180000 }],
    }, sidecars: [sidecar("docs", "Docs", "running")] })
    await page.getByRole("button", { name: "Local · This computer · /srv/local", exact: true }).click()
    await page.locator('.tab-strip-tabs [role=tab]', { hasText: 'Local' }).waitFor()
    await page.getByRole("button", { name: "Home", exact: true }).click()
    const home = page.locator(".folder-home-root")
    await home.getByRole('tab', { name: 'Recent', exact: true }).waitFor()
    const presentation = async (root: typeof home) => root.evaluate(node => {
      const sizes = []
      for (const selector of ['[role=tablist]', '.folder-home-recent-item', '.folder-home-creation-actions']) {
        const element = node.querySelector(selector)!
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
        sizes.push({ width: rect.width, height: rect.height, background: style.backgroundColor, font: style.font, radius: style.borderRadius })
      }
      return { background: getComputedStyle(node).backgroundColor, sizes }
    })
    const expected = await presentation(home)
    await capture(page, 'home-desktop')
    await home.getByRole('tab', { name: 'Browse', exact: true }).click()
    await capture(page, '02-browse-dark')
    await home.getByRole('tab', { name: 'Recent', exact: true }).click()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await page.locator(".new-instance-button").click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Search recent projects")
    const root = blank.locator(".folder-home-root")
    assert.deepEqual(await presentation(root), expected)
    assert.equal(await blank.getByRole("heading", { name: "Open a project" }).count(), 1)
    assert.equal(await blank.locator('.folder-home-logo').count(), 0)
    assert.deepEqual(await blank.getByRole('tab').allTextContents(), ['Recent3', 'Browse3'])
    const selector = await blank.getByRole('tablist').boundingBox()
    const search = await blank.getByRole('searchbox', { name: 'Search recent projects' }).boundingBox()
    assert.ok(search!.y >= selector!.y + selector!.height, 'search stays under the selector')
    assert.equal(await blank.getByRole('link').count(), 0)
    assert.equal(await blank.locator('.locale-selector, .panel-section, .version-pill, .absolute.top-4').count(), 0)
    assert.equal(await blank.locator('.folder-home-open-instance-button').count(), 1)
    assert.equal(await blank.getByText('Box', { exact: true }).count(), 1)
    assert.equal(await blank.getByText('/srv/remote', { exact: true }).count(), 1)
    await capture(page, 'blank-desktop')
    await page.setViewportSize({ width: 480, height: 800 })
    await capture(page, 'blank-narrow')
    assert.equal(await root.evaluate(node => node.scrollWidth <= node.clientWidth), true)
    await page.setViewportSize({ width: 1200, height: 800 })
    await blank.getByRole('tab', { name: 'Browse', exact: true }).click()
    const field = blank.getByRole('textbox', { name: 'Server address or link' })
    await field.fill('https://added.example')
    await field.press('Enter')
    const added = blank.getByRole('button', { name: 'Open a project on added.example' })
    await added.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === 'added.example')
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 1)
    await added.click()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 1)
    await chooseRemoteRoot(page)
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
  } finally { await page.close() }
})

test("the quick launcher delegates browsing, authentication and server addition to a blank tab", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server('box')] } })
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    await chooseRemoteRoot(page)
    await page.locator('.new-instance-button').click({ button: 'right' })
    const launcher = page.locator('.new-instance-launcher')
    await launcher.getByRole('heading', { name: 'Recent projects', exact: true }).waitFor()
    await capture(page, '09-launcher')
    assert.equal(await launcher.locator('.browse-menu, input[type=password], [data-server-add-field], .new-tab-actions').count(), 0)
    await launcher.getByRole('button', { name: 'Open another project…', exact: true }).click()
    await launcher.waitFor({ state: 'hidden' })
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await blank.getByRole('tab', { name: 'Browse', exact: true }).click()
    const field = blank.getByRole('textbox', { name: 'Server address or link' })
    await field.fill('https://launcher.example')
    await field.press('Enter')
    const row = blank.getByRole('button', { name: 'Open a project on launcher.example' })
    await row.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === 'launcher.example')
    assert.equal((await views(page)).opened.length, 1)
    assert.equal((await views(page)).windows.length, 0)
    assert.deepEqual(fixture.created, [])
    await row.click()
    await blank.getByRole('button', { name: 'Open this folder', exact: true }).click()
    await blank.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 2)
  } finally { await page.close() }
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
    await blank.getByRole('tab', { name: 'Recent', exact: true }).click()
    await blank.getByRole('button', { name: 'Local · This computer · /srv/local', exact: true }).click()
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

    // The quick launcher only lists recents; its Open badge joins the existing occurrence.
    await page.locator(".new-instance-button").click({ button: "right" })
    const launcher = page.locator(".new-instance-launcher")
    const quickRecent = launcher.locator('.new-instance-launcher-recent[data-sidecar="docs"]')
    await quickRecent.waitFor()
    assert.equal(await launcher.locator('.browse-menu').count(), 0)
    await quickRecent.locator('.window-action').click()
    await launcher.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.tab-pill').count(), 2)
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

for (const code of ['tls_error', 'ECONNREFUSED fixture diagnostic'] as const) test(`${code}: remote failure stays on its named server with a short error and retry`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')] } })
    await page.route('**/api/remote-servers/box/browse', route => route.fulfill({ status: 409, json: { error: code } }))
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box', exact: true }).click()
    const remote = page.locator('.remote-server-browser')
    await remote.getByRole('alert').getByText(code === 'tls_error' ? 'Certificate check failed.' : 'Server unreachable.', { exact: true }).waitFor()
    assert.equal(await remote.locator('.remote-server-navigation').innerText(), 'Box')
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.deepEqual((await views(page)).opened, [])
    assert.equal(await remote.getByText('ECONNREFUSED fixture diagnostic', { exact: true }).count(), 0)
    await page.unroute('**/api/remote-servers/box/browse')
    await remote.getByRole('button', { name: 'Retry', exact: true }).click()
    await remote.locator('[data-remote-folder]').waitFor()
    assert.equal(await remote.getByRole('alert').count(), 0)
  } finally { await page.close() }
})

for (const kind of ['local', 'remote', 'SideCar'] as const) test(`${kind}: recent primary actions create occurrences and Open joins without duplication`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const fixture = await open(page, '', { context: 'local', host: 'electron', uiState: {
      remoteServers: [server('box')],
      recentFolders: kind === 'local' ? [{ path: '/srv/local', projectName: 'Local', lastAccessed: 1 }] : [],
      remoteProjectRecents: kind === 'remote' ? [{ profileId: 'box', folder: '/srv/remote', projectName: 'Remote', lastAccessed: 1 }] : [],
      sidecarRecents: kind === 'SideCar' ? [{ sidecarId: 'docs', lastAccessed: 1 }] : [],
    }, sidecars: [sidecar('docs', 'Docs', 'running')] })
    const home = page.locator('.folder-home-root')
    await home.getByRole('tab', { name: 'Browse', exact: true }).click()
    await home.locator('[data-sidecar="docs"]').waitFor()
    await home.getByRole('tab', { name: 'Recent', exact: true }).click()
    await home.locator('.folder-home-recent-primary-action').click()
    await page.locator('.tab-strip-tabs [role=tab]').first().waitFor()
    assert.equal(await page.locator('.tab-strip-tabs [role=tab]').count(), 1)
    const original = await page.locator('.tab-strip-tabs > [data-app-tab-id]').first().getAttribute('data-app-tab-id')
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await home.locator('.folder-home-open-instance-button').click()
    assert.equal(await page.locator('.tab-strip-tabs [role=tab]').count(), 1)
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await home.locator('.folder-home-recent-primary-action').click()
    await page.waitForFunction(() => document.querySelectorAll('.tab-strip-tabs [role=tab]').length === 2)
    const ids = await page.locator('.tab-strip-tabs > [data-app-tab-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-app-tab-id')))
    assert.equal(new Set(ids).size, 2)
    assert.equal(ids[0], original)
    await page.locator('.new-instance-button').click({ button: 'right' })
    const quick = page.locator('.new-instance-launcher')
    await quick.locator('.new-instance-launcher-recent .window-action').focus()
    if (kind === 'local') {
      await capture(page, 'A-quick-populated')
      await page.setViewportSize({ width: 480, height: 800 })
      await capture(page, 'A-quick-narrow')
      await page.setViewportSize({ width: 1200, height: 800 })
    }
    await page.keyboard.press('Enter')
    await quick.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.tab-strip-tabs [role=tab]').count(), 2)
    await page.locator('.new-instance-button').click({ button: 'right' })
    await quick.locator('.new-instance-launcher-recent-primary').click()
    await page.waitForFunction(() => document.querySelectorAll('.tab-strip-tabs [role=tab]').length === 3)
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await blank.locator('.folder-home-recent-primary-action').click()
    await page.waitForFunction(() => !document.querySelector('[data-tab-kind="blank"]') && document.querySelectorAll('.tab-strip-tabs [role=tab]').length === 4)
    if (kind === 'local') assert.deepEqual(fixture.created, Array(4).fill('/srv/local'))
    if (kind === 'remote') {
      await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 4)
      assert.equal(new Set((await views(page)).opened.map(view => view.viewId)).size, 4)
    }
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
