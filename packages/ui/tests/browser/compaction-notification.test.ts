import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  const fixture = await borrowFixture({
      name: "compaction-notification",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/compaction-notification.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await cache?.dispose() })

test("one automatic compaction shows one notification, whichever tabs or replays deliver it", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const message = 'Session "Compaction fixture" was compacted'
    const bubbles = page.getByText(message, { exact: true })
    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.compacted("tab-a", "evt_1", 7)
      fixture.compacted("tab-b", "evt_1", 7)
      // A reconnect replays the same durable event.
      fixture.compacted("tab-a", "evt_replay", 7)
    })
    await bubbles.first().waitFor()
    await page.waitForTimeout(300)
    assert.equal(await bubbles.count(), 1)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.history()), [message])

    // The session's next compaction is new: it reaches the history and replaces the bubble.
    await page.evaluate(() => (window as any).fixture.compacted("tab-b", "evt_2", 9))
    await page.waitForFunction(() => (window as any).fixture.history().length === 2)
    await page.waitForTimeout(600)
    assert.equal(await bubbles.count(), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
