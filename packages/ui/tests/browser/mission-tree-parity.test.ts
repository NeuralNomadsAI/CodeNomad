import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import type { MissionActorActivity, MissionMap, MissionSummary, MissionTask } from "../../../server/src/api-types"
import { missionSummary } from "../../../server/src/missions/mission-summary"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { armFixtureNavigationBudget, waitForMissionPanelRefresh } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { missionContentFixture, panelMissions } from "./mission-content-fixture"
import { clickMissionAction, inlineMissionEntry, missionDetail, missionGeneralAction, missionRow, missionRows, missionTask, missionToolbar,
  routeUiSettings, selectMission, selectedMissionTitle, waitForMissionDeleteSessions } from "./mission-actions"

// The Missions panel follows the session list: one selection (a row or one task), the
// chevron alone expands, tasks are nested session rows, the chevron carries its tasks'
// most urgent state and finished tasks stay green until seen.
let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "mission-tree-parity", routes: [{ path: "/mission-parity",
    html: "<html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-control.tsx\"></script></body></html>" }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const RELEASE = "Release the 3.0 build", AUDIT = "Audit the dependencies", EMPTY = "Plan the next quarter", SCHEDULE = "Nightly review"
const task = (key: string, title: string, status: MissionTask["status"], patch: Partial<MissionTask> = {}): MissionTask => ({ id: `task-${key}`, key, title,
  brief: `Brief for ${title}`, role: "worker", status, blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1, ...patch })
const actor = (sessionId: string, title: string) => ({ sessionId, kind: "specialist" as const, managed: true, title, roles: ["worker"], location: { directory: "fixture" }, joinedAt: 1 })
function mission(id: string, objective: string, tasks: MissionTask[], patch: Partial<MissionMap> = {}): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective, template: "custom", coordinatorSessionId: `ses_${id}`,
    status: "active", runState: "running", frontier: [], claims: [], revision: 2, createdAt: 1, updatedAt: Date.now() - 3_600_000, history: [], historyTruncated: false,
    actors: [{ sessionId: `ses_${id}`, kind: "coordinator", managed: true, title: "Coordinator", roles: ["coordinator"], location: { directory: "fixture" }, joinedAt: 1 },
      ...tasks.filter(item => item.actorSessionId).map(item => actor(item.actorSessionId!, item.title))],
    briefing: { id: `brf_${id}`, requestID: `req_${id}`, createdAt: 2, basedOnRevision: 2, basedOnUpdatedAt: 2, summary: `Briefing of ${objective}.`,
      achieved: [], ongoing: [], obstacles: [], next: [] } as unknown as MissionMap["briefing"], tasks, reports: [], ...patch }
}
const release = () => mission("release", RELEASE, [task("draft", "Draft notes", "completed"),
  task("review", "Review notes", "dispatching", { actorSessionId: "ses_review", blockedBy: ["draft"] }), task("publish", "Publish notes", "queued", { blockedBy: ["review"] })])
const audit = () => mission("audit", AUDIT, [task("scan", "Scan dependencies", "dispatching", { actorSessionId: "ses_scan" })])
const empty = () => mission("empty", EMPTY, [], { runState: "prepared" })
const schedule: RecurrenceSchedule = { id: "rec_nightly", title: SCHEDULE, revision: 1, state: "running", clock: { time: "02:00", zone: "UTC" },
  nextDueAt: Date.now() + 3_600_000, pending: null, controls: [], actions: ["pause", "stop", "run-now"], history: [], latestResult: null }

interface Data { missions: MissionMap[]; activity: Record<string, MissionActorActivity[]>; schedules: RecurrenceSchedule[]
  deletions: Array<Record<string, unknown>>; failDelete: number
  /** The rows' summaries, when they differ from the server's own (`missionSummary`). */
  summaries?: (missions: MissionMap[]) => MissionSummary[] }
