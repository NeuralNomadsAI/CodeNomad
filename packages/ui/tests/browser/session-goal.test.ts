import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

// CODENOMAD_GOAL_SCREENSHOTS=<dir> captures the goal line's states.
const screenshots = process.env.CODENOMAD_GOAL_SCREENSHOTS
let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "session-goal",
    routes: [
      { path: "/goal-fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/session-goal.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  if (screenshots) mkdirSync(screenshots, { recursive: true })
})
after(async () => { await browser?.close() })

type Goal = { id: string; objective: string; status: "active" | "paused" | "complete"; reason?: string; rounds: number; maxRounds: number; updatedAt: number }
const objective = "Make every browser regression pass on Windows, then document the new Status line in all ten help translations"
const active: Goal = { id: "goal-1", objective, status: "active", rounds: 2, maxRounds: 50, updatedAt: 1 }
const paused: Goal = { ...active, status: "paused", reason: "Paused by the user", updatedAt: 2 }

/** The Status tab over a goal route the test answers; `answers` maps each session to its current reply. */
async function open(answers: Record<string, unknown>) {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  const reads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem("opencode-session-right-panel-tab-v2", "status"))
  await page.route("**/api/**", route => {
    const match = new URL(route.request().url()).pathname.match(/\/api\/workspaces\/goal-fixture\/sessions\/([^/]+)\/goal$/)
    if (!match) return route.fulfill({ contentType: "application/json", body: "{}" })
    const sessionId = decodeURIComponent(match[1]!)
    reads.push(sessionId)
    const answer = answers[sessionId]
    return answer === "error" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "down" }) })
      : route.fulfill({ contentType: "application/json", body: JSON.stringify(answer ?? { status: "goal", goal: null }) })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).goalFixture))
  await page.getByRole("button", { name: /^Tokens\b/ }).waitFor()
  return { page, errors, reads }
}

const line = (page: Page) => page.getByRole("group", { name: "Goal", exact: true })
const call = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(([name, values]) => (window as any).goalFixture[name as string](...(values as unknown[])), [method, args] as const)
const waitFor = async (condition: () => Promise<boolean> | boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(message)
}
const capture = async (page: Page, name: string) => {
  if (screenshots) await page.locator(".status-tab-container").screenshot({ path: path.join(screenshots, `${name}.png`) })
}

