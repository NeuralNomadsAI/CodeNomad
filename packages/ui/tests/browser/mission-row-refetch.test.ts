import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./mission-panel-route"

let browser: Browser, url: string, cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-row-refetch",
      routes: [
        { path: "/mission-row-refetch", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-row-refetch.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await cache?.dispose() })
async function prepare(page: Page) {
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).missionRowFixture))
  await page.locator('[data-fixture="cleanup"] .mission-list-item').waitFor()
}
const cleanupRow = '[data-fixture="cleanup"] .mission-list-item'
async function refetch(page: Page) { await page.evaluate(() => (window as any).missionRowFixture.refetch()); await page.waitForTimeout(80) }

test("Cleanup preserves exact retry controls/open menus while current receipt text and disabled state update", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let posts = 0
  try {
    await prepare(page)
    const button = await page.locator(`${cleanupRow} .mission-list-inline button`).elementHandle()
    await button!.focus()
    await refetch(page)
    assert.equal(await button!.evaluate(e => e.isConnected && e === document.activeElement), true)
    await page.evaluate(() => (window as any).missionRowFixture.update())
    await page.waitForTimeout(80)
    assert.equal(await button!.evaluate(e => e.isConnected && e === document.activeElement), true)
    assert.match((await page.locator(cleanupRow).textContent())!, /Fresh cleanup receipt/)
    await page.evaluate(() => (window as any).missionRowFixture.disabled(true))
    assert.equal(await button!.isDisabled(), true)
    await page.evaluate(() => (window as any).missionRowFixture.disabled(false))
    await page.evaluate(() => (window as any).missionRowFixture.width(80))
    await page.locator(`${cleanupRow} .action-overflow-trigger`).click()
    // Do not race the menu's deferred opening autofocus with item.focus().
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menu")
    const menu = await page.getByRole("menuitem").elementHandle()
    await menu!.focus()
    await refetch(page)
    assert.equal(await menu!.evaluate(e => e.isConnected && e === document.activeElement), true)
    // The retry reconciles through its mission's read, then deletes on the same path.
    await page.route("**/api/workspaces/row-refetch/missions/mission", async route => {
      if (route.request().method() === "GET") {
        const cleanups = await page.evaluate(() => (window as any).missionRowFixture.receipt())
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ available: true, cleanups }) })
      }
      posts++
      assert.equal(route.request().method(), "DELETE")
      assert.equal(route.request().postDataJSON().requestId, "request")
      await route.fulfill({ contentType: "application/json", body: "{}" })
    })
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="refreshes"]')?.textContent === "1")
    assert.equal(posts, 1)
    assert.equal(await button!.evaluate(e => e.isConnected), true)
  } finally { await page.close() }
})

test("Cleanup replaced/settled receipts and newly disabled contexts fence delayed retries without stealing focus", async () => {
  for (const change of ["replaceReceipt", "settle", "disabled", "active", "active-aba", "disabled-aba", "receipt-aba", "instance-aba"]) {
    const page = await browser.newPage({ locale: "en-US" })
    let release!: () => void, reads = 0, writes = 0
    const waiting = new Promise<void>(resolve => { release = resolve })
    try {
      await prepare(page)
      const saved = await page.evaluate(() => (window as any).missionRowFixture.receipt())
      await page.route("**/api/workspaces/row-refetch/missions/mission", async route => {
        if (route.request().method() === "GET") {
          reads++
          await waiting
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ available: true, cleanups: saved }) })
        }
        writes++
        await route.fulfill({ contentType: "application/json", body: "{}" })
      })
      const button = await page.locator(`${cleanupRow} .mission-list-inline button`).elementHandle()
      await button!.click()
      await page.waitForFunction(() => (document.querySelector('[data-fixture="cleanup"] .mission-list-inline button') as HTMLButtonElement)?.disabled)
      await page.locator('[data-fixture="outside"]').focus()
      await page.evaluate(change => {
        const fixture = (window as any).missionRowFixture
        if (change === "disabled") fixture.disabled(true)
        else if (change === "active") fixture.active(false)
        else if (change === "active-aba") { fixture.active(false); fixture.active(true) }
        else if (change === "disabled-aba") { fixture.disabled(true); fixture.disabled(false) }
        else if (change === "receipt-aba") { fixture.settle(); fixture.restoreReceipt() }
        else if (change === "instance-aba") { fixture.instance("other-instance"); fixture.instance("row-refetch") }
        else fixture[change]()
      }, change)
      release()
      await page.waitForTimeout(150)
      assert.equal(reads, 1)
      assert.equal(writes, 0, change)
      assert.equal(await page.locator('[data-fixture="refreshes"]').textContent(), "0")
      assert.equal(await page.locator('[data-fixture="outside"]').evaluate(e => e === document.activeElement), true)
      if (change === "replaceReceipt" || change === "settle") {
        assert.equal(await button!.evaluate(e => e.isConnected), false)
        await button!.evaluate(e => (e as HTMLButtonElement).click())
        assert.equal(reads, 1)
      }
    } finally { release(); await page.close() }
  }
})

test("switching cleanup instances clears old pending state, and late completion cannot clear a new attempt", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let releaseOld!: () => void, releaseNew!: () => void, writes = 0
  const oldRead = new Promise<void>(resolve => { releaseOld = resolve })
  const newRead = new Promise<void>(resolve => { releaseNew = resolve })
  try {
    await prepare(page)
    const saved = await page.evaluate(() => (window as any).missionRowFixture.receipt())
    await page.route("**/api/workspaces/*/missions/mission", async route => {
      if (route.request().method() === "GET") {
        await (route.request().url().includes("/row-refetch/") ? oldRead : newRead)
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ available: true, cleanups: saved }) })
      }
      writes++
      await route.fulfill({ contentType: "application/json", body: "{}" })
    })
    await page.locator(`${cleanupRow} .mission-list-inline button`).click()
    await page.waitForFunction(() => (document.querySelector('[data-fixture="cleanup"] .mission-list-inline button') as HTMLButtonElement)?.disabled)
    await page.evaluate(() => (window as any).missionRowFixture.instance("other-instance"))
    await page.waitForFunction(() => !(document.querySelector('[data-fixture="cleanup"] .mission-list-inline button') as HTMLButtonElement)?.disabled)
    await page.locator(`${cleanupRow} .mission-list-inline button`).click()
    releaseOld()
    await page.waitForTimeout(100)
    assert.equal(writes, 0)
    assert.equal(await page.locator(`${cleanupRow} .mission-list-inline button`).isDisabled(), true)
    releaseNew()
    await page.waitForFunction(() => document.querySelector('[data-fixture="refreshes"]')?.textContent === "1")
    assert.equal(writes, 1)
    assert.equal(await page.locator(`${cleanupRow} .mission-list-inline button`).isDisabled(), false)
  } finally { releaseOld(); releaseNew(); await page.close() }
})
