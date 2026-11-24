import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "empty-tab",
    routes: [{ path: "/fixture", html: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/empty-tab.tsx"></script></body></html>' }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const profiles = ["Beta", "Alpha"].map(name => ({
  id: name.toLowerCase(), name, baseUrl: `https://${name.toLowerCase()}.example`,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
}))

async function openApp(page: Page, remoteServers = profiles, recentFolders: { path: string; lastAccessed: number }[] = [], configureRoutes?: () => Promise<void>) {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
    if (path.endsWith("/browse")) return route.fulfill({ status: 409, json: { error: "needs_credentials", code: "needs_credentials" } })
    const data: Record<string, unknown> = {
      "/api/workspaces": [],
      "/api/storage/config/ui": { settings: { locale: "en" } },
      "/api/storage/state/ui": { remoteServers, recentFolders },
      "/api/meta": { serversUsable: true, serversManageable: true, secretEntryAllowed: true },
      "/api/opencode/update": { state: "ready", serviceState: "ready" },
      "/api/opencode/login/start": { state: "off" },
      "/api/sidecars": { sidecars: [] },
    }
    return route.fulfill({ json: data[path] ?? {} })
  })
  await configureRoutes?.()
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await page.getByRole("heading", { name: "CodeNomad", exact: true }).waitFor()
}

for (const mode of ["desktop", "web", "phone"]) {
  test(`${mode}: the empty tab is the start page and app controls stay in the tab bar`, async () => {
    const page = await browser.newPage({ viewport: { width: mode === "phone" ? 390 : 1280, height: 850 } })
    try {
      if (mode === "desktop") await page.addInitScript(`{
        // Exercise the local desktop renderer in Chromium without starting a desktop host.
        Object.assign(window, { __CODENOMAD_WINDOW_CONTEXT__: "local", __CODENOMAD_RUNTIME_HOST__: "electron",
          electronAPI: {
            loadClientState: async () => ({ isPrimary: true, restoreEnabled: true }), claimClientStateAccess: async () => true,
            onMenuAction(callback) { window.runFixtureMenuAction = callback; return () => {} },
          } })
      }`)
      await openApp(page)
      const blank = page.locator('[data-tab-kind="blank"]')
      const blankId = await blank.getAttribute("data-tab-id")
      assert.ok(blankId)
      const logo = page.locator(mode === "desktop" ? ".native-titlebar-brand img" : ".tab-bar-logo img").first()
      assert.equal(await logo.evaluate(el => !!el.closest("a, button")), false)
      const actions = page.locator(".tab-bar-actions")
      for (const name of ["Open settings", "Remote connect"]) {
        assert.ok(await actions.getByRole("button", { name, exact: true }).isVisible())
        assert.equal(await blank.getByRole("button", { name, exact: true }).count(), 0)
      }
      if (mode === "web") {
        await actions.getByRole("button", { name: "Remote connect", exact: true }).click()
        await page.getByRole("button", { name: "Remote Access", exact: true }).waitFor()
        await page.getByRole("button", { name: "Close settings", exact: true }).click()
      }
      assert.equal(await blank.locator('[aria-label="Language"]').count(), 0)
      for (const name of ["Sponsor", "CodeNomad GitHub", "CodeNomad GitHub Stars", "CodeNomad Discord"]) {
        assert.ok(await blank.getByRole("link", { name, exact: true }).isVisible(), name)
      }
      const browse = (await blank.getByRole("region", { name: "Browse", exact: true }).boundingBox())!
      const recent = (await blank.getByRole("region", { name: "Recent tabs", exact: true }).boundingBox())!
      if (mode === "phone") assert.ok(browse.y + browse.height < recent.y)
      else {
        assert.ok(browse.height >= 256)
        assert.equal(browse.height, recent.height)
        assert.equal(browse.y, recent.y)
        assert.ok(browse.x + browse.width < recent.x)
      }

      await page.evaluate(() => (window as unknown as { openFixtureProject(): void }).openFixtureProject())
      await page.locator('[data-remote-restore="demo"]').waitFor()
      if (mode === "web") {
        await page.getByRole("button", { name: "New instance", exact: true }).click({ button: "right" })
        const launcher = page.getByRole("dialog", { name: "Recent tabs", exact: true })
        const describedBy = await launcher.getAttribute("aria-describedby")
        assert.ok(describedBy)
        assert.equal(await page.locator(`[id="${describedBy}"]`).textContent(), "Choose a recent project.")
        await page.keyboard.press("Escape")
      }
      await page.getByRole("button", { name: "New instance", exact: true }).click()
      const activeBlank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
      const secondId = await activeBlank.getAttribute("data-tab-id")
      assert.notEqual(secondId, blankId)
      assert.equal(await blank.count(), 2)
      await page.keyboard.press("Control+n")
      const thirdId = await activeBlank.getAttribute("data-tab-id")
      assert.notEqual(thirdId, secondId)
      assert.notEqual(thirdId, blankId)
      assert.equal(await blank.count(), 3)
      if (mode === "desktop") {
        await page.evaluate(() => (window as unknown as { runFixtureMenuAction(action: string): void }).runFixtureMenuAction("new-instance"))
        assert.equal(await blank.count(), 4)
        assert.notEqual(await activeBlank.getAttribute("data-tab-id"), thirdId)
        await page.keyboard.press("Control+w")
        assert.equal(await activeBlank.getAttribute("data-tab-id"), thirdId)
      }
      await page.keyboard.press("Control+w")
      assert.equal(await activeBlank.getAttribute("data-tab-id"), secondId)
      await page.keyboard.press("Control+w")
      await page.locator('[data-remote-restore="demo"]').waitFor()
      await page.keyboard.press("Control+w")
      assert.equal(await activeBlank.getAttribute("data-tab-id"), blankId)
      await page.keyboard.press("Control+w")
      await blank.getByRole("heading", { name: "CodeNomad", exact: true }).waitFor()
      assert.equal(await blank.count(), 1)
      assert.notEqual(await activeBlank.getAttribute("data-tab-id"), blankId)
    } finally {
      await page.close()
    }
  })
}

