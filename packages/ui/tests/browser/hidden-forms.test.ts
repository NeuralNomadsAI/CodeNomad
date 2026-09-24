import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "hidden-forms-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/hidden-forms.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("session and provider Forms hide protocol inputs but submit their defaults", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    for (const name of ["Session form", "Provider form"]) {
      const form = page.getByRole("form", { name })
      assert.equal(await form.locator("input").count(), 1, "hidden fields must not be mounted or focusable")
      assert.equal(await form.getByText("Hidden tenant").count(), 0)
      await form.getByRole("textbox", { name: "Name" }).fill("Alice")
      await form.locator('button[type="submit"]').click()
    }
    assert.deepEqual(await page.evaluate(() => (window as any).fixture), {
      replies: [{ name: "Alice", tenant: "native-tenant", flag: false }],
      authReplies: [{ name: "Alice", tenant: "native-tenant", flag: false }],
    })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
