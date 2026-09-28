import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
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
after(async () => { await browser?.close(); await server?.close() })

async function withPage(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
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