test("a short stacked Browse panel leaves room for long recents without expanding with them", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  try {
    const recents = Array.from({ length: 20 }, (_, index) => ({ path: `/project-${index}`, lastAccessed: 20 - index }))
    await openApp(page, profiles, recents)
    const root = page.locator(".folder-home-root:visible")
    const browse = root.getByRole("region", { name: "Browse", exact: true })
    const recent = root.getByRole("region", { name: "Recent tabs", exact: true })
    await recent.getByRole("listitem").nth(19).waitFor()
    let narrowHeight = 0
    let compactBrowseHeight = 0
    for (const [width, height] of [[1280, 850], [390, 850], [390, 1319], [390, 620], [639, 620], [640, 620], [1280, 850]]) {
      await page.setViewportSize({ width, height })
      const first = (await browse.boundingBox())!
      const second = (await recent.boundingBox())!
      assert.ok(second.height >= 256, JSON.stringify({ width, height, second }))
      if (width <= 639) {
        assert.ok(first.y + first.height < second.y)
        assert.ok(first.height < 256, JSON.stringify({ width, height, first }))
        assert.ok(second.height <= height - first.height, JSON.stringify({ width, height, second }))
        if (height === 850) {
          narrowHeight = second.height
          compactBrowseHeight = first.height
        }
        assert.equal(first.height, compactBrowseHeight)
        if (height === 1319) assert.ok(second.height > narrowHeight, "stacked panels still grow with available height")
      } else {
        assert.equal(first.height, second.height)
        assert.equal(first.y, second.y)
        assert.ok(first.x + first.width < second.x)
      }
      const list = recent.getByRole("list")
      assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight), "recents scroll inside the panel")
      const footer = (await root.locator(".folder-home-shell > .text-center").last().boundingBox())!
      assert.ok(footer.y >= second.y + second.height, "the footer follows both panels")
      assert.ok(await root.evaluate(el => el.scrollWidth <= el.clientWidth), "the page fits horizontally")
    }
  } finally { await page.close() }
})

