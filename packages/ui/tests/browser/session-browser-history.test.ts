import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import electronPath from "electron"
import { chromium, _electron, type Browser, type Page } from "playwright"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { build } from "esbuild"
import type { MissionMap } from "../../../server/src/api-types"
import { missionPanelRoute } from "./mission-panel-route"
import { missionContentFixture, panelMissions } from "./mission-content-fixture"
import { prepareGitPrototypeAssets } from "./fixtures/git-history-assets.mjs"

let server: ViteDevServer, browser: Browser, base: string
const pageRequests: string[] = []
let holdHistoryRequest: ((release: () => void) => void) | undefined
before(async () => {
  prepareGitPrototypeAssets()
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
    publicDir: fileURLToPath(new URL("../../src/renderer/public", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, solid(), { name: "session-browser-history", configureServer(s) {
      s.middlewares.use("/history-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/history-fixture", '<html><head><style>webview{display:flex}</style></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-browser-history.tsx"></script></body></html>'))
      })
      s.middlewares.use("/page", (req, res) => {
        pageRequests.push(req.url!)
        res.setHeader("Content-Type", "text/html")
        res.end('<html><body><a href="/page/b">Next page</a><input id="draft"></body></html>')
      })
      s.middlewares.use("/shared-site", (req, res) => {
        if (req.url === "/login") res.setHeader("Set-Cookie", "shared_login=fixture; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600")
        if (req.url === "/logout") res.setHeader("Set-Cookie", "shared_login=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
        const signedIn = req.headers.cookie?.includes("shared_login=fixture") ?? false
        res.setHeader("Content-Type", "text/html")
        res.end(`<html><body><p id="signed-in">${signedIn}</p></body></html>`)
      })
      s.middlewares.use("/interrupted-history", (req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.setHeader("Cache-Control", "no-store")
        // Force Back to fetch the document instead of restoring it from BFCache.
        const release = () => res.end('<html><body>Interrupted history<script>addEventListener("unload", () => {})</script></body></html>')
        if (req.url === "/a" && holdHistoryRequest) {
          const hold = holdHistoryRequest
          holdHistoryRequest = undefined
          hold(release)
        } else release()
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } }).catch(async error => { await cache.dispose(); throw error })
  shutdown.own(server)
  await server.listen()
  base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

async function prepare(page: Page, host: string, query = "") {
  page.setDefaultTimeout(20_000)
  page.on("pageerror", error => console.error("[browser history fixture]", error))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/panel-extensions", route => route.fulfill({ json: [] }))
  await page.goto(`${base}/history-fixture?host=${host}${query}`)
  await page.waitForFunction(() => (window as any).browserHistoryReady, undefined, { timeout: 60_000 })
}
const preview = (page: Page, sessionId: string) => page.evaluate(id => (window as any).fixture.preview(id), sessionId)

test("a duplicate's toolbar reopens a saved preview after its first requester closes", { timeout: 90_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  try {
    await prepare(page, "web", "&duplicate=1")
    const url = `${base}/page/saved`
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), url)
    await page.locator('[data-preview-instance="header-windows"]').getByRole("button", { name: "Close", exact: true }).click()
    await page.reload()
    await page.waitForFunction(() => (window as any).browserHistoryReady)
    await page.evaluate(url => (window as any).fixture.delayPreview(url, false, true), url)
    await page.locator('[data-occurrence="header-windows"]').getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.isPreviewDelayed())
    await page.evaluate(() => (window as any).fixture.selectOccurrence("header-duplicate"))
    await page.locator('[data-occurrence="header-duplicate"]').getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.closeOccurrence("header-windows")
      f.releasePreview()
    })
    await page.locator('[data-preview-instance="header-duplicate"] .window-shell').waitFor({ state: "visible" })
    assert.equal(await page.evaluate(() => (window as any).fixture.preview("session", "header-duplicate")?.targetUrl), url)
    assert.equal(await page.evaluate(() => (window as any).fixture.deletedPreviews.length), 1, "only A's stale token is released")
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

for (const host of ["web", "tauri", "electron"]) test(`${host}: floating drawers cover the retained preview and retire its native target`, { timeout: 90_000 }, async () => {
  const native = host === "electron" ? await launchHistoryElectron() : undefined
  const page = native?.page ?? await browser.newPage({ viewport: { width: 800, height: 800 } })
  try {
    if (native) await native.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 800))
    await prepare(page, host)
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), `${base}/page/a`)
    const pane = page.locator('[data-preview-instance="header-windows"] .window-shell')
    await pane.waitFor({ state: "visible" })
    if (host !== "web") await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_register"))
    const guest = await page.locator(host === "electron" ? "webview" : host === "web" ? "iframe" : "[data-session-id] .window-shell").elementHandle()
    const token = (await preview(page, "session")).token
    await page.getByRole("button", { name: "Right panel", exact: true }).click()
    await page.locator(".session-floating-drawer .MuiDrawer-paper").waitFor({ state: "visible" })
    await page.getByRole("tab", { name: "Files", exact: true }).click()
    const hit = await page.evaluate(() => ({
      tag: document.elementFromPoint(600, 300)?.tagName,
      drawer: Boolean(document.elementFromPoint(600, 300)?.closest(".MuiDrawer-paper")),
    }))
    assert.equal(hit.drawer, true, `the drawer must receive input, not ${hit.tag}`)
    if (host === "tauri") await page.waitForFunction(() => (window as any).fixture.native.calls
      .filter((c: any) => c.command === "browser_target_update").at(-1)?.payload.visible === false)
    if (host === "electron") await page.waitForFunction(() => (window as any).fixture.native.calls.at(-1)?.command === "browser_target_unregister")
    await page.getByRole("button", { name: "Right panel", exact: true }).click()
    await page.locator(".session-floating-drawer").waitFor({ state: "detached" })
    await pane.waitFor({ state: "visible" })
    assert.equal((await preview(page, "session")).token, token)
    assert.equal(await guest!.evaluate(element => element.isConnected), true, "covering a preview retains its DOM")
    // The preview's own menu remains usable, above the guest.
    await pane.getByRole("button", { name: "Viewport size", exact: true }).click()
    await pane.getByRole("menuitemradio", { name: "Mobile viewport (390 x 844)", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.savedPreview("session")?.viewport === "mobile")
    await page.evaluate(() => (window as any).fixture.showPreviewDialog())
    const dialog = page.getByRole("dialog", { name: "Preview overlay", exact: true })
    await dialog.waitFor()
    assert.equal(await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    }), true, "dialogs paint above the retained guest")
    if (host === "tauri") await page.waitForFunction(() => (window as any).fixture.native.calls
      .filter((c: any) => c.command === "browser_target_update").at(-1)?.payload.visible === false)
    await dialog.getByRole("button", { name: "OK", exact: true }).click()
    await pane.waitFor({ state: "visible" })
  } finally {
    if (native) { await native.app.close(); await rm(native.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    else await page.close()
  }
})

for (const host of ["web", "tauri", "electron"]) test(`${host}: opening a duplicate uses the session's existing preview token and URL`, { timeout: 90_000 }, async () => {
  const native = host === "electron" ? await launchHistoryElectron() : undefined
  const page = native?.page ?? await browser.newPage({ viewport: { width: 1400, height: 900 } })
  try {
    await prepare(page, host, "&duplicate=1")
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), `${base}/page/a`)
    const original = await preview(page, "session")
    await page.evaluate(() => (window as any).fixture.selectOccurrence("header-duplicate"))
    const tab = page.locator('[data-occurrence="header-duplicate"]')
    await tab.locator(".message-stream-container").waitFor({ state: "visible" })
    await tab.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.preview("session", "header-duplicate")?.mode === "preview")
    const duplicate = await page.evaluate(() => (window as any).fixture.preview("session", "header-duplicate"))
    assert.equal(duplicate.token, original.token, "showing the other tab must reuse the session's token")
    assert.equal(duplicate.targetUrl, original.targetUrl, "showing the other tab must retain the session's URL")
  } finally {
    if (native) { await native.app.close(); await rm(native.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    else await page.close()
  }
})

test("localhost transcript links open only the clicked duplicate occurrence", { timeout: 90_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const a = "header-windows", b = "header-duplicate"
  try {
    await prepare(page, "web", "&duplicate=1&assistant=1&links=1")
    const root = (id: string) => page.locator(`[data-occurrence="${id}"]`)
    await root(a).getByRole("link", { name: "Local preview", exact: true }).click()
     await page.locator('[data-preview-instance="header-windows"] .window-shell').waitFor({ state: "visible" })
     assert.equal(await page.evaluate(id => (window as any).fixture.preview("session", id).mode, b), "chat")
    const original = await page.evaluate(id => (window as any).fixture.preview("session", id), a)
    await page.evaluate(id => (window as any).fixture.selectOccurrence(id), b)
    await root(b).getByRole("link", { name: "Local preview", exact: true }).click()
     await page.locator('[data-preview-instance="header-duplicate"] .window-shell').waitFor({ state: "visible" })
    const other = await page.evaluate(id => (window as any).fixture.preview("session", id), b)
     assert.equal(original.token, other.token)
    assert.equal(other.targetUrl, base.replace("127.0.0.1", "localhost") + "/page/a")
    assert.deepEqual(await page.evaluate(id => (window as any).fixture.preview("session", id), a), original)
  } finally { await page.close() }
})

