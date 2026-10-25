import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "markdown-loopback-link-fixture", configureServer(s) {
      s.middlewares.use("/markdown-loopback-link-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/markdown-loopback-link-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/markdown-loopback-link.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, allowedHosts: ["insecure.test"], hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/markdown-loopback-link-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const created = (page: Page) => page.evaluate(() => (window as any).fixture.created()) as Promise<Array<{ sessionId: string; url: string }>>

test("loopback link clicks open the session preview only once availability is known", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    const loopback = page.locator('#markdown-root a[href="http://localhost:3000/"]')
    await loopback.waitFor()

    // Before the server meta answers, availability is unknown: links keep
    // their default behavior, so Remote Control with previews off never
    // opens a dead preview.
    await loopback.click()
    assert.deepEqual(await created(page), [])

    await page.evaluate(() => (window as any).fixture.resolvePreviewsAvailable())

    // The escape hatch is discoverable on intercepted links only; an
    // author-provided title wins and non-loopback links stay untouched.
    assert.match(await loopback.getAttribute("title"), /web preview/)
    assert.equal(await page.locator('#markdown-root a[href="https://example.com/"]').getAttribute("title"), null)
    assert.equal(await page.locator('#markdown-root a[href="https://127.example.com/"]').getAttribute("title"), null)
    assert.equal(await page.locator('#markdown-root a[href="http://localhost:9998/"]').getAttribute("title"), "Custom title")

    await loopback.click()
    assert.deepEqual(await created(page), [{ sessionId: "session-link", url: "http://localhost:3000/" }])

    // External, modifier, middle-button and non-loopback-IPv4 clicks keep
    // browser defaults. Firefox fires `click` for the middle button, so the
    // Firefox behavior is reproduced with a synthetic button=1 click.
    await page.locator('#markdown-root a[href="https://example.com/"]').click()
    await page.locator('#markdown-root a[href="http://localhost:9999/"]').click({ modifiers: ["Meta"] })
    await page.locator('#markdown-root a[href="http://localhost:9999/"]').evaluate((anchor) => {
      anchor.dispatchEvent(new MouseEvent("click", { button: 1, bubbles: true, cancelable: true }))
    })
    await page.locator('#markdown-root a[href="https://127.example.com/"]').click()
    assert.deepEqual(await created(page), [{ sessionId: "session-link", url: "http://localhost:3000/" }])

    // Through Remote Control with the host's web previews off, loopback
    // links keep their default browser behavior and our tooltip clears
    // without touching an author's title.
    await page.evaluate(() => (window as any).fixture.setPreviewsUnavailable())
    await page.waitForFunction(() => (document.querySelector('#markdown-root a[href="http://localhost:3000/"]') as HTMLAnchorElement).title === "")
    assert.equal(await page.locator('#markdown-root a[href="http://localhost:9998/"]').getAttribute("title"), "Custom title")
    await page.locator('#markdown-root a[href="http://localhost:9999/"]').click()
    assert.deepEqual(await created(page), [{ sessionId: "session-link", url: "http://localhost:3000/" }])
  } finally {
    await page.close()
  }
})
