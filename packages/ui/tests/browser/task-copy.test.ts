import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { TASK_STEP_MOUNT_LIMIT } from "../../src/components/tool-call/renderers/task-summary"

let browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  const fixture = await borrowFixture({
      name: "task-copy",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/task-copy.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await cache?.dispose() })

async function withPage(run: (page: Page) => Promise<void>, scenario?: string) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    // Outside the tiered runner the standalone daemon skips warmup; the first
    // fixture page of such a run pays the cold dependency graph.
    await page.goto(scenario ? `${url}?steps=${scenario}` : url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Task-copy fixture failure", errors, await page.evaluate(() => ({
      state: (window as any).fixture?.snapshot(),
      text: document.querySelector("main")?.textContent?.slice(0, 2500),
      tools: Array.from(document.querySelectorAll(".tool-call")).slice(0, 5).map(element => ({
        part: element.getAttribute("data-part-id"), expanded: element.querySelector(".tool-call-header-toggle")?.getAttribute("aria-expanded"),
      })),
    })))
    throw error
  } finally { await page.close() }
}

test("short native child boundary cursor does not invent render overflow", { timeout: 45_000 }, async () => withPage(async page => {
  const tool = page.locator('.tool-call[data-part-id="parent-task"]')
  const sections = tool.locator('.tool-call-task-sections').first()
  const steps = sections.locator(':scope > section').filter({ has: page.locator('.tool-call-task-section-title', { hasText: /^Steps$/ }) })
  await steps.waitFor()
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "1 step")
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
  assert.match(await sections.textContent() ?? "", /Validated result:.*484/)
  const state = await page.evaluate(() => (window as any).fixture.snapshot())
  assert.equal(state.requests.filter((request: any) => request.sessionID === "child").length, 1)
  // The cursor is merely a boundary token: a bounded older read is empty.
  await page.evaluate(() => (window as any).fixture.probeOlder())
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "1 step")
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).requests.filter((request: any) => request.sessionID === "child").length, 2)
}, "short"))

test("a background subagent card shows the child's latest report instead of its launch acknowledgement", { timeout: 45_000 }, async () => withPage(async page => {
  const tool = page.locator('.tool-call[data-part-id="parent-task"]')
  const output = tool.locator('.tool-call-task-sections section[data-subagent-report]')
  await output.waitFor()
  assert.equal(await output.getAttribute("data-subagent-report"), "running")
  assert.match(await output.textContent() ?? "", /Partial findings.*Background work still running/s)
  assert.doesNotMatch(await tool.textContent() ?? "", /working in the background/)
  // A later idle period's final report replaces it live, through the native event stream.
  await page.evaluate(() => (window as any).fixture.report("completed", "Final answer: 42"))
  await page.waitForFunction(() => document.querySelector('.tool-call[data-part-id="parent-task"] section[data-subagent-report]')?.getAttribute("data-subagent-report") === "completed")
  assert.match(await output.textContent() ?? "", /Final answer: 42/)
  assert.doesNotMatch(await output.textContent() ?? "", /Partial findings/)
  // The synthetic reports stay hidden from the transcript: the result appears once, in the card.
  assert.equal(((await page.locator("main").textContent()) ?? "").split("Final answer: 42").length - 1, 1)
  // An authoritative reload keeps the same latest report.
  await page.evaluate(() => (window as any).fixture.reload())
  assert.equal(await output.getAttribute("data-subagent-report"), "completed")
  assert.match(await output.textContent() ?? "", /Final answer: 42/)
  // Continuing the same child gives the new call its own report; the first card keeps its result.
  await page.evaluate(() => (window as any).fixture.continueChild("Continued result"))
  const continued = page.locator('.tool-call[data-part-id="continued-task"] section[data-subagent-report]')
  await continued.waitFor()
  assert.match(await continued.textContent() ?? "", /Continued result/)
  assert.match(await output.textContent() ?? "", /Final answer: 42/)
  assert.doesNotMatch(await output.textContent() ?? "", /Continued result/)
  await page.evaluate(() => (window as any).fixture.report("error", "Child failed"))
  await page.waitForFunction(() => document.querySelector('.tool-call[data-part-id="continued-task"] section[data-subagent-report]')?.getAttribute("data-subagent-report") === "error")
  assert.equal(await output.getAttribute("data-subagent-report"), "completed")
}, "background"))

