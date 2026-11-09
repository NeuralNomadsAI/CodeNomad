import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { createFixtureCache } from "./fixture-cache"

const root = fileURLToPath(new URL("../..", import.meta.url))
let server: ViteDevServer, browser: Browser, baseUrl: string
let fixtureCache: Awaited<ReturnType<typeof createFixtureCache>> | undefined
before(async () => {
  fixtureCache = await createFixtureCache()
  const shutdown = createFixtureShutdown(fixtureCache)
  server = await createServer({
    cacheDir: fixtureCache.cacheDir,
    configFile: false, root, logLevel: "error", plugins: [shutdown.plugin, solid(), {
      name: "browser-fixture",
      configureServer(server) {
        server.middlewares.use("/fixture", async (req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await server.transformIndexHtml("/fixture", `<html><body><div id="root" style="display:flex;height:700px;width:1100px"></div><script type="module" src="/tests/browser/fixtures/session.tsx"></script></body></html>`))
        })
      },
    }],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  baseUrl = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close(); await fixtureCache?.dispose() })

async function open(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.endsWith("/permission-receipts")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ receipts: [] }) })
    }
    return route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "" })
  })
  await runWithDiagnosticCleanup({
    run: async () => {
      await page.goto(`${baseUrl}/fixture`)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      await run(page)
      assert.deepEqual(errors, [])
    },
    diagnose: async () => {
      console.error("Browser fixture failure", await page.evaluate(() => ({
        state: (window as any).fixture?.snapshot?.(),
      })))
    },
    cleanup: () => page.close(),
    onObservationError: error => console.error("Browser fixture diagnostic capture failed", error),
    onCleanupError: error => console.error("Browser fixture cleanup failed", error),
  })
}

/** The prompt-queue action row shows while the engine still holds the prompt parked. */
function pendingActions(page: Page, marker: string) {
  return page.locator(".message-stream-block").filter({ hasText: marker })
    .locator('button[aria-label="Move to queue"], button[aria-label="Steer now"]')
}
/** DOM order of the transcript rows, as the reader sees them. */
async function rowOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll(".message-stream-block"))
    .map(row => row.textContent ?? ""))
}

async function assertPromptAboveReply(page: Page, marker: string, reply: string) {
  const rows = await rowOrder(page)
  const promptIndex = rows.findIndex(row => row.includes(marker))
  const replyIndex = rows.findIndex(row => row.includes(reply))
  assert.ok(promptIndex >= 0, `the delivered prompt must render (rows: ${JSON.stringify(rows.map(row => row.slice(0, 40)))})`)
  assert.ok(replyIndex >= 0, `the streaming reply must render (rows: ${JSON.stringify(rows.map(row => row.slice(0, 40)))})`)
  assert.ok(promptIndex < replyIndex, `the delivered prompt must sit above its reply, got prompt at ${promptIndex} and reply at ${replyIndex} of ${rows.length} rows`)
}

test("another client's prompt keeps its place above the reply once the engine admits it", async () => {
  await open(async page => {
    const marker = "Prompt from the other terminal"
    // The daemon parks the prompt in the inbox and starts the execution before
    // admission; the delivered event lands before the first model step.
    await page.evaluate(text => (window as any).fixture.remoteEnqueue("msg_remote", text), marker)
    await pendingActions(page, marker).first().waitFor()
    await page.evaluate(() => (window as any).fixture.remoteDeliver("msg_remote"))
    await pendingActions(page, marker).waitFor({ state: "detached", timeout: 3000 })
    const reply = "Reply marker admitted first"
    await page.evaluate(reply => { (window as any).fixture.start(); (window as any).fixture.delta(reply) }, reply)
    await page.locator(".message-stream-block").filter({ hasText: reply }).waitFor()
    await assertPromptAboveReply(page, marker, reply)
  })
})

test("a delivered prompt admitted after the reply started streaming does not sink below it", async () => {
  await open(async page => {
    const marker = "Steered prompt admitted late"
    await page.evaluate(text => (window as any).fixture.remoteEnqueue("msg_late", text), marker)
    await pendingActions(page, marker).first().waitFor()
    // Admission lands while the reply is already streaming on the same session.
    const reply = "Streaming reply before admission"
    await page.evaluate(reply => { (window as any).fixture.start(); (window as any).fixture.delta(reply) }, reply)
    await page.locator(".message-stream-block").filter({ hasText: reply }).waitFor()
    await page.evaluate(() => (window as any).fixture.remoteDeliver("msg_late"))
    await pendingActions(page, marker).waitFor({ state: "detached", timeout: 3000 })
    await assertPromptAboveReply(page, marker, reply)
    // It stays put while the reply keeps streaming.
    await page.evaluate(more => (window as any).fixture.delta(more), " more streamed text")
    await page.waitForTimeout(300)
    await assertPromptAboveReply(page, marker, reply)
  })
})
