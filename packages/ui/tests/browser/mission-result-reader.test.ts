import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap, MissionReport, MissionTask } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { missionMessages as en } from "../../src/lib/i18n/messages/en/missions"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
      cacheDir: cache.cacheDir, plugins: [solid(), { name: "mission-result-reader", configureServer(s) {
        s.middlewares.use("/mission-result-reader", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/mission-result-reader", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-result-reader.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-result-reader`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { try { await server?.close() } finally { await cache.dispose() }; throw error }
})
after(async () => { try { await browser?.close() } finally { try { await server?.close() } finally { await cache?.dispose() } } })

function snapshot() {
  const report: MissionReport = { id: "late", taskKey: "work", sessionId: "actor", createdAt: 2, outcome: "completed", late: true,
    summary: "Retained late result", next: ["Verify before publication"], evidence: ["Recorded proof"],
    artifact: { source: "x".repeat(19_000) + "RAW_TAIL" }, notificationStatus: "pending", delivery: "coordinator-notification" }
  const task: MissionTask = { id: "task", key: "work", title: "Retired review", brief: "Original brief", role: "specialist",
    status: "withdrawn", blockedBy: [], lateReports: [report], createdAt: 1, updatedAt: 2 }
  const mission: MissionMap = { version: 1, id: "mission", projectID: "project", projectCanonical: "/fixture", objective: "Original objective",
    summary: "Verified final outcome", template: "custom", coordinatorSessionId: "coordinator", status: "completed", actors: [],
    tasks: [task], reports: [], frontier: [], claims: [], revision: 2, createdAt: 1, updatedAt: 2, history: [] }
  return { available: true, projectID: "project", missions: [mission], generatedAt: 1 }
}

test("direct result reading preserves retained late sources and hides technical artifacts by default", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } }), mutations: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => {
      if (route.request().method() !== "GET") mutations.push(route.request().url())
      return route.fulfill({ json: route.request().url().includes("/missions") ? snapshot()
        : route.request().url().endsWith("/storage/config/ui") ? { settings: { locale: "en" } } : {} })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).resultReader))
    await page.evaluate(() => (window as any).resultReader.show("report", "late"))
    const reader = page.locator(".mission-reader")
    await reader.getByText("Retained late result", { exact: true }).waitFor()
    assert.deepEqual(await reader.getByRole("heading", { level: 3 }).allTextContents(), ["Summary", "Recommended next moves", "Evidence"])
    assert.equal(await reader.locator("details").evaluate(element => (element as HTMLDetailsElement).open), false)
    assert.equal(await reader.locator("pre").isVisible(), false)
    assert.equal(await reader.locator("[data-notification]").isVisible(), false)
    await reader.locator("summary").click()
    assert.equal(await reader.locator("[data-notification]").isVisible(), true)
    const artifact = reader.locator("article").filter({ has: page.getByRole("heading", { name: en["missions.control.artifact"], exact: true }) })
    const pageInput = artifact.getByRole("spinbutton")
    await pageInput.fill((await pageInput.getAttribute("max"))!)
    await artifact.getByText(/RAW_TAIL/).waitFor()
    assert((await artifact.locator("pre").textContent())!.length <= 9001)
    assert.deepEqual(mutations, [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("mission outcome precedes the original objective in the overview reader", async () => {
  const page = await browser.newPage()
  try {
    await page.route("**/api/**", route => route.fulfill({ json: route.request().url().includes("/missions") ? snapshot()
      : route.request().url().endsWith("/storage/config/ui") ? { settings: { locale: "en" } } : {} }))
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).resultReader))
    await page.evaluate(() => (window as any).resultReader.show("overview"))
    const reader = page.locator(".mission-reader")
    await reader.getByText("Verified final outcome", { exact: true }).waitFor()
    assert.deepEqual(await reader.getByRole("heading", { level: 3 }).allTextContents(), ["Summary", "Objective"])
  } finally { await page.close() }
})

test("a historical non-late report is explicitly identified as a previous attempt", async () => {
  const page = await browser.newPage(), value = snapshot()
  value.missions[0].tasks[0].lateReports![0].late = false
  try {
    await page.route("**/api/**", route => route.fulfill({ json: route.request().url().includes("/missions") ? value
      : route.request().url().endsWith("/storage/config/ui") ? { settings: { locale: "en" } } : {} }))
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).resultReader))
    await page.evaluate(() => (window as any).resultReader.show("report", "late"))
    const reader = page.locator(".mission-reader")
    await reader.getByText(en["missions.progress.previousAttempt"], { exact: true }).waitFor()
    await reader.getByText("Retained late result", { exact: true }).waitFor()
    assert.equal(await reader.locator("details").evaluate(element => (element as HTMLDetailsElement).open), false)
  } finally { await page.close() }
})
