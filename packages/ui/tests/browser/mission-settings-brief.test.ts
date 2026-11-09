import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { missionContentFixture, panelMissions } from "./mission-content-fixture"
import { missionMenuItem, missionToolbar } from "./mission-actions"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import type {} from "./fixtures/mission-editor-lifetime"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-settings-brief",
      routes: [
        { path: "/settings-brief", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-editor-lifetime.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); })

const profiles = { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m", variant: "high" } },
  roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } } }
const finished: MissionMap = { version: 1, id: "msn_done", projectID: "project", projectCanonical: "/fixture", title: "Dependency audit",
  objective: "Audit dependencies and report risky upgrades.", notes: "  Keep notes verbatim.\n", template: "custom", profiles, taskMode: "independent",
  status: "completed", runState: "stopped", summary: "All done", coordinatorSessionId: "ses_coordinator", revision: 9, createdAt: 1, updatedAt: 2,
  history: [], historyTruncated: false, frontier: [], claims: [], actors: [], tasks: [], reports: [] } as MissionMap

async function setup(page: Page, preferences: "accept" | "reject", initial: Record<string, unknown> = {}) {
  const errors: string[] = [], writes: Array<Record<string, any>> = [], missionWrites: string[] = []
  let settings: Record<string, unknown> = initial
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`window.__preferencesCalls=[];Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true,
    openPreferences:async(...args)=>{window.__preferencesCalls.push(JSON.parse(JSON.stringify(args)));${preferences === "reject" ? "throw new Error('Invalid preferences section')" : ""}}}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui*", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { settings } })
    const body = route.request().postDataJSON(), patch = new URL(route.request().url()).searchParams.get("conditional") ? body.patch : body
    writes.push(patch); settings = { ...settings, ...patch.settings }
    return route.fulfill({ json: { settings } })
  })
  await page.route("**/api/workspaces/fixture/missions**", route => {
    const request = route.request(), path = new URL(request.url()).pathname, content = missionContentFixture(request.url(), request.method(), [finished])
    if (content) return route.fulfill({ json: content })
    if (request.method() !== "GET") { missionWrites.push(path); return route.abort() }
    return route.fulfill({ json: path.endsWith("/missions/recurrence")
      ? recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] })
      : { available: true, projectID: "project", missions: panelMissions([finished]), generatedAt: 1, discardedEvents: 0 } })
  })
  await page.goto(url)
  await page.evaluate(async () => {
    const instances = "/src/stores/instances.ts", view = "/src/stores/mission-view-state.ts"
    ;(await import(instances)).setActiveInstanceId("fixture")
    ;(await import(view)).updateMissionProjectView("/fixture", { selected: "msn_done" })
  })
  return { errors, writes, missionWrites }
}

const settingsOpen = (page: Page) => page.evaluate(async () => { const path = "/src/stores/settings-screen.ts"; return (await import(path)).settingsOpen() })
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __preferencesCalls: unknown[] }).__preferencesCalls)

test("the Missions gear opens the native Preferences window at Missions with the active project context", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page, "accept")
  try {
    await page.evaluate(async () => {
      const path = "/src/stores/session-state.ts", state = await import(path)
      state.setSessions(new Map([["fixture", new Map([["selected", { id: "selected", location: { directory: "/mnt/d/repo/worktree" } }]])]]))
      state.seedRestoredSessionSelection("fixture", "selected", "selected")
    })
    await page.locator(".mission-control-header").getByRole("button", { name: "Preferences", exact: true }).click()
    await page.waitForFunction(() => (window as unknown as { __preferencesCalls: unknown[] }).__preferencesCalls.length === 1)
    const [[section, context, toggle, resume]] = await calls(page) as Array<[string, { instanceId?: string; workspacePath?: string; location?: { directory: string } }, boolean, boolean]>
    assert.equal(section, "missions")
    assert.equal(context.instanceId, "fixture")
    assert.equal(context.workspacePath, "/fixture", "record the opened backend folder independently of the session's native Location")
    assert.equal(context.location?.directory, "/mnt/d/repo/worktree")
    assert.deepEqual([toggle, resume], [false, false])
    assert.equal(await settingsOpen(page), false, "no embedded Settings beside the native window")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("a native rejection is reported instead of opening embedded Settings", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page, "reject")
  try {
    await page.locator(".mission-control-header").getByRole("button", { name: "Preferences", exact: true }).click()
    await page.getByText("Preferences could not open in their window.", { exact: false }).waitFor()
    assert.equal((await calls(page)).length, 1, "never retried")
    assert.equal(await settingsOpen(page), false)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("Save as brief copies only a finished Mission's recorded inputs and launches nothing", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page, "accept")
  try {
    const detail = page.locator("section.mission-detail")
    // Save as brief is an overflow-menu item, never a control under the Mission's row.
    assert.equal(await page.locator(".mission-control").getByRole("button", { name: "Save as brief", exact: true }).count(), 0)
    assert.equal(await detail.locator(".mission-action-texts").isVisible(), false, "no empty row under the Mission")
    // From a folded Mission, the menu unfolds its detail to show the name field; Escape
    // closes it and gives focus back to the menu's trigger.
    // This Mission has no tasks: its row has no chevron and its selected detail starts folded.
    const row = page.locator(".mission-row:has(.mission-row-select[aria-current=true])")
    assert.equal(await row.locator("button.session-item-expander").count(), 0)
    assert.equal(await detail.isVisible(), false)
    await (await missionMenuItem(page, "save-brief")).click()
    await detail.getByLabel("Brief name", { exact: true }).waitFor()
    assert.equal(await detail.isVisible(), true, "the menu unfolds the Mission")
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Brief name", undefined, { timeout: 5_000 })
    await page.keyboard.press("Escape")
    await detail.getByLabel("Brief name", { exact: true }).waitFor({ state: "detached" })
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("action-overflow-trigger")), true, "focus returns to the menu's trigger")
    await (await missionMenuItem(page, "save-brief")).click()
    const name = detail.getByLabel("Brief name", { exact: true })
    assert.equal(await name.inputValue(), "Dependency audit", "the Mission title prefills the name")
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Brief name", undefined, { timeout: 5_000 })
    await name.fill("Weekly dependency audit")
    // Enter saves; focus returns to the menu's trigger even though the write disabled the field.
    await name.press("Enter")
    await name.waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.classList.contains("action-overflow-trigger"), undefined, { timeout: 5_000 })
    assert.equal(fixture.writes.length, 1)
    const [saved] = fixture.writes[0]!.settings.missionModels as Array<Record<string, unknown>>
    assert.match(saved!.id as string, /^[0-9a-f-]{36}$/)
    assert.notEqual(saved!.id, finished.id)
    const { id: _id, ...inputs } = saved!
    assert.deepEqual(inputs, { version: 1, name: "Weekly dependency audit", objective: finished.objective, notes: finished.notes,
      template: "custom", profiles, taskMode: "independent" })
    assert.deepEqual(fixture.missionWrites, [], "saving a brief never creates, starts or edits a Mission")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("saving the brief that fills the library returns focus to an enabled toolbar control", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const briefs = Array.from({ length: 19 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, version: 1,
    name: `Brief ${index}`, objective: "Objective", notes: "", template: "custom", profiles, taskMode: "independent" }))
  const fixture = await setup(page, "accept", { missionModels: briefs })
  try {
    const detail = page.locator("section.mission-detail")
    await (await missionMenuItem(page, "save-brief")).click()
    const name = detail.getByLabel("Brief name", { exact: true })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Brief name", undefined, { timeout: 5_000 })
    await name.fill("Twentieth brief")
    await name.press("Enter")
    await name.waitFor({ state: "detached" })
    // Full, the library leaves the menu nothing to offer: its trigger is disabled, so
    // focus lands on the toolbar's first enabled button instead of the body.
    assert.equal(await missionToolbar(page).locator(".action-overflow-trigger").isDisabled(), true)
    await page.waitForFunction(() => {
      const active = document.activeElement as HTMLButtonElement | null
      return Boolean(active?.closest(".mission-action-bar") && !active.disabled)
    }, undefined, { timeout: 5_000 })
    assert.equal(fixture.writes.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})