test("stacked recents collapse to their empty state or one or two rows", async () => {
  let previousHeight = 0
  for (const count of [0, 1, 2]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 850 } })
    try {
      const recents = Array.from({ length: count }, (_, index) => ({ path: `/project-${index}`, lastAccessed: 20 - index }))
      await openApp(page, profiles, recents)
      const recent = page.getByRole("region", { name: "Recent tabs", exact: true })
      if (count) await recent.getByRole("listitem").nth(count - 1).waitFor()
      else await recent.getByRole("status").waitFor()
      const { height } = (await recent.boundingBox())!
      assert.ok(height > previousHeight && height < 256, JSON.stringify({ count, height, previousHeight }))
      previousHeight = height
    } finally { await page.close() }
  }
})

for (const [delayed, touch] of [["recents", false], ["sidecars", false], ["recents", true], ["sidecars", true]] as const) {
  test(`a stacked Browse submit survives ${delayed} arriving during a ${touch ? "tap" : "click"}`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 850 }, hasTouch: touch, isMobile: touch })
    const arrival = Promise.withResolvers<void>()
    const recents = Array.from({ length: 20 }, (_, i) => ({ path: `/project-${i}`, lastAccessed: 20 - i }))
    const sidecars = Array.from({ length: 8 }, (_, i) => ({ id: `sidecar-${i}`, name: `SideCar ${i}`, status: "running", kind: "port", port: 7000 + i }))
    let probes = 0
    try {
      await openApp(page, [], recents, async () => {
        await page.route("**/api/meta", route => route.fulfill({ json: { sidecarsAllowed: true, serversUsable: true, serversManageable: true, secretEntryAllowed: true } }))
        await page.route("**/api/storage/state/ui", async route => {
          if (delayed === "recents") await arrival.promise
          await route.fallback()
        })
        await page.route("**/api/sidecars", async route => {
          if (delayed === "sidecars") await arrival.promise
          await route.fulfill({ json: { sidecars } })
        })
        await page.route("**/api/remote-servers/probe", route => {
          probes++
          return route.fulfill({ status: 502, json: { error: "unreachable", code: "unreachable" } })
        })
      })
      const browse = page.getByRole("region", { name: "Browse", exact: true })
      const lastSidecar = browse.locator('[data-sidecar="sidecar-7"]')
      const lastRecent = page.getByRole("region", { name: "Recent tabs", exact: true }).getByRole("listitem").nth(19)
      await (delayed === "recents" ? lastSidecar : lastRecent).waitFor()
      await browse.locator(".browse-menu-footer input").fill("https://new-server.example")
      const submit = browse.locator(".browse-menu-footer button[type=submit]")
      await submit.scrollIntoViewIfNeeded()
      const { x, y, width, height } = (await submit.boundingBox())!
      const point = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) }
      const input = touch ? await page.context().newCDPSession(page) : undefined
      if (input) await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
      else {
        await page.mouse.move(point.x, point.y)
        await page.mouse.down()
      }
      arrival.resolve()
      await (delayed === "recents" ? lastRecent : lastSidecar).waitFor()
      assert.ok(await submit.evaluate((button, point) => button.contains(document.elementFromPoint(point.x, point.y)), point),
        "the same pointer position still hits Submit")
      if (input) await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      else await page.mouse.up()
      await browse.getByRole("alert").waitFor({ timeout: 5000 })
      assert.equal(probes, 1)
    } finally {
      arrival.resolve()
      await page.close()
    }
  })
}

for (const width of [1280, 390]) {
  test(`direct HTTPS sign-in fits the Browse panel at ${width} pixels`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 850 } })
    try {
      await openApp(page)
      await page.locator('[data-remote-server="alpha"]').click()
      await page.getByRole("textbox", { name: "New pairing link", exact: true }).waitFor()
      const submit = page.getByRole("button", { name: "Sign in", exact: true })
      await submit.scrollIntoViewIfNeeded()
      const bounds = await page.locator(".browse-menu:visible").boundingBox()
      const button = await submit.boundingBox()
      assert.ok(bounds && button && button.y + button.height <= bounds.y + bounds.height + 1, JSON.stringify({ bounds, button }))
      await submit.click({ trial: true })
    } finally {
      await page.close()
    }
  })
}