test("a duplicate's diff, session selection, Info and Back/Forward preserve its sibling's reader and scroll", { timeout: 90_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const a = "header-windows", b = "header-duplicate"
  const root = (id: string) => page.locator(`[data-occurrence="${id}"]`)
  try {
    await prepare(page, "web", "&duplicate=1")
    await page.evaluate(id => (window as any).fixture.selectOccurrence(id), b)
    await page.evaluate(id => (window as any).fixture.readFile(id, "Long.md"), b)
    const markdown = root(b).locator(".workspace-markdown")
    await markdown.getByRole("heading", { name: "Long.md", exact: true }).waitFor()
    await markdown.evaluate(element => new Promise<void>(resolve => {
      element.addEventListener("scroll", () => resolve(), { once: true }); element.scrollTop = 900
    }))
    const scroll = await markdown.evaluate(element => element.scrollTop)
    const content = await markdown.textContent()
    assert.ok(scroll > 500)
    const before = await page.evaluate(id => (window as any).fixture.presentation(id), b)
    await page.evaluate(id => (window as any).fixture.selectOccurrence(id), a)
    await page.evaluate(id => (window as any).fixture.readDiff(id), a)
    await root(a).locator(".monaco-diff-editor").waitFor()
    assert.ok(await root(a).getByText("diff.ts", { exact: true }).count())
    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    await root(a).locator('[data-session-id="second"] .message-stream-container').waitFor()
    await page.evaluate(() => (window as any).fixture.showInfo())
    await root(a).getByRole("button", { name: "Back", exact: true }).click()
    await root(a).locator('[data-session-id="second"] .message-stream-container').waitFor()
    await root(a).getByRole("button", { name: "Back", exact: true }).click()
    await root(a).locator('[data-session-id="session"] .message-stream-container').waitFor()
    await root(a).getByRole("button", { name: "Forward", exact: true }).click()
    await root(a).locator('[data-session-id="second"] .message-stream-container').waitFor()
    assert.deepEqual(await page.evaluate(id => (window as any).fixture.presentation(id), b), before)
    await page.evaluate(id => (window as any).fixture.selectOccurrence(id), b)
    await markdown.getByRole("heading", { name: "Long.md", exact: true }).waitFor()
    assert.ok(Math.abs(await markdown.evaluate(element => element.scrollTop) - scroll) <= 2)
    assert.equal(await markdown.textContent(), content)
    assert.equal(await page.evaluate(id => (window as any).fixture.selection(id), b), "session")
    assert.equal(await root(b).locator('.session-cache-pane[data-session-id="session"][data-session-active="true"]').count(), 1)
  } finally { await page.close() }
})

for (const inventory of ["missing", "unavailable", "recovered"]) test(`real shell: ${inventory} Mission inventory cannot supersede a held browser gesture`, { timeout: 90_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const maps: MissionMap[] = [{
    version: 1, id: "mission-a", projectID: "fixture", projectCanonical: "/repo", objective: "Retained reader", title: "Mission A",
    template: "custom", coordinatorSessionId: "session", status: "active", runState: "running",
    actors: [], tasks: [], frontier: [], claims: [], history: [], historyTruncated: false, revision: 1, createdAt: 1, updatedAt: 1, reports: [],
  }]
  let refreshed = false
  try {
    await prepare(page, "web")
    await page.route("**/api/workspaces/*/missions**", missionPanelRoute(async route => {
      const req = route.request(), path = new URL(req.url()).pathname
      if (path.endsWith("/content")) return route.fulfill({ json: missionContentFixture(req.url(), req.method(), maps) })
      if (path.endsWith("/missions")) return route.fulfill({ json: refreshed && inventory !== "missing"
        ? { available: false, reason: "plugin-unavailable", missions: [] }
        : { available: true, projectID: "fixture", missions: panelMissions(refreshed ? [] : maps), generatedAt: refreshed ? 2 : 1, discardedEvents: 0 } })
      return route.fulfill({ json: {} })
    }))
    await page.evaluate(() => (window as any).fixture.readMission("header-windows", "overview"))
    await page.locator(".mission-reader").getByText("Retained reader", { exact: true }).waitFor()
    await page.evaluate(({ url, inventory }) => {
      const f = (window as any).fixture
      f.delayPreview(url, inventory === "recovered")
      ;(window as any).previewAttempt = f.openPreview("session", url).then(() => "opened", (error: Error) => error.name + ": " + error.message)
    }, { url: `${base}/page/mission-race`, inventory })
    await page.waitForFunction(() => (window as any).fixture.isPreviewDelayed())
    refreshed = true
    await page.evaluate(cold => (window as any).fixture.refreshMissions(cold), inventory !== "missing")
    assert.equal(await page.evaluate(() => (window as any).fixture.missionStatus()), inventory !== "missing" ? "unavailable" : "ready")
    assert.equal(await page.evaluate(() => (window as any).fixture.presentation("header-windows").mission.reader?.missionId),
      inventory === "missing" ? undefined : "mission-a", "confirmed absence clears immediately; unavailable inventory retains the reader")
    if (inventory === "recovered") {
      refreshed = false
      await page.evaluate(() => (window as any).fixture.refreshMissions(true))
      assert.equal(await page.evaluate(() => (window as any).fixture.missionStatus()), "ready")
    }
    await page.evaluate(() => (window as any).fixture.releasePreview())
    if (inventory === "recovered") {
      assert.match(await page.evaluate(() => (window as any).previewAttempt), /Error:/)
      assert.equal(await page.evaluate(() => (window as any).fixture.presentation("header-windows").mission.reader?.missionId), "mission-a",
        "a recovered inventory preserves the reader when the browser fails")
      await page.locator(".mission-reader").getByText("Retained reader", { exact: true }).waitFor()
      assert.deepEqual(errors, [])
      return
    }
    assert.equal(await page.evaluate(() => (window as any).previewAttempt), "opened")
    await page.locator('[data-session-id="session"] .window-shell').waitFor({ state: "visible" })
    assert.equal(await page.evaluate(() => (window as any).fixture.presentation("header-windows").mission.reader), undefined)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("real shell: creating a session preserves a newer held browser gesture and the created conversation", { timeout: 90_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  try {
    await prepare(page, "web")
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.delayNewSession()
      ;(window as any).creationAttempt = f.startNewSession()
    })
    await page.waitForFunction(() => (window as any).fixture.newSessionPending())
    await page.evaluate(url => {
      const f = (window as any).fixture
      f.delayPreview(url)
      ;(window as any).previewAttempt = f.openPreview("session", url).then(() => "opened", (error: Error) => error.name + ": " + error.message)
    }, `${base}/page/new-session-race`)
    await page.waitForFunction(() => (window as any).fixture.isPreviewDelayed())
    await page.evaluate(() => (window as any).fixture.releaseNewSession())
    assert.equal(await page.evaluate(async () => (await (window as any).creationAttempt)?.id), "created")
    assert.equal(await page.evaluate(() => (window as any).fixture.hasSession("created")), true)
    assert.equal(await page.evaluate(() => (window as any).fixture.selection("header-windows")), "session")
    await page.evaluate(() => (window as any).fixture.releasePreview())
    assert.equal(await page.evaluate(() => (window as any).previewAttempt), "opened")
    await page.locator('[data-session-id="session"] .window-shell').waitFor({ state: "visible" })
  } finally { await page.close() }
})

for (const host of ["web", "tauri", "electron"]) test(`${host}: browser gestures supersede pending surface activation before committing`, { timeout: 120_000 }, async () => {
  const native = host === "electron" ? await launchHistoryElectron() : undefined
  const page = native?.page ?? await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await prepare(page, host)
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), `${base}/page/a`)
    const pane = page.locator('[data-session-id="session"] .window-shell')
    await pane.waitFor({ state: "visible" })
    for (const gesture of ["go", "refresh", "back", "forward"]) {
      if (host !== "web") await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_register"))
      await page.evaluate(() => (window as any).fixture.captureSurfaceIntent())
      assert.equal(await page.evaluate(() => (window as any).fixture.surfaceIntentCurrent()), true)
      if (gesture === "go") {
        await pane.locator("input").fill(`${base}/page/b`)
        await pane.locator("input").press("Enter")
      } else await pane.getByRole("button", { name: ({ refresh: "Refresh", back: "Back", forward: "Forward" })[gesture], exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixture.surfaceIntentCurrent()), false, `${gesture} retires the captured activation`)
      await page.waitForFunction(target => (window as any).fixture.preview("session").targetUrl === target, `${base}/page/${gesture === "back" ? "a" : "b"}`)
    }
    assert.deepEqual(errors, [])
  } finally {
    if (native) { await native.app.close(); await rm(native.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    else await page.close()
  }
})

