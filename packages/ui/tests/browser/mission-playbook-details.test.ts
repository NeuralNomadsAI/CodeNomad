import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import os from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { missionGeneralAction } from "./mission-actions"
import { missionPlaybookDetails } from "../../../server/src/missions/recipes"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "mission-playbook-details",
    routes: [{ path: "/mission-fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

/** A local desktop window whose playbook route answers, after `delay` ms, with the server's real recipe definitions. */
async function open(options: { fail?: number; delay?: number } = {}) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1200, height: 850 } })
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(60_000)
  const errors: string[] = [], reads: string[] = [], opened: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
    claimClientStateAccess: async () => true, loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }), saveClientState: async () => true } })`)
  await page.exposeFunction("recordOpen", (value: string) => { opened.push(value) })
  await page.addInitScript(`window.open = (value) => { window.recordOpen(String(value)); return null }`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: { location: { directory: "fixture" }, capability: null, effectiveDepth: null, project: null } }))
  await page.route("**/api/workspaces/fixture/missions**", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
  let failures = options.fail ?? 0
  await page.route("**/api/missions/playbooks*", async route => {
    const taskMode = new URL(route.request().url()).searchParams.get("taskMode") as "native" | "independent"
    reads.push(taskMode)
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay))
    if (failures-- > 0) return route.fulfill({ status: 503, json: { error: "unavailable" } })
    return route.fulfill({ json: missionPlaybookDetails(taskMode) })
  })
  await page.goto(url)
  await missionGeneralAction(page, "Create mission").click()
  await page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }).click()
  return { page, errors, reads, opened }
}

const screenshotPath = (name: string) => path.join(os.tmpdir(), "opencode", `${name}-${process.env.CODENOMAD_MISSION_CAPTURE_TAG ?? "updated"}.png`)
const reader = (page: Page) => page.locator(".mission-reader")
/** Steps, roles and instructions render together once the read for the shown task mode answers. */
const loaded = (page: Page) => reader(page).locator(".mission-playbook-steps > li").first().waitFor()
const instructions = (page: Page) => reader(page).locator("details.mission-playbook-instructions")
/** One recipient's fold inside the instructions. */
const prompt = (page: Page, title: string) => instructions(page).locator("details.mission-playbook-prompt")
  .filter({ has: page.locator(":scope > summary", { hasText: new RegExp(`^${title}$`) }) })
const promptText = async (page: Page, title: string) => (await prompt(page, title).locator("pre").allTextContents())

// The heading renders from the selected target at once; the steps, roles and instructions arrive with the read.
for (const delay of [0, 750] as const) test(`See details opens the selected playbook's steps and roles, with its exact instructions folded${delay ? `, after a ${delay} ms read` : ""}`, async () => {
  const { page, errors, reads, opened } = await open({ delay })
  try {
    const form = page.locator("form.mission-editor")
    await form.getByRole("combobox", { name: "Playbook", exact: true }).selectOption("debug")
    await form.getByRole("button", { name: "See details", exact: true }).click()
    await reader(page).getByRole("heading", { name: "Playbook: Debugging", exact: true }).waitFor()
    await loaded(page)
    const debug = missionPlaybookDetails("native").playbooks.find(playbook => playbook.id === "debug")!
    assert.deepEqual(await reader(page).locator(".mission-playbook-steps > li").allInnerTexts(), debug.sequence)
    assert.deepEqual(await reader(page).locator(".mission-playbook-roles > dt").allInnerTexts(),
      ["Coordinator", "Diagnostician", "Implementer", "Standards reviewer", "Specification reviewer", "Implementer continuation", "Fresh validator"])
    assert.deepEqual((await reader(page).locator(".mission-playbook-roles > dd").allInnerTexts()).slice(1), debug.roles.map(role => role.purpose))
    // The creation form stays open beside the reader.
    assert.equal(await form.isVisible(), true)
    await page.screenshot({ path: screenshotPath("mission-playbook-details") })

    // The complete English texts are folded until asked for, and are exactly the server's.
    assert.equal(await instructions(page).evaluate(element => (element as HTMLDetailsElement).open), false)
    assert.equal(await prompt(page, "Coordinator, one-time missions").isVisible(), false)
    await instructions(page).locator(":scope > summary").click()
    assert.deepEqual(await instructions(page).locator(":scope > details > summary").allInnerTexts(),
      ["Coordinator, one-time missions", "Coordinator, daily runs", "Diagnostician", "Implementer", "Standards reviewer", "Specification reviewer",
        "Implementer continuation", "Fresh validator"])
    assert.equal(await prompt(page, "Diagnostician").evaluate(element => (element as HTMLDetailsElement).open), false)
    assert.deepEqual(await promptText(page, "Coordinator, one-time missions"), [debug.prompts.coordinator.once])
    assert.deepEqual(await promptText(page, "Coordinator, daily runs"), [debug.prompts.coordinator.daily])
    // A native task's whole assignment, its reporting epilogue included; no independent session context.
    assert.deepEqual(await promptText(page, "Diagnostician"), [debug.prompts.roles.diagnostician.assignment])
    assert.match(debug.prompts.roles.diagnostician.assignment, /Complete only this task\..*ordinary native subagent result/s)
    await prompt(page, "Diagnostician").locator(":scope > summary").click()
    assert.equal(await prompt(page, "Diagnostician").locator("pre").getAttribute("lang"), "en")
    await reader(page).getByText("As sent with Native subagents.", { exact: false }).waitFor()
    await page.screenshot({ path: screenshotPath("mission-playbook-instructions") })

    await reader(page).getByRole("button", { name: "Read the guide to this playbook", exact: true }).click()
    for (const start = Date.now(); !opened.length && Date.now() - start < 5_000;) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(opened, ["https://neuralnomadsai.github.io/CodeNomad/en/playbooks.html#debug"])

    // Another playbook and task-session policy replace the details; the coordinator contract follows the policy.
    await form.getByRole("combobox", { name: "Playbook", exact: true }).selectOption("wayfinder")
    await form.getByRole("combobox", { name: "Task sessions", exact: true }).selectOption("independent")
    await form.getByRole("button", { name: "See details", exact: true }).click()
    await reader(page).getByRole("heading", { name: "Playbook: Exploration", exact: true }).waitFor()
    await loaded(page)
    if (!await instructions(page).evaluate(element => (element as HTMLDetailsElement).open)) await instructions(page).locator(":scope > summary").click()
    const wayfinder = missionPlaybookDetails("independent").playbooks.find(playbook => playbook.id === "wayfinder")!
    assert.deepEqual(await promptText(page, "Coordinator, one-time missions"), [wayfinder.prompts.coordinator.once])
    assert.match(wayfinder.prompts.coordinator.once, /persisted user-selected taskMode is independent/)
    // An independent task: its assignment, which reports through mission.report, and its per-turn session context.
    assert.deepEqual(await prompt(page, "Decision worker").locator("h4").allTextContents(), ["Assignment message", "Every turn of its independent session"])
    assert.deepEqual(await promptText(page, "Decision worker"), [wayfinder.prompts.roles.decision.assignment, wayfinder.prompts.roles.decision.session])
    assert.match(wayfinder.prompts.roles.decision.assignment, /When finished, call mission\.report/)
    assert.deepEqual(reads, ["native", "independent"])

    await reader(page).getByRole("button", { name: "Back to chat", exact: true }).click()
    await reader(page).waitFor({ state: "detached" })
    assert.equal(await form.isVisible(), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// Revealing the reader can close a narrow panel, which ends the view a creation completes in.
for (const status of [200, 400] as const) test(`See details waits for an in-flight creation, whose delayed ${status === 200 ? "success closes" : "rejection reopens"} the form`, async () => {
  const { page, errors } = await open()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => {
    void page.route("**/api/workspaces/fixture/missions", async route => {
      if (route.request().method() !== "POST") return route.fallback()
      const body = route.request().postDataJSON()
      resolve(); await held
      return status === 400 ? route.fulfill({ status, json: { error: "Invalid mission creation request" } })
        : route.fulfill({ json: { mission: { version: 1, id: "msn_created", projectID: "project", projectCanonical: "fixture", objective: body.objective,
          template: "custom", status: "active", runState: "prepared", coordinatorSessionId: "ses_coordinator", revision: 1, createdAt: 1, updatedAt: 1,
          history: [], historyTruncated: false, frontier: [], claims: [], actors: [], tasks: [], reports: [] } } })
    })
  })
  try {
    const form = page.locator("form.mission-editor"), details = form.getByRole("button", { name: "See details", exact: true })
    await form.locator("textarea").first().fill("Delayed creation")
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await reached
    assert.equal(await details.isDisabled(), true)
    // A programmatic click on the disabled button must not open the reader or end the creation's view.
    await details.evaluate(button => (button as HTMLButtonElement).click())
    release()
    if (status === 200) await form.waitFor({ state: "detached" })
    else {
      await form.getByRole("alert").filter({ hasText: /./ }).waitFor()
      await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
      assert.equal(await details.isDisabled(), false)
    }
    assert.equal(await reader(page).count(), 0)
    assert.deepEqual(errors, [])
  } finally { release(); await page.close() }
})

test("an unavailable playbook read is reported and retried only on request", async () => {
  const { page, errors, reads } = await open({ fail: 1 })
  try {
    await page.locator("form.mission-editor").getByRole("button", { name: "See details", exact: true }).click()
    await reader(page).getByRole("heading", { name: "Playbook: Flexible mission", exact: true }).waitFor()
    await reader(page).getByRole("alert").filter({ hasText: "The playbook could not be loaded." }).waitFor()
    assert.deepEqual(reads, ["native"])
    await reader(page).getByRole("button", { name: "Retry", exact: true }).click()
    await reader(page).locator(".mission-playbook-roles > dt").filter({ hasText: /^Tasks$/ }).waitFor()
    assert.deepEqual(reads, ["native", "native"])
    assert.equal(await reader(page).getByRole("alert").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
