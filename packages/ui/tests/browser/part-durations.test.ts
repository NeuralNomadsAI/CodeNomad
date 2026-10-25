import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
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
    armFixtureNavigationBudget(browser)
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

// Short running durations read "5s" (no clock, which looks like a time of day).
const seconds = (duration: string) => Number(/^(\d+)s$/.exec(duration)?.[1] ?? NaN)

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
    assert.equal(await finishedTool.innerText(), "4s")
    assert.equal(await finishedTool.getAttribute("data-live"), null)
    // It follows the status ("✓ Completed 4s"), visible without hovering, right
    // before the header actions' reserved space.
    assert.ok(await finishedTool.isVisible())
    const status = await page.locator('.tool-call[data-part-id="finished-tool"] .tool-call-header-status').boundingBox()
    const duration = await finishedTool.boundingBox()
    assert.ok(status && duration && duration.x >= status.x + status.width, "duration follows the status")
    assert.ok(duration!.x - (status!.x + status!.width) <= 12, "and sticks to it")
    // A sub-second tool shows no duration ("1s" everywhere would be noise).
    await page.locator('.tool-call[data-part-id="quick-tool"] .tool-call-header-status').waitFor()
    assert.equal(await page.locator('.tool-call[data-part-id="quick-tool"] .tool-call-header .part-duration').count(), 0)
    // The header actions keep their reserved space: hovering moves nothing.
    await page.locator('.tool-call[data-part-id="finished-tool"] .tool-call-header').hover()
    const hovered = await finishedTool.boundingBox()
    assert.ok(hovered && Math.abs(hovered.x - duration!.x) < 0.5, "hover does not shift the duration")

    const reasoning = (messageId: string) => page.locator(`.message-reasoning-card[data-part-id="${messageId}-reasoning-0"] .message-reasoning-header .part-duration`)
    await reasoning("finished-message").waitFor()
    assert.equal(await reasoning("finished-message").innerText(), "3s", "V2 reasoning created → completed")
    // An untitled step keeps its generic title; the duration is shown once.
    const untitled = page.locator('.message-reasoning-card[data-part-id="untitled-message-reasoning-0"] .message-reasoning-header')
    assert.equal(await untitled.locator(".part-duration").innerText(), "2s")
    assert.equal(await untitled.locator(".message-reasoning-title").innerText(), "Thoughts")
    assert.match(await untitled.locator(".message-reasoning-title").getAttribute("title") ?? "", /Thought for 2 seconds/)

    const runningTool = page.locator('.tool-call[data-part-id="running-tool"] .tool-call-header .part-duration')
    assert.equal(await runningTool.getAttribute("data-live"), "true")
    assert.equal(await reasoning("running-message").getAttribute("data-live"), "true")
    const before = seconds(await runningTool.innerText())
    assert.ok(before >= 3 && before <= 6, `running tool counts from ran (${before}s)`)
    await page.waitForFunction(start => {
      const text = document.querySelector('.tool-call[data-part-id="running-tool"] .part-duration')?.textContent ?? ""
      return Number(/^(\d+)s$/.exec(text)?.[1] ?? 0) > start
    }, before, { timeout: 5000 })
    if (process.env.CODENOMAD_DURATION_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_DURATION_CAPTURE })

    // Short of room, the status word goes before the title truncates; the icon,
    // duration, tooltip and accessible name stay.
    const header = page.locator('.tool-call[data-part-id="finished-tool"] .tool-call-header')
    const label = header.locator(".tool-call-header-status-label")
    const title = header.locator(".tool-call-summary-title")
    const truncated = () => title.evaluate(element => element.scrollWidth > element.clientWidth + 0.5)
    assert.ok(await label.isVisible())
    assert.equal(await truncated(), false)
    await page.setViewportSize({ width: 320, height: 900 })
    await label.waitFor({ state: "hidden" })
    assert.ok(await finishedTool.isVisible())
    assert.equal(await header.locator(".tool-call-header-status-icon").filter({ visible: true }).count(), 1)
    assert.equal(await header.locator(".tool-call-header-status").getAttribute("aria-label"), "Completed")
    assert.equal(await header.locator(".tool-call-header-status").getAttribute("title"), "Completed")
    assert.equal(await truncated(), false, "the word goes first, so the title stays whole here")
    if (process.env.CODENOMAD_DURATION_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_DURATION_CAPTURE.replace(/\.png$/, "-narrow.png") })
    // Narrower still, the title truncates after the word has gone.
    await page.setViewportSize({ width: 250, height: 900 })
    await page.waitForFunction(() => {
      const title = document.querySelector('.tool-call[data-part-id="finished-tool"] .tool-call-summary-title')
      return Boolean(title && title.scrollWidth > title.clientWidth + 0.5)
    })
    assert.equal(await label.isVisible(), false)
    await page.setViewportSize({ width: 1100, height: 900 })
    await label.waitFor({ state: "visible" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("tool header actions keep their icons after the overflow menu opens and closes", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    const header = page.locator('.tool-call[data-part-id="finished-tool"] .tool-call-header')
    await header.waitFor()
    // Show the narrow-layout trigger while the inline actions stay mounted beside it.
    await page.addStyleTag({ content: ".tool-call-header .action-overflow-narrow { display: inline-flex !important; }" })
    const inlineIcons = () => header.locator("button:not(.action-overflow-narrow) svg").count()
    const before = await inlineIcons()
    assert.ok(before > 0)
    await header.hover()
    await header.locator(".action-overflow-narrow").click()
    const menu = page.getByRole("menu")
    await menu.waitFor()
    assert.ok(await menu.locator("svg").count() > 0, "menu items render their own icons")
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "detached" })
    // Items shared with message-block's headerMenuItems (delete part) must not lose their inline icon.
    assert.equal(await inlineIcons(), before)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