for (const host of ["web", "tauri", "electron"]) {
  test(`${host}: duplicate foreground choices share one retained document, history, template and token`, { timeout: 120_000 }, async () => {
    const native = host === "electron" ? await launchHistoryElectron() : undefined
    const page = native?.page ?? await browser.newPage({ userAgent: "Windows fixture", viewport: { width: 1400, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    const a = "header-windows", b = "header-duplicate"
    const rootA = page.locator(`[data-occurrence="${a}"]`), rootB = page.locator(`[data-occurrence="${b}"]`)
    const paneA = page.locator(`[data-preview-instance="${a}"] .window-shell`)
    const paneB = page.locator(`[data-preview-instance="${b}"] .window-shell`)
    const read = (id: string) => page.evaluate(id => (window as any).fixture.preview("session", id), id)
    const select = (id: string) => page.evaluate(id => (window as any).fixture.selectOccurrence(id), id)
    const navigate = async (url: string) => {
      await paneA.locator("input").fill(url)
      await paneA.locator("input").press("Enter")
      await page.waitForFunction(({ id, url }) => (window as any).fixture.preview("session", id)?.targetUrl === url, { id: a, url })
    }
    try {
      await prepare(page, host, "&duplicate=1")
      await page.evaluate(url => (window as any).fixture.openPreview("session", url), `${base}/page/a`)
      await paneA.waitFor({ state: "visible" })
      if (host !== "web") {
        await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_register"))
        if (host === "electron") await page.waitForFunction(url => {
          const guest = document.querySelector("webview") as any
          return guest?.getURL() === url && !guest.isLoading()
        }, `${base}/page/a`)
      }
      await select(b)
      assert.equal((await read(b)).mode, "chat")
      await rootB.locator(".message-stream-container").waitFor({ state: "visible" })
      await select(a)
      await navigate(`${base}/page/b`)
      await page.waitForFunction(url => {
        const history = (window as any).fixture.preview("session").history
        return history.index === 1 && history.urls[1] === url
      }, `${base}/page/b`)
      await paneA.getByRole("button", { name: "Viewport size", exact: true }).click()
      await paneA.getByRole("menuitemradio", { name: "Mobile viewport (390 x 844)", exact: true }).click()
      await page.waitForFunction(() => (window as any).fixture.savedPreview("session")?.viewport === "mobile")
      assert.equal((await read(b)).viewport, "mobile")
      await rootA.getByRole("button", { name: "Back to chat", exact: true }).click()
      await rootA.getByRole("button", { name: "Open web preview", exact: true }).click()
      await paneA.getByRole("button", { name: "Close", exact: true }).click()
      assert.equal((await read(b)).mode, "chat")
      await rootA.getByRole("button", { name: "Open web preview", exact: true }).click()
      await paneA.getByRole("button", { name: "Back", exact: true }).click()
      await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url, `${base}/page/a`)
      await paneA.getByRole("button", { name: "Forward", exact: true }).click()
      await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url, `${base}/page/b`)
      const token = (await read(a)).token
      const created = await page.evaluate(() => (window as any).fixture.createdPreviews())
      const requests = pageRequests.length
      const guest = host === "electron" ? await page.evaluate(async () => {
        const guest = document.querySelector("webview") as any
        await guest.executeJavaScript('document.querySelector("#draft").value = "retained document"; window.retained = 123')
        return guest.getWebContentsId()
      }) : undefined
      const frame = host === "web" ? await page.locator("iframe").elementHandle() : undefined
      await select(b)
      await rootB.locator(".message-stream-container").waitFor({ state: "visible" })
      await rootB.getByRole("button", { name: "Open web preview", exact: true }).click()
      await paneB.waitFor({ state: "visible" })
      assert.equal((await read(b)).token, token)
      assert.equal((await read(a)).targetUrl, `${base}/page/b`)
      assert.equal(await page.evaluate(() => (window as any).fixture.createdPreviews()), created)
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.previewModes("header-duplicate")), { session: { mode: "preview" } })
      if (host === "electron") {
        assert.equal(await page.locator("webview").count(), 1)
        assert.deepEqual(await page.evaluate(async () => {
          const guest = document.querySelector("webview") as any
          return [guest.getWebContentsId(), await guest.executeJavaScript('[window.retained, document.querySelector("#draft").value]')]
        }), [guest, [123, "retained document"]])
        assert.equal(pageRequests.length, requests, "switching duplicate tabs never reloads the document")
      }
      if (frame) assert.equal(await frame.evaluate(element => element === document.querySelector("iframe")), true)
      if (host === "tauri") assert.equal(await page.evaluate(() => (window as any).fixture.native.calls.filter((c: any) => c.command === "browser_target_register").length), 1)
      await paneB.getByRole("button", { name: "Close", exact: true }).click()
      assert.equal((await read(a)).mode, "preview")
      assert.equal((await read(b)).mode, "chat")
      await select(a)
      await paneA.waitFor({ state: "visible" })
      await select(b)
      await rootB.getByRole("button", { name: "Open web preview", exact: true }).click()
      await paneB.waitFor({ state: "visible" })
      // Restore with B in chat and A in preview, without automatically visiting saved pages.
      await paneB.getByRole("button", { name: "Close", exact: true }).click()
      await page.reload()
      await page.waitForFunction(() => (window as any).browserHistoryReady)
      assert.equal(await page.locator(".window-shell").count(), 0)
      await rootA.locator(".message-stream-container").waitFor({ state: "visible" })
      const saved = await page.evaluate(() => [
        (window as any).fixture.savedPreview("session", "header-windows"),
        (window as any).fixture.savedPreview("session", "header-duplicate"),
      ])
      assert.equal(saved[0].mode, "preview")
      assert.equal(saved[1].mode, "chat")
      assert.equal(saved[0].targetUrl, `${base}/page/b`)
      assert.equal(saved[1].targetUrl, `${base}/page/b`)
      assert.equal(saved[0].viewport, "mobile")
      assert.equal(saved[1].viewport, "mobile")
      await rootA.getByRole("button", { name: "Open web preview", exact: true }).click()
      if (host !== "web") await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_register"))
      await paneA.getByRole("button", { name: "Viewport size", exact: true }).click()
      assert.equal(await paneA.getByRole("menuitemradio", { name: "Mobile viewport (390 x 844)", exact: true }).getAttribute("aria-checked"), "true")
      await paneA.getByRole("button", { name: "Viewport size", exact: true }).click()
      await select(b)
      await rootB.locator(".message-stream-container").waitFor({ state: "visible" })
      await rootB.getByRole("button", { name: "Open web preview", exact: true }).click()
      await paneB.waitFor({ state: "visible" })
      if (host !== "web") await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_register"))
      const tokenA = (await read(a)).token, tokenB = (await read(b)).token
      await page.evaluate(id => (window as any).fixture.closeOccurrence(id), a)
      await rootA.locator(".session-shell-frame").waitFor({ state: "detached" })
      assert.equal(await read(a), null)
      assert.equal((await read(b)).targetUrl, `${base}/page/b`)
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.deletedPreviews), [])
      assert.equal(tokenA, tokenB)
      if (host === "tauri") {
        await page.waitForFunction(() => (window as any).fixture.native.listenerCount() === 1)
        const calls = await page.evaluate(() => (window as any).fixture.native.calls)
        const registrationA = calls.find((call: any) => call.command === "browser_target_register" && call.payload.url.endsWith("/page/b")).payload.registrationId
        assert.equal(calls.filter((call: any) => call.command === "browser_target_register").length, 1)
        assert.ok(!calls.some((call: any) => call.command === "browser_target_unregister" && call.registrationId === registrationA))
      }
      await paneB.getByRole("button", { name: "Close", exact: true }).click()
      await rootB.getByRole("button", { name: "Open web preview", exact: true }).click()
      await paneB.waitFor({ state: "visible" })
      assert.deepEqual(errors, [])
    } finally {
      if (native) { await native.app.close(); await rm(native.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
      else await page.close()
    }
  })
}

for (const host of ["web", "tauri", "electron"]) {
  test(`${host}: mission readers, selection and files arbitrate only their own occurrence`, { timeout: 120_000 }, async () => {
    const native = host === "electron" ? await launchHistoryElectron() : undefined
    const page = native?.page ?? await browser.newPage({ userAgent: "Windows fixture", viewport: { width: 1400, height: 900 } })
    const errors: string[] = [], writes: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    const a = "header-windows", b = "header-duplicate"
    const rootA = page.locator(`[data-occurrence="${a}"]`), rootB = page.locator(`[data-occurrence="${b}"]`)
    const select = (id: string) => page.evaluate(id => (window as any).fixture.selectOccurrence(id), id)
    const state = (id: string) => page.evaluate(id => (window as any).fixture.presentation(id), id)
    const maps: MissionMap[] = ["a", "b"].map(id => ({
      version: 1, id: `mission-${id}`, projectID: "fixture", projectCanonical: "/repo", objective: `Objective ${id}`, title: `Mission ${id}`,
      template: "custom", coordinatorSessionId: "session", status: "active", runState: "running",
      actors: [], tasks: [], frontier: [], claims: [], history: [], historyTruncated: false, revision: 1, createdAt: 1, updatedAt: 1,
      reports: [{ id: `report-${id}`, taskKey: "", sessionId: "session", outcome: "completed", summary: `Independent report ${id}`,
        evidence: [], next: [], createdAt: 1 }],
    }))
    try {
      await prepare(page, host, "&duplicate=1&missions=1")
      const routeMissions = missionPanelRoute(async route => {
        const request = route.request(), path = new URL(request.url()).pathname
        if (path.endsWith("/content")) return route.fulfill({ json: missionContentFixture(request.url(), request.method(), maps) })
        if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "fixture", missions: panelMissions(maps), generatedAt: 1, discardedEvents: 0 } })
        if (request.method() !== "GET") writes.push(path)
        return route.fulfill({ json: {} })
      })
      await page.route("**/api/workspaces/*/missions**", routeMissions)
      await page.evaluate(id => (window as any).fixture.readMission(id, "report", "report-a"), a)
      await rootA.locator(".mission-reader").getByText("Independent report a", { exact: true }).waitFor()
      await rootA.locator(".mission-reader details > summary").click()
      await select(b)
      await rootB.locator(".message-stream-container").waitFor({ state: "visible" })
      assert.equal((await state(b)).mission.reader, undefined)
      await page.evaluate(id => (window as any).fixture.readFile(id, "B.md"), b)
      await rootB.locator(".workspace-file-view").getByText("Independent file content.", { exact: true }).waitFor()
      await select(a)
      // The real Missions panel follows row selection in this reader only.
      await rootA.locator('[data-mission-key="mission:mission-b"] .mission-row-select').click()
      await rootA.locator(".mission-reader").getByText("Objective b", { exact: true }).waitFor()
      assert.equal((await state(b)).file.path, "B.md")
      assert.equal((await state(b)).mission.reader, undefined)
      await rootA.locator(".mission-reader").getByRole("button", { name: "Back to chat", exact: true }).click()
      await select(b)
      await rootB.locator(".workspace-file-view").getByText("Independent file content.", { exact: true }).waitFor()
      await select(a)
      await page.evaluate(id => (window as any).fixture.readFile(id, "A.md"), a)
      await rootA.locator(".workspace-file-view").getByRole("heading", { name: "A.md", exact: true }).waitFor()
      await select(b)
      await page.evaluate(({ id, url }) => (window as any).fixture.openPreview("session", url, id), { id: b, url: `${base}/page/b` })
      await page.locator('[data-preview-instance="header-duplicate"] .window-shell').waitFor({ state: "visible" })
      assert.equal((await state(a)).file.path, "A.md")
      assert.equal((await state(a)).mission.reader, undefined)
      await select(a)
      await rootA.locator(".workspace-file-view").getByRole("heading", { name: "A.md", exact: true }).waitFor()
      // Restore A's report and its disclosure while B keeps its web target.
      await page.evaluate(id => (window as any).fixture.readMission(id, "report", "report-a"), a)
      await rootA.locator(".mission-reader").getByText("Independent report a", { exact: true }).waitFor()
      assert.equal(await rootA.locator(".mission-reader details").evaluate((node: HTMLDetailsElement) => node.open), true)
      await page.reload()
      await page.waitForFunction(() => (window as any).browserHistoryReady)
      await rootA.locator(".mission-reader").getByText("Independent report a", { exact: true }).waitFor()
      assert.equal(await rootA.locator(".mission-reader details").evaluate((node: HTMLDetailsElement) => node.open), true)
      assert.equal((await state(b)).mission.reader, undefined)
      await page.evaluate(id => (window as any).fixture.closeOccurrence(id), a)
      assert.equal((await state(b)).mission.reader, undefined)
      assert.equal(await page.evaluate(id => (window as any).fixture.savedPreview("session", id).mode, b), "preview")
      assert.deepEqual(writes, [])
      assert.deepEqual(errors, [])
    } finally {
      if (native) { await native.app.close(); await rm(native.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
      else await page.close()
    }
  })
}

