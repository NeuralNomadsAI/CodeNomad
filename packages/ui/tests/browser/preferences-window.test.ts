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

test("project context exposes only matching server metadata and fences ambiguity, removal, reuse and late reads", async () => {
  const page = await browser.newPage()
  const calls: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.electronAPI = { getPreferencesRequest: async () => ({ section: "general" }), acceptPreferencesRequest: async () => {},
      preferencesReady: async () => {}, onPreferencesSection: () => () => {}, onPreferencesCloseRequested: () => () => {}, onPreferencesTransitionRequested: () => () => {} }
  }` })
  const record = (id: string, serverId: string, path = "/App/") => ({ id, path, status: "ready", binding: { serverId, directory: path },
    capabilities: { serverId, generation: 1, features: { executionSettings: { state: "unavailable", reason: { code: "localOnly" }, evidence: "e1Policy" } } }, proxyPath: `/workspaces/${id}/instance` })
  let inventory = [record("same", "B"), record("local", "local-shared"), record("A-1", "A")]
  let hold: Promise<void> | undefined, release: (() => void) | undefined, held = false
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith("/api/") && !path.startsWith("/workspaces/")) return route.continue()
    if (path.includes("workspaces")) calls.push(path)
    if (path === "/api/workspaces") {
      const snapshot = inventory
      if (hold) { const pending = hold; hold = undefined; held = true; await pending }
      return route.fulfill({ json: snapshot }).catch(() => undefined)
    }
    return route.fulfill({ json: path === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
  })
  const request = (serverId: string, instanceId = "same", path = "/App/") => ({ section: "providers", serverId, instanceId, workspacePath: path, location: { directory: path, workspaceID: "stale" } })
  const setRequest = async (value: unknown) => page.evaluate(value => (window as any).contextHarness.setRequest(value), value)
  const context = () => page.evaluate(() => (window as any).contextHarness.context())
  const dispatch = async (event: unknown) => page.evaluate(event => (window as any).preferencesFixture.dispatch([event]), event)
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).preferencesFixture)
    await page.evaluate(value => { (window as any).contextHarness = (window as any).preferencesFixture.startContext(value) }, request("A"))
    await page.waitForFunction(() => (window as any).contextHarness.context()?.instanceId === "A-1")
    const resolved = await context()
    assert.deepEqual(resolved.binding, { serverId: "A", directory: "/App/" })
    assert.deepEqual(resolved.location, { directory: "/App/" })
    assert.equal(resolved.capabilities.features.executionSettings.reason.code, "localOnly")
    assert.ok(calls.every(path => path === "/api/workspaces"), JSON.stringify(calls))

    // Even a ready occurrence on the same server loses authority when its opened folder changes.
    // Keep the refresh pending so the assertion observes event-time revocation, not its HTTP result.
    await setRequest(request("A", "A-1"))
    await page.waitForFunction(() => (window as any).contextHarness.context()?.instanceId === "A-1")
    inventory = [record("A-1", "A", "/autre")]
    hold = new Promise(resolve => { release = resolve })
    assert.equal(await page.evaluate(workspace => {
      const w = window as any
      w.preferencesFixture.dispatch([{ type: "workspace.started", workspace }])
      return w.contextHarness.context()
    }, inventory[0]), undefined, "the folder change must revoke context synchronously")
    for (let attempt = 0; !held && attempt < 100; attempt++) await page.waitForTimeout(10)
    assert.ok(held, "the changed-folder metadata response is held")
    assert.equal(await context(), undefined)
    assert.ok(calls.every(path => path === "/api/workspaces"), JSON.stringify(calls))
    release!()
    await page.waitForTimeout(100)
    assert.equal(await context(), undefined, "late inventory cannot authorize the other folder")
    inventory = [record("A-1", "A")]
    await dispatch({ type: "workspace.started", workspace: inventory[0] })
    await page.waitForFunction(() => (window as any).contextHarness.context()?.instanceId === "A-1")

    await setRequest(request("A", "A-1", "/Other/"))
    await page.waitForTimeout(100)
    assert.equal(await context(), undefined, "an exact ID must still match the captured opened folder")
    inventory = [record("cap-stale", "A")]
    inventory[0]!.capabilities.serverId = "B"
    await setRequest(request("A", "cap-stale"))
    await page.waitForTimeout(100)
    assert.equal(await context(), undefined, "capability metadata belongs to the validated server")

    inventory = [record("same", "B"), record("A-1", "A"), record("A-2", "A")]
    await setRequest(request("A", "missing"))
    await page.waitForTimeout(100)
    assert.equal(await context(), undefined, "two same-server candidates are ambiguous")
    await dispatch({ type: "workspace.stopped", workspaceId: "A-2", reason: "deleted" })
    await page.waitForFunction(() => (window as any).contextHarness.context()?.instanceId === "A-1")
    await dispatch({ type: "workspace.stopped", workspaceId: "A-1", reason: "deleted" })
    await page.waitForTimeout(100)
    assert.equal(await context(), undefined, "a closed occurrence cannot reappear from stale inventory")

    inventory = [record("local", "local-shared"), record("fresh-A", "A", "/app/"), record("trailing-A", "A", "/App")]
    await setRequest(request("A", "orphan"))
    await page.waitForTimeout(100)
    assert.equal(await context(), undefined, "remote case and trailing characters remain opaque")
    await setRequest(request("unknown-profile", "local"))
    await page.waitForTimeout(100)
    assert.equal(await context(), undefined, "unknown identity never falls back to local")
    await setRequest({ section: "providers", instanceId: "local", workspacePath: "/App/" })
    await page.waitForFunction(() => (window as any).contextHarness.context()?.binding.serverId === "local-shared")

    inventory = [record("late-A", "A")]
    held = false
    hold = new Promise(resolve => { release = resolve })
    await setRequest(request("A", "late"))
    for (let attempt = 0; !held && attempt < 100; attempt++) await page.waitForTimeout(10)
    assert.ok(held, "the old server read reached the held response")
    inventory = [record("same", "B")]
    await setRequest(request("B"))
    await page.waitForFunction(() => (window as any).contextHarness.context()?.binding.serverId === "B")
    release!()
    await page.waitForTimeout(100)
    assert.equal((await context()).binding.serverId, "B")
    assert.equal(await page.evaluate(() => (window as any).contextHarness.rebounds.some((value: any) => value.instanceId === "late-A")), false)

    // A reused backend ID arriving from a different server revokes the old authority immediately.
    inventory = [record("same", "A")]
    await dispatch({ type: "workspace.started", workspace: inventory[0] })
    await page.waitForTimeout(100)
    assert.equal(await context(), undefined)
    await page.evaluate(() => (window as any).contextHarness.dispose())
    assert.ok(calls.every(path => path === "/api/workspaces"), JSON.stringify(calls))
    assert.deepEqual(errors, [])
  } finally { release?.(); await page.close() }
})

test("an invalid URL opened folder cannot resolve an exact ID on another folder", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const projectCalls: string[] = []
  await page.addInitScript({ content: `{
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.electronAPI = { getPreferencesRequest: async () => null, acceptPreferencesRequest: async () => {},
      preferencesReady: async () => { w.ready = true }, onPreferencesSection: () => () => {},
      onPreferencesCloseRequested: () => () => {}, onPreferencesTransitionRequested: () => () => {} }
  }` })
  await page.route(/\/(?:api|workspaces)\//, route => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/workspaces" || path.startsWith("/workspaces/") || path.startsWith("/api/opencode/") || path.includes("/binaries/")) projectCalls.push(path)
    return route.fulfill({ json: path === "/api/workspaces"
      ? [{ id: "same", path: "/autre", status: "ready", binding: { serverId: "A", directory: "/autre" }, proxyPath: "/workspaces/same/instance" }]
      : path === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
  })
  try {
    await page.goto(url + "?preferences=providers&preferencesServerId=A&preferencesInstanceId=same&preferencesWorkspacePath=%00")
    await page.waitForFunction(() => (window as any).ready)
    assert.equal(await page.getByRole("button", { name: "General", exact: true }).getAttribute("aria-current"), "page")
    assert.deepEqual(projectCalls, [], "rejected context must not acquire project authority or discover the local service")
  } finally { await page.close() }
})

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

test("a guarded server switch keeps the accepted request and scroll until native acceptance", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  await page.addInitScript({ content: `{
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.accepted = { section: "chat", serverId: "A", instanceId: "project-A", workspacePath: "/same", scrollTop: 300 }
    w.electronAPI = {
      getPreferencesRequest: async () => w.accepted,
      acceptPreferencesRequest: async request => {
        w.pending = request
        if (w.hold) await new Promise(resolve => { w.release = resolve })
        w.accepted = request
      },
      preferencesReady: async () => { w.ready = true },
      onPreferencesSection: listener => { w.section = listener; return () => {} },
      onPreferencesCloseRequested: () => () => {}, onPreferencesTransitionRequested: () => () => {},
    }
  }` })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).ready && document.querySelector(".settings-screen-scroll")?.scrollTop === 300)
    await page.evaluate(() => { (window as any).preferencesFixture.guard(() => (window as any).allowDiscard === true) })
    const next = { section: "chat", serverId: "B", instanceId: "project-B", workspacePath: "/same", scrollTop: 180 }
    await page.evaluate(value => (window as any).section(value), next)
    await page.evaluate(() => (window as any).__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__())
    assert.equal(await page.evaluate(() => (window as any).accepted.serverId), "A")
    assert.equal(await page.locator(".settings-screen-scroll").evaluate(element => element.scrollTop), 300)

    await page.evaluate(value => { const w = window as any; w.allowDiscard = true; w.hold = true; w.section(value) }, next)
    await page.waitForFunction(() => Boolean((window as any).release))
    assert.equal(await page.evaluate(() => (window as any).accepted.serverId), "A")
    assert.equal(await page.locator(".settings-screen-scroll").evaluate(element => element.scrollTop), 300)
    await page.evaluate(() => { const w = window as any; w.hold = false; w.release() })
    await page.waitForFunction(() => (window as any).accepted.serverId === "B" && document.querySelector(".settings-screen-scroll")?.scrollTop === 180)
    assert.equal(await page.getByRole("button", { name: "Chat", exact: true }).getAttribute("aria-current"), "page")
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
    await page.evaluate(() => (window as any).preferencesFixture.dispatch([
      { type: "instance.eventStatus", instanceId: "workspace-1", status: "connected", source: { serverId: "local-shared", generation: 1 } },
      { type: "instance.event", instanceId: "workspace-1", source: { serverId: "local-shared", generation: 1 }, event: {
      id: "evt_failed", type: "session.execution.failed", created: Date.now(), location: { directory: "/project" },
      data: { sessionID: "ses_limited", error: { message: "Usage limit reached" } } } }]))
    // The window received the authoritative status handshake and its event.
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
