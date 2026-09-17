import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "permission-fixture", configureServer(s) {
      s.middlewares.use("/permission-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/permission-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/permission-feedback.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/permission-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("rejection feedback survives same-request refreshes and resets for a new request", async () => {
  const page = await browser.newPage()
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(url)
    const reason = page.locator("textarea")
    await reason.fill("  Ne supprime pas les fichiers.\nLis-les seulement.  ")
    await page.locator("#refresh").click()
    assert.equal(await reason.inputValue(), "  Ne supprime pas les fichiers.\nLis-les seulement.  ")
    await page.locator(".tool-call-permission-button").last().click()
    assert.deepEqual(JSON.parse(await page.locator("#result").innerText()), {
      reply: "reject", message: "Ne supprime pas les fichiers.\nLis-les seulement.",
    })
    await page.locator("#next").click()
    assert.equal(await reason.inputValue(), "")
  } finally { await page.close() }
})
