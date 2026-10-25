import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "remote-access-settings",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/remote-access-settings.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); })

test("direct access stays collapsed behind Remote Control until the user opens it", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    const summary = page.locator("summary.remote-direct-access-summary")
    await summary.getByText("Direct access (local network, advanced)", { exact: true }).waitFor()
    const listening = page.getByText("Listening mode", { exact: true })
    assert.equal(await listening.isVisible(), false)
    await summary.click()
    await listening.waitFor()
    await page.getByText("Direct connections from other devices sign in with this password. Remote Control pairs devices instead.", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("direct access opens by itself while the server listens beyond localhost", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(`${url}?mode=all`)
    await page.getByText("Listening mode", { exact: true }).waitFor()
    assert.equal(await page.locator("details.remote-direct-access").evaluate((node) => (node as HTMLDetailsElement).open), true)
  } finally { await page.close() }
})