test("a background subagent's header stays running until the child session settles, across continuations", { timeout: 45_000 }, async () => withPage(async page => {
  const headerStatus = (part: string) => page.locator(`.tool-call[data-part-id="${part}"] > .tool-call-header .tool-call-header-status`)
  const parent = headerStatus("parent-task")
  await parent.waitFor()
  // The launch acknowledgement never completes the card: the child session still owns the work.
  assert.equal(await parent.getAttribute("data-status"), "running")
  assert.equal(await parent.getAttribute("aria-label"), "Running")
  // The live timer counts from the delegation start, ticks, and survives re-entering the session.
  const duration = page.locator('.tool-call[data-part-id="parent-task"] > .tool-call-header .part-duration')
  await duration.waitFor()
  assert.equal(await duration.getAttribute("data-live"), "true")
  const durationSeconds = () => page.evaluate(() => {
    const text = document.querySelector('.tool-call[data-part-id="parent-task"] > .tool-call-header .part-duration')?.textContent ?? ""
    const match = /^(\d+)m (\d+)s$/.exec(text)
    return match ? Number(match[1]) * 60 + Number(match[2]) : NaN
  })
  const beforeLeave = await durationSeconds()
  assert.ok(Number.isFinite(beforeLeave) && beforeLeave >= 60, `the duration counts from the delegation start (${beforeLeave}s)`)
  await page.waitForFunction(start => {
    const text = document.querySelector('.tool-call[data-part-id="parent-task"] > .tool-call-header .part-duration')?.textContent ?? ""
    const match = /^(\d+)m (\d+)s$/.exec(text)
    return Boolean(match && Number(match[1]) * 60 + Number(match[2]) > start)
  }, beforeLeave, { timeout: 5_000 })
  await page.evaluate(() => (window as any).fixture.selectSession("other"))
  for (let index = 0; index < 5; index++) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  }
  await page.evaluate(() => (window as any).fixture.selectSession("parent"))
  await parent.waitFor()
  assert.equal(await parent.getAttribute("data-status"), "running", "re-entering keeps the running state")
  const afterReturn = await durationSeconds()
  assert.ok(Number.isFinite(afterReturn) && afterReturn >= beforeLeave, `the timer resumes from the delegation start, not from remount (${afterReturn}s >= ${beforeLeave}s)`)
  await page.waitForFunction(start => {
    const text = document.querySelector('.tool-call[data-part-id="parent-task"] > .tool-call-header .part-duration')?.textContent ?? ""
    const match = /^(\d+)m (\d+)s$/.exec(text)
    return Boolean(match && Number(match[1]) * 60 + Number(match[2]) > start)
  }, afterReturn, { timeout: 5_000 })
  // A full browser restart resumes the same accumulated timer: the delegation instant and
  // the reports are daemon-persisted message data, rebuilt by the cold store's page read.
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await parent.waitFor()
  assert.equal(await parent.getAttribute("data-status"), "running", "a cold start still shows the child running")
  assert.equal(await duration.getAttribute("data-live"), "true")
  const afterReload = await durationSeconds()
  assert.ok(Number.isFinite(afterReload) && afterReload >= beforeLeave, `the restart resumes the persisted delegation instant (${afterReload}s >= ${beforeLeave}s)`)
  await page.waitForFunction(start => {
    const text = document.querySelector('.tool-call[data-part-id="parent-task"] > .tool-call-header .part-duration')?.textContent ?? ""
    const match = /^(\d+)m (\d+)s$/.exec(text)
    return Boolean(match && Number(match[1]) * 60 + Number(match[2]) > start)
  }, afterReload, { timeout: 5_000 })
  // The child's first termination is what marks the card completed.
  await page.evaluate(() => (window as any).fixture.report("completed", "Final answer: 42"))
  await page.waitForFunction(() => document.querySelector('.tool-call[data-part-id="parent-task"] > .tool-call-header .tool-call-header-status')?.getAttribute("data-status") === "completed")
  // Continuing the same child returns the whole range of its cards to running.
  await page.evaluate(() => (window as any).fixture.continueChildQuiet())
  const continued = headerStatus("continued-task")
  await continued.waitFor()
  assert.equal(await parent.getAttribute("data-status"), "running")
  assert.equal(await continued.getAttribute("data-status"), "running")
  // The running display never drives the settled-session tool pull: the parts
  // stay settled, so no further parent-session message reads may happen.
  const parentReads = () => page.evaluate(() => (window as any).fixture.snapshot().requests.filter((request: any) => request.sessionID === "parent").length)
  const readsWhileRunning = await parentReads()
  for (let index = 0; index < 30; index++) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  }
  assert.equal(await parentReads(), readsWhileRunning)
  // The newest round's report settles the whole range together.
  await page.evaluate(() => (window as any).fixture.report("error", "Child failed"))
  await page.waitForFunction(() => {
    const parent = document.querySelector('.tool-call[data-part-id="parent-task"] > .tool-call-header .tool-call-header-status')
    const continued = document.querySelector('.tool-call[data-part-id="continued-task"] > .tool-call-header .tool-call-header-status')
    return parent?.getAttribute("data-status") === "error" && continued?.getAttribute("data-status") === "error"
  })
}, "background"))

