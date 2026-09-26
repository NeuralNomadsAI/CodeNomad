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

test("skills are Location-scoped, removable and fence stale catalog responses", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 700 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    assert.equal(await page.getByRole("button", { name: "Skills", exact: true }).count(), 0)
    const openSkills = async () => {
      await page.locator(".prompt-input-container textarea").first().fill("/skills")
      await page.locator(".send-button").click()
    }
    await openSkills()
    await page.waitForFunction(() => (window as any).fixture.pending().length === 1)
    await page.evaluate(() => (window as any).fixture.setSession("b"))
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    await openSkills()
    await page.waitForFunction(() => (window as any).fixture.pending().length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.pending()), ["/a", "/b"])
    await page.evaluate(() => { (window as any).fixture.resolve(1, "current"); (window as any).fixture.resolve(0, "stale") })
    await page.getByRole("combobox", { name: "Skills" }).selectOption("current")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected()), [{ type: "skill", id: "current", name: "current" }])
    assert.equal(await page.locator('option[value="stale"]').count(), 0)
    await page.getByRole("combobox", { name: "Skills" }).selectOption("current")
    assert.equal((await page.evaluate(() => (window as any).fixture.selected())).length, 1)
    await page.getByText("Review", { exact: true }).waitFor()
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    if (process.env.CODENOMAD_SKILLS_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_SKILLS_CAPTURE, fullPage: true })
    await page.getByRole("button", { name: "Remove skill current" }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected()), [])
    await page.evaluate(() => { for (let i = 0; i < 3; i++) (window as any).fixture.invalidate() })
    assert.equal((await page.evaluate(() => (window as any).fixture.pending())).length, 3)
    await page.evaluate(() => (window as any).fixture.resolve(2, "outdated"))
    await page.waitForFunction(() => (window as any).fixture.pending().length === 4)
    assert.equal(await page.locator('option[value="outdated"]').count(), 0)
    await page.evaluate(() => (window as any).fixture.setActive(false))
    await page.evaluate(() => { (window as any).fixture.resolve(3, "late"); (window as any).fixture.invalidate() })
    assert.equal(await page.getByRole("combobox").count(), 0)
    assert.equal((await page.evaluate(() => (window as any).fixture.pending())).length, 4)
    assert.deepEqual(await page.evaluate(() => [(window as any).fixture.sends, (window as any).fixture.commands]), [[], []])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