async function open(page: Page, data: Data, windowContext: "local" | "remote" = "local") {
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:${JSON.stringify(windowContext)},electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  const list = () => ({ available: true, projectID: "project", missions: panelMissions(data.missions), cleanups: [], generatedAt: Date.now(), discardedEvents: 0,
    ...(data.summaries ? { summaries: data.summaries(data.missions) } : {}),
    activity: { generatedAt: Date.now(), missions: data.missions.map(value => ({ missionId: value.id, actors: data.activity[value.id] ?? [] })) } })
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const content = missionContentFixture(request.url(), request.method(), data.missions)
    if (content) return route.fulfill({ json: content })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: "project",
      projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: data.schedules }) })
    if (path.endsWith("/missions/scheduled")) return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
    if (path.endsWith("/current")) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: data.schedules[0]?.id ?? null, passageID: null } })
    if (path.endsWith("/subagent-depth")) return route.fulfill({ json: { location: { directory: "fixture" }, capability: null, effectiveDepth: null, project: null } })
    // Pause is refused: the mission changed first.
    if (path.endsWith("/control")) return route.fulfill({ status: 409, json: { code: "revision-conflict" } })
    const one = /\/missions\/([^/]+)$/.exec(path)
    if (one && request.method() === "DELETE") {
      data.deletions.push(request.postDataJSON())
      if (data.failDelete > 0) { data.failDelete--; return route.fulfill({ status: 503, body: "Cleanup pending" }) }
      data.missions = data.missions.filter(value => value.id !== decodeURIComponent(one[1]))
      return route.fulfill({ json: { deleted: true } })
    }
    if (path.endsWith("/missions") || one) return route.fulfill({ json: list() })
    return route.fulfill({ json: {} })
  })
  const settings = await routeUiSettings(page)
  await page.goto(url, { timeout: 60_000 })
  await page.evaluate(() => (window as any).missionFixture.connectCatalog())
  await page.evaluate(async () => {
    const path = "/src/stores/instances.ts", { updateInstance } = await import(path)
    updateInstance("fixture", { metadata: { project: { id: "project" } } })
  })
  await (await inlineMissionEntry(page, data.missions[0].objective)).waitFor({ timeout: 60_000 })
  return { errors, settings }
}
const fresh = (): Data => ({ missions: [release(), audit(), empty()], activity: { release: [{ sessionId: "ses_review", state: "running" }], audit: [] },
  schedules: [], deletions: [], failDelete: 0 })
