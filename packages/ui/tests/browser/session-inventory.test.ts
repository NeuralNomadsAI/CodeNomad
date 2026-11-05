import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

// prototype-1236: an explicit (native) inventory pages naturally when the list end is visible, with no
// explanatory text or manual button; bounded by Retry after a failure and by user scrolling after idle pages.
async function open(name: string, query = ""): Promise<{ browser: Browser; page: Page; errors: string[] }> {
  const fixture = await borrowFixture({ name, routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-inventory.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(fixture.url + query)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { browser, page, errors }
}
const calls = (page: Page) => page.evaluate(() => (window as any).fixture.calls as unknown[])
const settle = (page: Page) => page.waitForTimeout(400)

test("explicit inventory pages naturally once its end is visible, without text or button, and explains incomplete search", async () => {
  const { browser, page, errors } = await open("session-inventory")
  try {
    await page.locator('[data-session-id="Older conversation"]').waitFor()
    assert.deepEqual((await calls(page)).slice(1), [{ cursor: "next" }])
    await page.getByRole("status").filter({ hasText: "All conversations loaded." }).waitFor({ state: "attached" })
    assert.equal(await page.getByRole("button", { name: "Load more conversations", exact: true }).count(), 0)
    assert.equal(await page.getByText("Showing loaded conversations", { exact: false }).count(), 0)
    await page.getByRole("combobox", { name: "Sort sessions" }).selectOption("name")
    await settle(page)
    assert.equal((await calls(page)).length, 2, "sorting never exhausts native pages")
    await page.getByRole("textbox", { name: "Search sessions", exact: true }).fill("needle")
    await page.getByText("Showing one page of matches. Refine your search for other conversations.", { exact: true }).waitFor()
    assert.equal((await calls(page)).length, 3)
    assert.deepEqual(errors, [])
  } finally { await page.close(); await browser.close() }
})

test("a failed page keeps its rows, waits for Retry with one polite channel and resumes the failed continuation", async () => {
  const { browser, page, errors } = await open("session-inventory-retry", "?fail")
  try {
    for (const attempt of [1, 2]) {
      const error = page.getByRole("status").filter({ hasText: "fixture offline" })
      await error.waitFor()
      assert.equal(await error.getAttribute("aria-live"), "polite")
      assert.equal(await page.getByRole("alert").count(), 0)
      assert.equal(await page.locator('[data-session-id="Newest conversation"]').count(), 1)
      await settle(page)
      assert.equal((await calls(page)).length, attempt + 1, "a failed page is not retried automatically")
      if (attempt === 2) await page.evaluate(() => (window as any).fixture.fail(false))
      await page.getByRole("button", { name: "Retry", exact: true }).focus()
      await page.keyboard.press("Enter")
      await page.waitForFunction(count => (window as any).fixture.calls.length === count, attempt + 2)
    }
    await page.locator('[data-session-id="Older conversation"]').waitFor()
    assert.deepEqual((await calls(page)).slice(1), [{ cursor: "next" }, { cursor: "next" }, { cursor: "next" }])
    assert.deepEqual(errors, [])
  } finally { await page.close(); await browser.close() }
})

test("pages that show nothing stop after three until the user scrolls the list", async () => {
  const { browser, page, errors } = await open("session-inventory-idle", "?empty")
  try {
    await page.waitForFunction(() => (window as any).fixture.calls.length === 4)
    await settle(page)
    assert.equal((await calls(page)).length, 4)
    await page.locator(".session-list").dispatchEvent("wheel")
    await page.waitForFunction(() => (window as any).fixture.calls.length === 7)
    await settle(page)
    assert.equal((await calls(page)).length, 7)
    assert.deepEqual(errors, [])
  } finally { await page.close(); await browser.close() }
})

for (const mode of ["empty", "coalesced", "hidden", "close", "stale-error"] as const) test(`an automatic page is guarded and announced (${mode})`, async () => {
  const { browser, page, errors } = await open(`session-inventory-${mode}`, `?hold=${mode}`)
  try {
    await page.waitForFunction(() => Boolean((window as any).fixture.holds.release))
    assert.equal(await page.getByRole("status").innerText(), "Loading more sessions…")
    if (mode === "coalesced") await page.evaluate(async () => {
      const { loadMoreSessions } = await import("/src/stores/session-api.ts")
      ;(window as any).coalesced = Promise.all([loadMoreSessions("inventory-fixture"), loadMoreSessions("inventory-fixture")]).catch(() => {})
    })
    assert.equal(await page.evaluate(() => (window as any).fixture.holds.starts), 1)
    if (mode === "hidden") await page.evaluate(() => { document.querySelector<HTMLElement>(".session-list")!.style.display = "none" })
    if (mode === "close") await page.evaluate(async () => (await import("/src/stores/instances.ts")).removeInstance("inventory-fixture", { authoritative: false }))
    if (mode === "stale-error") await page.evaluate(async () => {
      (await import("/src/stores/instances.ts")).updateInstance("inventory-fixture", { capabilities: { generation: 2 } as any })
    })
    await page.evaluate(async () => { (window as any).fixture.holds.release(); await (window as any).coalesced })
    if (mode === "empty" || mode === "coalesced") {
      await page.getByRole("status").filter({ hasText: "All conversations loaded." }).waitFor({ state: "attached" })
    } else {
      await page.waitForFunction(() => !document.querySelector('[aria-live="polite"]')?.textContent)
      assert.equal(await page.getByRole("alert").count(), 0)
    }
    assert.equal(await page.evaluate(() => (window as any).fixture.holds.starts), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close(); await browser.close() }
})

test("explicit native movement uses the real event dispatcher without exhausting remaining pages", async () => {
  const { browser, page, errors } = await open("session-inventory-events")
  try {
    await page.locator('[data-session-id="Older conversation"]').waitFor()
    await page.evaluate(() => (window as any).fixture.moveUnqualified())
    assert.equal(await page.locator('[data-session-id="Newest conversation"]').count(), 1, "uncorrelated connecting-only event stays rejected")
    assert.equal((await calls(page)).length, 2)
    await page.evaluate(() => (window as any).fixture.move())
    await page.locator('[data-session-id="Newest conversation"]').waitFor({ state: "detached" })
    await page.waitForFunction(() => (window as any).fixture.calls.length >= 3)
    const location = await page.evaluate(async () => {
      const { sessions } = await import("/src/stores/session-state.ts")
      return sessions().get("inventory-fixture")?.get("Newest conversation")?.location.directory
    })
    assert.equal(location, "/elsewhere")
    await settle(page)
    assert.ok((await calls(page)).length <= 6, "idle native pages stop without user scrolling")
    assert.deepEqual(errors, [])
  } finally { await page.close(); await browser.close() }
})
