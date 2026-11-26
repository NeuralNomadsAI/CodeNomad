import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionActorActivity, MissionMap, MissionTask } from "../../../server/src/api-types"
import { captureMissionView } from "./mission-view-capture"
import { missionContentFixture } from "./mission-content-fixture"
import { inlineMissionEntry, missionDetail, missionEntryStatus, missionGeneralAction, missionMenuItemState, missionPicker, missionRows,
  missionRow, missionToolbar, selectMission, selectedMissionTitle } from "./mission-actions"
import { panelMissions } from "./mission-content-fixture"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-panel-layout",
      routes: [
        { path: "/mission-layout", html: "<html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-control.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); })

const hour = 3_600_000
const task = (key: string, title: string, status: MissionTask["status"], blockedBy: string[] = []): MissionTask => ({ id: `task-${key}`, key, title,
  brief: `Brief for ${title}`, role: "worker", status, blockedBy, outstandingExecution: false, createdAt: 1, updatedAt: 1 })
function mission(id: string, patch: Partial<MissionMap>): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [{ sessionId: `ses_${id}`, kind: "coordinator", managed: true,
      title: "Coordinator", roles: ["coordinator"], location: { directory: "fixture" }, joinedAt: 1 }],
    frontier: [], claims: [], revision: 3, createdAt: 1, updatedAt: Date.now() - 2 * hour, history: [], historyTruncated: false, tasks: [], reports: [], ...patch }
}
const finished = mission("release", { status: "completed", objective: "Prepare the 2.4 release notes for the desktop and web apps. Gather every merged change, group them by audience and draft the announcement.",
  summary: "Release notes are drafted in docs/releases/2.4.md. All 31 merged pull requests are grouped into Desktop, Web and Developer sections; two breaking changes are called out at the top with migration steps. The announcement draft is ready for review.",
  tasks: ["Collect merged changes", "Group by audience", "Draft desktop notes", "Draft web notes", "Write migration steps", "Draft announcement", "Proofread", "Publish draft"]
    .map((title, index) => task(`t${index}`, title, "completed", index ? [`t${index - 1}`] : [])) })
const audit = mission("audit", { status: "completed", objective: "Audit the login flow for accessibility issues", summary: "No blocking issue found; three minor fixes were applied.", updatedAt: Date.now() - 26 * hour })
const actor = (sessionId: string, title: string) => ({ sessionId, kind: "specialist" as const, managed: true, title, roles: ["worker"], location: { directory: "fixture" }, joinedAt: 1 })
const active = mission("migrate", { objective: "Migrate the storage layer to the new engine, then remove the legacy adapters and their tests once everything passes",
  briefing: { id: "brf", requestID: "req", createdAt: Date.now() - 20 * 60_000, basedOnRevision: 3, basedOnUpdatedAt: Date.now() - 20 * 60_000,
    summary: "The new engine is wired behind a flag and the read path passes. Writes still go through the legacy adapter while the schema migration is reviewed.",
    achieved: [], ongoing: [], obstacles: [], next: [] } as unknown as MissionMap["briefing"],
  actors: [{ sessionId: "ses_migrate", kind: "coordinator", managed: true, title: "Coordinator", roles: ["coordinator"], location: { directory: "fixture" }, joinedAt: 1 },
    actor("ses_worker", "Schema reviewer"), actor("ses_runner", "Benchmark runner"), actor("ses_writer", "Write-path porter")],
  tasks: [task("read", "Port the read path", "completed"),
    { ...task("bench", "Benchmark the new engine", "dispatching", ["read"]), actorSessionId: "ses_runner" },
    { ...task("schema", "Review the schema migration", "queued", ["read"]), actorSessionId: "ses_worker" },
    { ...task("write", "Port the write path", "needs-input", ["read"]), actorSessionId: "ses_writer" },
    task("legacy", "Keep the legacy reader alive", "failed"),
    task("cleanup", "Remove legacy adapters", "blocked", ["write", "bench"])],
  history: [{ revision: 2, source: "coordinator", actorSessionId: "ses_migrate", reason: "Split the write path from cleanup", addedTaskKeys: ["cleanup"], retiredTasks: [], dependencyUpdates: [], createdAt: 2 }] })
