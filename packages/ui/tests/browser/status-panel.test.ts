import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "status-fixture", configureServer(s) {
      s.middlewares.use("/status-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/status-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/status-panel.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/status-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("Tokens can be collapsed, hidden and restored across reloads with legacy Plan customization", async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.addInitScript(() => {
    localStorage.setItem("opencode-session-right-panel-tab-v2", "status")
    const key = "opencode-session-right-panel-customization-v1"
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      statusSectionOrder: ["plan", "yolo-mode", "provider-usage"], hiddenStatusSectionIds: ["plan"],
    }))
  })
  try {
    await page.goto(url)
    const tokens = page.getByRole("button", { name: "Tokens", exact: true })
    const metrics = page.locator(".session-context-panel")
    await metrics.waitFor({ state: "visible" })
    assert.equal(await page.getByRole("button", { name: "Plan", exact: true }).count(), 0)
    await tokens.click()
    await metrics.waitFor({ state: "hidden" })
    await tokens.click()
    await metrics.waitFor({ state: "visible" })

    const customize = page.getByRole("button", { name: "Customize right panel", exact: true })
    await customize.click()
    assert.equal(await page.getByRole("checkbox", { name: "Plan", exact: true }).count(), 0)
    await page.getByRole("checkbox", { name: "Tokens", exact: true }).uncheck()
    await metrics.waitFor({ state: "detached" })
    assert.equal(await tokens.count(), 0)
    assert.ok(await page.evaluate(() => (window as any).statusFixture.customization().hiddenStatusSectionIds.includes("tokens")))

    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).statusFixture))
    assert.equal(await tokens.count(), 0)
    await customize.click()
    assert.equal(await page.getByRole("checkbox", { name: "Tokens", exact: true }).isChecked(), false)
    await page.getByRole("checkbox", { name: "Tokens", exact: true }).check()
    await page.keyboard.press("Escape")
    await metrics.waitFor({ state: "visible" })
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Status fixture failure", errors, await page.locator("body").innerText())
    throw error
  } finally { await page.close() }
})
