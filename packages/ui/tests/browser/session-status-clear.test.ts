import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
    name: "session-status-clear",
    routes: [
      { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/session-status-clear.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

async function open(page: Page) {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await events.route(page)
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.locator('[data-session-id="parent-f"]').waitFor()
  return errors
}
const badge = (page: Page, sessionId: string) => page.locator(`[data-session-id="${sessionId}"] .session-status`)
const statuses = (page: Page, ids: string[]) => Promise.all(ids.map(async id => {
  const located = badge(page, id)
  return await located.count() ? located.innerText() : null
}))
const selected = (page: Page) => page.evaluate(() => [...(window as any).fixture.selected])
async function center(page: Page, sessionId: string) {
  const box = (await badge(page, sessionId).boundingBox())!
  return { x: box.x + box.width - 6, y: box.y + box.height / 2 }
}

test("Idle and Interrupted badges clear by click or keyboard without opening the session", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  try {
    const errors = await open(page)
    const idle = page.getByRole("button", { name: "Clear Idle" }).first()
    assert.equal(await idle.getAttribute("title"), "Clear")
    await badge(page, "idle-a").click()
    assert.equal(await badge(page, "idle-a").count(), 0)

    const interrupted = page.getByRole("button", { name: "Clear Interrupted", exact: true })
    await interrupted.focus()
    await page.keyboard.press("Enter")
    assert.equal(await badge(page, "interrupted-b").count(), 0)
    assert.equal(await badge(page, "idle-a").count(), 0, "acknowledging stays")
    assert.deepEqual(await selected(page), [], "clearing selects nothing")
    assert.equal(await page.evaluate(() => (window as any).fixture.session("interrupted-b").generationRecovery), "interrupted",
      "the native interruption fact is untouched")

    // Working and input requests are never clearable; their badge area still opens the row.
     assert.deepEqual(await statuses(page, ["working-c", "permission-d", "question-d"]), ["WORKING", "NEEDS PERMISSION", "NEEDS INPUT"])
    assert.equal(await page.locator('[data-session-id="working-c"] button.session-status').count(), 0)
     assert.equal(await page.locator('[data-session-id="permission-d"] button.session-status').count(), 0)
     assert.equal(await page.locator('[data-session-id="question-d"] button.session-status').count(), 0)
    await badge(page, "working-c").click()
    assert.deepEqual(await selected(page), ["working-c"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("dragging from a badge clears every Idle or Interrupted badge it crosses and leaves the rest", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  try {
    const errors = await open(page)
    const start = await center(page, "idle-a"), end = await center(page, "idle-e")
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 12 })
    await page.mouse.up()
    assert.deepEqual(await statuses(page, ["idle-a", "interrupted-b", "working-c", "permission-d", "question-d", "idle-e"]),
      [null, null, "WORKING", "NEEDS PERMISSION", "NEEDS INPUT", null])
    assert.deepEqual(await selected(page), [], "the release opens nothing")

    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a touch drag across badges scrolls instead of clearing", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, hasTouch: true })
  try {
    const errors = await open(page)
    const start = await center(page, "idle-e")
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] })
      for (let step = 1; step <= 12; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y - step * 12 }] })
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      await page.waitForFunction(() => document.querySelector(".session-list")!.scrollTop > 0)
      await page.locator('[data-session-id="idle-a"]').scrollIntoViewIfNeeded()
      assert.deepEqual(await statuses(page, ["idle-a", "interrupted-b", "idle-e"]), ["IDLE", "INTERRUPTED", "IDLE"])
      assert.deepEqual(await selected(page), [])
    } finally { await cdp.detach() }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("parent work and input indicators stay visible and keep their expand action", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  try {
    const errors = await open(page)
    const chevron = page.locator('[data-session-id="parent-f"] .session-item-expander')
    for (const field of ["pendingPermission", "pendingForm"]) {
      await page.evaluate(field => (window as any).fixture.pending("f-1", field, true), field)
      assert.equal(await chevron.getAttribute("data-child-activity"), "permission")
      assert.equal(await chevron.getAttribute("data-toggle-sweep"), null)
      await chevron.click()
      assert.equal(await chevron.getAttribute("aria-expanded"), "true")
      assert.equal(await badge(page, "f-2").innerText(), "INTERRUPTED")
      await chevron.click()
      await page.evaluate(field => (window as any).fixture.pending("f-1", field, false), field)
    }
    for (const state of ["working", "compacting"]) {
      await page.evaluate(state => (window as any).fixture.status("f-1", state), state)
      assert.equal(await chevron.getAttribute("data-child-activity"), state)
      assert.equal(await chevron.getAttribute("data-toggle-sweep"), null)
    }
    assert.deepEqual(await selected(page), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a parent with Idle and native Interrupted children expands and collapses without clearing badges", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  try {
    const errors = await open(page)
    await page.evaluate(() => (window as any).fixture.interrupt("f-2"))
    await page.waitForFunction(() => (window as any).fixture.session("f-2").generationRecovery === "interrupted")
    const chevron = page.locator('[data-session-id="parent-f"] .session-item-expander')
    assert.equal(await chevron.getAttribute("aria-expanded"), "false")
    for (let cycle = 0; cycle < 2; cycle++) {
      await chevron.click()
      assert.equal(await chevron.getAttribute("aria-expanded"), "true", "the first click expands, including with terminal attention")
      await badge(page, "f-1").waitFor()
      await badge(page, "f-2").waitFor()
      assert.deepEqual(await statuses(page, ["f-1", "f-2"]), ["IDLE", "INTERRUPTED"])
      assert.equal(await chevron.getAttribute("aria-label"), "Collapse session")
      assert.equal(await chevron.getAttribute("title"), "Collapse")
      assert.equal(await chevron.getAttribute("data-child-activity"), null)
      assert.equal(await chevron.getAttribute("data-toggle-sweep"), null)
      await chevron.click()
      assert.equal(await chevron.getAttribute("aria-expanded"), "false")
      await badge(page, "f-1").waitFor({ state: "hidden" })
      await badge(page, "f-2").waitFor({ state: "hidden" })
      assert.equal(await chevron.getAttribute("aria-label"), "Expand session — 1 subsession idle")
      assert.equal(await chevron.getAttribute("title"), "Expand — 1 subsession idle")
      assert.equal(await chevron.getAttribute("data-child-activity"), "idle")
      assert.equal(await chevron.getAttribute("data-toggle-sweep"), null)
    }
    assert.deepEqual(await selected(page), [])
    assert.equal(await page.evaluate(() => (window as any).fixture.session("f-1").idleSince), 5)
    assert.equal(await page.evaluate(() => (window as any).fixture.session("f-2").generationRecovery), "interrupted")

    // An Interrupted-only branch has a plain chevron and the same keyboard action.
    const other = page.locator('[data-session-id="parent-g"] .session-item-expander')
    assert.equal(await other.getAttribute("data-child-activity"), null)
    assert.equal(await other.getAttribute("aria-label"), "Expand session")
    assert.equal(await other.getAttribute("title"), "Expand")
    assert.equal(await other.getAttribute("data-toggle-sweep"), null)
    await other.focus()
    await page.keyboard.press("Space")
    assert.equal(await other.getAttribute("aria-expanded"), "true")
    assert.equal(await badge(page, "g-1").innerText(), "INTERRUPTED")
    await page.keyboard.press("Enter")
    assert.equal(await other.getAttribute("aria-expanded"), "false")
    assert.deepEqual(await selected(page), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("opening and viewing keeps Interrupted until explicitly cleared, including a new interruption", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  try {
    const errors = await open(page)
    await page.locator('[data-session-id="interrupted-b"] .session-item-select').click()
    assert.equal(await badge(page, "interrupted-b").innerText(), "INTERRUPTED", "opening keeps a restored interruption without an Idle marker")
    await page.evaluate(() => (window as any).fixture.idle("interrupted-b"))
    await page.waitForFunction(() => (window as any).fixture.session("interrupted-b").idleSince === null)
    assert.equal(await badge(page, "interrupted-b").innerText(), "INTERRUPTED", "viewing an Idle marker keeps Interrupted")
    await badge(page, "interrupted-b").click()
    assert.equal(await badge(page, "interrupted-b").count(), 0)
    await page.evaluate(() => (window as any).fixture.refresh("interrupted-b"))
    assert.equal(await badge(page, "interrupted-b").count(), 0, "a refresh does not resurrect it")
    await page.locator('[data-session-id="viewed"] .session-item-select').click()
    await page.locator('[data-session-id="interrupted-b"] .session-item-select').click()
    assert.equal(await badge(page, "interrupted-b").count(), 0, "reopening preserves the explicit clear")

    await page.evaluate(() => (window as any).fixture.interrupt("interrupted-b"))
    await page.waitForFunction(() => document.querySelector('[data-session-id="interrupted-b"] .session-status')?.textContent?.includes("Interrupted"))
    await badge(page, "interrupted-b").click()
    assert.equal(await badge(page, "interrupted-b").count(), 0)
    assert.deepEqual(await selected(page), ["interrupted-b", "viewed", "interrupted-b"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("opening an Idle session still clears its badge after the existing fade", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  try {
    const errors = await open(page)
    await page.locator('[data-session-id="idle-a"] .session-item-select').click()
    await page.waitForFunction(() => (window as any).fixture.session("idle-a").idleSince === null)
    await badge(page, "idle-a").waitFor({ state: "hidden" })
    assert.deepEqual(await selected(page), ["idle-a"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
