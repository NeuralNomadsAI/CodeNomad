import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "reasoning-collapse", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/reasoning-collapse.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function checkCollapsed(page: Page, collapsed: boolean, count: number) {
  await page.waitForFunction(({ collapsed, count }) => document.querySelectorAll(".message-reasoning-text").length === (collapsed ? 0 : count), { collapsed, count })
  const header = page.locator(count === 1 ? ".message-reasoning-toggle" : ".message-reasoning-group .message-technical-group-toggle")
  assert.equal(await header.getAttribute("aria-expanded"), String(!collapsed))
  assert.equal(await page.getByText("The visible response stays readable.", { exact: true }).isVisible(), true)
}

for (const count of [1, 2]) test(`${count} reasoning step(s) respect collapse, expand and hide filters beside response content`, async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, locale: "en-US" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(`${url}?steps=${count}`, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.getByText("The visible response stays readable.", { exact: true }).waitFor()
    await checkCollapsed(page, true, count)
    await page.getByRole("button", { name: "Message content", exact: true }).click()
    const filters = page.locator(".transcript-filters")
    await filters.getByRole("button", { name: "Expand thinking", exact: true }).click()
    await checkCollapsed(page, false, count)
    await filters.getByRole("button", { name: "Collapse thinking", exact: true }).click()
    await checkCollapsed(page, true, count)
    await page.evaluate(() => (window as any).fixture.reload())
    await checkCollapsed(page, true, count)
    await filters.getByRole("button", { name: "Hide thinking", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector(".message-reasoning-card, .message-reasoning-group"))
    assert.equal(await page.getByText("The visible response stays readable.", { exact: true }).isVisible(), true)
    await filters.getByRole("button", { name: "Show thinking", exact: true }).click()
    await checkCollapsed(page, true, count)
    await page.keyboard.press("Escape")
    const header = page.locator(count === 1 ? ".message-reasoning-toggle" : ".message-reasoning-group .message-technical-group-toggle")
    await header.click()
    await checkCollapsed(page, false, count)
    await header.click()
    await checkCollapsed(page, true, count)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
