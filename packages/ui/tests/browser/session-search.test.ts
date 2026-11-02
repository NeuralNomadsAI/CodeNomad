import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
      name: "session-search",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/session-search.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

test("technical carriers stay out of followed-conversation choices and native title searches", async () => {
  const page = await browser.newPage()
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await events.route(page)
    await page.goto(url); await page.waitForFunction(() => Boolean((window as any).fixture))
    const picker = page.locator(".mission-conversation-picker")
    await picker.locator("summary").click()
    await picker.getByText("Local conversation", { exact: true }).waitFor()
    assert.equal(await picker.getByText("Carrier needle", { exact: true }).count(), 0)
    await picker.getByRole("searchbox").fill("needle")
    await page.waitForFunction(() => (window as any).fixture.searches.some((s: any) => s.search === "needle"))
    await picker.getByText("Child needle", { exact: true }).waitFor()
    assert.equal(await picker.getByText("Carrier needle", { exact: true }).count(), 0)
    await picker.getByText("Child needle", { exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.watched()), ["child"])
    assert.equal(await page.locator('[data-session-id="ses_cn_schedule_fixture"]').count(), 0)
  } finally { await page.close() }
})

test("search is flat, filters each session, selects only matches and restores the normal hierarchy", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await events.route(page)
  const rows = () => page.locator(".session-item-base").evaluateAll(elements => elements.map(el => el.getAttribute("data-session-id")))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const toggle = page.getByRole("switch", { name: "Subsessions", exact: true })
    const mainToggle = page.getByRole("switch", { name: "Main sessions", exact: true })
    await page.locator('.session-item-base[data-session-id="parent"]').waitFor()
    assert.deepEqual(await rows(), ["local", "parent"])
    assert.equal(await mainToggle.isChecked(), true)
    assert.equal(await page.getByRole("switch").first().evaluate(el => el.closest("label")?.textContent?.trim()), "Main sessions")
    await mainToggle.uncheck()
    assert.deepEqual(await rows(), [])
    await toggle.check()
    await page.locator('[data-session-id="child"]').waitFor()
    assert.deepEqual(await rows(), ["child", "grandchild"])
    await mainToggle.check()
    assert.deepEqual(await rows(), ["child", "grandchild", "local", "parent"])
    assert.equal(await page.locator(".session-item-nested").count(), 0)
    assert.equal(await page.locator(".session-item-expander[aria-expanded]").count(), 0)
    assert.equal(await page.locator('[data-session-id="grandchild"] .worktree-indicator').innerText(), "feature")
    const sort = page.getByRole("combobox").first()
    await sort.selectOption("name")
    assert.deepEqual(await rows(), ["child", "grandchild", "local", "parent"])
    await sort.selectOption("worktree")
    assert.deepEqual(await rows(), ["grandchild", "parent", "child", "local"])
    await sort.selectOption("activity")
    assert.deepEqual(await rows(), ["child", "grandchild", "local", "parent"])
    const filter = page.getByRole("combobox", { name: "Filter sessions by worktree" })
    await filter.selectOption("/repo")
    assert.deepEqual(await rows(), ["child", "local"])
    const search = page.getByRole("textbox", { name: "Search sessions" })
    await search.fill("needle")
    await page.waitForFunction(() => (window as any).fixture.searches.some((s: any) => s.search === "needle"))
    await page.waitForFunction(() => document.querySelectorAll(".session-item-base").length === 1)
    assert.deepEqual(await rows(), ["child"])
    await page.getByRole("button", { name: "Select all sessions" }).click()
    assert.equal(await page.locator('.session-item-base input[type="checkbox"]:checked').count(), 1)
    await toggle.uncheck()
    assert.deepEqual(await rows(), [])
    assert.equal(await page.getByRole("button", { name: /Delete selected/ }).count(), 0)
    await toggle.check()
    assert.equal(await page.locator('.session-item-base input[type="checkbox"]:checked').count(), 0)
    await page.locator('[data-session-id="child"] .session-item-select').click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected), ["child"])
    await filter.selectOption("/feature")
    await search.fill("remote")
    await page.locator('[data-session-id="orphan"]').waitFor()
    assert.deepEqual(await rows(), ["orphan"], "server result without its parent is independently renderable")
    assert.equal(await page.evaluate(() => (window as any).fixture.parentReads()), 0)
    await mainToggle.uncheck()
    await page.evaluate(() => (window as any).fixture.setSearchMode(false))
    await page.locator('[data-session-id="parent"]').waitFor()
    assert.equal(await page.getByRole("switch").count(), 0)
    assert.ok((await rows()).includes("parent"))
    assert.ok(await page.locator(".session-item-expander[aria-expanded]").count() > 0)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})

test("dragging across the selection checkboxes gives every crossed session the first one's new state", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await events.route(page)
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.getByRole("switch", { name: "Subsessions", exact: true }).check()
    await page.waitForFunction(() => document.querySelectorAll(".session-item-base").length === 4)
    const boxes = page.locator('.session-item-base input[type="checkbox"]')
    const checked = () => boxes.evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).checked))
    const center = async (index: number) => {
      const box = (await boxes.nth(index).boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    await boxes.nth(1).check()

    // Down the column in one jump and back, released on the first box: every crossed session
    // is selected, the checked one stays so, and the release keeps the first one's new state.
    // A touch landing mid-drag leaves the mouse sweep going.
    const first = await center(0), middle = await center(1), last = await center(3)
    await page.mouse.move(first.x, first.y)
    await page.mouse.down()
    await page.mouse.move(middle.x, middle.y, { steps: 4 })
    await page.locator("body").dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", isPrimary: false, button: 0, buttons: 1 })
    await page.mouse.move(last.x, last.y)
    await page.mouse.move(first.x, first.y)
    await page.mouse.up()
    assert.deepEqual(await checked(), [true, true, true, true])

    // Back up from the last, then released over the second row's title: the release opens no session.
    const second = await center(1), title = (await page.locator(".session-item-select").nth(1).boundingBox())!
    await page.mouse.move(last.x, last.y)
    await page.mouse.down()
    await page.mouse.move(second.x, second.y, { steps: 8 })
    await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2, { steps: 4 })
    await page.mouse.up()
    assert.deepEqual(await checked(), [true, false, false, false])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected), [])
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "")

    // A press whose release went elsewhere (another window, a system prompt) leaves no sweep
    // behind: moving with the button up toggles nothing.
    await boxes.nth(3).dispatchEvent("pointerdown", { button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true })
    await page.mouse.move(last.x, last.y)
    await page.mouse.move(first.x, first.y, { steps: 8 })
    assert.deepEqual(await checked(), [true, false, false, false])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
