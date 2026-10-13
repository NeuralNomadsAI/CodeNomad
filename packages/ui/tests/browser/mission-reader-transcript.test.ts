import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  const shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-session-fixture", configureServer(s) {
      s.middlewares.use("/mission-session-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-session-fixture", '<html><body><div id="root" style="display:flex;height:100vh"></div><script type="module" src="/tests/browser/fixtures/mission-session.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-session-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function open(missions: unknown[]) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1000, height: 800 } })
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(90_000)
  page.on("pageerror", error => console.error("fixture error", error))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.route("**/api/workspaces/browser-instance/missions", route => route.fulfill({ json: { available: true, missions, generatedAt: 1, discardedEvents: 0 } }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return page
}
/** History rows actually painted inside the stream viewport. */
const paintedHistory = (page: Page) => page.evaluate(() => {
  const stream = document.querySelector(".message-stream") as HTMLElement
  const box = stream.getBoundingClientRect()
  return [...stream.querySelectorAll("p")].filter(el => {
    const r = el.getBoundingClientRect()
    return r.height > 0 && r.bottom > box.top && r.top < box.bottom && /^History \d+$/.test(el.textContent ?? "")
  }).map(el => el.textContent)
})

test("a reader for a Mission absent from the loaded map releases the transcript instead of hiding it", async () => {
  const page = await open([])
  try {
    await page.evaluate(() => (window as any).fixture.seedHistory())
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.waitForFunction(() => !document.querySelector(".mission-reader")
      && !document.querySelector(".mission-transcript-content")?.hasAttribute("inert"))
    assert.equal(await page.locator(".mission-transcript-content").evaluate(el => getComputedStyle(el).visibility), "visible")
    assert.ok((await paintedHistory(page)).includes("History 59"))
  } finally { await page.close() }
})

test("history loaded beneath a reader is followed to its latest message once the reader closes", async () => {
  const page = await open([{ version: 1, id: "reader", projectID: "project", projectCanonical: "/fixture", objective: "Objective", template: "custom",
    coordinatorSessionId: "ses_fixture", status: "active", actors: [], frontier: [], claims: [], revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false,
    tasks: [{ id: "task", key: "task-one", title: "Inspect", brief: "Brief", role: "research", status: "completed", blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }],
    reports: [{ id: "report-reader", taskKey: "task-one", sessionId: "ses_fixture", outcome: "completed", summary: "Report opening paragraph.", evidence: [], next: [], createdAt: 1 }] }])
  try {
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.locator(".mission-reader").getByText("Report opening paragraph.", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).fixture.seedHistory())
    assert.equal(await page.locator(".mission-transcript-content").getAttribute("inert"), "")
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll(".message-stream p")].some(el => {
      const r = el.getBoundingClientRect(), box = document.querySelector(".message-stream")!.getBoundingClientRect()
      return el.textContent === "History 59" && r.height > 0 && r.top < box.bottom && r.bottom > box.top
    }))
  } finally { await page.close() }
})
