import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "permission-feedback",
      routes: [
        { path: "/permission-fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/permission-feedback.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("rejection feedback survives same-request refreshes and resets for a new request", async () => {
  const page = await browser.newPage()
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(url)
    const reason = page.locator("textarea")
    await reason.fill("  Ne supprime pas les fichiers.\nLis-les seulement.  ")
    await page.locator("#refresh").click()
    assert.equal(await reason.inputValue(), "  Ne supprime pas les fichiers.\nLis-les seulement.  ")
    await page.locator(".tool-call-permission-button").last().click()
    assert.deepEqual(JSON.parse(await page.locator("#result").innerText()), {
      reply: "reject", message: "Ne supprime pas les fichiers.\nLis-les seulement.",
    })
    await page.locator("#next").click()
    assert.equal(await reason.inputValue(), "")
  } finally { await page.close() }
})
