import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "closed-tab-drafts",
    routes: [
      { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/closed-tab-drafts.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("closing a project tab and reopening its folder gives the unsent draft back", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => {
    ;(window as any).__CODENOMAD_RUNTIME_HOST__ = "electron"
    ;(window as any).__CODENOMAD_WINDOW_CONTEXT__ = "local"
    ;(window as any).EventSource = class extends EventTarget { close() {} }
  })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  const fixture = (call: string, ...args: string[]) =>
    page.evaluate(([call, args]) => (window as any).draftsFixture[call as string](...(args as string[])), [call, args] as const)
  try {
    await page.goto(url)
    const composer = page.locator("textarea:visible").first()
    await composer.fill("an unsent idea")
    await page.getByRole("tab").filter({ hasText: "first" }).locator(".tab-close").click()
    await composer.waitFor({ state: "detached" })
    await fixture("stopped", "first")
    await page.waitForFunction(() => !(window as any).draftsFixture.records().includes("first"))

    await fixture("open", "second", "D:\\Drafts\\Other")
    assert.equal(await page.locator("textarea:visible").first().inputValue(), "", "another folder gets nothing")
    await fixture("open", "third", "d:/drafts/project/")
    await page.getByRole("tab").filter({ hasText: "third" }).waitFor()
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "an unsent idea")
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})
