import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "websearch-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/websearch.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("web result cards retain safe links, literal snippets, fallback and native consent submission", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.locator(".websearch-results").waitFor()
    assert.equal(await page.getByRole("link", { name: "Native result" }).getAttribute("href"), "https://example.org/article")
    assert.match(await page.locator(".websearch-results").innerText(), /<script>literal snippet<\/script>/)
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.getByRole("radio", { name: "Choose another provider" }).check()
    await page.getByRole("button", { name: "Submit", exact: true }).click()
    assert.equal(await page.locator("output").innerText(), '{"choice":"choose"}')
    if (process.env.CODENOMAD_WEBSEARCH_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_WEBSEARCH_CAPTURE, fullPage: true })
    await page.evaluate(() => (window as any).fixture.setOutput("Unknown provider response"))
    await page.getByText("Unknown provider response", { exact: true }).waitFor()
    assert.equal(await page.locator(".websearch-results").count(), 0)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error(errors, await page.locator("main").innerText())
    throw error
  } finally { await page.close() }
})
