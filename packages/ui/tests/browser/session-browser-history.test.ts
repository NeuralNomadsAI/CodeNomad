import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import electronPath from "electron"
import { chromium, _electron, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { build } from "esbuild"

let server: ViteDevServer, browser: Browser, base: string
const pageRequests: string[] = []
let holdHistoryRequest: ((release: () => void) => void) | undefined
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "session-browser-history", configureServer(s) {
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
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function prepare(page: Page, host: string, query = "") {
  page.setDefaultTimeout(20_000)
  page.on("pageerror", error => console.error("[browser history fixture]", error))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(`${base}/history-fixture?host=${host}${query}`)
  await page.waitForFunction(() => (window as any).browserHistoryReady, undefined, { timeout: 60_000 })
}
const preview = (page: Page, sessionId: string) => page.evaluate(id => (window as any).fixture.preview(id), sessionId)

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
    const saved = await page.evaluate(() => JSON.parse((window as any).fixture.readLayout("opencode-session-previews-v1"))[JSON.stringify(["/repo", "session"])])
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
      const saved = await page.evaluate(() => JSON.parse((window as any).fixture.readLayout("opencode-session-previews-v1"))[JSON.stringify(["/repo", "session"])])
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
    await page.evaluate(url => (window as any).fixture.openPreview("session", url, "/other-project"), `${base}/page/other`)
    await page.evaluate(() => (window as any).fixture.selectSession("session"))
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    await page.waitForFunction(id => (window as any).fixture.native.calls.some((c: any) => c.command === "browser_target_update" && c.payload.registrationId === id && c.payload.visible === true), registration)
    await page.locator('[data-session-id="session"] .window-shell').getByRole("button", { name: "Back", exact: true }).click()
    const calls = await page.evaluate(() => (window as any).fixture.native.calls)
    assert.equal(calls.filter((c: any) => c.command === "browser_target_register").length, 2)
    assert.equal(calls.filter((c: any) => c.command === "browser_target_unregister").length, 0)
    assert.ok(calls.some((c: any) => c.command === "browser_target_action" && c.payload.registrationId === registration && c.payload.action === "history-go"))
    assert.equal((await preview(page, "session")).targetUrl, `${base}/page/a`)
    assert.equal((await preview(page, "second")).targetUrl, `${base}/page/c`)
    assert.equal(await page.evaluate(() => (window as any).fixture.preview("session", "/other-project").targetUrl), `${base}/page/other`)
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
    const saved = await page.evaluate(() => JSON.parse((window as any).fixture.readLayout("opencode-session-previews-v1"))[JSON.stringify(["/repo", "session"])])
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
    assert.equal(Object.keys(persisted).length, 1)
    await page.evaluate(() => (window as any).fixture.selectSession("session"))
    // The previously opened browser is shown again when selecting its session.
    const pane = page.locator('[data-session-id="session"] .window-shell')
    await pane.getByRole("button", { name: "Close", exact: true }).click()
    assert.equal((await preview(page, "session")).mode, "chat")
    await page.evaluate(() => { (window as any).fixture.selectSession("second"); (window as any).fixture.selectSession("session") })
    assert.equal((await preview(page, "session")).targetUrl, `${base}/page/legacy`)
  } finally { await page.close() }
})