test("a call continued before its first report shares the next report instead of running forever", { timeout: 45_000 }, async () => withPage(async page => {
  const first = page.locator('.tool-call[data-part-id="parent-task"] section[data-subagent-report]')
  await first.waitFor()
  assert.equal(await first.getAttribute("data-subagent-report"), "running")
  await page.evaluate(() => (window as any).fixture.continueChild("Joined result"))
  const continued = page.locator('.tool-call[data-part-id="continued-task"] section[data-subagent-report]')
  await continued.waitFor()
  await page.waitForFunction(() => document.querySelector('.tool-call[data-part-id="parent-task"] section[data-subagent-report]')?.getAttribute("data-subagent-report") === "completed")
  assert.match(await first.textContent() ?? "", /Joined result/)
  assert.match(await continued.textContent() ?? "", /Joined result/)
}, "background-quiet"))

test("exactly 200 observed child rows are not render overflow", { timeout: 45_000 }, async () => withPage(async page => {
  const sections = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-sections').first()
  const steps = sections.locator(':scope > section').filter({ has: page.locator('.tool-call-task-section-title', { hasText: /^Steps$/ }) })
  await steps.waitFor()
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "200 steps")
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
  // The list mounts its newest window; the gap reveals the omitted steps in place.
  const rows = steps.locator('.tool-call-task-summary > .tool-call')
  const gap = steps.locator('.message-hidden-parts')
  assert.equal(await rows.count(), TASK_STEP_MOUNT_LIMIT)
  assert.match(await gap.textContent() ?? "", new RegExp(`${200 - TASK_STEP_MOUNT_LIMIT} items hidden`))
  // Each reveal mounts one bounded step of the omitted rows.
  for (let reveals = 0; reveals < 3 && await gap.count() > 0; reveals += 1) {
    await gap.getByRole("button").click()
  }
  await steps.locator('.message-hidden-parts').waitFor({ state: "detached" })
  assert.equal(await rows.count(), 200)
}, "limit"))

test("text-only latest child window exposes full-history steps copy without claiming overflow", { timeout: 45_000 }, async () => withPage(async page => {
  const sections = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-sections').first()
  const steps = sections.locator(':scope > section').filter({ has: page.locator('.tool-call-task-section-title', { hasText: /^Steps$/ }) })
  await steps.waitFor()
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "0 steps")
  assert.equal(await steps.locator('.tool-call-task-summary > .tool-call').count(), 0)
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).requests.filter((request: any) => request.sessionID === "child").length, 1)
  await steps.getByRole("button", { name: "Copy tool output" }).click()
  await page.waitForFunction(() => (window as any).fixture.snapshot().clipboard.length === 1)
  const state = await page.evaluate(() => (window as any).fixture.snapshot())
  const copied = JSON.parse(state.clipboard[0])
  assert.equal(copied.length, 1)
  assert.equal(copied[0].id, "child-0000-tool")
  assert.equal(copied[0].state.output, `Untruncated child-0000: ${"長い output\n".repeat(500)}`)
  assert.equal(state.requests.filter((request: any) => request.ascending && request.sessionID === "child").length, 2)
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 0)
}, "text-tail"))

