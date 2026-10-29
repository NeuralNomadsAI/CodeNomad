import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "websearch",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/websearch.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("web result cards retain safe links, literal snippets, fallback and native consent submission", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.locator(".websearch-results").waitFor()
    assert.equal(await page.getByRole("link", { name: "Native result" }).getAttribute("href"), "https://example.org/article")
    assert.match(await page.locator(".websearch-results").innerText(), /<script>literal snippet<\/script>/)
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.getByRole("radio", { name: "Choose another provider" }).check()
    await page.getByRole("button", { name: "Submit", exact: true }).click()
    assert.equal(await page.locator("output").innerText(), '{"choice":"choose"}')
    if (process.env.CODENOMAD_WEBSEARCH_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_WEBSEARCH_CAPTURE, fullPage: true })
    await page.evaluate(() => (window as any).fixture.setOutput("Unknown provider response"))
    await page.getByText("Unknown provider response", { exact: true }).waitFor()
    assert.equal(await page.locator(".websearch-results").count(), 0)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error(errors, await page.locator("main").innerText())
    throw error
  } finally { await page.close() }
})
