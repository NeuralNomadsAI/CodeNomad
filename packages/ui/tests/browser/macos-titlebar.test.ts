import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  const shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [shutdown.plugin, solid(), { name: "macos-titlebar-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/macos-titlebar.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })

const WIDTH = 1100

/** `pageZoom` is the zoom factor Electron's preload reports for the page. */
async function prepare(platform: string, pageZoom = 1) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 500 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  // A local desktop window on the given OS, without any real host or user state, whose
  // window is twice as wide as the page, as with docked DevTools. A source string keeps
  // the transpiler's function-name helpers out of the page.
  await page.addInitScript(`
    Object.defineProperty(Navigator.prototype, "platform", { get() { return ${JSON.stringify(platform)} } })
    Object.defineProperty(window, "outerWidth", { get() { return window.innerWidth * 2 } })
    window.electronAPI = { getZoomFactor() { return ${pageZoom} } }
    window.__CODENOMAD_RUNTIME_HOST__ = "electron"
    window.__CODENOMAD_WINDOW_CONTEXT__ = "local"
  `)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).titlebarFixture))
  return { page, errors }
}

test("macOS leaves menus and window controls native and holds the app actions in its title bar", async () => {
  const { page, errors } = await prepare("MacIntel")
  try {
    assert.equal(await page.locator(".native-titlebar-menu").count(), 0, "menus stay in the global menu bar")
    assert.equal(await page.locator(".native-titlebar-controls").count(), 0, "the traffic lights replace the window buttons")
    assert.equal(await page.locator(".tab-bar-actions").count(), 0, "the tab bar leaves the actions to the title bar")
    const bar = (await page.locator(".native-titlebar").boundingBox())!
    assert.equal(bar.height, 28, "the bar matches the native title bar centring the traffic lights")
    const mark = (await page.locator(".native-titlebar-logo").boundingBox())!
    assert.ok(mark.x >= 60, "the mark clears the traffic lights")
    assert.ok(Math.abs(mark.y + mark.height / 2 - (bar.y + bar.height / 2)) <= 0.5, "the mark is centred in the bar")

    const actions = page.locator(".native-titlebar-actions")
    for (const name of ["Open settings", "Notification History", "Remote connect"]) {
      const button = (await actions.getByRole("button", { name, exact: true }).boundingBox())!
      assert.ok(button.y >= bar.y && button.y + button.height <= bar.y + bar.height, `${name} fits in the bar`)
    }
    const actionsBox = (await actions.boundingBox())!
    assert.ok(actionsBox.x + actionsBox.width > WIDTH - 8, "the actions end the bar")

    await actions.getByRole("button", { name: "Notification History", exact: true }).click()
    const panel = (await page.locator(".toast-history-panel").boundingBox())!
    assert.ok(panel.y >= bar.y + bar.height, "the history opens below the title bar")
    assert.ok(panel.x >= 0 && panel.x + panel.width <= WIDTH, "the history stays in the window")
    assert.equal(await page.locator(".toast-history-panel").evaluate(element => getComputedStyle(element).userSelect), "text", "history text stays selectable")
    await page.keyboard.press("Escape")
    await page.locator(".toast-history-panel").waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const pageZoom of [0.5, 5]) {
  test(`the macOS title bar keeps the traffic lights' native geometry at ${pageZoom * 100} % page zoom`, async () => {
    const { page, errors } = await prepare("MacIntel", pageZoom)
    try {
      // A page CSS pixel is `pageZoom` window points: 28 / pageZoom px make the 28-point bar.
      const bar = (await page.locator(".native-titlebar").boundingBox())!
      assert.ok(Math.abs(bar.height - 28 / pageZoom) < 0.1, `bar height ${bar.height}`)
      assert.ok((await page.locator(".native-titlebar-logo").boundingBox())!.x >= 60 / pageZoom, "the mark clears the 60-point traffic lights")
      await page.locator(".native-titlebar-actions").getByRole("button", { name: "Notification History", exact: true }).click()
      const panel = (await page.locator(".toast-history-panel").boundingBox())!
      assert.ok(panel.y >= bar.y + bar.height - 0.1, "the history opens below the title bar")
      assert.ok(Math.abs(panel.width - 380) < 1, `the history keeps the page zoom (width ${panel.width})`)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("Windows keeps the in-window menus, window controls and the tab bar's app actions", async () => {
  const { page, errors } = await prepare("Win32")
  try {
    assert.equal(await page.locator(".native-titlebar-menu").count(), 1)
    assert.equal(await page.locator(".native-titlebar-controls").count(), 1)
    assert.equal(await page.locator(".native-titlebar-actions").count(), 0)
    assert.equal(await page.locator(".tab-bar-actions").getByRole("button", { name: "Open settings", exact: true }).count(), 1)
    assert.equal((await page.locator(".native-titlebar").boundingBox())!.height, 36)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
