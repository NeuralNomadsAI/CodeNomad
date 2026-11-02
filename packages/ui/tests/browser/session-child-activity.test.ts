import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  const fixture = await borrowFixture({
      name: "session-child-activity",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/session-child-activity.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await cache?.dispose() } })

test("a collapsed parent's chevron carries visible subsession statuses without reshaping the list", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  const rows = () => page.locator(".session-item-base").evaluateAll(elements => elements.map(el => el.getAttribute("data-session-id")))
  const chevron = (sessionId: string) => page.locator(`[data-session-id="${sessionId}"] .session-item-expander`)
  const color = (sessionId: string) => chevron(sessionId).evaluate(el => getComputedStyle(el).color)
  // The chevron transitions its colour; wait until it settles on the status token.
  const settlesOn = (sessionId: string, token: string) => page.waitForFunction(([id, name]) => {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    return getComputedStyle(document.querySelector(`[data-session-id="${id}"] .session-item-expander`)!).color === expected
  }, [sessionId, token] as const)
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.locator('[data-session-id="other"]').waitFor()
    assert.deepEqual(await rows(), ["work", "other"])
    const workBox = await page.locator('[data-session-id="work"]').boundingBox()
    const idleColor = await color("other")
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)
    assert.equal(await chevron("other").getAttribute("aria-label"), "Expand session")

    // A subsession of another conversation starts: nothing opens, the collapsed parent's chevron is coloured.
    await page.evaluate(() => (window as any).fixture.status("other-grandchild", "working"))
    await page.waitForFunction(() => document.querySelector('[data-session-id="other"] .session-item-expander')?.getAttribute("data-child-activity") === "working")
    assert.deepEqual(await rows(), ["work", "other"])
    assert.deepEqual(await page.locator('[data-session-id="work"]').boundingBox(), workBox)
    assert.equal(await chevron("other").getAttribute("aria-label"), "Expand session — 1 subsession working")
    assert.equal(await chevron("other").getAttribute("title"), "Expand — 1 subsession working")
    await settlesOn("other", "--session-status-working-fg")
    assert.notEqual(await color("other"), idleColor)
    assert.equal(await chevron("other").locator(".disclosure-chevron").evaluate(el => getComputedStyle(el).animationName), "pulse")
    // No extra badge: the parent's own status area is untouched.
    assert.equal(await page.locator('[data-session-id="other"] .session-item-badges > *').count(), 0)

    // Input requests outrank work, stay steady and are counted in the label.
    await page.evaluate(() => (window as any).fixture.permission("other-child", true))
    await page.waitForFunction(() => document.querySelector('[data-session-id="other"] .session-item-expander')?.getAttribute("data-child-activity") === "permission")
    assert.equal(await chevron("other").getAttribute("aria-label"), "Expand session — 1 subsession needs input, 1 subsession working")
    await settlesOn("other", "--session-status-permission-fg")
    assert.equal(await chevron("other").locator(".disclosure-chevron").evaluate(el => getComputedStyle(el).animationName), "none")
    if (process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE })

    // Expanding restores a plain chevron; the child rows show their own state.
    await chevron("other").click()
    await page.locator('[data-session-id="other-child"]').waitFor()
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)
    assert.equal(await chevron("other").getAttribute("aria-label"), "Collapse session")
    assert.equal(await chevron("other-child").getAttribute("data-child-activity"), "working")

    // Completing the nested helper turns its collapsed ancestors green, just like its Idle tag.
    await page.evaluate(() => {
      ;(window as any).fixture.permission("other-child", false)
      ;(window as any).fixture.status("other-grandchild", "idle")
    })
    await settlesOn("other-child", "--session-status-idle-fg")
    assert.equal(await chevron("other-child").getAttribute("aria-label"), "Expand session — 1 subsession idle")
    await chevron("other-child").click()
    await page.locator('[data-session-id="other-grandchild"] .session-idle').waitFor()
    assert.equal(await chevron("other-child").getAttribute("data-child-activity"), null)
    await chevron("other").click()
    await settlesOn("other", "--session-status-idle-fg")
    assert.equal(await chevron("other").locator(".disclosure-chevron").evaluate(el => getComputedStyle(el).animationName), "none")
    if (process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE })

    // Work and input still outrank idle. Clearing the last unseen idle removes the green hint.
    await page.evaluate(() => (window as any).fixture.status("other-child", "compacting"))
    await settlesOn("other", "--session-status-compacting-fg")
    await page.evaluate(() => (window as any).fixture.permission("other-child", true))
    await settlesOn("other", "--session-status-permission-fg")
    await page.evaluate(() => {
      ;(window as any).fixture.permission("other-child", false)
      ;(window as any).fixture.status("other-child", "idle")
    })
    await settlesOn("other", "--session-status-idle-fg")
    assert.equal(await chevron("other").getAttribute("aria-label"), "Expand session — 2 subsessions idle")
    await page.evaluate(() => {
      ;(window as any).fixture.seen("other-child")
      ;(window as any).fixture.seen("other-grandchild")
    })
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)

    // Follow the existing idle visibility preference, including the seen-badge fade.
    await page.evaluate(() => (window as any).fixture.idle("other-grandchild", 1))
    await settlesOn("other", "--session-status-idle-fg")
    await page.evaluate(() => (window as any).fixture.keepIdle(false))
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)
    await page.evaluate(() => (window as any).fixture.idle("other-grandchild", Date.now()))
    await settlesOn("other", "--session-status-idle-fg")
    await page.waitForFunction(() => !document.querySelector('[data-session-id="other"] .session-item-expander')?.hasAttribute("data-child-activity"), undefined, { timeout: 8000 })
    await page.evaluate(() => (window as any).fixture.idle("other-grandchild", 1))
    await page.evaluate(() => (window as any).fixture.fade("other-grandchild"))
    await settlesOn("other", "--session-status-idle-fg")
    await page.evaluate(() => {
      ;(window as any).fixture.seen("other-grandchild")
      ;(window as any).fixture.endFade("other-grandchild", 1)
    })
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)

    // Neither interrupted nor retrying badges may be misrepresented as green idle.
    for (const extra of [{ generationRecovery: "interrupted" }, { retry: { attempt: 1, message: "Retry", next: 0 } }]) {
      await page.evaluate(extra => (window as any).fixture.idle("other-grandchild", Date.now(), extra), extra)
      assert.equal(await chevron("other").getAttribute("data-child-activity"), null)
    }

    // A new activity in the viewed conversation reveals it without pointer interaction.
    await page.mouse.move(1100, 850)
    await page.evaluate(() => (window as any).fixture.status("work-child", "working"))
    await page.locator('[data-session-id="work-child"]').waitFor()
    assert.deepEqual((await rows()).slice(0, 2), ["work", "work-child"])
    assert.deepEqual(await page.locator('[data-session-id="work"]').boundingBox(), workBox)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("visible branches follow new chevron states recursively, restore all opened levels and can be disabled in General", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  const row = (id: string) => page.locator(`[data-session-id="${id}"]`)
  const chevron = (id: string) => row(id).locator(".session-item-expander")
  const expanded = () => chevron("work").getAttribute("aria-expanded")
  const status = (value: string) => page.evaluate(value => (window as any).fixture.status("work-grandchild", value), value)
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const option = page.getByRole("checkbox", { name: "Automatically expand subsessions", exact: true })
    assert.equal(await option.isChecked(), true, "enabled by default in General")

    // A transition opens every required level without hover.
    await page.mouse.move(1100, 850)
    await status("working")
    await row("work-grandchild").waitFor()
    assert.equal(await expanded(), "true")
    const saved = await page.evaluate(() => (window as any).fixture.expanded() as string[])
    assert.deepEqual(saved.sort(), ["work", "work-child"])
    await page.evaluate(saved => (window as any).fixture.restore(saved), saved)
    await row("work-grandchild").waitFor()

    // The visible grandchild is not selected. Its own chevron now becomes active:
    // only that branch needs opening, while its ancestors are already expanded.
    await page.evaluate(() => (window as any).fixture.status("work-great-grandchild", "working"))
    await row("work-great-grandchild").waitFor()
    assert.equal(await chevron("work-grandchild").getAttribute("aria-expanded"), "true")
    await chevron("work-grandchild").click()
    await settled()
    assert.equal(await chevron("work-grandchild").getAttribute("aria-expanded"), "false")
    await page.evaluate(() => (window as any).fixture.status("work-great-grandchild", "idle"))
    await page.evaluate(() => (window as any).fixture.form("work-great-grandchild", true))
    await row("work-great-grandchild").waitFor()
    // Keep the next root-level transition independent of that recursive helper.
    await page.evaluate(() => {
      ;(window as any).fixture.form("work-great-grandchild", false)
      ;(window as any).fixture.status("work-great-grandchild", "idle")
    })
    // A newly created recursive agent beneath a visible leaf opens that leaf too.
    await page.evaluate(() => (window as any).fixture.add("work-deep-agent", "work-great-grandchild", "working"))
    await row("work-deep-agent").waitFor()
    await page.evaluate(() => (window as any).fixture.status("work-deep-agent", "idle"))

    // Manual collapse itself is not a new status; a later start of the same helper reopens it.
    await chevron("work").click()
    await settled()
    assert.equal(await expanded(), "false")
    await row("work").locator(".session-item-title").hover()
    await status("working")
    await settled()
    assert.equal(await expanded(), "false")
    await status("idle")
    await status("working")
    await row("work-grandchild").waitFor()

    // Turning it off blocks both work and requests.
    await chevron("work").click()
    await option.uncheck()
    assert.equal(await page.evaluate(() => (window as any).fixture.preferences().autoExpandActiveSubsessions), false)
    await row("work").locator(".session-item-title").hover()
    await status("idle")
    await status("compacting")
    await page.evaluate(() => (window as any).fixture.permission("work-grandchild", true))
    await settled()
    assert.equal(await expanded(), "false")
    assert.equal(await chevron("work").getAttribute("data-child-activity"), "permission")
    await chevron("work").click()
    await row("work-grandchild").waitFor()
    await chevron("work").click()

    // Re-enabling during an existing request is not a status transition either.
    await option.check()
    await row("work").locator(".session-item-title").hover()
    await settled()
    assert.equal(await expanded(), "false")
    await page.evaluate(() => {
      ;(window as any).fixture.permission("work-grandchild", false)
      ;(window as any).fixture.status("work-grandchild", "idle")
    })
    await page.evaluate(() => (window as any).fixture.form("work-grandchild", true))
    await row("work-grandchild").waitFor()

    // A permission arriving after work started is a new chevron state too.
    await chevron("work").click()
    await row("work").locator(".session-item-title").hover()
    await page.evaluate(() => (window as any).fixture.form("work-grandchild", false))
    await page.evaluate(() => (window as any).fixture.permission("work-grandchild", true))
    await row("work-grandchild").waitFor()

    // Pointer position is irrelevant to a new transition.
    await chevron("work").click()
    await row("work").locator(".session-item-title").hover()
    await page.mouse.move(1100, 850)
    await page.evaluate(() => (window as any).fixture.permission("work-grandchild", false))
    await status("working")
    await settled()
    await row("work-grandchild").waitFor()
    assert.equal(await expanded(), "true")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("buffered offscreen subsessions wait for a fresh transition while visible", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  const row = page.locator('[data-session-id="work-grandchild"]')
  const chevron = row.locator(".session-item-expander")
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.status("work-grandchild", "working"))
    await row.waitFor()
    const top = await row.evaluate(el => {
      const viewport = el.closest(".session-list")!
      return viewport.scrollTop + el.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    })
    await page.locator(".session-list-container").evaluate(el => { el.parentElement!.style.height = "40px" })
    await page.evaluate(() => (window as any).fixture.status("work-great-grandchild", "working"))
    assert.equal(await chevron.getAttribute("aria-expanded"), "false", "a buffered row beyond the scroll viewport stays closed")
    await page.locator(".session-list").evaluate((el, top) => { el.scrollTop = top }, top)
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-session-id="work-grandchild"]')?.getBoundingClientRect()
      const viewport = document.querySelector(".session-list")?.getBoundingClientRect()
      return row && viewport && row.top < viewport.bottom && row.bottom > viewport.top
    })
    assert.equal(await chevron.getAttribute("aria-expanded"), "false", "scrolling into view alone does not open it")
    await page.evaluate(() => (window as any).fixture.status("work-great-grandchild", "idle"))
    await page.evaluate(() => (window as any).fixture.status("work-great-grandchild", "working"))
    assert.equal(await chevron.getAttribute("aria-expanded"), "true")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
