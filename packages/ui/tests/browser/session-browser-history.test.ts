import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import electronPath from "electron"
import { chromium, _electron, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, base: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "session-browser-history", configureServer(s) {
      s.middlewares.use("/history-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/history-fixture", '<html><head><style>webview{display:flex}</style></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-browser-history.tsx"></script></body></html>'))
      })
      s.middlewares.use("/page", (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end('<html><body><a href="/page/b">Next page</a><input id="draft"></body></html>')
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
  await page.waitForFunction(() => (window as any).browserHistoryReady)
}
const preview = (page: Page, sessionId: string) => page.evaluate(id => (window as any).fixture.preview(id), sessionId)

test("real shell retains separate Electron histories across chat, sessions, project visibility and Info", { timeout: 90_000 }, async () => {
  const temp = process.env.CODENOMAD_TEST_TEMP || (process.platform === "win32" ? join(process.env.LOCALAPPDATA!, "Temp", "opencode") : tmpdir())
  await mkdir(temp, { recursive: true })
  const profile = await mkdtemp(join(temp, "session-browser-history-"))
  const env = { ...process.env, CODENOMAD_TEST_PROFILE: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: process.env.CODENOMAD_TEST_ELECTRON || electronPath,
    args: ["--no-sandbox", fileURLToPath(new URL("fixtures/browser-frame-native-electron.cjs", import.meta.url))], env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
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
    await firstPane.getByRole("button", { name: "Back", exact: true }).click()
    await page.waitForFunction(url => (window as any).fixture.preview("session").targetUrl === url, `${base}/page/a`)
    assert.equal((await preview(page, "second")).targetUrl, `${base}/page/c`)
    await firstPane.getByRole("button", { name: "Close", exact: true }).click()
    await first.waitFor({ state: "detached" })
    assert.equal(await preview(page, "session"), null, "closing must not immediately restore the preview")
    assert.equal(await page.locator("webview").count(), 1)
    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    assert.equal((await preview(page, "second")).targetUrl, `${base}/page/c`)
    assert.deepEqual(errors, [])
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
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
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
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
    assert.ok(calls.some((c: any) => c.command === "browser_target_action" && c.payload.registrationId === registration && c.payload.action === "back"))
    assert.equal((await preview(page, "session")).targetUrl, `${base}/page/b`)
    assert.equal((await preview(page, "second")).targetUrl, `${base}/page/c`)
    assert.equal(await page.evaluate(() => (window as any).fixture.preview("session", "/other-project").targetUrl), `${base}/page/other`)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the legacy project URL is adopted once and closing does not restore it again", async () => {
  const page = await browser.newPage({ userAgent: "Windows fixture", viewport: { width: 1200, height: 900 } })
  try {
    await prepare(page, "web", "&legacy=1")
    await page.waitForFunction(() => (window as any).fixture.preview("session"))
    assert.equal((await preview(page, "session")).targetUrl, `${base}/page/legacy`)
    await page.evaluate(() => (window as any).fixture.selectSession("second"))
    assert.equal(await preview(page, "second"), null)
    const persisted = await page.evaluate(() => JSON.parse((window as any).fixture.readLayout("opencode-session-previews-v1")))
    assert.equal(persisted["/repo"], undefined)
    assert.equal(Object.keys(persisted).length, 1)
    await page.evaluate(() => (window as any).fixture.selectSession("session"))
    await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    const pane = page.locator('[data-session-id="session"] .window-shell')
    await pane.getByRole("button", { name: "Close", exact: true }).click()
    assert.equal(await preview(page, "session"), null)
    await page.evaluate(() => { (window as any).fixture.selectSession("second"); (window as any).fixture.selectSession("session") })
    assert.equal(await preview(page, "session"), null)
  } finally { await page.close() }
})
