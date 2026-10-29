import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "hidden-forms",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/hidden-forms.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("session and provider Forms hide protocol inputs but submit their defaults", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    for (const name of ["Session form", "Provider form"]) {
      const form = page.getByRole("form", { name })
      assert.equal(await form.locator("input").count(), 1, "hidden fields must not be mounted or focusable")
      assert.equal(await form.getByText("Hidden tenant").count(), 0)
      await form.getByRole("textbox", { name: "Name" }).fill("Alice")
      await form.locator('button[type="submit"]').click()
    }
    assert.deepEqual(await page.evaluate(() => (window as any).fixture), {
      replies: [{ name: "Alice", tenant: "native-tenant", flag: false }],
      authReplies: [{ name: "Alice", tenant: "native-tenant", flag: false }],
    })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
