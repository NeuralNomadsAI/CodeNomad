import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "file-search-retry",
      routes: [
        { path: "/search-fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/file-search-retry.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { } })

test("picker retries busy searches and cancels retries on query changes and close", async () => {
  const page = await browser.newPage()
  const calls: string[] = []
  let allowNeedle = false
  try {
    await page.route("**/api/**", route => {
      const request = new URL(route.request().url())
      if (!request.pathname.endsWith("/files/search")) return route.fulfill({ contentType: "application/json", body: "[]" })
      const q = request.searchParams.get("q")!
      calls.push(q)
      if (q !== "needle" || !allowNeedle) return route.fulfill({ status: 503, headers: { "Retry-After": "1" }, body: "busy" })
      return route.fulfill({ contentType: "application/json", body: JSON.stringify([{ name: "needle.txt", path: "needle.txt", type: "file" }]) })
    })
    const busy = page.waitForResponse(r => r.url().includes("/files/search") && r.status() === 503)
    await page.goto(url)
    await busy
    allowNeedle = true
    await page.getByText("needle.txt", { exact: true }).last().waitFor()
    assert.equal(calls.filter(q => q === "needle").length, 2)
    const oldBusy = page.waitForResponse(r => r.url().includes("q=obsolete"))
    await page.locator("#query").fill("obsolete")
    await oldBusy
    await page.locator("#query").fill("needle")
    await page.getByText("needle.txt", { exact: true }).last().waitFor()
    const closingBusy = page.waitForResponse(r => r.url().includes("q=closing"))
    await page.locator("#query").fill("closing")
    await closingBusy
    await page.locator("#close").click()
    // Advance beyond the Retry-After window to detect stale retry traffic.
    await page.waitForTimeout(1200)
    assert.equal(calls.filter(q => q === "obsolete").length, 1)
    assert.equal(calls.filter(q => q === "closing").length, 1)
  } finally { await page.close() }
})