for (const host of ["web", "tauri", "electron"]) {
  test(`${host}: duplicate image readers and shared execution preserve the other occurrence's content`, { timeout: 120_000 }, async () => {
    const native = host === "electron" ? await launchHistoryElectron() : undefined
    const page = native?.page ?? await browser.newPage({ viewport: { width: 1600, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    const a = "header-windows", b = "header-duplicate"
    const rootA = page.locator(`[data-occurrence="${a}"]`), rootB = page.locator(`[data-occurrence="${b}"]`)
    const select = (id: string) => page.evaluate(id => (window as any).fixture.selectOccurrence(id), id)
    const state = (id: string) => page.evaluate(id => (window as any).fixture.presentation(id), id)
    try {
      await prepare(page, host, "&duplicate=1")
      await page.evaluate(id => (window as any).fixture.readFile(id, "A.png"), a)
      const image = rootA.getByRole("img", { name: "A.png", exact: true })
      await image.waitFor()
      await page.waitForFunction(() => (document.querySelector(".workspace-image img") as HTMLImageElement)?.naturalWidth === 1)
      await select(b)
      await rootB.getByText("Fixture message", { exact: true }).waitFor()
      await page.evaluate(id => (window as any).fixture.readFile(id, "B.md"), b)
      await rootB.getByRole("heading", { name: "B.md", exact: true }).waitFor()
      await select(a)
      await image.waitFor()
      assert.equal((await state(b)).file.path, "B.md")
      await select(b)
      await rootB.getByRole("button", { name: "Back to conversation", exact: true }).click()
      await rootB.getByText("Fixture message", { exact: true }).waitFor()
      await select(a)
      await rootA.getByRole("button", { name: "Back to conversation", exact: true }).click()
      await page.evaluate(({ id, url }) => (window as any).fixture.openPreview("session", url, id), { id: a, url: `${base}/page/a` })
      const pane = page.locator('[data-preview-instance="header-windows"] .window-shell')
      await pane.waitFor()
      const before = await page.evaluate(id => (window as any).fixture.preview("session", id), a)
      await pane.locator("input").focus()
      for (const [event, status] of [["started", "working"], ["succeeded", "idle"]] as const) {
        await page.evaluate(event => (window as any).fixture.execution(event), event)
        await page.waitForFunction(({ a, b, status }) => [a, b].every(id => (window as any).fixture.status(id) === status), { a, b, status })
        assert.equal(await pane.locator("input").evaluate(element => document.activeElement === element), true)
        assert.deepEqual(await page.evaluate(id => (window as any).fixture.preview("session", id), a), before)
        await select(b)
        await rootB.getByText("Fixture message", { exact: true }).waitFor()
        assert.equal(await rootB.getByRole("button", { name: "Stop session", exact: true }).isEnabled(), status === "working")
        await select(a)
        await pane.waitFor()
        await pane.locator("input").focus()
      }
      assert.deepEqual(errors, [])
    } finally {
      if (native) { await native.app.close(); await rm(native.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
      else await page.close()
    }
  })
}

test("browsed worktrees and Files commit filters remain independent between duplicates", async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const a = "header-windows", b = "header-duplicate"
  const rootA = page.locator(`[data-occurrence="${a}"]`), rootB = page.locator(`[data-occurrence="${b}"]`)
  const select = (id: string) => page.evaluate(id => (window as any).fixture.selectOccurrence(id), id)
  try {
    await prepare(page, "web", "&duplicate=1&worktrees=1")
    await page.route("**/git-history*", route => route.fulfill({ json: { commits: [
      { id: "a".repeat(40), subject: "Alpha change", author: "Fixture", date: "2026-01-01" },
      { id: "b".repeat(40), subject: "Beta change", author: "Fixture", date: "2026-01-02" },
    ], hasMore: false } }))
    await rootA.getByRole("tab", { name: "Files", exact: true }).click()
    await rootA.locator(".git-panel-worktree").selectOption("other")
    await rootA.getByRole("button", { name: "Commits", exact: true }).click()
    await rootA.locator(".git-panel-filter").fill("Alpha")
    await rootA.getByRole("button", { name: /Alpha change/ }).waitFor()
    assert.equal(await rootA.getByRole("button", { name: /Beta change/ }).count(), 0)
    await select(b)
    await rootB.getByRole("tab", { name: "Files", exact: true }).click()
    assert.equal(await rootB.locator(".git-panel-worktree").inputValue(), "root")
    await rootB.getByRole("button", { name: "Commits", exact: true }).click()
    await rootB.locator(".git-panel-filter").fill("Beta")
    await rootB.getByRole("button", { name: /Beta change/ }).waitFor()
    assert.equal(await rootB.getByRole("button", { name: /Alpha change/ }).count(), 0)
    await select(a)
    assert.equal(await rootA.locator(".git-panel-worktree").inputValue(), "other")
    assert.equal(await rootA.locator(".git-panel-filter").inputValue(), "Alpha")
    await rootA.getByRole("button", { name: /Alpha change/ }).waitFor()
    await select(b)
    assert.equal(await rootB.locator(".git-panel-worktree").inputValue(), "root")
    assert.equal(await rootB.locator(".git-panel-filter").inputValue(), "Beta")
    await rootB.getByRole("button", { name: /Beta change/ }).waitFor()
  } finally { await page.close() }
})

test("panel selections restore per occurrence and source readers retain lightweight view state", { timeout: 90_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const a = "header-windows", b = "header-duplicate"
  const rootA = page.locator(`[data-occurrence="${a}"]`), rootB = page.locator(`[data-occurrence="${b}"]`)
  const select = (id: string) => page.evaluate(id => (window as any).fixture.selectOccurrence(id), id)
  try {
    await prepare(page, "web", "&duplicate=1")
    await rootA.getByRole("tab", { name: "Files", exact: true }).click()
    await rootA.getByRole("button", { name: "Commits", exact: true }).click()
    await rootA.getByRole("tab", { name: "Status", exact: true }).click()
    await select(b)
    await rootB.getByRole("tab", { name: "Files", exact: true }).click()
    await rootB.getByRole("button", { name: "Changes", exact: true }).click()
    await select(a)
    assert.equal(await rootA.getByRole("tab", { name: "Status", exact: true }).getAttribute("aria-selected"), "true")
    await rootA.getByRole("tab", { name: "Files", exact: true }).click()
    assert.equal(await rootA.getByRole("button", { name: "Commits", exact: true }).getAttribute("aria-pressed"), "true")
    await rootA.getByRole("tab", { name: "Status", exact: true }).click()
    await page.reload()
    await page.waitForFunction(() => (window as any).browserHistoryReady)
    assert.equal(await rootA.getByRole("tab", { name: "Status", exact: true }).getAttribute("aria-selected"), "true")
    await page.waitForFunction(() => performance.getEntriesByType("paint").length > 0)
    await rootA.getByRole("tab", { name: "Files", exact: true }).click()
    assert.equal(await rootA.getByRole("button", { name: "Commits", exact: true }).getAttribute("aria-pressed"), "true")
    await select(b)
    assert.equal(await rootB.getByRole("tab", { name: "Files", exact: true }).getAttribute("aria-selected"), "true")
    assert.equal(await rootB.getByRole("button", { name: "Changes", exact: true }).getAttribute("aria-pressed"), "true")
    await select(a)
    await page.evaluate(id => (window as any).fixture.readFile(id, "Long.md"), a)
    const reader = rootA.locator(".workspace-file-view")
    await reader.getByText("Independent file content.", { exact: true }).waitFor()
    const rendered = reader.locator(".workspace-markdown")
    // Capture the real scroll event before unmounting; a DOM write alone can
    // still be waiting for its next rendering opportunity when the tab switches.
    await rendered.evaluate(element => new Promise<void>(resolve => {
      element.addEventListener("scroll", () => resolve(), { once: true })
      element.scrollTop = 1000
    }))
    const renderedPosition = await rendered.evaluate(element => element.scrollTop)
    assert.ok(renderedPosition > 900)
    await select(b)
    await rootB.locator(".message-stream-container").waitFor({ state: "visible" })
    await select(a)
    await rendered.waitFor()
    await page.waitForFunction(expected => (document.querySelector(".workspace-markdown")?.scrollTop ?? 0) >= expected - 2, renderedPosition)
    await reader.getByRole("button", { name: "Show source", exact: true }).click()
    await reader.locator(".view-line").filter({ hasText: "Independent file content." }).waitFor()
    await page.evaluate(() => {
      const editor = (window as any).monaco.editor.getEditors().at(-1)
      editor.revealLineInCenter(81)
      editor.setSelection({ startLineNumber: 81, startColumn: 1, endLineNumber: 81, endColumn: 10 })
    })
    await select(b)
    await rootB.locator(".message-stream-container").waitFor({ state: "visible" })
    await rootA.locator(".message-stream-container").waitFor({ state: "detached" })
    await select(a)
    await reader.getByRole("button", { name: "Preview Markdown", exact: true }).waitFor()
    await reader.locator(".monaco-editor .view-line").first().waitFor()
    assert.equal(await page.evaluate(() => (window as any).monaco.editor.getEditors().at(-1).getSelection().toString()), "[81,1 -> 81,10]")
    assert.ok(await page.evaluate(() => (window as any).monaco.editor.getEditors().at(-1).getScrollTop()) > 500)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const navigation of [false, true]) for (const fail of [false, true]) {
  test(`closing an occurrence during preview ${navigation ? "navigation" : "open"} ${fail ? "failure" : "completion"} leaves the survivor's focus and view untouched`, async () => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    const a = "header-windows", b = "header-duplicate"
    const rootB = page.locator(`[data-occurrence="${b}"]`)
    try {
      await prepare(page, "web", "&duplicate=1")
      const rootA = page.locator(`[data-occurrence="${a}"]`)
      if (navigation) await page.evaluate(url => (window as any).fixture.openPreview("session", url), `${base}/page/a`)
      const url = navigation ? `${base}/page/late` : "http://localhost:3000"
      await page.evaluate(({ url, fail }) => (window as any).fixture.delayPreview(url, fail), { url, fail })
      if (navigation) {
        const address = page.locator('[data-preview-instance="header-windows"] .window-shell input')
        await address.fill(url)
        await address.press("Enter")
      } else await rootA.getByRole("button", { name: "Open web preview", exact: true }).click()
      await page.waitForFunction(() => (window as any).fixture.isPreviewDelayed())
      await page.evaluate(id => (window as any).fixture.selectOccurrence(id), b)
      const composer = rootB.locator("textarea.prompt-input")
      await composer.fill("Keep B focused")
      await composer.focus()
      await page.evaluate(id => { (window as any).fixture.closeOccurrence(id); (window as any).fixture.releasePreview() }, a)
      await page.waitForFunction(() => !(window as any).fixture.isPreviewDelayed())
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      assert.equal(await composer.evaluate(element => document.activeElement === element), true)
      assert.equal(await composer.inputValue(), "Keep B focused")
      assert.equal(await rootB.locator(".message-stream-container").isVisible(), true)
      assert.equal(await page.getByRole("alertdialog").count(), 0)
      if (navigation) assert.equal(await page.evaluate(id => (window as any).fixture.preview("session", id).targetUrl, b), `${base}/page/a`)
      else assert.equal(await page.evaluate(id => (window as any).fixture.preview("session", id), b), null)
      assert.equal(await page.evaluate(() => (window as any).fixture.previewCount()), navigation ? 1 : 0)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

async function launchHistoryElectron(existingProfile?: string) {
  const temp = process.env.CODENOMAD_TEST_TEMP || (process.platform === "win32" ? join(process.env.LOCALAPPDATA!, "Temp", "opencode") : tmpdir())
  await mkdir(temp, { recursive: true })
  const profile = existingProfile ?? await mkdtemp(join(temp, "session-browser-history-"))
  const controllerPath = join(profile, "browser-controller.cjs")
  await build({ entryPoints: [fileURLToPath(new URL("../../../electron-app/electron/main/browser-controller.ts", import.meta.url))],
    outfile: controllerPath, bundle: true, platform: "node", format: "cjs", external: ["electron"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(controllerPath).href) } })
  const env = { ...process.env, CODENOMAD_TEST_PROFILE: profile, CODENOMAD_TEST_HISTORY_CONTROLLER: controllerPath }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ASAR
  const app = await _electron.launch({ executablePath: process.env.CODENOMAD_TEST_ELECTRON || electronPath,
    args: ["--no-sandbox", fileURLToPath(new URL("fixtures/browser-frame-native-electron.cjs", import.meta.url))], env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  return { app, page, profile }
}

test("session tabs share native cookies and site storage, but keep documents and histories separate", { timeout: 90_000 }, async () => {
  let { app, page, profile } = await launchHistoryElectron()
  try {
    await prepare(page, "electron")
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), `${base}/shared-site/login`)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_register"))
    const first = page.locator('[data-session-id="session"] webview')
    const firstId = await first.evaluate((guest: any) => guest.getWebContentsId())
    await first.evaluate((guest: any) => guest.executeJavaScript('localStorage.setItem("shared_marker", "kept"); sessionStorage.setItem("tab_marker", "first"); window.tab_only = "first"'))
    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    await page.evaluate(url => (window as any).fixture.openPreview("second", url), `${base}/shared-site/status`)
    await page.waitForFunction(() => (window as any).fixture.native.calls.filter((call: any) => call.command === "browser_target_register").length >= 2)
    const second = page.locator('[data-session-id="second"] webview')
    const secondId = await second.evaluate((guest: any) => guest.getWebContentsId())
    assert.notEqual(firstId, secondId)
    assert.equal(await second.evaluate((guest: any) => guest.executeJavaScript('document.querySelector("#signed-in").textContent')), "true", "the HttpOnly login is sent by the other tab")
    assert.equal(await second.evaluate((guest: any) => guest.executeJavaScript('localStorage.getItem("shared_marker")')), "kept")
    assert.equal(await second.evaluate((guest: any) => guest.executeJavaScript('sessionStorage.getItem("tab_marker")')), null)
    assert.equal(await second.evaluate((guest: any) => guest.executeJavaScript('typeof window.tab_only')), "undefined", "sharing a profile is not sharing a document")
    assert.equal(await second.evaluate((guest: any) => guest.executeJavaScript('document.cookie.includes("shared_login")')), false, "HttpOnly remains hidden from page scripts")
    const native = await app.evaluate(({ webContents, BrowserWindow }, { firstId, secondId }) => {
      const a = webContents.fromId(firstId)!, b = webContents.fromId(secondId)!
      return { shared: a.session === b.session, appIsolated: a.session !== BrowserWindow.getAllWindows()[0].webContents.session,
        first: a.navigationHistory.getAllEntries().map(entry => entry.url), second: b.navigationHistory.getAllEntries().map(entry => entry.url) }
    }, { firstId, secondId })
    assert.equal(native.shared, true)
    assert.equal(native.appIsolated, true)
    assert.ok(native.first.every(url => !url.includes("/status")))
    assert.ok(native.second.every(url => !url.includes("/login")))
    await page.evaluate(() => (window as any).fixture.selectSession("session"))
    await first.evaluate((guest: any) => guest.loadURL(`${location.origin}/shared-site/logout`))
    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    await second.evaluate((guest: any) => guest.loadURL(`${location.origin}/shared-site/status`))
    assert.equal(await second.evaluate((guest: any) => guest.executeJavaScript('document.querySelector("#signed-in").textContent')), "false", "logging out is shared like ordinary browser tabs")
    await page.evaluate(() => (window as any).fixture.selectSession("session"))
    await first.evaluate((guest: any) => guest.loadURL(`${location.origin}/shared-site/login`))
    await first.evaluate((guest: any) => guest.loadURL(`${location.origin}/shared-site/status`))
    await page.waitForFunction(url => {
      const preview = (window as any).fixture.preview("session")
      return preview.history.urls[preview.history.index] === url
    }, `${base}/shared-site/status`)
    await app.close()
    ;({ app, page } = await launchHistoryElectron(profile))
    await prepare(page, "electron")
    assert.equal(await page.locator("webview").count(), 0)
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_register"))
    const restored = page.locator('[data-session-id="session"] webview')
    assert.equal(await restored.evaluate((guest: any) => guest.executeJavaScript('document.querySelector("#signed-in").textContent')), "true", "persistent sign-in survives a full native process restart")
    assert.equal(await restored.evaluate((guest: any) => guest.executeJavaScript('localStorage.getItem("shared_marker")')), "kept")
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test("real shell retains separate Electron histories across chat, sessions, project visibility and Info", { timeout: 90_000 }, async () => {
  const { app, page, profile } = await launchHistoryElectron()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await prepare(page, "electron")
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), `${base}/page/a`)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_register"))
    const first = page.locator('[data-session-id="session"] webview')
    const guestId = await first.evaluate((guest: any) => guest.getWebContentsId())
    // Native input keeps Chromium from treating the initial entry as a
    // script-only navigation that the Back button is allowed to skip.
    await app.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id)!
      guest.sendInputEvent({ type: "mouseDown", x: 30, y: 16, button: "left", clickCount: 1 })
      guest.sendInputEvent({ type: "mouseUp", x: 30, y: 16, button: "left", clickCount: 1 })
    }, guestId)
    await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url, `${base}/page/b`)
    await first.evaluate((guest: any) => guest.executeJavaScript('document.querySelector("#draft").value = "Keep this form"'))
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    await page.locator("webview:visible").waitFor({ state: "hidden" })
    assert.equal(await page.locator("webview").count(), 1)
    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    assert.equal(await page.locator('.session-cache-pane[data-session-id="session"] .message-stream-container').count(), 0)
    assert.equal(await page.locator('.session-cache-pane[data-session-id="session"] textarea').count(), 0)
    await page.evaluate(() => (window as any).fixture.selectSession("session"))
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await first.waitFor({ state: "visible" })
    assert.equal(await first.evaluate((guest: any) => guest.getWebContentsId()), guestId)
    assert.equal(await first.evaluate((guest: any) => guest.executeJavaScript('document.querySelector("#draft").value')), "Keep this form")

    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    assert.equal(await preview(page, "second"), null)
    await page.evaluate(url => (window as any).fixture.openPreview("second", url), `${base}/page/c`)
    await page.locator('[data-session-id="second"] webview').waitFor({ state: "visible" })
    assert.equal((await preview(page, "session")).targetUrl, `${base}/page/b`)
    assert.equal(await page.locator("webview").count(), 2)
    assert.equal(await page.locator("textarea.prompt-input").count(), 1, "inactive browser shells do not retain composers")
    for (const transition of ["info", "project"]) {
      await page.evaluate(kind => kind === "info" ? (window as any).fixture.showInfo() : (window as any).fixture.setActive(false), transition)
      await page.locator("webview:visible").waitFor({ state: "hidden" })
      assert.equal(await page.locator("webview").count(), 2)
      await page.evaluate(() => { (window as any).fixture.setActive(true); (window as any).fixture.selectSession("session") })
      await first.waitFor({ state: "visible" })
      assert.equal(await first.evaluate((guest: any) => guest.getWebContentsId()), guestId)
    }
    const firstPane = page.locator('[data-session-id="session"] .window-shell')
    await firstPane.getByRole("button", { name: "Close", exact: true }).click()
    await first.waitFor({ state: "hidden" })
    assert.equal((await preview(page, "session")).mode, "chat")
    assert.equal(await page.locator("webview").count(), 2)
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await first.waitFor({ state: "visible" })
    assert.equal(await first.evaluate((guest: any) => guest.getWebContentsId()), guestId)
    assert.equal(await first.evaluate((guest: any) => guest.executeJavaScript('document.querySelector("#draft").value')), "Keep this form")
    await firstPane.getByRole("button", { name: "Back", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url, `${base}/page/a`)
    assert.equal((await preview(page, "second")).targetUrl, `${base}/page/c`)
    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    assert.equal((await preview(page, "second")).targetUrl, `${base}/page/c`)

    await page.evaluate(() => (window as any).fixture.selectSession("session"))
    await firstPane.getByRole("button", { name: "Forward", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session").history.urls[(window as any).fixture.preview("session").history.index] === url, `${base}/page/b`)
    await firstPane.getByRole("button", { name: "Close", exact: true }).click()
    const beforeRestart = pageRequests.length
    await page.reload()
    await page.waitForFunction(() => (window as any).browserHistoryReady)
    assert.equal(await page.locator("webview").count(), 0, "restart does not eagerly recreate saved browsers")
    assert.deepEqual(pageRequests.slice(beforeRestart), [], "no saved URL is replayed before opening its session browser")
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_register"))
    assert.deepEqual(pageRequests.slice(beforeRestart), ["/b"], "only the current page loads; neither the older page nor another session is visited")
    assert.notEqual(await first.evaluate((guest: any) => guest.getWebContentsId()), guestId)
    assert.equal(await first.evaluate((guest: any) => guest.executeJavaScript('document.querySelector("#draft").value')), "", "form state is not persisted")
    assert.deepEqual((await preview(page, "session")).history, { urls: [`${base}/page/a`, `${base}/page/b`], index: 1 })
    await firstPane.getByRole("button", { name: "Back", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session").history.index === 0 && (window as any).fixture.preview("session").targetUrl === url, `${base}/page/a`)
    await firstPane.getByRole("button", { name: "Forward", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session").history.index === 1 && (window as any).fixture.preview("session").targetUrl === url, `${base}/page/b`)
    assert.deepEqual(errors, [])
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test("hidden Electron navigation persists before reveal and restores only its committed page", { timeout: 90_000 }, async () => {
  const { app, page, profile } = await launchHistoryElectron()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const a = `${base}/page/a`, b = `${base}/page/b`
  try {
    await prepare(page, "electron")
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), a)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_register"))
    const guest = page.locator('[data-session-id="session"] webview')
    const guestId = await guest.evaluate((element: any) => element.getWebContentsId())
    await page.locator('[data-session-id="session"] .window-shell').getByRole("button", { name: "Close", exact: true }).click()
    await guest.waitFor({ state: "hidden" })
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_unregister"))
    // Use the actual retained guest and native controller, not the bridge's
    // synthetic navigation event. It is no longer registered for automation.
    await app.evaluate(async ({ webContents }, { guestId, b }) => { await webContents.fromId(guestId)!.loadURL(b) }, { guestId, b })
    await page.waitForFunction(url => {
      const preview = (window as any).fixture.preview("session")
      return preview.mode === "chat" && preview.targetUrl === url && preview.history.index === 1
    }, b)
    const saved = await page.evaluate(() => (window as any).fixture.savedPreview("session"))
    assert.deepEqual(saved, { targetUrl: b, mode: "chat", history: { urls: [a, b], index: 1 } })
    const beforeRestart = pageRequests.length
    await page.reload() // Restart before the hidden guest has ever been revealed.
    await page.waitForFunction(() => (window as any).browserHistoryReady)
    assert.equal(await page.locator("webview").count(), 0)
    assert.deepEqual(pageRequests.slice(beforeRestart), [])
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_register"))
    await page.waitForFunction(url => {
      const guest = document.querySelector("webview") as any
      return guest?.getURL() === url && !guest.isLoading()
    }, b)
    assert.deepEqual((await preview(page, "session")).history, { urls: [a, b], index: 1 })
    assert.deepEqual(pageRequests.slice(beforeRestart), ["/b"], "restoration loads B, never replays A")
    assert.notEqual(await guest.evaluate((element: any) => element.getWebContentsId()), guestId)
    assert.deepEqual(errors, [])
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

for (const action of ["Go", "Refresh"]) {
  test(`iframe ${action} supersedes a delayed Back response without rewriting the committed journal`, { timeout: 60_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    const a = `${base}/page/a`, b = `${base}/page/b`, d = `${base}/page/d`
    try {
      await prepare(page, "web")
      await page.evaluate(url => (window as any).fixture.openPreview("session", url), a)
      const pane = page.locator('[data-session-id="session"] .window-shell')
      await pane.locator("input").fill(b)
      await pane.locator("input").press("Enter")
      await page.waitForFunction(url => (window as any).fixture.preview("session").history.urls[1] === url, b)
      await page.evaluate(url => (window as any).fixture.delayPreview(url), a)
      await pane.getByRole("button", { name: "Back", exact: true }).click()
      await page.waitForFunction(() => (window as any).fixture.isPreviewDelayed())
      assert.deepEqual((await preview(page, "session")).history, { urls: [a, b], index: 1 })
      if (action === "Go") {
        await pane.locator("input").fill(d)
        await pane.locator("input").press("Enter")
        await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url, d)
      } else {
        await pane.getByRole("button", { name: "Refresh", exact: true }).click()
      }
      await page.evaluate(() => (window as any).fixture.releasePreview())
      await page.waitForFunction(() => !(window as any).fixture.isPreviewDelayed())
      // Let the released async navigation and Refresh's source-reset frame
      // finish before asserting that neither callback can revive the old Back.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const expectedUrl = action === "Go" ? d : b
      const expectedHistory = action === "Go" ? { urls: [a, b, d], index: 2 } : { urls: [a, b], index: 1 }
      const current = await preview(page, "session")
      assert.equal(current.targetUrl, expectedUrl)
      assert.deepEqual(current.history, expectedHistory)
      assert.equal(await pane.locator("iframe").getAttribute("src"), expectedUrl)
      assert.equal(await pane.getByRole("button", { name: "Back", exact: true }).isDisabled(), false)
      assert.equal(await pane.getByRole("button", { name: "Forward", exact: true }).isDisabled(), true)
      const saved = await page.evaluate(() => (window as any).fixture.savedPreview("session"))
      assert.equal(saved.targetUrl, expectedUrl)
      assert.deepEqual(saved.history, expectedHistory)
      assert.deepEqual(errors, [])
    } finally {
      await page.evaluate(() => (window as any).fixture.releasePreview()).catch(() => undefined)
      await page.close()
    }
  })
}

for (const navigation of ["address", "prop"]) {
  test(`real Electron ${navigation} navigation supersedes pending Back without overwriting history`, { timeout: 90_000 }, async () => {
    const { app, page, profile } = await launchHistoryElectron()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    let releaseHistory: (() => void) | undefined
    let gateTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await prepare(page, "electron")
      const a = `${base}/interrupted-history/a`, b = `${base}/interrupted-history/b`, d = `${base}/interrupted-history/d`
      await page.evaluate(url => (window as any).fixture.openPreview("session", url), a)
      await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_register"))
      await page.waitForFunction(url => {
        const guest = document.querySelector("webview") as any
        return guest?.getURL() === url && !guest.isLoading()
      }, a)
      const pane = page.locator('[data-session-id="session"] .window-shell')
      await pane.locator("input").fill(b)
      await pane.locator("input").press("Enter")
      await page.waitForFunction(url => (window as any).fixture.preview("session").history.urls[1] === url, b)
      const backRequested = new Promise<void>((resolve, reject) => {
        gateTimeout = setTimeout(() => reject(new Error("Back did not request the gated document")), 20_000)
        holdHistoryRequest = release => {
          clearTimeout(gateTimeout)
          releaseHistory = release
          resolve()
        }
      })
      await pane.getByRole("button", { name: "Back", exact: true }).click()
      await backRequested
      assert.deepEqual((await preview(page, "session")).history, { urls: [a, b], index: 1 }, `${navigation}: A has not committed while its response is held`)
      if (navigation === "address") {
        await pane.locator("input").fill(d)
        await pane.locator("input").press("Enter")
      } else {
        // The production automation-open path updates these same preview props.
        await page.evaluate(url => (window as any).fixture.openPreview("session", url), d)
      }
      await page.waitForFunction(url => {
        const preview = (window as any).fixture.preview("session")
        return preview.targetUrl === url && preview.history.urls[preview.history.index] === url
      }, d)
      releaseHistory!()
      releaseHistory = undefined
      const history = (await preview(page, "session")).history
      // Chromium can discard pending B when its native cursor moves to A before
      // commit; retaining B in the URL journal is also valid. Neither may replace A.
      assert.deepEqual(history, history.urls.length === 2 ? { urls: [a, d], index: 1 } : { urls: [a, b, d], index: 2 }, navigation)
      assert.equal(await pane.getByRole("button", { name: "Forward", exact: true }).isDisabled(), true)
      assert.equal(await pane.getByRole("button", { name: "Back", exact: true }).isDisabled(), false)
      assert.deepEqual(errors, [])
    } finally {
      holdHistoryRequest = undefined
      clearTimeout(gateTimeout)
      releaseHistory?.()
      await app.close()
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
}

test("native preview saves the redirected receipt after registration without reissuing the navigation", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "tauri")
    const requested = `${base}/page/requested`, committed = `${base}/page/redirected`
    await page.evaluate(async url => { await (window as any).fixture.openNativePreview("exact", url) }, requested)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_claim_open"))
    const registration = await page.evaluate(() => (window as any).fixture.native.calls.find((call: any) => call.command === "browser_target_claim_open").response.registrationId)
    const navigate = (url: string) => page.evaluate(({ registration, url }) => (window as any).fixture.native.navigate(registration, url), { registration, url })
    await navigate(committed)
    assert.equal(await page.evaluate(() => (window as any).fixture.savedPreview("session").targetUrl), undefined)
    await page.evaluate(url => (window as any).fixture.settleNativePreview("exact", url), committed)
    await page.waitForFunction(url => (window as any).fixture.savedPreview("session").targetUrl === url, committed)
    assert.deepEqual((await preview(page, "session")).history, { urls: [committed], index: 0 })
    assert.equal(await page.evaluate(() => (window as any).fixture.native.calls.some((call: any) => call.payload?.action === "navigate")), false)
    const next = `${base}/page/next`
    await navigate(next)
    await page.waitForFunction(url => (window as any).fixture.savedPreview("session").targetUrl === url, next)
    assert.deepEqual((await preview(page, "session")).history, { urls: [committed, next], index: 1 })
  } finally { await page.close() }
})

test("native open receipts keep the live address separate from the saved journal", async t => {
  const requested = `${base}/page/requested`, committed = `${base}/page/redirected`
  for (const [name, receipt, live, saved] of [
    ["a fragment arrives before the receipt", committed, `${committed}#latest`, committed],
    ["a long commit keeps the preceding journal", `${base}/page/${"a".repeat(2049)}`, `${base}/page/${"a".repeat(2049)}`, committed],
  ]) await t.test(name, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    try {
      await prepare(page, "tauri")
      const address = page.getByRole("textbox", { name: "Preview URL", exact: true })
      if (receipt === live) {
        await page.evaluate(url => (window as any).fixture.openPreview("session", url), committed)
        await address.waitFor()
      }
      const readSaved = () => page.evaluate(() => (window as any).fixture.savedPreview("session").targetUrl)
      const previousSaved = await readSaved()
      await page.evaluate(async url => { await (window as any).fixture.openNativePreview("exact", url) }, requested)
      await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_claim_open"))
      await page.evaluate(({ receipt, live }) => {
        const { native } = (window as any).fixture
        const registration = native.calls.find((call: any) => call.command === "browser_target_claim_open").response.registrationId
        native.navigate(registration, receipt)
        if (live !== receipt) native.navigate(registration, live)
      }, { receipt, live })
      assert.equal(await address.inputValue(), live)
      assert.equal(await readSaved(), previousSaved, "native events cannot save a pending request")
      await page.evaluate(url => (window as any).fixture.settleNativePreview("exact", url), receipt)
      assert.equal(await readSaved(), saved)
      assert.equal((await preview(page, "session")).targetUrl, live)
      assert.deepEqual((await preview(page, "session")).history, { urls: [saved], index: 0 })
      assert.equal(await address.inputValue(), live)
      assert.equal(await page.evaluate(() => (window as any).fixture.native.calls.some((call: any) => call.payload?.action === "navigate")), false)
    } finally { await page.close() }
  })
})

test("native ownership: delayed refusal, go to owner, explicit transfer and owner closure", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "tauri", "&duplicate=1&ownership=1&assistant=1&links=1")
    const first = "header-windows", second = "header-duplicate"
    const site = `${base}/page/original`
    const pane = (id: string) => page.locator(`[data-preview-instance="${id}"]`)
    const select = (id: string) => page.evaluate(id => (window as any).fixture.selectOccurrence(id), id)
    const conflict = page.getByText("Preview open in another tab", { exact: true })
    const registrations = () => page.evaluate(() => (window as any).fixture.native.calls.filter((call: any) => call.command === "browser_target_register").length)
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), site)
    await pane(first).getByRole("textbox", { name: "Preview URL" }).waitFor()
    await select(second)
    await page.evaluate(() => { (window as any).fixture.native.deferOwnership = true })
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.input?.instanceId === "header-duplicate"))
    assert.equal(await conflict.count(), 0, "the asking tab does not change before the host replies")
    assert.equal(await registrations(), 1)
    await page.evaluate(() => {
      const native = (window as any).fixture.native
      native.deferOwnership = false
      native.settleOwnership()
    })
    await conflict.waitFor()
    await page.getByRole("button", { name: "Go to tab" }).click()
    await pane(first).getByRole("textbox", { name: "Preview URL" }).waitFor()
    await select(second)
    await page.getByRole("button", { name: "Open here" }).click()
    assert.equal(await pane(second).getByRole("textbox", { name: "Preview URL" }).inputValue(), site)
    assert.equal(await registrations(), 1, "a transfer retains the existing native document")
    await select(first)
    await conflict.waitFor()
    await page.evaluate(id => (window as any).fixture.closeOccurrence(id), second)
    await conflict.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    assert.equal(await pane(first).getByRole("textbox", { name: "Preview URL" }).inputValue(), site)
    await page.waitForFunction(() => (window as any).fixture.native.calls.filter((call: any) => call.command === "browser_target_register").length === 2)
  } finally { await page.close() }
})

test("Enter before the first open's attachment acknowledgement preserves the address draft", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "tauri")
    const requested = `${base}/page/agent`, manual = `${base}/page/manual`
    await page.evaluate(url => {
      const f = (window as any).fixture
      f.native.deferOpenTarget = true
      return f.openNativePreview("first", url)
    }, requested)
    const claim = await page.waitForFunction(() => (window as any).fixture.native.calls
      .find((call: any) => call.command === "browser_target_claim_open" && call.response.kind === "target"))
    const { response: { registrationId, instanceId } } = await claim.jsonValue()
    const pane = page.locator(`[data-preview-instance="${instanceId}"]`)
    const address = pane.getByRole("textbox", { name: "Preview URL", exact: true })
    const submit = address.locator("..").locator('button[type="submit"]')
    const actions = () => page.evaluate(() => (window as any).fixture.native.calls
      .filter((call: any) => call.command === "browser_target_release_open" || call.payload?.action === "navigate"))
    await address.fill(manual)
    await address.press("Enter")
    assert.deepEqual(await actions(), [])
    assert.equal(await submit.isDisabled(), true)
    assert.equal(await address.inputValue(), manual)
    await page.evaluate(() => (window as any).fixture.native.settleOpenTarget())
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-preview-instance] button[type="submit"]')?.disabled)
    assert.equal(await address.inputValue(), manual)
    await address.press("Enter")
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.payload?.action === "navigate"))
    await page.evaluate(url => (window as any).fixture.settleNativePreview("first", undefined, true, url), manual)
    const [navigate] = await actions()
    assert.equal(navigate.payload.registrationId, registrationId)
    assert.equal(navigate.payload.url, manual)
  } finally { await page.close() }
})

