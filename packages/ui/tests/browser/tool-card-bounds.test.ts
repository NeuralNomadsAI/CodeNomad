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

async function withPage(run: (page: Page) => Promise<void>, query?: string) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    // Outside the tiered runner the standalone daemon skips warmup; the first
    // fixture page of such a run pays the cold dependency graph.
    await page.goto(query ? `${url}?${query}` : url, { waitUntil: "domcontentloaded", timeout: 90_000 })
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

test("an incoming step never unmounts the row being read at the top", { timeout: 60_000 }, async () => withPage(async page => {
  const steps = sectionByTitle(page, /^Steps$/)
  await steps.waitFor()
  const container = steps.locator(".tool-call-task-container")
  const rows = steps.locator(".tool-call-task-summary > .tool-call")
  await rows.first().waitFor()

  // A reader at the top of the list holds focus on the oldest mounted row.
  // A programmatic scrollTop jump alone does not break bottom-following; an
  // upward gesture does, the way a reader scrolling up does.
  await container.evaluate(element => { element.scrollTop = 0 })
  await container.hover()
  await page.mouse.wheel(0, -5)
  await page.waitForTimeout(100)
  const oldest = rows.first()
  const oldestId = await oldest.getAttribute("data-part-id")
  const focusTarget = oldest.locator("button").first()
  await focusTarget.focus()
  assert.equal(await page.evaluate(() => document.activeElement?.textContent !== undefined), true)

  await page.evaluate(() => (window as any).fixture.pushChildSteps(1))
  await steps.locator(".tool-call-task-section-meta").filter({ hasText: "91 steps" }).waitFor()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))

  assert.equal(await rows.count(), TASK_STEP_MOUNT_LIMIT + 1, "the reading window appends without sliding")
  assert.equal(await steps.locator(`.tool-call[data-part-id="${oldestId}"]`).count(), 1, "the row being read stays mounted")
  const focusHeld = await page.evaluate(id => {
    const row = document.querySelector(`.tool-call[data-part-id="${id}"]`)
    return row ? row.contains(document.activeElement) : false
  }, oldestId)
  assert.ok(focusHeld, "focus stays with the row being read")
  assert.ok(await container.evaluate(element => element.scrollTop < 40), "the reading position stays at the top")

  // Leaving the row (releasing its focus) and scrolling back to the bottom
  // resumes the sliding window.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await container.evaluate(element => { element.scrollTop = element.scrollHeight })
  await container.hover()
  await page.mouse.wheel(0, 5)
  await page.waitForTimeout(100)
  await page.evaluate(() => (window as any).fixture.pushChildSteps(1))
  await steps.locator(".tool-call-task-section-meta").filter({ hasText: "92 steps" }).waitFor()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  assert.equal(await rows.count(), TASK_STEP_MOUNT_LIMIT, "following again bounds the mounted window")
}))

test("a search hit beyond the pane cap reveals the card's hidden text", { timeout: 60_000 }, async () => withPage(async page => {
  const output = sectionByTitle(page, /^Output$/)
  await output.waitFor()
  const outputPane = output.locator(".tool-call-task-section-body .tool-call-markdown")
  await outputPane.locator(".message-hidden-text").waitFor()

  // Paragraph 40 sits beyond the 20 000-character window; the transcript search must land on it.
  await page.keyboard.press("Control+f")
  const search = page.locator(".message-search-input")
  await search.waitFor()
  await search.fill("Report paragraph 40")
  // The debounced native history query lands asynchronously; wait for its count.
  await page.waitForFunction(() => /\d/.test(document.querySelector(".message-search-count")?.textContent ?? ""), undefined, { timeout: 10_000 })
  await page.keyboard.press("Enter")
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => {
    const sections = document.querySelectorAll('.tool-call[data-part-id="parent-task"] section')
    for (const section of sections) {
      if (section.textContent?.includes("Output")) {
        return (section.querySelector(".tool-call-markdown")?.textContent ?? "").includes("Report paragraph 40")
      }
    }
    return false
  }, undefined, { timeout: 15_000 })
  assert.equal(await outputPane.locator(".message-hidden-text").count(), 0,
    "the hit's block reveals instead of leaving the match outside the card")
}, "report=60"))

