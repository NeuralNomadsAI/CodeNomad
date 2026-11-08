import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "session-archives", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-archives.tsx"></script></body></html>' }] })
  url = fixture.url; events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })
const row = (page: Page, id: string) => page.locator(`[data-session-id="${id}"]`)
async function action(page: Page, id: string, label: string) {
  await row(page, id).hover()
  const inline = row(page, id).getByRole("button", { name: label, exact: true })
  if (await inline.isVisible()) await inline.click()
  else {
    await row(page, id).getByRole("button", { name: "More actions", exact: true }).click()
    await page.getByRole("menuitem", { name: label, exact: true }).click()
  }
}
test("native archive, discovery and restore preserve the selected conversation, descendants and failed writes", async () => {
  const page = await browser.newPage()
  await page.route("**/api/**", route => route.fulfill({ json: {} })); await events.route(page)
  try {
    await page.goto(url); await page.waitForFunction(() => Boolean((window as any).fixture))
    await row(page, "done").waitFor()
    assert.equal(await row(page, "old").count(), 0)
    await row(page, "done").locator(".session-item-select").click()
    await action(page, "done", "Archive session")
    await row(page, "done").getByText("Archived", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.selected()), "done")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes), [{ sessionID: "done", archived: true }])
    assert.equal(await page.evaluate(() => (window as any).fixture.flags().find((r: any) => r[0] === "child")[1]), undefined)
    await row(page, "keep").locator(".session-item-select").click()
    await row(page, "done").waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).fixture.setFilter(true))
    const filter = page.getByRole("combobox", { name: "Filter sessions by archive state" })
    await filter.selectOption("archived")
    await row(page, "done").waitFor(); await row(page, "old").waitFor()
    assert.equal(await row(page, "keep").count(), 0)
    await page.getByRole("textbox", { name: "Search sessions" }).fill("old")
    await row(page, "done").waitFor({ state: "detached" })
    await action(page, "old", "Restore session")
    await row(page, "old").waitFor({ state: "detached" })
    await page.getByRole("textbox", { name: "Search sessions" }).fill("")
    await filter.selectOption("all")
    await row(page, "old").waitFor()
    assert.equal(await row(page, "old").getByText("Archived", { exact: true }).count(), 0)
    await page.evaluate(() => { (window as any).fixture.setFilter(false); (window as any).fixture.event("done", false) })
    await row(page, "done").waitFor()
    await page.evaluate(() => (window as any).fixture.fail(true))
    await action(page, "done", "Archive session")
    await page.waitForFunction(() => (window as any).fixture.writes.length === 3)
    assert.equal(await row(page, "done").getByText("Archived", { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.current().time.archived), undefined)
  } finally { await page.close() }
})

test("archive and restore remain keyboard accessible through the compact action menu", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} })); await events.route(page)
  try {
    await page.goto(url); await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.locator(".session-list-container").evaluate(element => { element.parentElement!.style.width = "170px" })
    await page.waitForFunction(() => document.querySelector('[data-session-id="done"]')?.getAttribute("data-compact-actions") === "true")
    const menu = row(page, "done").getByRole("button", { name: "More actions", exact: true })
    await menu.focus(); await menu.press("Enter")
    const archive = page.getByRole("menuitem", { name: "Archive session", exact: true })
    await archive.focus(); await archive.press("Enter")
    await row(page, "done").waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).fixture.setFilter(true))
    await page.getByRole("combobox", { name: "Filter sessions by archive state" }).selectOption("archived")
    await row(page, "done").waitFor()
    await action(page, "done", "Restore session")
    await row(page, "done").waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes), [
      { sessionID: "done", archived: true }, { sessionID: "done", archived: false },
    ])
  } finally { await page.close() }
})
