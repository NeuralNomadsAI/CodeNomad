import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser } from "playwright"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "external-link-clicks",
      routes: [
        { path: "/external-link-fixture", html: "<html><body><script type=\"module\" src=\"/tests/browser/fixtures/external-link-clicks.ts\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("anchors asking for a new window open through the host's opener command", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.click("#blank")
    await page.click("#plain", { modifiers: ["Control"] })
    await page.click("#plain", { modifiers: ["Shift"] })
    await page.click("#label")
    await page.click("#mail")
    // Same-window navigations stay with the host's navigation policy; other schemes stay closed.
    await page.click("#plain")
    await page.click("#blank", { modifiers: ["Alt"] })
    await page.click("#tel")
    await page.click("#app")
    await page.waitForFunction(() => (window as any).fixture.outcomes.length === 9)
    const { calls, outcomes } = await page.evaluate(() => (window as any).fixture)
    assert.deepEqual(outcomes.map((outcome: { id: string; claimed: boolean }) => `${outcome.id}:${outcome.claimed}`), [
      "blank:true", "plain:true", "plain:true", "nested:true", "mail:true",
      "plain:false", "blank:false", "tel:false", "app:false",
    ])
    assert.deepEqual(calls, [
      "https://example.com/blank", "https://example.com/plain", "https://example.com/plain",
      "https://example.com/nested", "mailto:hello@example.com",
    ].map(url => ({ command: "open_external_url", args: { url } })))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