test("a selection survives steps past the revealed window's edge", { timeout: 90_000 }, async () => withPage(async page => {
  const steps = sectionByTitle(page, /^Steps$/)
  await steps.waitFor()
  const rows = steps.locator(".tool-call-task-summary > .tool-call")
  const container = steps.locator(".tool-call-task-container")
  await rows.first().waitFor()

  // Reveal once: 160 steps mount 130 rows, the gap keeps the remaining 30.
  await steps.locator(".message-hidden-parts").getByRole("button").click()
  await page.locator('.tool-call[data-part-id="child-0030-tool"]').waitFor()
  const rowsAfterReveal = await rows.count()
  assert.ok(rowsAfterReveal > TASK_STEP_MOUNT_LIMIT, `one reveal mounts a wide window (${rowsAfterReveal} rows)`)

  // The reader selects text in the leading row (step-30) — exactly the row
  // the old ceiling dropped. The selection pins wherever the row sits.
  const selected = await page.evaluate(() => {
    const row = document.querySelector('.tool-call[data-part-id="child-0030-tool"]')
    const node = row?.querySelector(".tool-call-summary-title")?.firstChild ?? row?.firstChild
    if (!node) return false
    const document_ = node.ownerDocument
    document_.getSelection()?.removeAllRanges()
    const range = document_.createRange()
    range.selectNodeContents(node)
    document_.getSelection()?.addRange(range)
    return true
  })
  assert.ok(selected, "the leading row's text is selected")

  for (const [total, batch] of [[161, 1], [171, 10]] as const) {
    await page.evaluate(count => (window as any).fixture.pushChildSteps(count), batch)
    await steps.locator(".tool-call-task-section-meta").filter({ hasText: `${total} steps` }).waitFor()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    assert.equal(await page.locator('.tool-call[data-part-id="child-0030-tool"]').count(), 1,
      `at ${total} steps the selected row stays mounted`)
    const selectionHeld = await page.evaluate(() => {
      const selection = document.getSelection()
      return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0)
    })
    assert.ok(selectionHeld, `at ${total} steps the selection survives`)
  }

  // Releasing the selection lets the window slide past the released row.
  await page.evaluate(() => {
    document.getSelection()?.removeAllRanges()
    ;(document.activeElement as HTMLElement | null)?.blur()
    const container = document.querySelector(".tool-call-task-container") as HTMLElement | null
    if (container) container.scrollTop = container.scrollHeight
  })
  await page.evaluate(() => (window as any).fixture.pushChildSteps(1))
  await steps.locator(".tool-call-task-section-meta").filter({ hasText: "172 steps" }).waitFor()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  assert.equal(await page.locator('.tool-call[data-part-id="child-0030-tool"]').count(), 0,
    "the released row leaves the window")
}, "steps=160"))

test("a focused parent-card button never collapses the steps window", { timeout: 60_000 }, async () => withPage(async page => {
  const steps = sectionByTitle(page, /^Steps$/)
  await steps.waitFor()
  const rows = steps.locator(".tool-call-task-summary > .tool-call")
  await rows.first().waitFor()

  // The parent card's own header button is outside the steps pane; focusing
  // it must not resolve a boundary of -1 and collapse the window.
  await page.locator('.tool-call[data-part-id="parent-task"] > .tool-call-header > .tool-call-header-toggle').focus()
  await page.evaluate(() => (window as any).fixture.pushChildSteps(1))
  await steps.locator(".tool-call-task-section-meta").filter({ hasText: "91 steps" }).waitFor()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))

  assert.equal(await rows.count(), TASK_STEP_MOUNT_LIMIT, "the window keeps its mounted bound")
  assert.match(await steps.locator(".message-hidden-parts").textContent() ?? "", new RegExp(`${91 - TASK_STEP_MOUNT_LIMIT} items hidden`))
}))

test("a selection survives the scan bound dropping the old anchor", { timeout: 90_000 }, async () => withPage(async page => {
  const steps = sectionByTitle(page, /^Steps$/)
  await steps.waitFor()
  await steps.locator(".tool-call-task-summary > .tool-call").first().waitFor()

  // 190 steps with one reveal mount 130 rows; the reader selects step-61.
  await steps.locator(".message-hidden-parts").getByRole("button").click()
  await page.locator('.tool-call[data-part-id="child-0061-tool"]').waitFor()
  const selected = await page.evaluate(() => {
    const row = document.querySelector('.tool-call[data-part-id="child-0061-tool"]')
    const node = row?.querySelector(".tool-call-summary-title")?.firstChild ?? row?.firstChild
    if (!node) return false
    const document_ = node.ownerDocument
    document_.getSelection()?.removeAllRanges()
    const range = document_.createRange()
    range.selectNodeContents(node)
    document_.getSelection()?.addRange(range)
    return true
  })
  assert.ok(selected, "step-61's text is selected")

  // Streaming to 261 steps drops the rows before step-61 from the 200-key
  // scan window — the protection must follow the selected row, not the old
  // window anchor.
  await page.evaluate(() => (window as any).fixture.pushChildSteps(71))
  // The paged message window loads the newest 200 messages, so the counter
  // tops out at the scan bound while the child itself has 261 steps.
  await steps.locator(".tool-call-task-section-meta").filter({ hasText: "200 steps" }).waitFor()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

  assert.equal(await page.locator('.tool-call[data-part-id="child-0061-tool"]').count(), 1,
    "the selected row stays mounted when the scan bound passes its neighbourhood")
  const selectionHeld = await page.evaluate(() => {
    const selection = document.getSelection()
    return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0)
  })
  assert.ok(selectionHeld, "the selection survives the scan bound")
}, "steps=190"))

