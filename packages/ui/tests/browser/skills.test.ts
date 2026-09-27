import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "skills-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/skills.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("skills attach once through the @ menu with a removable badge", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 700 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    // No dedicated Skills button or dialog: the @ menu is the only entry point.
    assert.equal(await page.getByRole("button", { name: "Skills", exact: true }).count(), 0)
    assert.equal(await page.getByRole("dialog").count(), 0)
    const textarea = page.locator(".prompt-input-container textarea").first()
    await textarea.fill("@rev")
    await page.waitForFunction(() => (window as any).fixture.pending().length === 1)
    await page.evaluate(() => (window as any).fixture.resolve(0, "review"))
    await page.locator(".dropdown-item", { hasText: "review" }).first().click()
    await page.waitForFunction(() => (window as any).fixture.selected().length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected()), [{ type: "skill", id: "review", name: "review" }])
    // The @query token is dropped when the badge attaches.
    assert.ok(!(await textarea.inputValue()).includes("@rev"))
    await page.getByText("Review", { exact: true }).waitFor()
    // Selecting the same skill again does not duplicate the badge.
    await textarea.fill("@rev")
    await page.locator(".dropdown-item", { hasText: "review" }).first().click()
    assert.equal((await page.evaluate(() => (window as any).fixture.selected())).length, 1)
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    if (process.env.CODENOMAD_SKILLS_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_SKILLS_CAPTURE, fullPage: true })
    await page.getByRole("button", { name: "Remove skill review" }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected()), [])
    // The retired /skills shortcut no longer opens a picker or reads the catalog.
    const readsBefore = await page.evaluate(() => (window as any).fixture.pending().length)
    await textarea.fill("/skills")
    await page.waitForTimeout(300)
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.pending().length), readsBefore)
    assert.equal(await textarea.inputValue(), "/skills")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
