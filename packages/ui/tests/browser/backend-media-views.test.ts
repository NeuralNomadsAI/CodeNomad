import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

test("remote aside and workspace Markdown keep relative HTML inert, preserving local sources", async () => {
  const fixture = await borrowFixture({ name: "backend-media-views", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-media-views.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), probes: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => { if (request.url().includes("media-probe.png")) probes.push(request.url()) })
  await page.addInitScript({ content: 'window.EventSource = class extends EventTarget { close() {} }' })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/media-probe.png", route => route.fulfill({ status: 204 }))
  try {
    await page.goto(fixture.url)
    for (let mount = 0; mount < 2; mount++) {
      for (const selector of [".session-aside-answer", ".workspace-markdown"]) {
        await page.waitForFunction(selector => document.querySelectorAll(`${selector} .markdown-local-image`).length === 3, selector)
        assert.equal(await page.locator(`${selector} img`).count(), 0)
      }
      assert.deepEqual(probes, [])
      await page.evaluate(() => (window as any).views.unmount())
      await page.evaluate(() => (window as any).views.remount())
    }
    await page.evaluate(() => { (window as any).views.unmount(); (window as any).views.local() })
    await page.evaluate(() => (window as any).views.remount())
    for (const selector of [".session-aside-answer", ".workspace-markdown"]) {
      await page.waitForFunction(selector => document.querySelectorAll(`${selector} img`).length === 3, selector)
      assert.deepEqual(await page.locator(`${selector} img`).evaluateAll(images => images.map(image => image.getAttribute("src"))),
        ["/api/media-probe.png", "./media-probe.png", "../media-probe.png"])
    }
    assert.deepEqual(errors, [])
  } finally { await page.unrouteAll({ behavior: "wait" }); await browser.close() }
})
