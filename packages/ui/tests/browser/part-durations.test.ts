import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({
      configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "part-durations", configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/part-durations.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

const seconds = (clock: string) => clock.split(":").reduce((total, part) => total * 60 + Number(part), 0)

test("reasoning and tool headers show OpenCode V2 durations, live while running", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    const finishedTool = page.locator('.tool-call[data-part-id="finished-tool"] .tool-call-header .part-duration')
    await finishedTool.waitFor()
    // Execution time runs from ran to completed, not from input streaming.
    assert.equal(await finishedTool.innerText(), "0:04")
    assert.equal(await finishedTool.getAttribute("data-live"), null)
    // It leads the trailing status, visible without hovering; the space after
    // the status stays free for the hover/touch header actions.
    assert.ok(await finishedTool.isVisible())
    const status = await page.locator('.tool-call[data-part-id="finished-tool"] .tool-call-header-status').boundingBox()
    const duration = await finishedTool.boundingBox()
    assert.ok(status && duration && duration.x + duration.width <= status.x, "duration sits just before the status")
    assert.ok(status!.x - (duration!.x + duration!.width) < 16, "and stays next to it")

    const reasoning = (messageId: string) => page.locator(`.message-reasoning-card[data-part-id="${messageId}-reasoning-0"] .message-reasoning-header .part-duration`)
    await reasoning("finished-message").waitFor()
    assert.equal(await reasoning("finished-message").innerText(), "0:03", "V2 reasoning created → completed")

    const runningTool = page.locator('.tool-call[data-part-id="running-tool"] .tool-call-header .part-duration')
    assert.equal(await runningTool.getAttribute("data-live"), "true")
    assert.equal(await reasoning("running-message").getAttribute("data-live"), "true")
    const before = seconds(await runningTool.innerText())
    assert.ok(before >= 3 && before <= 6, `running tool counts from ran (${before}s)`)
    await page.waitForFunction(start => {
      const text = document.querySelector('.tool-call[data-part-id="running-tool"] .part-duration')?.textContent ?? ""
      return text.split(":").reduce((total, part) => total * 60 + Number(part), 0) > start
    }, before, { timeout: 5000 })
    if (process.env.CODENOMAD_DURATION_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_DURATION_CAPTURE })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