test("a visible row in the middle of the list stays mounted", { timeout: 90_000 }, async () => withPage(async page => {
  const steps = sectionByTitle(page, /^Steps$/)
  await steps.waitFor()
  const container = steps.locator(".tool-call-task-container")
  await steps.locator(".tool-call-task-summary > .tool-call").first().waitFor()

  // One reveal mounts 130 of 160 steps; the reader scrolls up to step-65
  // with nothing focused or selected.
  await steps.locator(".message-hidden-parts").getByRole("button").click()
  await page.locator('.tool-call[data-part-id="child-0065-tool"]').waitFor()
  await container.evaluate(() => {
    const container = document.querySelector(".tool-call-task-container") as HTMLElement | null
    const row = document.querySelector('.tool-call[data-part-id="child-0065-tool"]') as HTMLElement | null
    if (container && row) {
      container.scrollTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    }
  })
  // A programmatic scroll alone keeps bottom-following; an upward gesture, the
  // way a real reader scrolling up reads, releases it.
  await container.hover()
  await page.mouse.wheel(0, -4)
  await page.waitForTimeout(200)

  await page.evaluate(() => (window as any).fixture.pushChildSteps(10))
  await steps.locator(".tool-call-task-section-meta").filter({ hasText: "170 steps" }).waitFor()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

  const visible = await page.evaluate(() => {
    const container = document.querySelector(".tool-call-task-container") as HTMLElement | null
    const row = document.querySelector('.tool-call[data-part-id="child-0065-tool"]') as HTMLElement | null
    if (!container || !row) return { mounted: Boolean(row), visible: false }
    const box = row.getBoundingClientRect(), top = container.getBoundingClientRect().top
    return { mounted: true, visible: box.bottom > top && box.top < container.getBoundingClientRect().bottom }
  })
  assert.ok(visible.mounted, "the row being read stays mounted")
  assert.ok(visible.visible, "the row being read stays in sight")
}, "steps=160"))

test("Show more after a search reveal extends the window further", { timeout: 90_000 }, async () => withPage(async page => {
  const output = sectionByTitle(page, /^Output$/)
  await output.waitFor()
  const outputPane = output.locator(".tool-call-task-section-body .tool-call-markdown")
  await outputPane.locator(".message-hidden-text").waitFor()

  // Paragraph 300 sits near 380 000 characters: beyond even the search step's
  // 270 000-character window, so the reader must be able to keep revealing.
  await page.keyboard.press("Control+f")
  const search = page.locator(".message-search-input")
  await search.waitFor()
  await search.fill("Report paragraph 60")
  await page.waitForFunction(() => /\d/.test(document.querySelector(".message-search-count")?.textContent ?? ""), undefined, { timeout: 10_000 })
  await page.keyboard.press("Enter")
  await page.keyboard.press("Escape")
  const searchWindowLength = await (page.waitForFunction(() => {
    const sections = document.querySelectorAll('.tool-call[data-part-id="parent-task"] section')
    for (const section of sections) {
      if (section.textContent?.includes("Output")) return (section.querySelector(".tool-call-markdown")?.textContent ?? "").length
    }
    return 0
  }, undefined, { timeout: 20_000 })).then(handle => handle.jsonValue() as Promise<number>)
  assert.ok(searchWindowLength > 200_000, `the search reveal widened the window (${searchWindowLength})`)

  const notice = outputPane.locator(".message-hidden-text")
  assert.equal(await notice.count(), 1, "a megabyte-scale report keeps its reveal line")
  await notice.getByRole("button").click()
  await page.waitForFunction(target => {
    const sections = document.querySelectorAll('.tool-call[data-part-id="parent-task"] section')
    for (const section of sections) {
      if (section.textContent?.includes("Output")) return (section.querySelector(".tool-call-markdown")?.textContent ?? "").length > target
    }
    return false
  }, ((searchWindowLength) + 100_000) as number, { timeout: 20_000 })
}, "report=490"))