test("a session without a goal, or a runtime without the goal RPC, shows nothing at all", async () => {
  const { page, errors, reads } = await open({ ses_goal: { status: "goal", goal: null }, ses_other: { status: "unsupported" } })
  try {
    await waitFor(() => reads.includes("ses_goal"), "the shown session's goal is read")
    await page.waitForTimeout(100)
    assert.equal(await line(page).count(), 0)
    assert.equal(await page.locator(".session-goal-line").count(), 0)
    // Tokens stays the first thing in the tab: no hint, no gap.
    assert.equal(await page.locator(".status-tab-container > *").first().evaluate(element => element.classList.contains("right-panel-accordion")), true)
    await call(page, "select", "ses_other")
    await waitFor(() => reads.includes("ses_other"), "a newly shown session is read")
    await page.waitForTimeout(100)
    assert.equal(await page.locator(".session-goal-line").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the goal line sits above Tokens and drives /goal pause, resume and clear from its changes", async () => {
  const answers: Record<string, unknown> = { ses_goal: { status: "goal", goal: active } }
  const { page, errors, reads } = await open(answers)
  try {
    const goal = line(page)
    await goal.waitFor()
    // One row above the Tokens section.
    const tokens = page.getByRole("button", { name: /^Tokens\b/ })
    const [lineBox, tokensBox] = [await goal.boundingBox(), await tokens.boundingBox()]
    assert.ok(lineBox && tokensBox && lineBox.y + lineBox.height <= tokensBox.y + 1, "the line precedes Tokens")
    assert.ok(lineBox!.height <= 36, `one row, got ${lineBox!.height}px`)
    assert.equal(await page.locator(".status-tab-container > *").first().evaluate(element => element.classList.contains("session-goal-line")), true)
    assert.equal(await goal.locator(".session-goal-badge").innerText(), "Active")
    assert.equal(await goal.locator(".session-goal-objective").innerText(), objective)
    const ellipsis = await goal.locator(".session-goal-objective").evaluate(element => element.scrollWidth > element.clientWidth
      && getComputedStyle(element).textOverflow === "ellipsis")
    assert.equal(ellipsis, true, "a long objective is truncated on its one line")
    assert.match(await goal.locator(".session-goal-rounds").innerText(), /^2\/50/)
    assert.equal(await goal.locator(".session-goal-rounds").getAttribute("title"), "Round 2 of 50")
    assert.equal(await goal.getByRole("button", { name: "Resume goal" }).count(), 0)
    await capture(page, "goal-active")

    // Hover and focus show the whole objective.
    await goal.locator(".session-goal-summary").hover()
    const tooltip = page.locator(".session-goal-tooltip")
    await tooltip.waitFor()
    assert.match(await tooltip.innerText(), /document the new Status line in all ten help translations/)
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: "hidden" })

    // Pause by keyboard while the command is in flight: the line's actions wait for it,
    // and the busy toggle keeps focus.
    await call(page, "hold")
    const toggle = await goal.getByRole("button", { name: "Pause goal" }).elementHandle()
    await toggle!.focus()
    await page.keyboard.press("Enter")
    await waitFor(async () => (await call(page, "commands")).length === 1, "Pause sends the command")
    await waitFor(async () => await toggle!.getAttribute("aria-disabled") === "true", "the toggle is busy while its command runs")
    assert.equal(await goal.getByRole("button", { name: "Clear goal" }).getAttribute("aria-disabled"), "true")
    assert.equal(await toggle!.evaluate(element => element === document.activeElement), true, "the busy toggle keeps keyboard focus")
    await page.keyboard.press("Enter")
    // Activate Clear without moving focus off the toggle.
    await goal.getByRole("button", { name: "Clear goal" }).evaluate(element => (element as HTMLButtonElement).click())
    await page.waitForTimeout(50)
    assert.equal((await call(page, "commands")).length, 1, "busy actions ignore activation")
    const readsBeforeChange = reads.length
    answers.ses_goal = { status: "goal", goal: paused }
    await call(page, "changed", "ses_goal", paused)
    await call(page, "release")
    assert.deepEqual(await call(page, "commands"), [{ sessionID: "ses_goal", name: "goal", text: "pause", delivery: "steer" }])

    // The change updates the line: Paused, Resume, and the reason as its description and tooltip.
    const resume = goal.getByRole("button", { name: "Resume goal" })
    await resume.waitFor()
    await waitFor(async () => await resume.getAttribute("aria-disabled") !== "true", "actions return once the command settles")
    assert.equal(await toggle!.evaluate(element => element === document.activeElement && element.getAttribute("aria-label") === "Resume goal"), true,
      "focus stays on the same toggle, which now resumes")
    await waitFor(() => reads.length > readsBeforeChange, "the outcome is read after the command")
    assert.equal(await goal.locator(".session-goal-badge").innerText(), "Paused")
    const describedBy = await goal.getAttribute("aria-describedby")
    assert.ok(describedBy)
    assert.equal(await page.locator(`[id="${describedBy}"]`).innerText(), "Paused by the user")
    await goal.locator(".session-goal-summary").focus()
    await tooltip.waitFor()
    assert.match(await tooltip.innerText(), /Paused by the user/)
    await capture(page, "goal-paused-tooltip")
    await page.keyboard.press("Escape")

    await resume.click()
    await waitFor(async () => (await call(page, "commands")).length === 2, "Resume sends the command")
    assert.deepEqual((await call(page, "commands"))[1], { sessionID: "ses_goal", name: "goal", text: "resume", delivery: "steer" })
    const resumed = { ...active, rounds: 1, updatedAt: 3 }
    answers.ses_goal = { status: "goal", goal: resumed }
    await call(page, "changed", "ses_goal", resumed)
    await goal.getByRole("button", { name: "Pause goal" }).waitFor()
    assert.match(await goal.locator(".session-goal-rounds").innerText(), /^1\/50/)
    assert.equal(await goal.getAttribute("aria-describedby"), null)

    await goal.getByRole("button", { name: "Clear goal" }).click()
    await waitFor(async () => (await call(page, "commands")).length === 3, "Clear sends the command")
    assert.deepEqual((await call(page, "commands"))[2], { sessionID: "ses_goal", name: "goal", text: "clear", delivery: "steer" })
    answers.ses_goal = { status: "goal", goal: null }
    await call(page, "changed", "ses_goal", null)
    await goal.waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a completed goal keeps only Clear, a failed command shows its error and the line follows session switches and reconnects", async () => {
  const complete: Goal = { ...active, status: "complete", reason: "Every check passes", rounds: 7, updatedAt: 4 }
  const answers: Record<string, unknown> = { ses_goal: { status: "goal", goal: complete }, ses_other: { status: "goal", goal: null } }
  const { page, errors, reads } = await open(answers)
  try {
    const goal = line(page)
    await goal.waitFor()
    assert.equal(await goal.locator(".session-goal-badge").innerText(), "Complete")
    assert.equal(await goal.getByRole("button", { name: /^(Pause|Resume) goal$/ }).count(), 0)
    await capture(page, "goal-complete")

    await call(page, "failNext", "No goal is set.")
    await goal.getByRole("button", { name: "Clear goal" }).click()
    await page.getByText("No goal is set.", { exact: true }).waitFor()
    await waitFor(async () => await goal.getByRole("button", { name: "Clear goal" }).getAttribute("aria-disabled") !== "true", "a failed command releases the actions")

    // Another session has its own (no) goal; switching back shows this one again.
    await call(page, "select", "ses_other")
    await goal.waitFor({ state: "detached" })
    await call(page, "select", "ses_goal")
    await goal.waitFor()
    // A change heard while the stream was down is recovered by the reconnect read.
    const before = reads.filter(id => id === "ses_goal").length
    answers.ses_goal = { status: "goal", goal: { ...complete, status: "paused", reason: "The server restarted while the goal was active" } }
    await call(page, "reconnect")
    await waitFor(() => reads.filter(id => id === "ses_goal").length > before, "a reconnect re-reads the shown goal")
    await waitFor(async () => await goal.locator(".session-goal-badge").innerText() === "Paused", "the reconnect read is shown")
    // A failing read keeps the last goal shown.
    answers.ses_goal = "error"
    await call(page, "reconnect")
    await waitFor(() => reads.filter(id => id === "ses_goal").length > before + 1, "the next reconnect reads again")
    await page.waitForTimeout(100)
    assert.equal(await goal.locator(".session-goal-badge").innerText(), "Paused")
    // No conversation shown: nothing.
    await call(page, "select", null)
    await goal.waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
