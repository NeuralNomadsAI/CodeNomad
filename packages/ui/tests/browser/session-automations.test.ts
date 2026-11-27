import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import type { SessionAutomation } from "../../../../server/src/opencode/automation-contract"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "session-automations",
    routes: [
      { path: "/automations-fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/session-automations.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const activeAuto: SessionAutomation = {
  id: "aut_active",
  name: "Check CI workflow and report any flaky Windows browser failure",
  status: "active",
  trigger: { type: "every", every: "10 minutes", tz: "Europe/Paris" },
  tz: "Europe/Paris",
  action: { type: "prompt", prompt: "Inspect the latest CI run and summarize failures." },
  runCount: 3,
  nextDueAt: Date.now() + 10 * 60 * 1000,
  lastRunAt: Date.now() - 2 * 60 * 1000,
  lastOutcome: "fired",
  lastOutput: "Build green on 12/12 jobs",
  createdAt: 1,
  updatedAt: 20,
}

const failedPausedAuto: SessionAutomation = {
  id: "aut_failed",
  name: "Nightly check",
  status: "paused",
  trigger: { type: "cron", cron: "0 7 * * *", tz: "Europe/Paris" },
  tz: "Europe/Paris",
  action: { type: "shell", command: "npm test" },
  runCount: 1,
  lastRunAt: Date.now() - 60 * 60 * 1000,
  lastOutcome: "failed",
  lastOutput: "Exit code 1: timeout",
  createdAt: 1,
  updatedAt: 10,
}

const doneAuto: SessionAutomation = {
  id: "aut_done",
  name: "Remind me about release tag",
  status: "done",
  trigger: { type: "at", at: "2026-11-26T18:00:00Z", tz: "UTC" },
  tz: "UTC",
  action: { type: "code", code: "return { done: true }" },
  runCount: 1,
  lastRunAt: Date.now() - 3 * 60 * 60 * 1000,
  lastOutcome: "fired",
  stateJson: "{\"notified\":true}",
  createdAt: 1,
  updatedAt: 5,
}

async function open(
  answers: Record<string, unknown>,
  options: {
    onAction?: (req: { sessionId: string; automationId: string; method: string; action: string }) => Promise<{ status?: number; body: unknown }> | { status?: number; body: unknown }
  } = {},
) {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  const reads: string[] = []
  const actions: Array<{ sessionId: string; automationId: string; method: string; action: string }> = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem("opencode-session-right-panel-tab-v2", "status"))
  await page.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname
    if (/\/api\/workspaces\/automation-fixture\/sessions\/[^/]+\/goal$/.test(pathname)) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "goal", goal: null }) })
    }
    const listMatch = pathname.match(/\/api\/workspaces\/automation-fixture\/sessions\/([^/]+)\/automations$/)
    if (listMatch) {
      const sessionId = decodeURIComponent(listMatch[1]!)
      reads.push(sessionId)
      const answer = answers[sessionId]
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(answer ?? { status: "ok", automations: [] }) })
    }
    const actionMatch = pathname.match(/\/api\/workspaces\/automation-fixture\/sessions\/([^/]+)\/automations\/([^/]+)(?:\/(pause|resume))?$/)
    if (actionMatch) {
      const entry = {
        sessionId: decodeURIComponent(actionMatch[1]!),
        automationId: decodeURIComponent(actionMatch[2]!),
        method: route.request().method(),
        action: actionMatch[3] ?? "delete",
      }
      actions.push(entry)
      const reply = options.onAction ? await options.onAction(entry) : { body: { status: "ok" } }
      return route.fulfill({ status: reply.status ?? 200, contentType: "application/json", body: JSON.stringify(reply.body) })
    }
    return route.fulfill({ contentType: "application/json", body: "{}" })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).automationsFixture))
  await page.getByRole("button", { name: /^Tokens\b/ }).waitFor()
  return { page, errors, reads, actions }
}

