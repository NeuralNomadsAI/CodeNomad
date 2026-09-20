import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string

before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error",
    plugins: [solid(), { name: "plugin-controls-fixture", configureServer(vite) {
      vite.middlewares.use("/fixture", async (_request, response) => {
        response.setHeader("Content-Type", "text/html")
        response.end(await vite.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/plugin-controls.tsx"></script></body></html>'))
      })
    } }],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

test("V2 plugin controls keep runtime and configured state distinct and write an explicit scope", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(url)

  await page.getByText("Runtime inventory", { exact: true }).waitFor()
  await page.getByText("Configured entries", { exact: true }).waitFor()
  await page.getByText("Package: @acme/reviewer", { exact: true }).waitFor()
  await page.getByText("Options", { exact: true }).waitFor()
  await page.getByText("Configured but not running", { exact: true }).waitFor()
  assert.equal(await page.getByRole("switch").count(), 3)
  assert.equal(await page.getByRole("switch").first().isDisabled(), true)
  await page.getByText("Choose Global or Project before changing a plugin.", { exact: true }).waitFor()

  const scopeOption = page.getByRole("radio", { name: /Project/ })
  await scopeOption.click()
  assert.equal(await scopeOption.getAttribute("aria-checked"), "true")
  const sleeping = page.locator('[data-plugin-id="sleeping.plugin"]')
  const toggle = sleeping.getByRole("switch")
  assert.equal(await toggle.getAttribute("aria-checked"), "false")
  await toggle.click()
  await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => (
    call.type === "mutation" && call.pluginId === "sleeping.plugin"
      && call.scope === "project" && call.enabled === true
  )))
  assert.equal(await toggle.getAttribute("aria-checked"), "true")
  await sleeping.getByText("Configured on", { exact: true }).waitFor()

  const squareCorners = await page.evaluate(() => {
    const scope = document.querySelector(".plugin-scope-option")!
    const toggle = document.querySelector(".plugin-activation-switch")!
    return [getComputedStyle(scope).borderRadius, getComputedStyle(toggle).borderRadius]
  })
  assert.deepEqual(squareCorners, ["0px", "0px"])

  await page.evaluate(() => (window as any).fixture.activateSleepingPlugin())
  await page.getByText("Package: sleeping-package", { exact: true }).waitFor()
  const burstReads = await page.evaluate(() => (window as any).fixture.eventBurst())
  assert.equal(burstReads, 2, "an in-flight event burst must coalesce into one trailing refresh")
  assert.deepEqual(errors, [])
  await page.close()
})
