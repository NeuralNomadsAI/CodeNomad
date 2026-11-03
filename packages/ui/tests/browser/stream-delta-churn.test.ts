import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "stream-delta-churn",
    routes: [
      { path: "/fixture", html: "<html><body><div id=\"root\" style=\"display:flex;width:1100px;height:740px\"></div><script type=\"module\" src=\"/tests/browser/fixtures/stream-delta-churn.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function withPage(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => {
    const request = new URL(route.request().url())
    if (request.hostname !== "127.0.0.1") return route.abort()
    if (request.pathname.startsWith("/api/")) return route.fulfill({ json: {} })
    return route.continue()
  })
  await page.goto(url, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => Boolean((window as any).streamDeltaFixture), undefined, { timeout: 60_000 })
  try {
    await run(page)
    assert.deepEqual(errors, [], "page errors")
  } finally {
    await page.close()
  }
}

test("a text delta does not replace action-group buttons of a settled reply", async () => {
  await withPage(async page => {
    const result = await page.evaluate(() => (window as any).streamDeltaFixture.deltaMutations(3, 40))
    assert.equal(result.messageFound, true, "the streaming message is projected")
    assert.ok(result.textLength >= 40 * 80, `the delta's text is rendered (${result.textLength})`)
    assert.equal(result.actionGroupMutations, 0,
      `a streaming text delta must not replace action-group buttons; got ${result.actionGroupMutations} mutations: ${JSON.stringify(result.mutations)}`)
  })
})