test("a link commit received before the interrupted agent open settles is saved without the cancelled page", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "tauri")
    const [prior, loading, help] = ["prior", "loading", "help"].map(path => `${base}/page/${path}`)
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), prior)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.payload?.action === "history"))
    await page.evaluate(url => (window as any).fixture.openNativePreview("pending-link", url), loading)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_claim_open"))
    await page.evaluate(({ loading, help }) => {
      const f = (window as any).fixture
      const { registrationId } = f.native.calls.find((call: any) => call.command === "browser_target_claim_open").response
      f.native.navigate(registrationId, loading)
      f.native.navigate(registrationId, help)
      f.settleNativePreview("pending-link", undefined, true, help)
    }, { loading, help })
    assert.equal((await preview(page, "session")).targetUrl, help)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.savedPreview("session").history), { urls: [prior, help], index: 1 })
    assert.equal(await page.evaluate(() => (window as any).fixture.native.calls.some((call: any) => call.payload?.action === "navigate")), false)
  } finally { await page.close() }
})

test("closing the preview drops its unsubmitted address before opening a conversation link", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "tauri", "&assistant=1&links=1")
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), `${base}/page/prior`)
    const pane = page.locator('[data-preview-instance="header-windows"]')
    const address = pane.getByRole("textbox", { name: "Preview URL", exact: true })
    await address.fill(`${base}/page/unused-draft`)
    await pane.getByRole("button", { name: "Close", exact: true }).click()
    const link = page.getByRole("link", { name: "Local preview", exact: true })
    const expected = await link.getAttribute("href")
    await link.click()
    await page.waitForFunction(url => (window as any).fixture.preview("session")?.targetUrl === url, expected)
    assert.equal(await address.inputValue(), expected)
  } finally { await page.close() }
})

