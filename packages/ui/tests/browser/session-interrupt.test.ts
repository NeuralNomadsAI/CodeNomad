import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "interrupt-fixture", configureServer(s) {
      s.middlewares.use("/interrupt-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/interrupt-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-interrupt.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/interrupt-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

for (const gesture of ["button", "double Escape"] as const) {
  test(`${gesture} interrupts only the selected session using the TUI request`, async () => {
    const page = await browser.newPage({ locale: "en-US" })
    const requests: string[] = [], errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith("/interrupt")) {
        requests.push(url.pathname + url.search)
        return route.fulfill({ json: { interrupted: true } })
      }
      return route.fulfill({ json: {} })
    })
    try {
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      for (const id of ["ses_parent", "ses_child"]) {
        await page.evaluate(id => (window as any).fixture.select(id), id)
        const response = page.waitForResponse(response => response.url().includes(`/api/session/${id}/interrupt`))
        if (gesture === "button") await page.getByRole("button", { name: "Stop session", exact: true }).click()
        else {
          await page.locator("textarea").first().focus()
          await page.keyboard.press("Escape")
          assert.equal(requests.length, id === "ses_parent" ? 0 : 1)
          await page.keyboard.press("Escape")
        }
        await response
      }
      assert.deepEqual(requests, ["ses_parent", "ses_child"].map(id => `/workspaces/interrupt-instance/instance/api/session/${id}/interrupt?resume=true`))
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}