const block = (page: Page) => page.getByRole("group", { name: "Automations", exact: true })
const call = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(([name, values]) => (window as any).automationsFixture[name as string](...(values as unknown[])), [method, args] as const)
const waitFor = async (condition: () => Promise<boolean> | boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

test("hides completely when a session has no automations or the runtime does not support them", async () => {
  const { page, errors, reads } = await open({
    ses_auto: { status: "ok", automations: [] },
    ses_other: { status: "unsupported" },
  })
  try {
    await waitFor(() => reads.includes("ses_auto"), "reads active session automations")
    await page.waitForTimeout(100)
    assert.equal(await block(page).count(), 0)
    assert.equal(await page.locator(".status-tab-container > *").first().evaluate(el => el.classList.contains("right-panel-accordion")), true)
    await call(page, "select", "ses_other")
    await waitFor(() => reads.includes("ses_other"), "reads switched session")
    await page.waitForTimeout(100)
    assert.equal(await block(page).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("renders live rows above Tokens, folds Done, opens detail dialog, pauses/resumes with focus preservation and confirms delete", async () => {
  let list: SessionAutomation[] = [activeAuto, failedPausedAuto, doneAuto]
  let hold: Promise<void> | undefined, releaseHold: (() => void) | undefined
  const answers: Record<string, unknown> = {
    get ses_auto() { return { status: "ok", automations: list } },
    ses_other: { status: "ok", automations: [] },
  }
  const { page, errors, reads, actions } = await open(answers, {
    onAction: async (req) => {
      if (hold) await hold
      if (req.action === "pause") {
        list = list.map(item => item.id === req.automationId ? { ...item, status: "paused" } : item)
      } else if (req.action === "resume") {
        list = list.map(item => item.id === req.automationId ? { ...item, status: "active" } : item)
      } else if (req.action === "delete") {
        list = list.filter(item => item.id !== req.automationId)
      }
      return { body: { status: "ok" } }
    },
  })
  try {
    const group = block(page)
    await group.waitFor()
    // Failed row sorts first, then active; Done is folded until expanded.
    const rows = group.locator(".session-automation-row")
    assert.equal(await rows.count(), 2)
    assert.equal(await rows.nth(0).getAttribute("data-automation-id"), "aut_failed")
    assert.equal(await rows.nth(0).locator(".session-automation-badge").getAttribute("data-outcome"), "failed")
    assert.equal(await rows.nth(1).getAttribute("data-automation-id"), "aut_active")

    // Hover shows tooltip details.
    await rows.nth(1).locator(".session-automation-summary").hover()
    const tooltip = page.locator(".session-automation-tooltip")
    await tooltip.waitFor()
    assert.match(await tooltip.innerText(), /10 minutes/)
    assert.match(await tooltip.innerText(), /Build green/)
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: "hidden" })

    // Click opens the read-only OutputWindow detail dialog and Escape closes it.
    await rows.nth(1).locator(".session-automation-summary").click()
    const dialog = page.getByRole("dialog", { name: activeAuto.name })
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /Inspect the latest CI run/)
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })

    // Pause -> Resume preserves keyboard focus and ignores concurrent activation while busy.
    const activeRow = group.locator('[data-automation-id="aut_active"]')
    const toggle = await activeRow.getByRole("button", { name: "Pause automation" }).elementHandle()
    hold = new Promise<void>(resolve => { releaseHold = resolve })
    await toggle!.focus()
    await page.keyboard.press("Enter")
    await waitFor(async () => await toggle!.getAttribute("aria-disabled") === "true", "toggle marks busy while pause runs")
    assert.equal(await toggle!.evaluate(el => el === document.activeElement), true, "busy toggle keeps focus")
    await page.keyboard.press("Enter")
    await page.waitForTimeout(50)
    assert.equal(actions.length, 1, "busy toggle ignores duplicate Enter")
    releaseHold?.()
    hold = undefined
    await activeRow.getByRole("button", { name: "Resume automation" }).waitFor()
    await waitFor(async () => await toggle!.getAttribute("aria-disabled") !== "true", "toggle clears busy once pause settles")
    assert.equal(await toggle!.evaluate(el => el === document.activeElement && el.getAttribute("aria-label") === "Resume automation"), true)
    assert.equal(actions[0]?.action, "pause")

    // Expand Done disclosure and verify Done row has no Pause/Resume button.
    const doneToggle = group.getByRole("button", { name: "Done (1)" })
    await doneToggle.click()
    assert.equal(await doneToggle.getAttribute("aria-expanded"), "true")
    const doneRow = group.locator('[data-automation-id="aut_done"]')
    await doneRow.waitFor()
    assert.equal(await doneRow.getByRole("button", { name: /^(Pause|Resume) automation$/ }).count(), 0)

    // Delete confirms via AlertDialog before mutating.
    await doneRow.getByRole("button", { name: "Delete automation" }).click()
    await page.getByRole("button", { name: "Delete automation" }).last().click()
    await doneRow.waitFor({ state: "detached" })
    assert.equal(actions.at(-1)?.action, "delete")

    // Execution completion triggers a refresh for the active session.
    const readsBefore = reads.length
    await call(page, "executionSucceeded", "ses_auto")
    await waitFor(() => reads.length > readsBefore, "execution.succeeded refreshes automations")

    // Switching to another session hides the block.
    await call(page, "select", "ses_other")
    await group.waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("keeps Pause and Delete inside a narrow row even with a long MCP event trigger", async () => {
  const longEventAuto: SessionAutomation = {
    id: "aut_long_event",
    name: "Watch repository pull request events",
    status: "active",
    trigger: {
      type: "event",
      server: "very-long-mcp-server-identifier-for-notifications",
      event: "repository.pull_request.review_requested.and_checks_completed",
    },
    tz: "UTC",
    action: { type: "prompt", prompt: "Review updates" },
    runCount: 4,
    createdAt: 1,
    updatedAt: 2,
  }
  const { page, errors } = await open({ ses_auto: { status: "ok", automations: [longEventAuto] } })
  try {
    await page.setViewportSize({ width: 320, height: 700 })
    const row = block(page).locator('[data-automation-id="aut_long_event"]')
    await row.waitFor()
    const rowBox = await row.boundingBox()
    const pauseBox = await row.getByRole("button", { name: "Pause automation" }).boundingBox()
    const deleteBox = await row.getByRole("button", { name: "Delete automation" }).boundingBox()
    assert.ok(rowBox && pauseBox && deleteBox)
    assert.ok(pauseBox.x + pauseBox.width <= rowBox.x + rowBox.width + 1, "Pause stays inside row")
    assert.ok(deleteBox.x + deleteBox.width <= rowBox.x + rowBox.width + 1, "Delete stays inside row")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
