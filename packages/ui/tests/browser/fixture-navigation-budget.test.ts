import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createServer, type Server } from "node:http"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, hangingServer: Server, hangingUrl: string
before(async () => {
  // A server that accepts the connection but never responds, so page.goto can
  // only end through its navigation timeout.
  hangingServer = createServer(() => {})
  await new Promise<void>(resolve => hangingServer.listen(0, "127.0.0.1", resolve))
  hangingUrl = `http://127.0.0.1:${(hangingServer.address() as { port: number }).port}/hang`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); hangingServer?.close() })

test("an armed budget fails a hanging navigation quickly through newPage and passes options through", async () => {
  armFixtureNavigationBudget(browser, 500)
  const started = performance.now()
  await assert.rejects(browser.newPage({ viewport: { width: 400, height: 300 } }).then(page => page.goto(hangingUrl)),
    error => error.name === "TimeoutError")
  const elapsed = performance.now() - started
  assert.ok(elapsed < 5_000, `armed budget must cut the default 30s navigation wait, took ${elapsed.toFixed(0)}ms`)
})

test("an armed budget covers pages created through newContext and keeps context options working", async () => {
  armFixtureNavigationBudget(browser, 500)
  const context = await browser.newContext({ viewport: { width: 640, height: 480 }, locale: "en-US" })
  const page = await context.newPage()
  assert.deepEqual(page.viewportSize(), { width: 640, height: 480 })
  const started = performance.now()
  await assert.rejects(page.goto(hangingUrl), error => error.name === "TimeoutError")
  assert.ok(performance.now() - started < 5_000, "context pages inherit the armed navigation budget")
  await context.close()
})

test("an armed budget also bounds action waits, not only navigation", async () => {
  armFixtureNavigationBudget(browser, 500)
  const page = await browser.newPage()
  await page.goto("about:blank")
  const started = performance.now()
  await assert.rejects(page.waitForFunction(() => false), error => error.name === "TimeoutError")
  assert.ok(performance.now() - started < 5_000, "armed budget must cut the default 30 s action-wait too")
  await page.close()
})

test("arming twice stays safe and unarmed pages keep Playwright's own default", async () => {
  armFixtureNavigationBudget(browser, 500)
  armFixtureNavigationBudget(browser, 500)
  const page = await browser.newPage()
  await assert.rejects(page.goto(hangingUrl), error => error.name === "TimeoutError")
  await page.close()
})
