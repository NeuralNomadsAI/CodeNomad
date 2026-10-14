import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: cache.cacheDir,
    plugins: [solid(), { name: "task-copy-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/task-copy.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })

async function withPage(run: (page: Page) => Promise<void>, scenario?: string) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(scenario ? `${url}?steps=${scenario}` : url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Task-copy fixture failure", errors, await page.evaluate(() => ({
      state: (window as any).fixture?.snapshot(),
      text: document.querySelector("main")?.textContent?.slice(0, 2500),
      tools: Array.from(document.querySelectorAll(".tool-call")).slice(0, 5).map(element => ({
        part: element.getAttribute("data-part-id"), expanded: element.querySelector(".tool-call-header-toggle")?.getAttribute("aria-expanded"),
      })),
    })))
    throw error
  } finally { await page.close() }
}

test("short native child boundary cursor does not invent render overflow", { timeout: 45_000 }, async () => withPage(async page => {
  const tool = page.locator('.tool-call[data-part-id="parent-task"]')
  const sections = tool.locator('.tool-call-task-sections').first()
  const steps = sections.locator(':scope > section').filter({ has: page.locator('.tool-call-task-section-title', { hasText: /^Steps$/ }) })
  await steps.waitFor()
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "1 steps")
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
  assert.match(await sections.textContent() ?? "", /Validated result:.*484/)
  const state = await page.evaluate(() => (window as any).fixture.snapshot())
  assert.equal(state.requests.filter((request: any) => request.sessionID === "child").length, 1)
  // The cursor is merely a boundary token: a bounded older read is empty.
  await page.evaluate(() => (window as any).fixture.probeOlder())
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "1 steps")
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).requests.filter((request: any) => request.sessionID === "child").length, 2)
}, "short"))

test("exactly 200 observed child rows are not render overflow", { timeout: 45_000 }, async () => withPage(async page => {
  const sections = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-sections').first()
  const steps = sections.locator(':scope > section').filter({ has: page.locator('.tool-call-task-section-title', { hasText: /^Steps$/ }) })
  await steps.waitFor()
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "200 steps")
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
  assert.equal(await steps.locator('.tool-call-task-summary > .tool-call').count(), 200)
}, "limit"))

test("text-only latest child window exposes full-history steps copy without claiming overflow", { timeout: 45_000 }, async () => withPage(async page => {
  const sections = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-sections').first()
  const steps = sections.locator(':scope > section').filter({ has: page.locator('.tool-call-task-section-title', { hasText: /^Steps$/ }) })
  await steps.waitFor()
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "0 steps")
  assert.equal(await steps.locator('.tool-call-task-summary > .tool-call').count(), 0)
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).requests.filter((request: any) => request.sessionID === "child").length, 1)
  await steps.getByRole("button", { name: "Copy tool output" }).click()
  await page.waitForFunction(() => (window as any).fixture.snapshot().clipboard.length === 1)
  const state = await page.evaluate(() => (window as any).fixture.snapshot())
  const copied = JSON.parse(state.clipboard[0])
  assert.equal(copied.length, 1)
  assert.equal(copied[0].id, "child-0000-tool")
  assert.equal(copied[0].state.output, `Untruncated child-0000: ${"長い output\n".repeat(500)}`)
  assert.equal(state.requests.filter((request: any) => request.ascending && request.sessionID === "child").length, 2)
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
}, "text-tail"))

test("observed 201 child rows retain capped count and real truncation warning", { timeout: 45_000 }, async () => withPage(async page => {
  const sections = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-sections').first()
  const steps = sections.locator(':scope > section').filter({ has: page.locator('.tool-call-task-section-title', { hasText: /^Steps$/ }) })
  await steps.waitFor()
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "200+ steps")
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 1)
  assert.equal(await steps.locator('.tool-call-task-summary > .tool-call').count(), 200)
  assert.match(await steps.locator('.tool-call-diagnostic-message').textContent() ?? "", /200/)
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).requests.filter((request: any) => request.sessionID === "child").length, 1)
}, "overflow"))

async function copyButton(page: Page, nested: boolean) {
  const tool = page.locator(`.tool-call[data-part-id="${nested ? "nested-task" : "parent-task"}"]`)
  const toggle = tool.locator(":scope > .tool-call-header > .tool-call-header-toggle")
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click()
  return tool.locator(".tool-call-task-sections").first()
    .locator(":scope > section > header .tool-call-io-actions > button").first()
}

test("nested task copies inherit the active parent conversation rather than selected child identity", { timeout: 45_000 }, async () => withPage(async page => {
  const button = await copyButton(page, true)
  await button.click()
  await page.waitForFunction(() => (window as any).fixture.snapshot().clipboard.length === 1)
  const state = await page.evaluate(() => (window as any).fixture.snapshot())
  assert.equal(state.selectedSession, "parent")
  const copied = JSON.parse(state.clipboard[0])
  assert.equal(copied.length, 230)
  assert.equal(copied[0].state.output, `Untruncated grandchild-0000: ${"長い output\n".repeat(500)}`)
  assert.equal(copied.at(-1).id, "grandchild-0229-tool")
  assert.equal(state.requests.filter((request: any) => request.ascending && request.sessionID === "grandchild").length, 2)
}))

for (const scenario of ["parent-session", "parent-instance", "nested-session", "nested-instance", "nested-unmount"] as const) {
  test(`${scenario} lifecycle cancels held full-copy reads and fences late clipboard writes`, { timeout: 45_000 }, async () => withPage(async page => {
    const nested = scenario.startsWith("nested")
    const sessionID = nested ? "grandchild" : "child"
    const button = await copyButton(page, nested)
    await page.evaluate(() => (window as any).fixture.hold())
    await button.click()
    await page.waitForFunction(sessionID => (window as any).fixture.snapshot().requests.some((request: any) =>
      request.ascending && request.sessionID === sessionID), sessionID)
    assert.equal(await button.isDisabled(), true)
    await page.evaluate(scenario => {
      const fixture = (window as any).fixture
      if (scenario.endsWith("instance")) fixture.setActiveInstance(false)
      else if (scenario.endsWith("unmount")) fixture.unmount()
      else fixture.selectSession("other")
    }, scenario)
    await page.waitForFunction(sessionID => (window as any).fixture.snapshot().requests.some((request: any) =>
      request.ascending && request.sessionID === sessionID && request.aborted), sessionID)
    await page.evaluate(() => (window as any).fixture.release())
    // Let the deliberately late transport response and consumer finalizers run.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.deepEqual(state.clipboard, [])
    assert.equal(state.requests.filter((request: any) => request.ascending && request.sessionID === sessionID).length, 1)
  }))
}
