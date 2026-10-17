import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "sidecar-sandbox-fixture", configureServer(s) {
      s.middlewares.use("/sidecar-sandbox-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/sidecar-sandbox-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/sidecar-sandbox.tsx"></script></body></html>'))
      })
      for (const path of ["/sidecars/fixture", "/sidecar-sandbox-guest"]) {
        s.middlewares.use(path, (_req: unknown, res: { setHeader(k: string, v: string): void; end(body: string): void }) => {
          res.setHeader("Content-Type", "text/html")
          res.end("<html><body>Sandbox fixture</body></html>")
        })
      }
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, allowedHosts: ["insecure.test"], hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/sidecar-sandbox-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const sandboxTokens = async (page: Page, selector: string): Promise<string[]> =>
  (await page.locator(`${selector} iframe`).evaluate((frame) =>
    (frame.getAttribute("sandbox") ?? "").split(" ").filter(Boolean))) as string[]

test("SideCar frames stay same-origin while preview frames remain isolated", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.locator("#sidecar-root iframe").waitFor()
    await page.locator("#preview-root iframe").waitFor()

    const sidecarSandbox = await sandboxTokens(page, "#sidecar-root")
    assert.deepEqual(
      new Set(sidecarSandbox),
      new Set(["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-downloads", "allow-same-origin"]),
    )

    const previewSandbox = new Set(await sandboxTokens(page, "#preview-root"))
    assert.equal(previewSandbox.has("allow-same-origin"), false)
    assert.equal(previewSandbox.has("allow-scripts"), true)
  } finally {
    await page.close()
  }
})
