import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "mcp-motion", configureServer(s) {
      s.middlewares.use("/mcp-motion", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mcp-motion", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mcp-motion.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mcp-motion`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function withFixture(motion: "reduce" | "no-preference", run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 700, height: 850 }, deviceScaleFactor: 1.5, reducedMotion: motion, locale: "en-US" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForFunction(() => Boolean((window as any).mcpFixture), undefined, { timeout: 30_000 })
    await page.locator(".status-dot").first().waitFor()
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}

async function perpetualAnimations(page: Page) {
  return page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity,
  ).length)
}

for (const motion of ["no-preference", "reduce"] as const) {
  test(`eight connected MCP servers stay static at rest (${motion}, 150% scale)`, () => withFixture(motion, async page => {
    assert.equal(await page.locator(".status-dot.ready").count(), 8)
    assert.equal(await page.getByRole("checkbox").count(), 8)
    assert.equal(await perpetualAnimations(page), 0, "connected servers must not schedule perpetual animation frames")
    assert.deepEqual(await page.evaluate(() => (window as any).mcpFixture.calls), [])
    const header = page.locator(".right-panel-accordion-trigger")
    await header.click()
    await page.locator(".status-dot").first().waitFor({ state: "hidden" })
    assert.equal(await perpetualAnimations(page), 0)
    await header.click()
    await page.locator(".status-dot").first().waitFor()
    assert.equal(await page.locator(".status-dot.ready").count(), 8)
    assert.equal(await perpetualAnimations(page), 0)
  }))

  test(`MCP operation feedback stops on success and failure (${motion})`, () => withFixture(motion, async page => {
    const toggle = page.getByRole("checkbox", { name: "Toggle dnd-5e MCP server", exact: true })
    assert.equal(await toggle.isChecked(), true)
    await toggle.click()
    await page.locator("svg.animate-spin").waitFor()
    assert.equal(await toggle.isDisabled(), true)
    assert.equal(await perpetualAnimations(page), motion === "reduce" ? 0 : 2, "only the pending dot and spinner may loop")
    if (motion === "reduce") {
      // Exercise live OS-preference changes rather than only the initial media query.
      await page.emulateMedia({ reducedMotion: "no-preference" })
      await page.waitForFunction(() => document.getAnimations().some(a => a.effect?.getComputedTiming().iterations === Infinity))
      await page.emulateMedia({ reducedMotion: "reduce" })
      assert.equal(await perpetualAnimations(page), 0)
    }
    await page.evaluate(() => (window as any).mcpFixture.settle())
    await page.locator("svg.animate-spin").waitFor({ state: "detached" })
    assert.equal(await toggle.isChecked(), false)
    assert.equal(await toggle.isEnabled(), true)
    assert.equal(await perpetualAnimations(page), 0)
    await toggle.click()
    await page.locator("svg.animate-spin").waitFor()
    await page.evaluate(() => (window as any).mcpFixture.settle(true))
    await page.locator("svg.animate-spin").waitFor({ state: "detached" })
    assert.equal(await toggle.isChecked(), false)
    assert.equal(await toggle.isEnabled(), true)
    assert.equal(await perpetualAnimations(page), 0)
    await toggle.click()
    await page.locator("svg.animate-spin").waitFor()
    await page.evaluate(() => (window as any).mcpFixture.settle())
    await page.locator("svg.animate-spin").waitFor({ state: "detached" })
    assert.equal(await toggle.isChecked(), true)
    assert.equal(await page.locator(".status-dot.ready").count(), 8)
    assert.equal(await perpetualAnimations(page), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).mcpFixture.calls), Array(3).fill({ server: "dnd-5e", location: { directory: "/fixture" } }))
    await page.evaluate(() => (window as any).mcpFixture.setStatus("serena", "failed"))
    await page.getByText("Fixture server failed", { exact: true }).waitFor()
    assert.equal(await page.locator(".status-dot.error").count(), 1)
    assert.equal(await perpetualAnimations(page), 0)
  }))
}
