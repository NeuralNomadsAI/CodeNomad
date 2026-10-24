import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "markdown-loopback-link-fixture", configureServer(s) {
      s.middlewares.use("/markdown-loopback-link-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/markdown-loopback-link-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/markdown-loopback-link.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, allowedHosts: ["insecure.test"], hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/markdown-loopback-link-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("plain loopback link clicks open the session preview; external and modified clicks do not", async () => {
  const page: Page = await browser.newPage()
  try {
    await page.goto(url)
    await page.locator('#markdown-root a[href="http://localhost:3000/"]').waitFor()

    await page.locator('#markdown-root a[href="http://localhost:3000/"]').click()
    assert.deepEqual(
      await page.evaluate(() => (window as any).fixture.created()),
      [{ sessionId: "session-link", url: "http://localhost:3000/" }],
    )

    await page.locator('#markdown-root a[href="https://example.com/"]').click()
    await page.locator('#markdown-root a[href="http://localhost:9999/"]').click({ modifiers: ["Meta"] })
    // Firefox fires `click` for the middle button; Chromium only fires
    // `auxclick`, so the Firefox behavior is reproduced with a synthetic
    // button=1 click event through the real handler.
    await page.locator('#markdown-root a[href="http://localhost:9999/"]').evaluate((anchor) => {
      anchor.dispatchEvent(new MouseEvent("click", { button: 1, bubbles: true, cancelable: true }))
    })
    assert.deepEqual(
      await page.evaluate(() => (window as any).fixture.created()),
      [{ sessionId: "session-link", url: "http://localhost:3000/" }],
    )
  } finally {
    await page.close()
  }
})