test("server settings keep the saved order for equal dates and reuse the active empty tab", async () => {
  const page = await browser.newPage()
  try {
    await openApp(page)
    const blank = page.locator('[data-tab-kind="blank"]')
    const blankId = await blank.getAttribute("data-tab-id")
    await blank.locator('[data-remote-server="alpha"]').click()
    await blank.locator(".remote-server-navigation bdi").getByText("Alpha", { exact: true }).waitFor()
    await page.getByRole("button", { name: "New instance", exact: true }).click()
    const active = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    const activeId = await active.getAttribute("data-tab-id")
    await active.locator('[data-remote-server="alpha"]').waitFor()
    await page.getByRole("button", { name: "Open settings", exact: true }).click()
    await page.locator('button[aria-label="Language"]').waitFor()
    await page.getByRole("button", { name: "Servers", exact: true }).click()
    const rows = page.getByRole("button", { name: /^Open: (Beta|Alpha)$/ })
    await rows.nth(1).waitFor()
    assert.deepEqual(await rows.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label"))), ["Open: Beta", "Open: Alpha"])
    await rows.first().click()
    await active.locator(".remote-server-navigation bdi").getByText("Beta", { exact: true }).waitFor()
    assert.equal(await active.getAttribute("data-tab-id"), activeId)
    assert.equal(await blank.count(), 2)
    await page.locator(`[data-app-tab-id="${blankId}"]`).getByRole("tab").click()
    await active.locator(".remote-server-navigation bdi").getByText("Alpha", { exact: true }).waitFor()
    await page.locator(`[data-app-tab-id="${activeId}"]`).getByRole("tab").click()
    await active.locator(".remote-server-navigation bdi").getByText("Beta", { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test("startup keeps the loading state and restores the last selected tab", async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript(`{
      Object.assign(window, { __CODENOMAD_WINDOW_CONTEXT__: "local", __CODENOMAD_RUNTIME_HOST__: "electron",
        electronAPI: {
          claimClientStateAccess: async () => true,
          loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: {
            version: 1, revision: 1, savedAt: 1, layout: {}, session: {
              activeTabIndex: 1, homeActive: true,
              tabs: ["First", "Last"].map(name => ({
                kind: "workspace", backendId: "offline", folder: "/" + name, occurrence: 0, projectName: name,
                drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
              })),
            },
          } }),
        },
      })
    }`)
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname
      if (path === "/api/storage/config/ui") await hold
      if (path === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
      return route.fulfill({ json: path === "/api/workspaces" ? [] : path === "/api/storage/config/ui"
        ? { settings: { locale: "en", multiBackend: true } } : path === "/api/opencode/update"
          ? { state: "ready", serviceState: "ready" } : {} })
    })
    await page.goto(url, { waitUntil: "commit" })
    try {
      await page.locator(".loading-state").waitFor({ timeout: 30000 })
      assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
    } finally { release() }
    const selected = page.locator('[data-tab-kind="remote-restore"][data-tab-visible="true"]')
    await selected.waitFor()
    assert.match(await selected.innerText(), /Last/)
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
  } finally { await page.close() }
})

test("web reload restores several empty tabs in order with the last one selected", async () => {
  const page = await browser.newPage()
  try {
    await openApp(page)
    await page.evaluate(() => (window as unknown as { openFixtureProject(): void }).openFixtureProject())
    await page.getByRole("button", { name: "New instance", exact: true }).click()
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.getByRole("heading", { name: "CodeNomad", exact: true }).waitFor()
    const contents = page.locator("[data-tab-kind]")
    assert.deepEqual(await contents.evaluateAll(tabs => tabs.map(tab => [
      tab.getAttribute("data-tab-kind"), tab.getAttribute("data-tab-visible"),
    ])), [["blank", "false"], ["remote-restore", "false"], ["blank", "true"]])
    await page.keyboard.press("Control+w")
    await page.locator('[data-remote-restore="demo"]').waitFor()
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.locator('[data-remote-restore="demo"]').waitFor()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 1)
  } finally { await page.close() }
})
