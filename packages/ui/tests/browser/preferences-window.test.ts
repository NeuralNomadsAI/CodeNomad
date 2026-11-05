import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "preferences-window",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\" style=\"height:100vh\"></div><script type=\"module\" src=\"/tests/browser/fixtures/preferences-window.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); })

test("Preferences restores section and scroll after recreation and flushes an immediate close", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.electronAPI = {
      getPreferencesRequest: async () => JSON.parse(localStorage.getItem("fixture-preferences") ?? '{"section":"general"}'),
      acceptPreferencesRequest: async (request) => {
        w.savingRequest = request
        await new Promise(resolve => setTimeout(resolve, w.saveDelay ?? 30))
        localStorage.setItem("fixture-preferences", JSON.stringify(request))
      },
      preferencesReady: async () => { w.ready = true },
      onPreferencesSection: (listener) => { w.section = listener; return () => {} },
      onPreferencesCloseRequested: (listener) => { w.closePreferences = listener; return () => {} },
      onPreferencesTransitionRequested: () => () => {},
      closeWindow: async () => { w.fixtureClosed = true },
    }
  }` })
  await page.route("**/api/**", route => new URL(route.request().url()).pathname.startsWith("/api/")
    ? route.fulfill({ contentType: "application/json", body: "{}" })
    : route.continue())
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).ready)
    await page.getByRole("button", { name: "Chat", exact: true }).click()
    const scroll = page.locator(".settings-screen-scroll")
    await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")!.scrollHeight > 1300)
    await scroll.hover()
    await page.mouse.wheel(0, 420)
    await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")!.scrollTop >= 400)
    const top = await scroll.evaluate(e => Math.round(e.scrollTop))
    await page.evaluate(() => (window as any).closePreferences())
    await page.waitForFunction(() => (window as any).fixtureClosed)
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-preferences")!))
    assert.equal(saved.section, "chat")
    assert.equal(saved.scrollTop, top)
    await page.reload()
    await page.waitForFunction(() => (window as any).ready)
    await page.waitForFunction(top => Math.abs(document.querySelector(".settings-screen-scroll")!.scrollTop - top) < 2, top)
    assert.equal(await page.getByRole("button", { name: "Chat", exact: true }).getAttribute("aria-current"), "page")
    // A targeted entry point overrides the remembered section and resets scroll.
    await page.evaluate(() => (window as any).section({ section: "general" }))
    await page.waitForFunction(() => document.querySelector('.settings-nav-button[aria-current="page"]')?.textContent?.includes("General"))
    await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")!.scrollTop === 0)

    // Closing while a section write is in flight must snapshot the accepted
    // section, not the old section that was visible when close was requested.
    await page.evaluate(() => { (window as any).saveDelay = 200; (window as any).fixtureClosed = false })
    await page.getByRole("button", { name: "Chat", exact: true }).click()
    await page.waitForFunction(() => (window as any).savingRequest?.section === "chat")
    await page.evaluate(() => (window as any).closePreferences())
    await page.waitForFunction(() => (window as any).fixtureClosed)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-preferences")!).section), "chat")

    // Application shutdown drains the view before native state ownership is
    // released, even if the scroll debounce has not fired yet.
    await page.reload()
    await page.waitForFunction(() => (window as any).ready)
    await scroll.hover()
    await page.mouse.wheel(0, 520)
    await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")!.scrollTop >= 500)
    const shutdownTop = await scroll.evaluate(e => Math.round(e.scrollTop))
    await page.evaluate(() => (window as any).__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__())
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-preferences")!).scrollTop), shutdownTop)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, content: (await page.locator("body").innerText()).slice(0, 1000) })
    throw error
  } finally { await page.close() }
})

test("a session error is announced in the windows showing sessions, never again in Preferences", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.electronAPI = {
      getPreferencesRequest: async () => ({ section: "general" }),
      acceptPreferencesRequest: async () => {},
      preferencesReady: async () => { w.ready = true },
      onPreferencesSection: () => () => {},
      onPreferencesCloseRequested: () => () => {},
      onPreferencesTransitionRequested: () => () => {},
      closeWindow: async () => {},
    }
  }` })
  await page.route("**/api/**", route => new URL(route.request().url()).pathname.startsWith("/api/")
    ? route.fulfill({ contentType: "application/json", body: "{}" })
    : route.continue())
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).ready)
    await page.evaluate(() => (window as any).preferencesFixture.dispatch([{ type: "instance.event", instanceId: "workspace-1", event: {
      id: "evt_failed", type: "session.execution.failed", created: Date.now(), location: { directory: "/project" },
      data: { sessionID: "ses_limited", error: { message: "Usage limit reached" } } } }]))
    // The window's event stream received it (the connection status follows every event).
    await page.waitForFunction(() => (window as any).preferencesFixture.status("workspace-1") === "connected")
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
    assert.equal(await page.getByRole("alertdialog").count(), 0, "the alert to acknowledge appears only where sessions are shown")
    assert.equal(await page.getByText("Usage limit reached").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a row hint from another window focuses the linked setting row on the native request and on later storage events", async () => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, locale: "en-US" })
  const page = await context.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    localStorage.setItem("codenomad.settings.rowTarget", JSON.stringify({ section: "opencode", row: "opencode-login-start", at: Date.now() }))
    w.electronAPI = {
      getPreferencesRequest: async () => ({ section: "opencode" }),
      acceptPreferencesRequest: async () => {},
      preferencesReady: async () => { w.ready = true },
      onPreferencesSection: (listener) => { w.section = listener; return () => {} },
      onPreferencesCloseRequested: () => () => {},
      onPreferencesTransitionRequested: () => () => {},
      closeWindow: async () => {},
    }
  }` })
  await context.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  const focused = () => page.waitForFunction(() => document.activeElement?.id === "opencode-login-start")
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).ready)
    await focused()
    assert.equal(await page.evaluate(() => localStorage.getItem("codenomad.settings.rowTarget")), null, "the hint is consumed once")
    await page.getByRole("button", { name: "OpenCode", exact: true }).focus()
    // Another window of the same origin links again while this one already shows the section.
    const other = await context.newPage()
    await other.goto(new URL("/api/fixture-origin", url).href)
    await other.evaluate(() => localStorage.setItem("codenomad.settings.rowTarget",
      JSON.stringify({ section: "opencode", row: "opencode-login-start", at: Date.now() })))
    await focused()
    await other.close()
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("Settings → Servers is the one place that opens, edits, adds and removes saved servers; Remote Access keeps none", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.windows = []
    w.electronAPI = {
      getPreferencesRequest: async () => ({ section: "remote" }),
      acceptPreferencesRequest: async () => {},
      preferencesReady: async () => { w.ready = true },
      onPreferencesSection: () => () => {},
      onPreferencesCloseRequested: () => () => {},
      onPreferencesTransitionRequested: () => () => {},
      openRemoteWindow: async (payload) => { w.windows.push(payload.id) },
      closeWindow: async () => {},
    }
  }` })
  let state: Record<string, unknown> = { remoteServers: [{ id: "box", name: "Box", baseUrl: "https://box.example", skipTlsVerify: false,
    createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z" }] }
  const probes: string[] = []
  await page.route("**/api/**", route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (pathname === "/api/remote-servers/probe") {
      const { baseUrl } = request.postDataJSON() as { baseUrl: string }
      probes.push(baseUrl)
      return route.fulfill({ json: { ok: true, reachable: true, normalizedUrl: baseUrl, skipTlsVerify: false, requiresAuth: true, authenticated: false } })
    }
    if (pathname === "/api/storage/state/ui" && request.method() === "PATCH") {
      state = { ...state, ...(request.postDataJSON() as Record<string, unknown>) }
      return route.fulfill({ json: state })
    }
    return route.fulfill({ json: pathname === "/api/storage/state/ui" ? state : {} })
  })
  const servers = () => (state.remoteServers as Array<{ id: string; name: string; baseUrl: string }>).map(({ id, name, baseUrl }) => [id, name, baseUrl])
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).ready)
    await page.locator(".settings-screen-scroll").getByText("Remote Control", { exact: false }).first().waitFor()
    const nav = await page.locator(".settings-nav-button").allTextContents()
    assert.equal(nav[nav.indexOf("Remote Access") + 1], "Servers")
    // Remote Access only lets other devices drive this computer.
    for (const gone of ["Saved Servers", "Connect CodeNomad Server", "Add server…", "Box"]) {
      assert.equal(await page.locator(".settings-screen-scroll").getByText(gone, { exact: true }).count(), 0, gone)
    }

    await page.getByRole("button", { name: "Servers", exact: true }).click()
    const row = page.locator('[data-remote-server="box"]')
    await row.getByText("https://box.example").waitFor()
    assert.equal(await row.locator("svg").count() >= 1, true, "the row shows the server icon")

    // Editing keeps the server's identity without probing it.
    await page.getByRole("button", { name: "Edit server: Box", exact: true }).click()
    const edit = page.getByRole("dialog", { name: "Edit server", exact: true })
    await edit.getByLabel("Server name").fill("Office")
    await edit.getByRole("button", { name: "Save", exact: true }).click()
    await edit.waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Edit server: Office", exact: true }).waitFor()
    assert.deepEqual(servers(), [["box", "Office", "https://box.example"]])
    assert.deepEqual(probes, [])

    // Adding: the name is optional, the server then reads as its host name.
    await page.getByRole("button", { name: "Add server…", exact: true }).click()
    const add = page.getByRole("dialog", { name: "Connect to Server", exact: true })
    await add.getByLabel("Server URL").fill("https://lab.example")
    await add.getByRole("button", { name: "Save", exact: true }).click()
    await add.waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Edit server: lab.example", exact: true }).waitFor()
    assert.deepEqual(probes, ["https://lab.example"])

    // Preferences has no tabs: a server opens in its own window.
    await page.getByRole("button", { name: "Open: Office", exact: true }).click()
    await page.waitForFunction(() => (window as any).windows.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).windows), ["box"])

    await page.getByRole("button", { name: "Remove saved server: Office", exact: true }).click()
    // The confirmation's own button; the row's carries the server's name.
    await page.getByRole("button", { name: "Remove saved server", exact: true }).click()
    await row.waitFor({ state: "detached" })
    assert.deepEqual(servers().map(([, name]) => name), ["lab.example"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})