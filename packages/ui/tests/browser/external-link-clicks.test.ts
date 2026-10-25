import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, { name: "external-link-clicks", configureServer(s) {
        s.middlewares.use("/external-link-fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/external-link-fixture", '<html><body><script type="module" src="/tests/browser/fixtures/external-link-clicks.ts"></script></body></html>'))
        })
      } }],
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/external-link-fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

test("anchors asking for a new window open through the host's opener command", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.click("#blank")
    await page.click("#plain", { modifiers: ["Control"] })
    await page.click("#plain", { modifiers: ["Shift"] })
    await page.click("#label")
    await page.click("#mail")
    // Same-window navigations stay with the host's navigation policy; other schemes stay closed.
    await page.click("#plain")
    await page.click("#blank", { modifiers: ["Alt"] })
    await page.click("#tel")
    await page.click("#app")
    await page.waitForFunction(() => (window as any).fixture.outcomes.length === 9)
    const { calls, outcomes } = await page.evaluate(() => (window as any).fixture)
    assert.deepEqual(outcomes.map((outcome: { id: string; claimed: boolean }) => `${outcome.id}:${outcome.claimed}`), [
      "blank:true", "plain:true", "plain:true", "nested:true", "mail:true",
      "plain:false", "blank:false", "tel:false", "app:false",
    ])
    assert.deepEqual(calls, [
      "https://example.com/blank", "https://example.com/plain", "https://example.com/plain",
      "https://example.com/nested", "mailto:hello@example.com",
    ].map(url => ({ command: "open_external_url", args: { url } })))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
