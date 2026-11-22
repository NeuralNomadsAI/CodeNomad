import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture, type BorrowedFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let fixture: BorrowedFixture, browser: Browser
before(async () => {
  fixture = await borrowFixture({ name: "rune-window-close", routes: [{ path: "/fixture", html:
    '<html><body style="margin:0"><div id="root"></div><script type="module" src="/tests/browser/fixtures/rune-window-close.tsx"></script></body></html>',
  }] })
  browser = await chromium.launch({ headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await fixture?.close() })

for (const colorScheme of ["light", "dark"] as const) {
  test(`window close exposes its name and activates on click, Enter and Space (${colorScheme})`, async () => {
    const page = await browser.newPage({ locale: "en-US", colorScheme, viewport: { width: 100, height: 100 } })
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(fixture.url)
      await page.evaluate(mode => document.documentElement.setAttribute("data-theme", mode), colorScheme)
      const button = page.getByRole("button", { name: "Close", exact: true })
      await button.waitFor()
      assert.equal(await page.getByRole("button").count(), 1)
      const bounds = await button.boundingBox()
      assert.equal(bounds?.width, 24); assert.equal(bounds?.height, 24)
      await page.keyboard.press("Tab")
      assert(await button.evaluate(e => e.matches(":focus-visible")))
      assert.equal(await button.evaluate(e => getComputedStyle(e).outlineWidth), "1px")
      await button.click()
      await page.keyboard.press("Enter")
      await page.keyboard.press("Space")
      assert.equal(await page.evaluate(() => (window as any).runeWindowClose.presses), 3)
    } finally { await page.close() }
  })
}