test("Back skips an interrupted agent visit without retiring the guest", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "tauri")
    const [a, b, c] = ["a", "b", "c"].map(path => `${base}/page/${path}`)
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), a)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.payload?.action === "history"))
    await page.evaluate(url => (window as any).fixture.openNativePreview("interrupted", url), b)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_claim_open"))
    await page.evaluate(url => {
      const fixture = (window as any).fixture
      const { native } = fixture
      const { registrationId } = native.calls.find((call: any) => call.command === "browser_target_claim_open").response
      native.navigate(registrationId, url)
      native.beforeNavigate = () => fixture.settleNativePreview("interrupted")
    }, b)
    const address = page.getByRole("textbox", { name: "Preview URL", exact: true })
    assert.equal(await address.inputValue(), b)
    await address.fill(c)
    await address.press("Enter")
    await page.waitForFunction(url => (window as any).fixture.savedPreview("session").targetUrl === url, c)
    assert.deepEqual((await preview(page, "session")).history, { urls: [a, c], index: 1 })
    await page.locator('[data-preview-instance="header-windows"]').getByRole("button", { name: "Back", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url, a)
    assert.equal(await page.evaluate(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_release_open")), false)
  } finally { await page.close() }
})

for (const manualFirst of [true, false]) test(`native ownership: ${manualFirst ? "manual" : "agent"} opener owns the preview`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await prepare(page, "tauri", "&duplicate=1&ownership=1&assistant=1&links=1")
    if (manualFirst) {
      await page.getByRole("link", { name: "Local preview", exact: true }).click()
      await page.locator('[data-preview-instance="header-windows"]').waitFor()
    }
    const url = `${base}/page/agent`
    await page.evaluate(url => (window as any).fixture.deliverAgentOpen(url, "header-duplicate"), url)
    const target = await page.waitForFunction(() => (window as any).fixture.native.calls
      .find((call: any) => call.command === "browser_target_claim_open")?.response)
    const expected = manualFirst ? "header-windows" : "header-duplicate"
    const response = await target.jsonValue()
    assert.equal(response.instanceId, expected)
    await page.evaluate(({ registrationId, instanceId, url }) => {
      const { native } = (window as any).fixture
      native.navigate(registrationId, url)
      native.emit("browser-target:open-settled", { sessionID: "session", requestID: "agent", instanceId, committedUrl: url })
    }, { ...response, url })
    assert.equal(await page.getByRole("textbox", { name: "Preview URL" }).inputValue(), url)
    const duplicate = manualFirst ? "header-duplicate" : "header-windows"
    await page.evaluate(id => (window as any).fixture.selectOccurrence(id), duplicate)
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.getByText("Preview open in another tab", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.native.calls.filter((call: any) => call.command === "browser_target_register").length), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the first agent open cannot refresh the neutral document or erase an address draft", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "tauri")
    const requested = `${base}/page/agent`, draft = `${base}/page/draft`
    await page.evaluate(url => (window as any).fixture.openNativePreview("first", url), requested)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((call: any) => call.command === "browser_target_claim_open"))
    const refresh = page.locator('[data-preview-instance="header-windows"]').getByRole("button", { name: "Refresh", exact: true })
    assert.equal(await refresh.isDisabled(), true)
    const address = page.getByRole("textbox", { name: "Preview URL", exact: true })
    await address.fill(draft)
    await page.evaluate(url => {
      const f = (window as any).fixture
      const { registrationId } = f.native.calls.find((call: any) => call.command === "browser_target_claim_open").response
      f.native.navigate(registrationId, url)
      f.settleNativePreview("first", url)
    }, requested)
    assert.equal(await refresh.isEnabled(), true)
    assert.equal(await address.inputValue(), draft)
    assert.equal((await preview(page, "session")).targetUrl, requested)
  } finally { await page.close() }
})

