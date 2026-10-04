import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
    cacheDir: cache.cacheDir, logLevel: "error", plugins: [solid(), {
      name: "mission-visibility-fixture", configureServer(s) {
        s.middlewares.use("/mission-visibility", async (_request, response) => {
          response.setHeader("Content-Type", "text/html")
          response.end(await s.transformIndexHtml("/mission-visibility", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-visibility.tsx"></script></body></html>'))
        })
      },
    }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-visibility`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { try { await browser?.close(); await server?.close() } finally { await cache?.dispose() } })
const call = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) =>
  (window as any).missionVisibility[method](arg), { method, arg })

test("actual mounted RightPanel suspends hidden Mission demand and refreshes native status only when visible", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let requests = 0
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions", route => {
      requests += 1
      return route.fulfill({ json: { available: true, version: 1, projectID: "fixture", missions: [],
        generatedAt: requests, discardedEvents: 0, activity: { generatedAt: requests, missions: [] } } })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    assert.equal(await page.locator(".mission-control").count(), 1, "Missions is mounted, not unmounted to simulate hiding")
    assert.deepEqual(await call(page, "demanded"), [])
    await call(page, "event", "session.status")
    await page.waitForTimeout(120)
    assert.equal(requests, 0)

    const shown = page.waitForResponse(response => response.url().endsWith("/missions"))
    await call(page, "activate", true)
    await shown
    await page.waitForFunction(() => (window as any).missionVisibility.state().status !== "loading")
    assert.equal((await call(page, "state")).status, "ready", JSON.stringify(await call(page, "state")))
    assert.match(await page.locator(".mission-control").innerText(), /No missions yet/)
    assert.equal(requests, 1, "loading/ready state does not retrigger visibility demand")
    assert.deepEqual(await call(page, "demanded"), ["mission-visibility"])
    const status = page.waitForResponse(response => response.url().endsWith("/missions"))
    await call(page, "event", "session.status")
    await status
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.equal(requests, 2)
    await call(page, "event", "session.text.delta")
    await page.waitForTimeout(120)
    assert.equal(requests, 2)

    // Cancel an already-scheduled invalidation on hide, then another hidden event.
    await call(page, "event", "session.status")
    await call(page, "activate", false)
    await call(page, "event", "session.execution.started")
    await page.waitForTimeout(120)
    assert.equal(requests, 2)
    assert.equal(await page.locator(".mission-control").count(), 1)
    assert.deepEqual(await call(page, "demanded"), [])
    const restored = page.waitForResponse(response => response.url().endsWith("/missions"))
    await call(page, "activate", true)
    await restored
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.equal(requests, 3)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
