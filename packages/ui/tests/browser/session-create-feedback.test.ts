import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "session-create-feedback",
    routes: [
      { path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-create-feedback.tsx"></script></body></html>' },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const newSessionButton = (page: Page) => page.getByRole("button", { name: "New session" })
const busy = (page: Page) => page.evaluate(() => {
  const button = document.querySelector('[aria-label="New session"]') as HTMLButtonElement | null
  return {
    disabled: button?.disabled === true || button?.classList.contains("Mui-disabled") === true,
    spinning: Boolean(button?.querySelector("svg.animate-spin")),
  }
})
async function until(page: Page, expectation: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 5000
  while (!(await expectation())) {
    if (Date.now() > deadline) throw new Error(`Did not observe ${description}`)
    await page.waitForTimeout(20)
  }
}

test("creating a session on a stalled network shows busy feedback, one request and a recoverable failure", async () => {
  const page = await browser.newPage({ viewport: { width: 480, height: 400 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    try {
      await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 15_000 })
    } catch {
      throw new Error(`fixture did not load: ${errors.join(" | ") || "no page errors captured"}`)
    }
    await newSessionButton(page).click()

    // The trigger is disabled and spinning while the create request hangs.
    await until(page, async () => {
      const state = await busy(page)
      return state.disabled && state.spinning
    }, "busy new-session button")

    // Concurrent entries share the hanging request: the real new-session
    // shortcut, pressed twice through the registered hotkey wiring.
    await page.keyboard.press("Control+Shift+N")
    await page.keyboard.press("Control+Shift+N")
    assert.equal(await page.evaluate(() => (window as any).fixture.createCalls()), 1, "one create request while busy")

    // The failed creation surfaces a dialog instead of dying silently.
    await page.evaluate(() => (window as any).fixture.settle("fail"))
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })
    assert.match(await page.locator('[role="dialog"]').innerText(), /failed/i)
    await until(page, async () => {
      const state = await busy(page)
      return !state.disabled && !state.spinning
    }, "idle new-session button after failure")
    await page.locator('[role="dialog"] button').last().click()
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 })

    // A retry over a recovered network completes and activates the session.
    await newSessionButton(page).click()
    await until(page, async () => (await busy(page)).spinning, "busy new-session button on retry")
    await page.evaluate(() => (window as any).fixture.settle("ok"))
    await until(page, async () => {
      const state = await busy(page)
      return !state.disabled && !state.spinning
    }, "idle new-session button after success")
    assert.equal(await page.evaluate(() => (window as any).fixture.activeParentId()), "created")
    assert.equal(await page.evaluate(() => (window as any).fixture.createCalls()), 2)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
