import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { TASK_PANE_RENDER_CHARACTER_LIMIT } from "../../src/lib/render-text-window"
import { TASK_STEP_MOUNT_LIMIT } from "../../src/components/tool-call/renderers/task-summary"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "tool-card-bounds",
    routes: [
      { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/tool-card-bounds.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function withPage(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    // Outside the tiered runner the standalone daemon skips warmup; the first
    // fixture page of such a run pays the cold dependency graph.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Tool-card-bounds fixture failure", errors, await page.evaluate(() => ({
      text: document.querySelector("main")?.textContent?.slice(0, 2500),
      rows: document.querySelectorAll(".tool-call-task-summary > .tool-call").length,
      notices: Array.from(document.querySelectorAll(".message-hidden-text, .message-hidden-parts")).map(element => element.textContent),
    })))
    throw error
  } finally { await page.close() }
}

const cardSections = (page: Page) => page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-sections').first()

const sectionByTitle = (page: Page, title: RegExp) =>
  cardSections(page).locator(":scope > section").filter({ has: page.locator(".tool-call-task-section-title", { hasText: title }) })

test("subagent card panes mount a bounded window of long prompt and report text", { timeout: 60_000 }, async () => withPage(async page => {
  const prompt = sectionByTitle(page, /^Prompt$/)
  await prompt.waitFor()
  const promptPane = prompt.locator(".tool-call-task-section-body .tool-call-markdown")
  const output = sectionByTitle(page, /^Output$/)
  await output.waitFor()
  const outputPane = output.locator(".tool-call-task-section-body .tool-call-markdown")

  for (const pane of [promptPane, outputPane]) {
    // Markdown renders async; the reveal line lands with its real render.
    await pane.locator(".message-hidden-text").waitFor()
    assert.equal(await pane.locator(".message-hidden-text").count(), 1, "a bounded pane shows the reveal line")
    const text = await pane.textContent()
    assert.ok(
      (text ?? "").length < TASK_PANE_RENDER_CHARACTER_LIMIT + 500,
      `pane mounts a bounded prefix, not the whole text (${(text ?? "").length} characters)`,
    )
  }

  // The report reveals in place to its full text; the native output stays copyable.
  await outputPane.getByRole("button", { name: "Show all" }).click()
  await outputPane.locator(".message-hidden-text").waitFor({ state: "detached" })
  assert.match(await outputPane.textContent() ?? "", /Report paragraph 49/)
  // The untouched prompt keeps its bounded window.
  assert.equal(await promptPane.locator(".message-hidden-text").count(), 1)
}))

test("the steps list mounts a bounded newest window with an in-place reveal", { timeout: 60_000 }, async () => withPage(async page => {
  const steps = sectionByTitle(page, /^Steps$/)
  await steps.waitFor()
  assert.equal(await steps.locator(".tool-call-task-section-meta").textContent(), "90 steps")

  const rows = steps.locator(".tool-call-task-summary > .tool-call")
  assert.equal(await rows.count(), TASK_STEP_MOUNT_LIMIT, "only the newest window of steps mounts")

  const gap = steps.locator(".message-hidden-parts")
  assert.equal(await gap.count(), 1, "the omitted gap renders a placeholder")
  assert.match(await gap.textContent() ?? "", new RegExp(`${90 - TASK_STEP_MOUNT_LIMIT} items hidden`))

  // The mounted DOM of the nested scroller stays bounded.
  const nodes = await steps.locator(".tool-call-task-container").evaluate(element => element.querySelectorAll("*").length)
  assert.ok(nodes < 2_500, `the steps scroller mounts a bounded subtree (${nodes} elements)`)

  await gap.getByRole("button").click()
  await steps.locator(".message-hidden-parts").waitFor({ state: "detached" })
  assert.equal(await rows.count(), 90, "the reveal mounts the whole step list")
  assert.equal(await steps.locator(".tool-call-task-section-meta").textContent(), "90 steps")
}))

test("revealed step and text windows persist across a remount", { timeout: 60_000 }, async () => withPage(async page => {
  const steps = sectionByTitle(page, /^Steps$/)
  await steps.waitFor()
  await steps.locator(".message-hidden-parts").getByRole("button").click()
  await steps.locator(".message-hidden-parts").waitFor({ state: "detached" })
  const output = sectionByTitle(page, /^Output$/)
  await output.locator(".message-hidden-text").getByRole("button", { name: "Show all" }).click()
  await output.locator(".message-hidden-text").waitFor({ state: "detached" })

  await page.evaluate(() => (window as any).fixture.remount())
  const remounted = sectionByTitle(page, /^Steps$/)
  await remounted.waitFor()
  assert.equal(await remounted.locator(".tool-call-task-summary > .tool-call").count(), 90, "revealed steps stay revealed")
  assert.equal(await remounted.locator(".message-hidden-parts").count(), 0)
  const outputAfter = sectionByTitle(page, /^Output$/)
  await outputAfter.waitFor()
  assert.equal(await outputAfter.locator(".message-hidden-text").count(), 0, "revealed report text stays revealed")
  assert.match(await outputAfter.textContent() ?? "", /Report paragraph 49/)
}))

test("streaming steps keep the fixed-height container following the newest step", { timeout: 60_000 }, async () => withPage(async page => {
  const steps = sectionByTitle(page, /^Steps$/)
  await steps.waitFor()
  const container = steps.locator(".tool-call-task-container")
  const box = await container.evaluate(element => {
    const style = getComputedStyle(element)
    return { maxHeight: style.maxHeight, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }
  })
  assert.notEqual(box.maxHeight, "none", "the steps container keeps its fixed height")
  assert.ok(box.scrollHeight > box.clientHeight, "the steps container still scrolls its overflow")

  await container.evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.evaluate(() => (window as any).fixture.pushChildSteps(3))
  await steps.locator(".tool-call-task-section-meta").filter({ hasText: "93 steps" }).waitFor()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))

  const follow = await container.evaluate(element => ({
    atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 4,
    newestVisible: Boolean(Array.from(element.querySelectorAll(".tool-call-summary-title")).at(-1)?.textContent?.includes("step-92")),
  }))
  assert.ok(follow.atBottom, "the container keeps following the newest step")
  assert.ok(follow.newestVisible, "the newest step is mounted and visible")
  assert.equal(await steps.locator(".tool-call-task-summary > .tool-call").count(), TASK_STEP_MOUNT_LIMIT,
    "the mounted window keeps its bound while the list grows")
}))
