import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "provider-usage-fixture", configureServer(vite) {
      vite.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await vite.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/provider-usage.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function prepare(page: Page) {
  const requests: Route[] = []
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  // Do not open any shared server/SSE connection. Events below use the real dispatcher.
  await page.addInitScript(() => {
    ;(window as any).EventSource = class {
      static OPEN = 1; readyState = 1
      addEventListener() {} removeEventListener() {} close() {}
    }
  })
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.startsWith("/api/usage/")) { requests.push(route); return }
    return route.fulfill({ contentType: "application/json", body: "{}" })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).usageFixture))
  return { requests, errors }
}
const fulfill = (route: Route, usedPercent: number) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
  requestedProviderId: "openai", providerId: "codex", providerName: "Codex", supported: true, configured: true, ok: true, fetchedAt: Date.now(),
  windows: { "5h": { usedPercent, remainingPercent: 100 - usedPercent, windowSeconds: 18000, resetAt: null } },
}) })
async function waitRequests(requests: Route[], count: number) {
  const deadline = Date.now() + 5000
  while (requests.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(requests.length, count)
}

test("rendered quota requests carry instance/session identity and stale sessions cannot publish or warm remounts", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    const first = new URL(requests[0].request().url())
    assert.equal(first.searchParams.get("instanceId"), "first")
    assert.equal(first.searchParams.get("sessionId"), "session-a")
    assert.equal(first.searchParams.get("modelId"), "gpt-5")
    await page.evaluate(() => (window as any).usageFixture.select({ instanceId: "second", sessionId: "session-b", directory: "/worktree" }))
    await waitRequests(requests, 2)
    const second = new URL(requests[1].request().url())
    assert.equal(second.searchParams.get("instanceId"), "second")
    assert.equal(second.searchParams.get("sessionId"), "session-b")
    await fulfill(requests[1], 20)
    await page.getByRole("progressbar").waitFor()
    await fulfill(requests[0], 10)
    await page.waitForTimeout(50)
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "20")
    await page.evaluate(() => (window as any).usageFixture.mounted(false))
    await page.locator("[data-usage]").waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).usageFixture.mounted(true))
    await waitRequests(requests, 3)
    assert.equal(await page.getByRole("progressbar").count(), 0, "no global warm snapshot before native account validation")
    await fulfill(requests[2], 30)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "30")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("native account events and reconnect clear old quotas; hidden panels do not fetch", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched", "another-instance"))
    assert.equal(requests.length, 1)
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 2)
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await page.evaluate(() => (window as any).usageFixture.connection("disconnected"))
    await fulfill(requests[1], 20)
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await page.evaluate(() => (window as any).usageFixture.connection("connected"))
    await waitRequests(requests, 3); await fulfill(requests[2], 30)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.active(false))
    await page.evaluate(() => (window as any).usageFixture.event("integration.updated"))
    await page.waitForTimeout(50)
    assert.equal(requests.length, 3)
    await page.evaluate(() => (window as any).usageFixture.active(true))
    await waitRequests(requests, 4); await fulfill(requests[3], 40)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "40")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
