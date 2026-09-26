import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "web-settings-fixture", configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/websearch-settings.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
test("web settings use explicit scopes, native keys, no mutation replay and fence late writes", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 1000 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.getByLabel("Project", { exact: true }).selectOption("off")
    await page.getByText("Effective configuration: Disabled", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes), [{ location: { directory: "/a" }, scope: "project", provider: false }])
    await page.evaluate(() => (window as any).fixture.reject())
    await page.getByLabel("Project", { exact: true }).selectOption("default")
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByLabel("Project", { exact: true }).inputValue(), "off")
    assert.equal((await page.evaluate(() => (window as any).fixture.writes)).length, 2)
    await page.getByLabel("Web search provider", { exact: true }).selectOption("alpha")
    await page.getByLabel("API key", { exact: true }).fill("fixture-secret")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.waitForFunction(() => (document.querySelector('input[type="password"]') as HTMLInputElement)?.value === "")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.keys), [{ integrationID: "alpha", key: "fixture-secret" }])
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    if (process.env.CODENOMAD_WEB_SETTINGS_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_WEB_SETTINGS_CAPTURE, fullPage: true })
    await page.evaluate(() => (window as any).fixture.hold())
    await page.getByLabel("Global", { exact: true }).selectOption("provider:random")
    await page.evaluate(() => (window as any).fixture.setDirectory("/b"))
    await page.getByText("Effective configuration: Alpha", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).fixture.release())
    assert.equal(await page.getByLabel("Global", { exact: true }).inputValue(), "provider:alpha")
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error(errors, await page.locator("body").innerText())
    throw error
  } finally { await page.close() }
})
