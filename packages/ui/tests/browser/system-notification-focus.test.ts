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
    plugins: [shutdown.plugin, solid(), { name: "system-notification-focus-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/system-notification-focus.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })

test("system notifications are held back only while the window has focus, unless allowed", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  // The window's focus, switched by the test; the page itself stays visible throughout.
  await page.addInitScript("window.__focused = true; Document.prototype.hasFocus = function () { return window.__focused }")
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => document.visibilityState), "visible")
    const notify = (title: string) => page.evaluate((value) => (window as any).fixture.notify(value), title)
    const shown = () => page.evaluate(() => (window as any).fixture.shown() as string[])

    await notify("Focused")
    // A visible window behind another application or on another screen has no focus.
    await page.evaluate(() => { (window as any).__focused = false })
    await notify("Visible without focus")
    await page.waitForFunction(() => (window as any).fixture.shown().length === 1)
    assert.deepEqual(await shown(), ["Visible without focus"])

    await page.evaluate(() => { (window as any).__focused = true })
    await page.evaluate(() => (window as any).fixture.allowWhenFocused(true))
    await notify("Focused and allowed")
    await page.waitForFunction(() => (window as any).fixture.shown().length === 2)
    assert.deepEqual(await shown(), ["Visible without focus", "Focused and allowed"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
