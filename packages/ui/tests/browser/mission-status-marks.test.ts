import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionActor, MissionActorActivity, MissionMap } from "../../../server/src/api-types"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget, waitForMissionPanelRefresh } from "./mission-panel-route"
import { inlineMissionEntry, missionToolbarAction, selectedMissionTitle, selectMission } from "./mission-actions"
import { panelMissions } from "./mission-content-fixture"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "mission-status-marks", routes: [{ path: "/mission-fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const actor = (sessionId: string, kind: MissionActor["kind"] = "coordinator"): MissionActor =>
  ({ sessionId, title: sessionId, kind, managed: kind === "specialist", roles: [kind], location: { directory: "fixture" }, joinedAt: 1 })
function mission(id: string, patch: Partial<MissionMap> = {}): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [actor(`ses_${id}`)], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false, reports: [],
    tasks: [{ id: `task-${id}`, key: "task-one", title: "Inspect evidence", brief: "Brief", role: "research", status: "completed",
      blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }], ...patch }
}

async function open(missions: () => MissionMap[], activity: () => Array<{ missionId: string; actors: MissionActorActivity[] }>) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  const errors: string[] = [], recoveries: unknown[] = [], taskMarkReads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => {
    const input = request.url().endsWith("/missions/panel-page") ? request.postDataJSON() : undefined
    if (input?.source === "task-marks") taskMarkReads.push(`${input.missionID}@${input.window.offset}`)
  })
  await page.addInitScript(`Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
    claimClientStateAccess: async () => true,
    loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(localStorage.getItem("fixture-native") ?? "null") }),
    saveClientState: async (_token, snapshot) => { localStorage.setItem("fixture-native", JSON.stringify(snapshot)); return true },
  } })`)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(missions()),
    generatedAt: Date.now(), discardedEvents: 0, activity: { generatedAt: Date.now(), missions: activity() } } }))
  await page.route("**/api/workspaces/fixture/missions/*/recover", route => {
    recoveries.push(route.request().postDataJSON())
    return route.fulfill({ json: { mission: missions()[0], admitted: true } })
  })
  await page.goto(url)
  return { page, errors, recoveries, taskMarkReads }
}
const fixtureCall = (page: Page, method: string) => page.evaluate(method => (window as any).missionFixture[method](), method)
async function refresh(page: Page) {
  const response = waitForMissionPanelRefresh(page)
  await fixtureCall(page, "refresh")
  await response
}
const mark = async (page: Page, title: string) => (await inlineMissionEntry(page, title)).locator(".mission-row-flag").getAttribute("data-mark")