test("observed 201 child rows retain capped count and real truncation warning", { timeout: 45_000 }, async () => withPage(async page => {
  const sections = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-sections').first()
  const steps = sections.locator(':scope > section').filter({ has: page.locator('.tool-call-task-section-title', { hasText: /^Steps$/ }) })
  await steps.waitFor()
  assert.equal(await steps.locator('.tool-call-task-section-meta').textContent(), "200+ steps")
  assert.equal(await steps.locator('.tool-call-diagnostic-message').count(), 1)
  assert.equal(await steps.locator('.tool-call-task-summary > .tool-call').count(), TASK_STEP_MOUNT_LIMIT)
  assert.match(await steps.locator('.message-hidden-parts').textContent() ?? "", new RegExp(`${200 - TASK_STEP_MOUNT_LIMIT} items hidden`))
  assert.match(await steps.locator('.tool-call-diagnostic-message').textContent() ?? "", /200/)
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).requests.filter((request: any) => request.sessionID === "child").length, 1)
}, "overflow"))

async function copyButton(page: Page, nested: boolean) {
  const tool = page.locator(`.tool-call[data-part-id="${nested ? "nested-task" : "parent-task"}"]`)
  const toggle = tool.locator(":scope > .tool-call-header > .tool-call-header-toggle")
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click()
  return tool.locator(".tool-call-task-sections").first()
    .locator(":scope > section > header .tool-call-io-actions > button").first()
}

test("nested task copies inherit the active parent conversation rather than selected child identity", { timeout: 45_000 }, async () => withPage(async page => {
  const button = await copyButton(page, true)
  await button.click()
  await page.waitForFunction(() => (window as any).fixture.snapshot().clipboard.length === 1)
  const state = await page.evaluate(() => (window as any).fixture.snapshot())
  assert.equal(state.selectedSession, "parent")
  const copied = JSON.parse(state.clipboard[0])
  assert.equal(copied.length, 230)
  assert.equal(copied[0].state.output, `Untruncated grandchild-0000: ${"長い output\n".repeat(500)}`)
  assert.equal(copied.at(-1).id, "grandchild-0229-tool")
  assert.equal(state.requests.filter((request: any) => request.ascending && request.sessionID === "grandchild").length, 2)
}))

for (const scenario of ["parent-session", "parent-instance", "nested-session", "nested-instance", "nested-unmount"] as const) {
  test(`${scenario} lifecycle cancels held full-copy reads and fences late clipboard writes`, { timeout: 45_000 }, async () => withPage(async page => {
    const nested = scenario.startsWith("nested")
    const sessionID = nested ? "grandchild" : "child"
    const button = await copyButton(page, nested)
    await page.evaluate(() => (window as any).fixture.hold())
    await button.click()
    await page.waitForFunction(sessionID => (window as any).fixture.snapshot().requests.some((request: any) =>
      request.ascending && request.sessionID === sessionID), sessionID)
    assert.equal(await button.isDisabled(), true)
    await page.evaluate(scenario => {
      const fixture = (window as any).fixture
      if (scenario.endsWith("instance")) fixture.setActiveInstance(false)
      else if (scenario.endsWith("unmount")) fixture.unmount()
      else fixture.selectSession("other")
    }, scenario)
    await page.waitForFunction(sessionID => (window as any).fixture.snapshot().requests.some((request: any) =>
      request.ascending && request.sessionID === sessionID && request.aborted), sessionID)
    await page.evaluate(() => (window as any).fixture.release())
    // Let the deliberately late transport response and consumer finalizers run.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.deepEqual(state.clipboard, [])
    assert.equal(state.requests.filter((request: any) => request.ascending && request.sessionID === sessionID).length, 1)
  }))
}