test("Back discards the address draft that existed before the navigation gesture", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "tauri")
    const a = `${base}/page/a`, b = `${base}/page/b`, draft = `${base}/page/draft`
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), a)
    const registration = await page.waitForFunction(() => (window as any).fixture.native.calls
      .find((call: any) => call.command === "browser_target_register")?.payload.registrationId)
    await page.evaluate(({ id, url }) => (window as any).fixture.native.navigate(id, url), { id: await registration.jsonValue(), url: b })
    const address = page.getByRole("textbox", { name: "Preview URL", exact: true })
    await page.waitForFunction(url => (window as any).fixture.preview("session")?.targetUrl === url, b)
    await address.fill(draft)
    await page.locator('[data-session-id="session"] .window-shell').getByRole("button", { name: "Back", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session")?.targetUrl === url, a)
    assert.equal(await address.inputValue(), a)
  } finally { await page.close() }
})

test("Tauri retains hidden native registrations and restores the correct session target", async () => {
  const page = await browser.newPage({ userAgent: "Windows fixture", viewport: { width: 1200, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await prepare(page, "tauri")
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), `${base}/page/a`)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_register"))
    const registration = await page.evaluate(() => (window as any).fixture.native.calls.find((c: any) => c.command === "browser_target_register").payload.registrationId)
    await page.evaluate(({ registration, url }) => (window as any).fixture.native.navigate(registration, url), { registration, url: `${base}/page/b` })
    await page.locator('[data-session-id="session"] .window-shell').getByRole("button", { name: "Close", exact: true }).click()
    await page.waitForFunction(id => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_update" && c.payload.registrationId === id && c.payload.visible === false), registration)
    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    await page.evaluate(url => (window as any).fixture.openPreview("second", url), `${base}/page/c`)
    await page.waitForFunction(() => (window as any).fixture.native.calls.filter((c: any) => c.command === "browser_target_register").length === 2)
    await page.evaluate(() => (window as any).fixture.registerHiddenOccurrence("/other-project"))
    await page.evaluate(url => (window as any).fixture.openPreview("session", url, "/other-project"), `${base}/page/b`)
    await page.evaluate(() => (window as any).fixture.selectSession("session"))
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(id => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_update" && c.payload.registrationId === id && c.payload.visible === true), registration)
    await page.locator('[data-session-id="session"] .window-shell').getByRole("button", { name: "Back", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url, `${base}/page/a`)
    const calls = await page.evaluate(() => (window as any).fixture.native.calls)
    assert.equal(calls.filter((c: any) => c.command === "browser_target_register").length, 2)
    assert.equal(calls.filter((c: any) => c.command === "browser_target_unregister").length, 0)
    assert.ok(calls.some((c: any) => c.command === "browser_target_action" && c.payload.registrationId === registration && c.payload.action === "history-go"))
    assert.equal((await preview(page, "session")).targetUrl, `${base}/page/a`)
    assert.equal((await preview(page, "second")).targetUrl, `${base}/page/c`)
    assert.equal(await page.evaluate(() => (window as any).fixture.preview("session", "/other-project").targetUrl), `${base}/page/a`)
    await page.locator('[data-session-id="session"] .window-shell').getByRole("button", { name: "Forward", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.preview("session").history.index === 1)
    await page.reload()
    await page.waitForFunction(() => (window as any).browserHistoryReady)
    assert.equal(await page.locator('[data-session-id="session"] .window-shell').count(), 0)
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_register"))
    const restoredPane = page.locator('[data-session-id="session"] .window-shell')
    await restoredPane.getByRole("button", { name: "Back", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.preview("session").history.index === 0)
    await restoredPane.getByRole("button", { name: "Forward", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.preview("session").history.index === 1)
    const restoredCalls = await page.evaluate(() => (window as any).fixture.native.calls)
    assert.deepEqual(restoredCalls.filter((call: any) => call.command === "browser_target_action" && call.payload.action === "navigate").map((call: any) => call.payload.url), [`${base}/page/a`])
    assert.equal(restoredCalls.filter((call: any) => call.command === "browser_target_register").length, 1, "other saved sessions stay closed")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Tauri captures navigation while hidden and persists its history through renderer restart", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ userAgent: "Windows fixture", viewport: { width: 1200, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const a = `${base}/page/a`, b = `${base}/page/b`
  try {
    await prepare(page, "tauri")
    await page.evaluate(url => (window as any).fixture.openPreview("session", url), a)
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_action" && c.payload.action === "history"))
    const registration = await page.evaluate(() => (window as any).fixture.native.calls.find((c: any) => c.command === "browser_target_register").payload.registrationId)
    const pane = page.locator('[data-session-id="session"] .window-shell')
    await pane.getByRole("button", { name: "Close", exact: true }).click()
    await page.waitForFunction(id => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_update" && c.payload.registrationId === id && c.payload.visible === false), registration)
    await page.evaluate(({ registration, url }) => (window as any).fixture.native.navigate(registration, url), { registration, url: b })
    await page.waitForFunction(url => {
      const preview = (window as any).fixture.preview("session")
      return preview.mode === "chat" && preview.targetUrl === url && preview.history.index === 1
    }, b)
    const saved = await page.evaluate(() => (window as any).fixture.savedPreview("session"))
    assert.deepEqual(saved, { targetUrl: b, mode: "chat", history: { urls: [a, b], index: 1 } }, "hidden navigation is persisted before revealing the guest")
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await pane.waitFor({ state: "visible" })
    assert.deepEqual((await preview(page, "session")).history, { urls: [a, b], index: 1 })
    await pane.getByRole("button", { name: "Back", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url && (window as any).fixture.preview("session").history.index === 0, a)
    assert.deepEqual((await preview(page, "session")).history, { urls: [a, b], index: 0 })
    await page.reload()
    await page.waitForFunction(() => (window as any).browserHistoryReady)
    assert.equal(await page.locator(".window-shell").count(), 0, "saved browsers remain lazy after restart")
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_register"))
    assert.deepEqual((await preview(page, "session")).history, { urls: [a, b], index: 0 })
    await pane.getByRole("button", { name: "Forward", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url && (window as any).fixture.preview("session").history.index === 1, b)
    assert.deepEqual((await preview(page, "session")).history, { urls: [a, b], index: 1 })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the legacy project URL is adopted once and the cross only hides its retained preview", async () => {
  const page = await browser.newPage({ userAgent: "Windows fixture", viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "web", "&legacy=1")
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.preview("session"))
    assert.equal((await preview(page, "session")).targetUrl, `${base}/page/legacy`)
    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    assert.equal(await preview(page, "second"), null)
    const persisted = await page.evaluate(() => JSON.parse((window as any).fixture.readLayout("opencode-session-previews-v1")))
    assert.equal(persisted["/repo"], undefined)
    assert.equal(Object.keys(persisted).length, 0)
    assert.equal((await page.evaluate(() => (window as any).fixture.savedPreview("session"))).targetUrl, `${base}/page/legacy`)
    await page.evaluate(() => (window as any).fixture.selectSession("session"))
    // The previously opened browser is shown again when selecting its session.
    const pane = page.locator('[data-session-id="session"] .window-shell')
    await pane.getByRole("button", { name: "Close", exact: true }).click()
    assert.equal((await preview(page, "session")).mode, "chat")
    await page.evaluate(() => { (window as any).fixture.selectSession("second"); (window as any).fixture.selectSession("session") })
    assert.equal((await preview(page, "session")).targetUrl, `${base}/page/legacy`)
  } finally { await page.close() }
})