// Observed native activity: one task runs, one actor waits on a native question.
const activeActivity: MissionActorActivity[] = [{ sessionId: "ses_runner", state: "running" }, { sessionId: "ses_worker", state: "form" }, { sessionId: "ses_writer", state: "idle-without-report" }]
async function open(page: Page, missions: MissionMap[]) {
  page.setDefaultTimeout(15_000)
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname, content = missionContentFixture(route.request().url(), route.request().method(), missions)
    if (content) return route.fulfill({ json: content })
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(missions), generatedAt: 1, discardedEvents: 0,
      activity: { generatedAt: 1, missions: missions.map(value => ({ missionId: value.id, actors: value === active ? activeActivity : [] })) } } })
    return route.fulfill({ json: {} })
  })
  // The first load may wait for Vite's cold dependency optimization.
  await page.goto(url, { timeout: 60_000 })
  await page.evaluate(() => (window as any).missionFixture.connectCatalog())
  await page.evaluate(async () => {
    const path = "/src/stores/instances.ts", { updateInstance } = await import(path)
    updateInstance("fixture", { metadata: { project: { id: "project" } } })
  })
}
const detail = missionDetail
const inlineEntries = (page: Page) => missionRows(page).locator("button.mission-row-select")
/** The selected item's icon toolbar as [label, disabled] pairs, in order. */
const toolbar = (page: Page) => missionToolbar(page).locator("button").evaluateAll(buttons =>
  buttons.map(button => [button.getAttribute("aria-label"), (button as HTMLButtonElement).disabled]))

