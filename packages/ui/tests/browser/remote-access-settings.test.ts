import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "remote-access-fixture", configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/remote-access-settings.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("direct access stays collapsed behind Remote Control until the user opens it", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    const summary = page.locator("summary.remote-direct-access-summary")
    await summary.getByText("Direct access (local network, advanced)", { exact: true }).waitFor()
    const listening = page.getByText("Listening mode", { exact: true })
    assert.equal(await listening.isVisible(), false)
    await summary.click()
    await listening.waitFor()
    await page.getByText("Direct connections from other devices sign in with this password. Remote Control pairs devices instead.", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("direct access opens by itself while the server listens beyond localhost", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(`${url}?mode=all`)
    await page.getByText("Listening mode", { exact: true }).waitFor()
    assert.equal(await page.locator("details.remote-direct-access").evaluate((node) => (node as HTMLDetailsElement).open), true)
  } finally { await page.close() }
})
