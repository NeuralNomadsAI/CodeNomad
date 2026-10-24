import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "session-preview-sandbox-fixture", configureServer(s) {
      s.middlewares.use("/session-preview-sandbox-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/session-preview-sandbox-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-preview-sandbox.tsx"></script></body></html>'))
      })
      s.middlewares.use("/previews/fixture-session-loopback", (_req: unknown, res: { setHeader(k: string, v: string): void; end(body: string): void }) => {
        res.setHeader("Content-Type", "text/html")
        res.end("<html><body>Loopback preview fixture</body></html>")
      })
      s.middlewares.use("/previews/fixture-session-external", (_req: unknown, res: { setHeader(k: string, v: string): void; end(body: string): void }) => {
        res.setHeader("Content-Type", "text/html")
        res.end("<html><body>External preview fixture</body></html>")
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, allowedHosts: ["insecure.test"], hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/session-preview-sandbox-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const sandboxTokens = async (page: Page, selector: string): Promise<string[]> =>
  (await page.locator(`${selector} iframe`).evaluate((frame) =>
    (frame.getAttribute("sandbox") ?? "").split(" ").filter(Boolean))) as string[]

test("session preview frames are same-origin only for loopback targets", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.locator("#loopback-preview-root iframe").waitFor({ state: "attached" })
    await page.locator("#external-preview-root iframe").waitFor({ state: "attached" })

    const loopbackSandbox = new Set(await sandboxTokens(page, "#loopback-preview-root"))
    assert.deepEqual(
      loopbackSandbox,
      new Set(["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-downloads", "allow-same-origin"]),
    )

    const externalSandbox = new Set(await sandboxTokens(page, "#external-preview-root"))
    assert.equal(externalSandbox.has("allow-same-origin"), false)
    assert.equal(externalSandbox.has("allow-scripts"), true)
  } finally {
    await page.close()
  }
})