test("the list is a list: one-line titled entries, nothing below until a selection, creation on one screen", async () => {
  const page = await browser.newPage({ locale: "en-US", timezoneId: "UTC", viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [active, finished, audit])
    await (await inlineMissionEntry(page, /^Prepare the 2\.4/)).waitFor()
    assert.equal(await inlineEntries(page).count(), 3)
    assert.equal(await detail(page).count(), 0, "no selection, no detail")
    assert.equal(await selectedMissionTitle(page).count(), 0, "nothing is selected by default")
    for (const entry of await inlineEntries(page).all()) {
      assert.deepEqual(await entry.evaluate(el => [...el.children].map(child => child.getAttribute("class")!.split(" ")[0])), ["mission-row-mark", "session-item-title", "sr-only"])
      assert.equal(await entry.locator(".mission-row-mark > svg.mission-row-flag").count(), 1)
      const [row, title, line] = await entry.evaluate(el => { const title = el.querySelector(".session-item-title")!
        return [el.getBoundingClientRect().height, title.getBoundingClientRect().height, parseFloat(getComputedStyle(title).lineHeight)] })
      assert.ok(title <= line + 0.5 && row <= 32, "exactly one short line, even for long titles")
    }
    assert.match(await missionEntryStatus(page, /^Prepare the 2\.4/), /^Completed · 2 hours ago$/)
    assert.doesNotMatch(await page.locator(".mission-control").innerText(), /Release notes are drafted|engine is wired|ses_|task-/, "no prose or identifiers in the panel")
    await captureMissionView(page, "list-nothing-selected")
    await missionGeneralAction(page, "Create mission").click()
    await page.locator("form.mission-editor").waitFor()
    await captureMissionView(page, "creation")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("one-time selected: red task questions, icon toolbar, Summary eye and the dependency tree as the single task view", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [active, finished])
    await selectMission(page, /^Migrate the storage layer/)
    assert.equal(await missionPicker(page).locator("section.mission-detail").count(), 0, "the detail is the selected row's children, never in the header")
    const schema = detail(page).locator('.mission-tree-node[data-task-key="schema"] .mission-tree-task')
    // Its actor's "form" activity state alone (possibly an uncorrelated global request)
    // keeps the task's reader: only a correlated request makes it open a question.
    assert.equal(await schema.getAttribute("aria-description"), null)
    await page.evaluate(async () => {
      const path = "/src/stores/forms.ts", { replaceFormQueue } = await import(path)
      replaceFormQueue("fixture", [{ id: "form-1", sessionID: "ses_worker", title: "Which index strategy should the migration keep?", fields: [{}], location: { directory: "fixture" } }])
    })
    // The worker's open question is its task's: the chevron carries it, the flag stays the mission's own.
    const row = missionRow(page, /^Migrate the storage layer/)
    await row.locator('.session-item-expander[data-child-activity="permission"]').waitFor()
    assert.equal(await row.locator('.mission-row-flag[data-mark="permission"]').count(), 0)
    assert.equal(await schema.getAttribute("aria-description"), "Opens its question", "the correlated request makes the task open it")
    assert.equal(await page.locator(".mission-control").getByText("Which index strategy should the migration keep?").count(), 0, "questions open in the dock, never in the panel")
    assert.equal(await missionToolbar(page).locator(".mission-overview-toggle").getAttribute("aria-label"), "Summary")
    // The tree merges status into the dependency graph.
    const states = await detail(page).locator(".mission-tree .mission-tree-node").evaluateAll(items => items.map(item => [(item as HTMLElement).dataset.taskKey, (item as HTMLElement).dataset.state]))
    assert.deepEqual(states, [["read", "done"], ["legacy", "failed"], ["bench", "active"], ["schema", "input"], ["write", "blocked"], ["cleanup", "waiting"]])
    assert.equal(await detail(page).locator(".mission-graph path[data-to='cleanup']").count(), 2)
    assert.equal(await detail(page).locator(".mission-tree-mark svg").count(), 6, "every node shows a status icon")
    const visibleText = await detail(page).evaluate(element => {
      const copy = element.cloneNode(true) as HTMLElement
      copy.querySelectorAll(".sr-only").forEach(node => node.remove())
      return copy.textContent ?? ""
    })
    assert.doesNotMatch(visibleText, /Done|Completed|Waiting|Blocked|tasks done|%|engine is wired/, "no visible status words, counts or prose")
    assert.equal(await detail(page).locator('.mission-tree-node[data-task-key="schema"] .sr-only').textContent(), "Awaiting your input", "status words remain available to assistive technology")
    assert.equal(await page.locator(".mission-control").locator("textarea, form").count(), 0, "no coordinator field")
    assert.deepEqual(await page.locator(".mission-control .mission-disclosure").evaluateAll(items => items.map(item => item.className)),
      [], "the tasks are the mission's children: no disclosure, no More")
    assert.equal((await missionMenuItemState(page, "edit")).enabled, true, "Edit lives in the overflow menu")
    assert.deepEqual(await toolbar(page), [["Pause mission", false], ["Stop mission permanently", false], ["Summary", false],
      ["Open conversation", false], ["Delete selected mission…", false], ["More actions", false]])
    assert.equal((await missionMenuItemState(page, "request")).label, "Request an update")
    await captureMissionView(page, "one-time-selected")
    // Overview opens the briefing centrally; its eye highlights the exact target.
    await missionToolbar(page).locator(".mission-overview-toggle").click()
    await page.locator(".mission-reader").getByText(/The new engine is wired/).waitFor()
    assert.equal(await missionToolbar(page).locator(".mission-overview-toggle").getAttribute("aria-pressed"), "true")
    await page.locator(".mission-reader details.mission-report-technical > summary", { hasText: "Plan changes" }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("finished one-time Mission: titled entry, disabled inapplicable actions, prose only in the reader, all-done tree opens task readers", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [finished, audit])
    await (await inlineMissionEntry(page, /^Prepare the 2\.4/)).waitFor()
    assert.equal(await inlineEntries(page).first().locator(".session-item-title").innerText(), "Prepare the 2.4 release notes for the desktop and web apps")
    await selectMission(page, /^Prepare the 2\.4/)
    assert.equal(await selectedMissionTitle(page).innerText(), "Prepare the 2.4 release notes for the desktop and web apps")
    // Inapplicable actions stay in place, disabled: no primary, Stop or Edit for a finished Mission.
    assert.deepEqual(await toolbar(page), [["Start", true], ["Stop mission permanently", true], ["Summary", false],
      ["Open conversation", false], ["Delete selected mission…", false], ["More actions", false]])
    // The menu still applies: a finished Mission can be saved as a brief; its other actions stay disabled.
    for (const [key, enabled] of [["request", false], ["interrupt", false], ["save-brief", true], ["edit", false]] as const)
      assert.equal((await missionMenuItemState(page, key)).enabled, enabled, key)
    const tree = detail(page).locator(".mission-tree")
    assert.equal(await tree.locator(".mission-tree-node[data-state='done']").count(), 8)
    assert.equal(await detail(page).locator("p, .mission-result").count(), 0, "no result prose in the panel")
    assert.doesNotMatch(await page.locator(".mission-control").innerText(), /ses_|task-t0|Release notes are drafted/)
    await captureMissionView(page, "finished-one-time")
    await missionToolbar(page).locator(".mission-overview-toggle").click()
    await page.locator(".mission-reader").getByText(/^Release notes are drafted/).waitFor()
    // While the eye is pressed, the reader follows the selection: a selected task shows its own.
    await tree.locator(".mission-tree-task").first().click()
    await page.locator(".mission-reader .window-title").getByText("Collect merged changes", { exact: true }).waitFor()
    assert.equal(await tree.locator(".mission-tree-task").first().getAttribute("aria-current"), "true")
    assert.equal(await selectedMissionTitle(page).count(), 0, "the task, not its Mission row, is the selection")
    assert.equal(await missionToolbar(page).locator(".mission-overview-toggle").getAttribute("aria-pressed"), "true", "the eye shows the task's open reader")
    const taskReader = page.locator(".mission-task-reader")
    await taskReader.getByText("Done", { exact: true }).waitFor()
    assert.doesNotMatch(await taskReader.innerText(), /No result recorded|Unblocks|Blocks /)
    await tree.locator(".mission-tree-task").nth(1).click()
    await page.locator(".mission-reader .window-title").getByText("Group by audience", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the header gear opens Settings → Missions instead of inline preferences", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    await open(page, [audit])
    // Record the native Preferences window request of this local Electron host.
    await page.evaluate(() => { (window as any).electronAPI.openPreferences = async (...args: unknown[]) => { ((window as any).preferenceRequests ??= []).push(args) } })
    const gear = missionGeneralAction(page, "Preferences")
    assert.equal(await gear.getAttribute("aria-expanded"), null, "the gear is a navigation, not an inline disclosure")
    await gear.click()
    await page.waitForFunction(() => (window as any).preferenceRequests?.length === 1)
    assert.equal(await page.evaluate(() => (window as any).preferenceRequests[0][0]), "missions")
    assert.equal(await page.evaluate(async () => (await import("/src/stores/settings-screen.ts" as string)).activeSettingsSection()), "missions")
    assert.equal(await page.locator(".mission-control .mission-preferences").count(), 0, "preferences are never rendered inside the panel")
    await gear.click()
    await page.waitForFunction(() => (window as any).preferenceRequests?.length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).preferenceRequests[1].slice(0, 1).concat((window as any).preferenceRequests[1][2])), ["missions", false],
      "a second click reopens the section rather than toggling it closed")
  } finally { await page.close() }
})