/** Serves a changed dataset and waits for the panel to read it. */
async function publish(page: Page, data: Data, change: (data: Data) => void) {
  change(data)
  const refreshed = waitForMissionPanelRefresh(page)
  await page.evaluate(() => (window as any).missionFixture.refresh())
  await refreshed
}
const chevron = (page: Page, title: string) => missionRow(page, title).locator(".session-item-expander")
const rowBase = (page: Page, title: string) => missionRow(page, title).locator(".session-item-base")
/** The nested session row (`.session-item-base`) holding a task button. */
const taskBase = (button: Locator) => button.locator("xpath=..")
const taskNode = (page: Page, key: string) => missionRows(page).locator(`li.mission-tree-node[data-task-key="${key}"]`)
const eye = (page: Page) => missionToolbar(page).locator(".mission-overview-toggle")
const reader = (page: Page) => page.locator(".mission-reader")
async function until(check: () => Promise<boolean>, what: string, timeout = 10_000) {
  for (const deadline = Date.now() + timeout; !(await check().catch(() => false));) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const attribute = (element: Locator, name: string, value: string | null) =>
  until(async () => await element.getAttribute(name) === value, `${name}=${value}`)
/** Every highlighted row of the panel, by its title. */
const highlighted = (page: Page) => missionRows(page).locator(".session-item-base.session-item-active .session-item-title").allInnerTexts()

test("one selection at a time: a Mission row, or instead one of its tasks", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    const { errors } = await open(page, fresh())
    await selectMission(page, RELEASE)
    const releaseRow = await inlineMissionEntry(page, RELEASE)
    assert.deepEqual(await highlighted(page), [RELEASE])
    const draft = missionTask(missionRows(page), "Draft notes")
    // Tasks are the row's nested session rows: spacer, status mark (the graph's anchor), select button.
    assert.deepEqual(await taskBase(draft).evaluate(base => [base.className.includes("session-item-nested"),
      ...[...base.children].map(child => child.classList.contains("session-item-expander--spacer") ? "spacer"
        : child.hasAttribute("data-graph-anchor") ? "mark" : child.classList.contains("session-item-select") ? "select" : child.className)]),
    [true, "spacer", "mark", "select"])

    await draft.click()
    await attribute(draft, "aria-current", "true")
    assert.equal(await releaseRow.getAttribute("aria-current"), null, "the task, not its Mission, is the selection")
    assert.deepEqual(await highlighted(page), ["Draft notes"])
    assert.match(await rowBase(page, RELEASE).first().getAttribute("class") ?? "", /session-item-inactive/)
    assert.equal(await selectedMissionTitle(page).count(), 0)
    assert.equal(await missionToolbar(page).getByRole("button", { name: "Open the task's conversation", exact: true }).count(), 1, "the task takes the toolbar")
    assert.equal(await draft.getAttribute("aria-pressed"), null, "a task row selects; it is no reader toggle")
    assert.equal(await reader(page).count(), 0, "selecting a task opens no reader")

    // Selecting the Mission row again clears the task selection.
    await releaseRow.click()
    await attribute(releaseRow, "aria-current", "true")
    assert.equal(await draft.getAttribute("aria-current"), null)
    assert.deepEqual(await highlighted(page), [RELEASE])
    assert.equal(await missionToolbar(page).getByRole("button", { name: "Open conversation", exact: true }).count(), 1)

    // Another Mission's task, shown by its chevron without selecting it, takes the one selection.
    await chevron(page, AUDIT).click()
    const scan = missionTask(missionRows(page), "Scan dependencies")
    await scan.waitFor()
    assert.deepEqual(await highlighted(page), [RELEASE], "a chevron never selects a one-time Mission")
    await scan.click()
    await attribute(scan, "aria-current", "true")
    assert.deepEqual(await highlighted(page), ["Scan dependencies"])
    assert.equal(await missionRows(page).locator('[aria-current="true"]').count(), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a click only selects; the chevron alone expands and collapses a row", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    const data = fresh(); data.schedules = [schedule]
    const { errors } = await open(page, data)
    const entry = await inlineMissionEntry(page, RELEASE), expander = chevron(page, RELEASE)
    const draft = missionTask(missionRows(page), "Draft notes")
    await entry.click()
    await attribute(entry, "aria-current", "true")
    assert.equal(await expander.getAttribute("aria-expanded"), "false", "selecting leaves the row collapsed")
    assert.equal(await missionDetail(page).isVisible(), false)
    await entry.click()
    assert.equal(await expander.getAttribute("aria-expanded"), "false", "clicking the selected row again does not expand it")

    await expander.click()
    await attribute(expander, "aria-expanded", "true")
    await draft.waitFor()
    assert.equal(await missionDetail(page).isVisible(), true)
    await entry.click()
    assert.equal(await expander.getAttribute("aria-expanded"), "true", "nor does it collapse it")
    await expander.click()
    await attribute(expander, "aria-expanded", "false")
    await draft.waitFor({ state: "hidden" })
    assert.equal(await entry.getAttribute("aria-current"), "true", "collapsing keeps the selection")

    // An unselected one-time Mission's chevron shows its tasks without selecting it.
    await chevron(page, AUDIT).click()
    await missionTask(missionRows(page), "Scan dependencies").waitFor()
    assert.equal(await (await inlineMissionEntry(page, AUDIT)).getAttribute("aria-current"), null)
    assert.equal(await entry.getAttribute("aria-current"), "true")

    // An unselected schedule's children are its selected detail: its chevron selects and expands it.
    const nightly = await inlineMissionEntry(page, SCHEDULE)
    await chevron(page, SCHEDULE).click()
    await attribute(nightly, "aria-current", "true")
    await attribute(chevron(page, SCHEDULE), "aria-expanded", "true")
    await page.locator(".mission-schedule-detail").waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the eye is a mode: pressed, the reader follows the selection from Mission to task to Mission", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    const { errors } = await open(page, fresh())
    await selectMission(page, RELEASE)
    assert.equal(await eye(page).getAttribute("aria-pressed"), "false")
    await eye(page).click()
    await reader(page).getByText(`Briefing of ${RELEASE}.`).waitFor()
    assert.equal(await eye(page).getAttribute("aria-pressed"), "true")

    const draft = missionTask(missionRows(page), "Draft notes")
    await draft.click()
    await reader(page).locator(".window-title").getByText("Draft notes", { exact: true }).waitFor()
    assert.equal(await missionToolbar(page).getByRole("button", { name: "Open the task's conversation", exact: true }).count(), 1)
    assert.equal(await eye(page).getAttribute("aria-pressed"), "true", "the task toolbar's eye shows its open reader")

    await missionTask(missionRows(page), "Review notes").click()
    await reader(page).locator(".window-title").getByText("Review notes", { exact: true }).waitFor()

    await (await inlineMissionEntry(page, AUDIT)).click()
    await reader(page).getByText(`Briefing of ${AUDIT}.`).waitFor()
    assert.equal(await eye(page).getAttribute("aria-pressed"), "true")

    // Released, the eye closes the reader, and selection no longer opens one.
    await eye(page).click()
    await reader(page).waitFor({ state: "detached" })
    await chevron(page, AUDIT).click()
    const scan = missionTask(missionRows(page), "Scan dependencies")
    await scan.click()
    await attribute(scan, "aria-current", "true")
    assert.equal(await reader(page).count(), 0)
    assert.equal(await eye(page).getAttribute("aria-pressed"), "false")
    // Pressing it with a task selected opens that task's reader.
    await eye(page).click()
    await reader(page).locator(".window-title").getByText("Scan dependencies", { exact: true }).waitFor()
    assert.equal(await eye(page).getAttribute("aria-pressed"), "true")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a Mission's chevron carries its task rows' most urgent state: input, working, or nothing for finished work", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    const ask = mission("ask", "Ask about the schema", [task("answer", "Answer the schema question", "queued", { actorSessionId: "ses_answer" })])
    const work = mission("work", "Work on the importer", [task("build", "Build the importer", "dispatching", { actorSessionId: "ses_build" })])
    // A finished task whose conversation still runs (after its report) is finished work, not work.
    const shipped = mission("shipped", "Ship the exporter", [task("ship", "Package the exporter", "completed", { actorSessionId: "ses_ship" }),
      task("wait", "Announce the exporter", "blocked", { blockedBy: ["ship"] })])
    const data: Data = { missions: [ask, work, shipped], schedules: [], deletions: [], failDelete: 0, activity: {
      ask: [{ sessionId: "ses_answer", state: "form" }], work: [{ sessionId: "ses_build", state: "running" }], shipped: [{ sessionId: "ses_ship", state: "running" }] } }
    const { errors } = await open(page, data)
    for (const [title, taskTitle] of [["Ask about the schema", "Answer the schema question"], ["Work on the importer", "Build the importer"],
      ["Ship the exporter", "Announce the exporter"]]) {
      await chevron(page, title).click()
      await missionTask(missionRows(page), taskTitle).waitFor()
    }
    await until(async () => await chevron(page, "Ask about the schema").getAttribute("data-child-activity") === "permission", "an asking task")
    assert.equal(await taskNode(page, "answer").getAttribute("data-state"), "input")
    await until(async () => await chevron(page, "Work on the importer").getAttribute("data-child-activity") === "working", "a working task")
    assert.equal(await taskNode(page, "build").getAttribute("data-state"), "active")
    // Read, its rows decide: no row works, though an actor's conversation still runs.
    assert.deepEqual(await missionRows(page).locator("li.mission-tree-node").evaluateAll(items => items
      .filter(item => ["ship", "wait"].includes((item as HTMLElement).dataset.taskKey!)).map(item => (item as HTMLElement).dataset.state)), ["done", "waiting"])
    assert.equal(await chevron(page, "Ship the exporter").getAttribute("data-child-activity"), null)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a task finished after the panel first looked stays green until it is selected, its mark is clicked or its Mission is marked as read", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    const data = fresh()
    const { errors } = await open(page, data)
    await selectMission(page, RELEASE)
    // Tasks already finished at the panel's first use never ask for attention.
    await taskNode(page, "draft").and(page.locator('[data-state="done"]')).waitFor()
    assert.equal(await taskNode(page, "draft").getAttribute("data-unseen"), null)
    assert.equal(await taskNode(page, "draft").locator(".mission-tree-mark-clear").count(), 0)
    await chevron(page, AUDIT).click()
    await missionTask(missionRows(page), "Scan dependencies").waitFor()
    await until(async () => await chevron(page, RELEASE).getAttribute("data-child-activity") === "working", "the working review")

    const finish = (missionId: string, keys: string[], patch: Partial<MissionMap> = {}) => publish(page, data, value => {
      value.missions = value.missions.map(item => item.id !== missionId ? item : { ...item, ...patch, revision: item.revision + 1, updatedAt: Date.now(),
        tasks: item.tasks.map(entry => keys.includes(entry.key) ? { ...entry, status: "completed" as const, updatedAt: Date.now() } : entry) })
      value.activity[missionId] = []
    })
    // Finished and unseen: green, its mark a Mark as read button, the chevron idle like a subsession.
    await finish("release", ["review"])
    const review = taskNode(page, "review")
    await review.and(page.locator("[data-unseen]")).waitFor()
    const mark = review.locator("button.mission-tree-mark-clear")
    assert.equal(await mark.getAttribute("aria-label"), "Mark as read")
    assert.equal(await mark.getAttribute("data-toggle-sweep"), "mission-task-seen")
    await until(async () => await chevron(page, RELEASE).getAttribute("data-child-activity") === "idle", "an idle chevron")
    await mark.click()
    await attribute(review, "data-unseen", null)
    assert.equal(await review.locator(".mission-tree-mark-clear").count(), 0)
    assert.equal(await missionTask(missionRows(page), "Review notes").getAttribute("aria-current"), null, "its mark marks it seen without selecting it")
    await attribute(chevron(page, RELEASE), "data-child-activity", null)

    // Selecting an unseen task marks it seen.
    await finish("release", ["publish"])
    const publishNode = taskNode(page, "publish")
    await publishNode.and(page.locator("[data-unseen]")).waitFor()
    await missionTask(missionRows(page), "Publish notes").click()
    await attribute(publishNode, "data-unseen", null)
    await attribute(chevron(page, RELEASE), "data-child-activity", null)

    // The chevron's context menu marks all of a Mission's tasks, and its own completion, as read.
    // Its finish is the project's first after the panel's first read, so it is unseen too.
    await finish("audit", ["scan"], { status: "completed", finishSequence: 1 })
    const scan = taskNode(page, "scan")
    await scan.and(page.locator("[data-unseen]")).waitFor()
    await until(async () => await chevron(page, AUDIT).getAttribute("data-child-activity") === "idle", "the audit's idle chevron")
    const flag = missionRow(page, AUDIT).locator(".mission-row-flag")
    assert.equal(await flag.getAttribute("data-mark"), "done")
    await chevron(page, AUDIT).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Mark as read", exact: true }).click()
    await attribute(scan, "data-unseen", null)
    await attribute(chevron(page, AUDIT), "data-child-activity", null)
    await attribute(flag, "data-mark", "idle")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a Mission whose plan holds no task has no chevron; an unknown count keeps it", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    const data = fresh(), UNKNOWN = "Sketch the roadmap"
    data.missions.push(mission("unknown", UNKNOWN, []))
    // A summary from a server that does not count tasks yet: no taskCount.
    data.summaries = missions => missions.map(value => {
      const { taskCount, ...summary } = missionSummary(value)
      return value.id === "unknown" ? summary : { ...summary, taskCount }
    })
    const { errors } = await open(page, data)
    const leaf = missionRow(page, EMPTY)
    await leaf.waitFor()
    assert.equal(await leaf.locator("span.session-item-expander.session-item-expander--spacer").count(), 1)
    assert.equal(await leaf.locator("button.session-item-expander").count(), 0)
    assert.equal(await chevron(page, RELEASE).evaluate(element => element.tagName), "BUTTON", "a Mission with tasks keeps its chevron")
    assert.equal(await chevron(page, UNKNOWN).evaluate(element => element.tagName), "BUTTON", "an unknown task count keeps the chevron")
    // Selected, it stays a leaf: still no chevron once its map is read.
    await selectMission(page, EMPTY)
    assert.equal(await (await inlineMissionEntry(page, EMPTY)).getAttribute("aria-current"), "true")
    assert.equal(await leaf.locator("button.session-item-expander").count(), 0)
    assert.equal(await missionRows(page).getByText("No tasks yet", { exact: false }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

/** Records whether a Mission editor form ever rendered (a hidden delete form never does). */
// A string script: the test transpiler would wrap a named helper with an undefined `__name`.
const watchForms = (page: Page) => page.evaluate(`(() => {
  window.formShown = false
  new MutationObserver(() => {
    const form = document.querySelector("form.mission-editor")
    if (form && form.getClientRects().length) window.formShown = true
  }).observe(document.body, { subtree: true, childList: true, attributes: true })
})()`)
const formShown = (page: Page) => page.evaluate(() => (window as unknown as { formShown: boolean }).formShown)

test("the trash deletes at once with the Preferences' choice; its form appears only when a deletion failed", async () => {
  // The embedded Settings screen exists in browser and remote windows.
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    const data = fresh()
    const { errors, settings } = await open(page, data, "remote")
    await waitForMissionDeleteSessions(page, false)
    await watchForms(page)
    await clickMissionAction(page, "Delete selected mission…", RELEASE)
    await (await inlineMissionEntry(page, RELEASE)).waitFor({ state: "detached" })
    assert.equal(data.deletions.length, 1)
    assert.equal(data.deletions[0].deleteManagedSessions, false, "by default, task conversations are kept")
    assert.equal(await formShown(page), false, "a successful deletion shows no form")
    assert.equal(await page.locator("form.mission-editor").count(), 0)

    // Settings › Missions: one checkbox decides for every later deletion.
    await missionGeneralAction(page, "Preferences").click()
    const shell = page.locator(".settings-screen-shell")
    const option = shell.locator(".mission-preferences-check").getByRole("checkbox", { name: "Deleting a mission also deletes its task conversations", exact: true })
    assert.equal(await option.isChecked(), false)
    await option.check()
    await waitForMissionDeleteSessions(page, true)
    assert.deepEqual(settings.writes.at(-1), { settings: { missionDeleteSessions: true } })
    await shell.locator(".settings-screen-close").filter({ visible: true }).first().click()
    await shell.waitFor({ state: "detached" })

    data.failDelete = 1
    await clickMissionAction(page, "Delete selected mission…", AUDIT)
    const form = page.locator("form.mission-editor")
    await form.getByRole("alert").waitFor()
    assert.equal(await formShown(page), true)
    assert.equal(data.deletions[1].deleteManagedSessions, true, "the Preferences' choice")
    assert.equal(await form.getByRole("checkbox").count(), 0, "the form asks nothing")
    assert.equal(await form.getByRole("button", { name: "Cancel", exact: true }).isEnabled(), true)
    await form.getByRole("button", { name: "Try again", exact: true }).click()
    await form.waitFor({ state: "detached" })
    await (await inlineMissionEntry(page, AUDIT)).waitFor({ state: "detached" })
    assert.equal(data.deletions.length, 3, "the failed request, then its exact retry after the reconciliation read")
    assert.deepEqual(data.deletions[2], data.deletions[1])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("command feedback is announced and joins the primary button's tooltip instead of a status line", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    const { errors } = await open(page, fresh())
    const detail = await selectMission(page, RELEASE)
    const primary = missionToolbar(page).locator("button").first()
    assert.equal(await primary.getAttribute("title"), "Pause mission")
    await primary.click()
    const alert = detail.locator(".mission-action-feedback [role=alert]")
    await alert.getByText("Pause was not applied", { exact: false }).waitFor({ state: "attached" })
    const text = (await alert.innerText()).trim()
    await until(async () => await primary.getAttribute("title") === `Pause mission — ${text}`, "the tooltip with the feedback")
    // Still in the expanded detail and announced, but visually hidden.
    assert.equal(await detail.isVisible(), true)
    assert.ok(await alert.evaluate(element => { const box = element.getBoundingClientRect(); return box.width <= 1 && box.height <= 1 }),
      "the explanation takes no room in the panel")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
