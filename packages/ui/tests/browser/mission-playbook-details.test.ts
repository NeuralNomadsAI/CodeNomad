import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import os from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
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

/** A local desktop window whose playbook route answers with the server's real recipe definitions. */
async function open(options: { fail?: number } = {}) {
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
  await page.route("**/api/missions/playbooks*", route => {
    const taskMode = new URL(route.request().url()).searchParams.get("taskMode") as "native" | "independent"
    reads.push(taskMode)
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
const instructions = (page: Page) => reader(page).locator("details.mission-playbook-instructions")
const prompt = (page: Page, title: string) => instructions(page).locator(".mission-playbook-prompt").filter({ has: page.locator("h4", { hasText: new RegExp(`^${title}$`) }) }).locator("pre")

test("See details opens the selected playbook's steps and roles, with its exact instructions folded", async () => {
  const { page, errors, reads, opened } = await open()
  try {
    const form = page.locator("form.mission-editor")
    await form.getByRole("combobox", { name: "Playbook", exact: true }).selectOption("debug")
    await form.getByRole("button", { name: "See details", exact: true }).click()
    await reader(page).getByRole("heading", { name: "Playbook: Debugging", exact: true }).waitFor()
    const debug = missionPlaybookDetails("native").playbooks.find(playbook => playbook.id === "debug")!
    assert.deepEqual(await reader(page).locator(".mission-playbook-steps > li").allInnerTexts(), debug.sequence)
    assert.deepEqual(await reader(page).locator(".mission-playbook-roles > dt").allInnerTexts(),
      ["Coordinator", "Diagnostician", "Implementer", "Standards reviewer", "Specification reviewer", "Implementer continuation", "Fresh validator"])
    assert.deepEqual((await reader(page).locator(".mission-playbook-roles > dd").allInnerTexts()).slice(1), debug.roles.map(role => role.purpose))
    // The creation form stays open beside the reader.
    assert.equal(await form.isVisible(), true)
    await page.screenshot({ path: screenshotPath("mission-playbook-details") })

    // The English prompt text is folded until asked for, and is exactly the server's.
    assert.equal(await instructions(page).evaluate(element => (element as HTMLDetailsElement).open), false)
    assert.equal(await prompt(page, "Coordinator").isVisible(), false)
    await instructions(page).locator(":scope > summary").click()
    const shared = missionPlaybookDetails("native")
    assert.equal(await prompt(page, "Coordinator").textContent(), [debug.coordinator, ...shared.coordinator].join("\n\n"))
    assert.equal(await prompt(page, "Coordinator, one-time missions only").textContent(), shared.oneTimeCoordinator)
    assert.equal(await prompt(page, "Diagnostician").textContent(), debug.roles[0].instructions)
    assert.equal(await prompt(page, "Diagnostician: report format").textContent(), debug.roles[0].reportContract)
    assert.equal(await prompt(page, "Every task assignment").textContent(), shared.task.join("\n\n"))
    assert.equal(await prompt(page, "Coordinator").getAttribute("lang"), "en")
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
    await instructions(page).waitFor()
    if (!await instructions(page).evaluate(element => (element as HTMLDetailsElement).open)) await instructions(page).locator(":scope > summary").click()
    const wayfinder = missionPlaybookDetails("independent").playbooks.find(playbook => playbook.id === "wayfinder")!
    assert.match(await prompt(page, "Coordinator").textContent() ?? "", /persisted user-selected taskMode is independent/)
    assert.equal((await prompt(page, "Coordinator").textContent())?.startsWith(wayfinder.coordinator), true)
    assert.deepEqual(reads, ["native", "independent"])

    await reader(page).getByRole("button", { name: "Back to chat", exact: true }).click()
    await reader(page).waitFor({ state: "detached" })
    assert.equal(await form.isVisible(), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
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