for (const variant of ["remount", "retitle", "leaf"] as const) test(`selection resolves the current business row after ${variant}`, async () => {
  let value = mission("selection", variant === "leaf" ? { tasks: [] } : {})
  const { page, errors } = await open(() => [value], () => [])
  try {
    const entry = await inlineMissionEntry(page, value.objective)
    await entry.waitFor()
    const original = await entry.elementHandle()
    if (variant === "retitle") value = { ...value, objective: "Renamed selection", revision: 2 }
    // Replace the real Solid panel at the selection/expansion boundary. The HTTP
    // refresh can also rename the business row while the helper still has its old title.
    await page.evaluate(`(async () => {
      const { missionStore } = await import("/src/stores/missions.ts")
      document.addEventListener("click", async function remount(event) {
        if (!event.target.closest(".mission-row-select")) return
        document.removeEventListener("click", remount)
        window.selectionClickTrusted = event.isTrusted
        const fixture = window.missionFixture
        fixture.mount(false)
        await missionStore.refresh("fixture")
        fixture.mount(true)
      })
    })()`)
    const detail = await selectMission(page, "Objective selection")
    assert.equal(await original!.evaluate(element => element.isConnected), false, "the original row really detached")
    assert.equal(await page.evaluate(() => (window as any).selectionClickTrusted), true)
    assert.equal(await selectedMissionTitle(page).innerText(), value.objective)
    assert.equal(await detail.isVisible(), variant !== "leaf")
    assert.equal(await page.locator('.mission-row[data-mission-key="mission:selection"] .session-item-expander:not(.session-item-expander--spacer)').count(), variant === "leaf" ? 0 : 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("marks follow the session palette and a completion stays green until this window shows it", async () => {
  let list = [
    mission("stuck", { updatedAt: 6 }),
    mission("working", { updatedAt: 5 }),
    mission("history", { updatedAt: 4, finishSequence: 1, status: "completed" }),
    mission("failed", { updatedAt: 3, status: "failed" }),
    mission("paused", { updatedAt: 2, runState: "paused" }),
    mission("prepared", { updatedAt: 1, runState: "prepared" }),
  ]
  let activity = [{ missionId: "stuck", actors: [{ sessionId: "ses_stuck", state: "idle-without-report" as const }] },
    { missionId: "working", actors: [{ sessionId: "ses_working", state: "running" as const }] }]
  const { page, errors } = await open(() => list, () => activity)
  try {
    // Each row's flag carries its own mark.
    await (await inlineMissionEntry(page, "Objective stuck")).waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll(".mission-rows .mission-row-flag")].some(element => element.getAttribute("data-mark") === "working"))
    assert.deepEqual(await Promise.all(["Objective stuck", "Objective working", "Objective history", "Objective failed", "Objective paused", "Objective prepared"]
      .map(title => mark(page, title))), ["interrupted", "working", "idle", "interrupted", "paused", "prepared"])
    assert.deepEqual(await page.evaluate(() => {
      const probe = document.createElement("span"); probe.style.color = "var(--accent-primary)"; document.body.append(probe)
      const blue = getComputedStyle(probe).color; probe.remove()
      return ["prepared", "paused"].map(mark => getComputedStyle([...document.querySelectorAll<HTMLElement>(".mission-rows .mission-row-flag")].find(item => item.dataset.mark === mark)!).color === blue)
    }), [true, true], "a prepared mission is accent blue, like a composed prompt, and so is one paused under way")

    list = list.map(value => value.id === "working" ? { ...value, status: "completed", updatedAt: 7, finishSequence: 2, revision: 2 } : value)
    activity = activity.filter(item => item.missionId !== "working")
    await refresh(page)
    await page.waitForFunction(() => [...document.querySelectorAll(".mission-rows .mission-row-flag")]
      .some(element => element.getAttribute("data-mark") === "done"))
    assert.equal(await mark(page, "Objective working"), "done")
    assert.equal(await mark(page, "Objective history"), "idle", "missions already completed on the first read count as seen")

    await selectMission(page, "Objective working")
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "idle")
    assert.equal(await mark(page, "Objective working"), "idle")
    await fixtureCall(page, "flush")
    await page.reload()
    await selectedMissionTitle(page).waitFor()
    assert.equal(await mark(page, "Objective working"), "idle", "seen completions stay seen in this window")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a refresh that reorders the rows keeps keyboard focus and the selection's detail", async () => {
  let list = [mission("first", { updatedAt: 3 }), mission("second", { updatedAt: 2 }), mission("third", { updatedAt: 1 })]
  const { page, errors } = await open(() => list, () => [])
  try {
    await selectMission(page, "Objective second")
    await (await inlineMissionEntry(page, "Objective third")).focus()
    const order = () => page.locator(".mission-rows .mission-row .session-item-title").allInnerTexts()
    assert.deepEqual(await order(), ["Objective first", "Objective second", "Objective third"])
    list = list.map(value => value.id === "third" ? { ...value, updatedAt: 9, revision: 2 } : value)
    await refresh(page)
    await page.waitForFunction(() => document.querySelector(".mission-rows .mission-row .session-item-title")?.textContent === "Objective third")
    assert.deepEqual(await order(), ["Objective third", "Objective first", "Objective second"])
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".mission-row")?.querySelector(".session-item-title")?.textContent),
      "Objective third", "the focused row keeps focus when a refresh moves it")
    assert.equal(await page.locator(".mission-row:has(.mission-row-select[aria-current=true]) + .mission-row-children section.mission-detail").count(), 1,
      "the detail stays the selected row's children")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a selected mission completing behind the creation form stays green until its detail shows again", async () => {
  let list = [mission("selected"), mission("other", { updatedAt: 2 })]
  const { page, errors } = await open(() => list, () => [])
  try {
    await selectMission(page, "Objective selected")
    await page.locator("section.mission-detail").waitFor()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.locator("form.mission-editor").waitFor()
    assert.equal(await page.locator("section.mission-detail").isVisible(), false)
    list = list.map(value => value.id === "selected" ? { ...value, status: "completed", updatedAt: 3, finishSequence: 1, revision: 2 } : value)
    await refresh(page)
    // The hidden (still mounted) tree keeps the unseen completion green.
    const fieldMark = () => page.evaluate(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark"))
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "done")
    await page.waitForTimeout(200)
    assert.equal(await fieldMark(), "done", "a completion behind the form is not seen")
    await page.locator("form.mission-editor").getByRole("button", { name: "Cancel", exact: true }).click()
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "idle")
    assert.equal(await page.locator("section.mission-detail").isVisible(), true, "seen once its detail shows again")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a stopped coordinator offers recovery in Pause's place only while nothing else runs; done tasks stay neutral", async () => {
  const base = mission("run")
  const value = mission("run", { actors: [actor("ses_run"), actor("ses_worker", "specialist")], tasks: [...base.tasks,
    { ...base.tasks[0]!, id: "task-blocked", key: "task-blocked", title: "Publish release", status: "needs-input" }] })
  let activity = [{ missionId: "run", actors: [{ sessionId: "ses_run", state: "idle-without-report" as const },
    { sessionId: "ses_worker", state: "running" as const }] }]
  const { page, errors, recoveries } = await open(() => [value], () => activity)
  try {
    await selectMission(page, "Objective run")
    await missionToolbarAction(page, "Pause mission").waitFor()
    assert.equal(await mark(page, "Objective run"), "working")
    activity = [{ missionId: "run", actors: [{ sessionId: "ses_run", state: "idle-without-report" }, { sessionId: "ses_worker", state: "idle-without-report" }] }]
    await refresh(page)
    await missionToolbarAction(page, "Recover interrupted mission").click()
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "interrupted")
    for (let attempt = 0; !recoveries.length && attempt < 100; attempt++) await page.waitForTimeout(20)
    assert.deepEqual(recoveries, [{ expectedRevision: 1, target: "coordinator" }])

    const [done, blocked, muted] = await page.evaluate(() => {
      const probe = document.createElement("span"); probe.style.color = "var(--text-muted)"; document.body.append(probe)
      const color = getComputedStyle(probe).color; probe.remove()
      return [...["done", "blocked"].map(state =>
        getComputedStyle(document.querySelector(`.mission-tree .mission-tree-node[data-state="${state}"] .mission-tree-mark`)!).color), color]
    })
    assert.equal(done, muted, "a finished task is history, not a green status")
    assert.equal(blocked, muted, "a reported blockage is an outcome, shown by its icon")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a failed mission reads as interrupted and resumes through coordinator recovery", async () => {
  const value = mission("failed", { status: "failed", summary: "Stopped short" })
  const { page, errors, recoveries } = await open(() => [value], () => [])
  try {
    await selectMission(page, "Objective failed")
    assert.match(await page.locator(".mission-row-select[aria-current=true] .sr-only").textContent() ?? "", /^Failed · /)
    assert.equal(await page.locator(".mission-row-select[aria-current=true] .mission-row-flag").getAttribute("data-mark"), "interrupted")
    assert.equal(await missionToolbarAction(page, "Stop mission permanently").isDisabled(), true)
    await missionToolbarAction(page, "Recover interrupted mission").click()
    for (let attempt = 0; !recoveries.length && attempt < 100; attempt++) await page.waitForTimeout(20)
    assert.deepEqual(recoveries, [{ expectedRevision: 1, target: "coordinator" }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the directory reads a row's task marks only while they can change it, and no further than the first seen one", async () => {
  const tasks = (id: string, live: number, updatedAt = 1) => Array.from({ length: 120 }, (_, index) => ({ id: `task-${id}-${index}`, key: `task-${index}`,
    title: `Task ${index}`, brief: "Brief", role: "research", status: index >= 120 - live ? "ready" : "completed", blockedBy: [],
    outstandingExecution: false, createdAt: 1, updatedAt })) as MissionMap["tasks"]
  // The live tasks close the plan: only the attention order brings them into the first window.
  let list = [mission("busy", { updatedAt: 3, tasks: tasks("busy", 2) }),
    mission("closed", { updatedAt: 2, finishSequence: 1, status: "completed", tasks: tasks("closed", 0) })]
  const { page, errors, taskMarkReads } = await open(() => list, () => [])
  const settled = () => page.waitForFunction(async () => {
    const store = (await import("/src/stores/missions.ts")).missionStore, marks = store.taskMarks("fixture", "busy")
    return !marks.loading && marks.revision === store.state("fixture").summaries.find(row => row.id === "busy")?.revision
  })
  try {
    await (await inlineMissionEntry(page, "Objective busy")).waitFor()
    await settled()
    await page.waitForTimeout(300)
    assert.deepEqual(taskMarkReads, ["busy@0"], "one window of the open Mission, none of the closed one it has seen")
    assert.equal(await page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.taskMarks("fixture", "busy").tasks.filter(task => task.status === "ready").length), 2)

    // A task finishes after what this window has seen: its Mission is read again, one window.
    const finished = tasks("busy", 2).map((task, index) => index === 0 ? { ...task, updatedAt: 10 } : task)
    list = [mission("busy", { updatedAt: 10, revision: 2, tasks: finished }), list[1]]
    await refresh(page)
    await settled()
    await page.waitForTimeout(300)
    assert.deepEqual(taskMarkReads, ["busy@0", "busy@0"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
