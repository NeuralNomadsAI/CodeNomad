import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionActor, MissionActorActivity, MissionMap } from "../../../server/src/api-types"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget, waitForMissionPanelRefresh } from "./mission-panel-route"
import { inlineMissionEntry, missionToolbarAction, selectedMissionTitle, selectMission } from "./mission-actions"
import { panelMissions } from "./mission-content-fixture"
import { recurrenceCurrentPageInput } from "../../../server/src/missions/recurrence-current"
import { projectMissionPanel } from "../../../server/src/missions/mission-panel-projection"
import { missionPanelPage } from "../../../server/src/missions/mission-panel-page"
import { missionActivityContext } from "../../../server/src/missions/mission-activity-context"

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

async function open(missions: () => MissionMap[], activity: () => Array<{ missionId: string; actors: MissionActorActivity[] }>,
  schedules: RecurrenceSchedule[] = []) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  const errors: string[] = [], recoveries: unknown[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
    claimClientStateAccess: async () => true,
    loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(localStorage.getItem("fixture-native") ?? "null") }),
    saveClientState: async (_token, snapshot) => { localStorage.setItem("fixture-native", JSON.stringify(snapshot)); return true },
  } })`)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(missions()),
    generatedAt: Date.now(), discardedEvents: 0, activity: { generatedAt: Date.now(), missions: activity() } } }))
  // The real bounded source/projections include its coordinator and one independent actor.
  const current = (id: string) => {
    const schedule = schedules.find(item => item.id === id), passageID = schedule?.pending?.passageID ?? null
    return { passageID, source: passageID ? { owner: "daily" as const, projectID: "project", scheduleID: id, passageID, missionID: passageID, digest: "a".repeat(43) } : undefined,
      map: passageID ? mission(passageID, { coordinatorSessionId: schedule!.pending!.conversationID,
        actors: [actor(schedule!.pending!.conversationID!), actor("ses_independent", "specialist")] }) : undefined }
  }
  await page.route(url => url.pathname.endsWith("/current"), route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!, value = current(id)
    return route.fulfill({ json: { version: 1, ownerRevision: 1, projectID: "project", scheduleID: id, passageID: value.passageID, ...(value.source ? { source: value.source } : {}) } })
  })
  await page.route(url => /\/current\/[^/]+\/page$/.test(url.pathname), route => {
    const input = recurrenceCurrentPageInput.parse(route.request().postDataJSON()), { map, source } = current(input.source.scheduleID), selector = input.selector
    assert.ok(map && source); assert.deepEqual(input.source, source)
    if (selector.source === "summaries" || selector.source === "cleanups" || selector.source === "marks") throw Error("Unexpected project read")
    const damage = { discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
    if (selector.source === "activity") return route.fulfill({ json: missionPanelPage({ projectID: "project", missionID: map.id, revision: map.revision,
      ...damage, passage: source, source: "activity", phase: "observed", observedAt: 1 }, [{ context: missionActivityContext(map, damage), coverage: "unknown",
      requests: { state: "unknown", items: [] }, activity: { actors: map.actors.map(actor => ({ sessionId: actor.sessionId, state: "unknown" })),
        family: { state: "unknown", members: [] } } }], selector.cursor) })
    return route.fulfill({ json: projectMissionPanel(map, selector, damage, { passage: source }) })
  })
  await page.route(url => url.pathname === "/api/workspaces/fixture/missions/recurrence", route => route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1,
    projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules }) }))
  await page.route("**/api/workspaces/fixture/missions/*/recover", route => {
    recoveries.push(route.request().postDataJSON())
    return route.fulfill({ json: { mission: missions()[0], admitted: true } })
  })
  await page.goto(url)
  return { page, errors, recoveries }
}
const fixtureCall = (page: Page, method: string) => page.evaluate(method => (window as any).missionFixture[method](), method)
async function refresh(page: Page) {
  const response = waitForMissionPanelRefresh(page)
  await fixtureCall(page, "refresh")
  await response
}
const mark = async (page: Page, title: string) => (await inlineMissionEntry(page, title)).locator(".mission-row-flag").getAttribute("data-mark")

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
    assert.equal(await page.evaluate(() => {
      const element = [...document.querySelectorAll<HTMLElement>(".mission-rows .mission-row-flag")].find(item => item.dataset.mark === "prepared")!
      const probe = document.createElement("span"); probe.style.color = "var(--accent-primary)"; document.body.append(probe)
      const blue = getComputedStyle(probe).color; probe.remove()
      return getComputedStyle(element).color === blue
    }), true, "a prepared mission is accent blue, like a composed prompt")

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
        getComputedStyle(document.querySelector(`.mission-tree li[data-state="${state}"] .mission-tree-mark`)!).color), color]
    })
    assert.equal(done, muted, "a finished task is history, not a green status")
    assert.equal(blocked, muted, "a reported blockage is an outcome, shown by its icon")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a recurring passage waiting for an answer is red; stopped and paused schedules keep a past failure quiet", async () => {
  const schedule = (id: string, title: string, patch: Partial<RecurrenceSchedule>): RecurrenceSchedule => ({ id, title, revision: 2,
    state: "running", clock: { time: "08:15", zone: "UTC" }, nextDueAt: Date.UTC(2026, 9, 28, 8, 15), pending: null, latestResult: null, history: [], controls: [],
    actions: ["pause", "stop", "run-now"], ...patch })
  const failedRun = { passageID: "pas_old", dueAt: 1, settledAt: 2, outcome: "failed" as const, reason: "not-started" as const, trigger: "daily" as const }
  const { page, errors } = await open(() => [], () => [], [
    schedule("rec_wait", "Waiting review", { pending: { passageID: "pas_wait", status: "running", trigger: "daily", conversationID: "ses_passage" },
      actions: ["pause", "stop"] }),
    schedule("rec_stopped", "Stopped review", { state: "stopped", nextDueAt: null, latestResult: failedRun, history: [failedRun], actions: [] }),
    schedule("rec_paused", "Paused review", { state: "paused", nextDueAt: null, latestResult: failedRun, history: [failedRun],
      actions: ["play", "stop", "run-now"] }),
  ])
  try {
    // Schedules are read only through a connected instance.
    await fixtureCall(page, "connectCatalog")
    await (await inlineMissionEntry(page, "Waiting review")).waitFor()
    assert.deepEqual(await Promise.all(["Waiting review", "Stopped review", "Paused review"].map(title => mark(page, title))),
      ["working", "idle", "paused"])
    // Selected, its read passage counts exactly what Needs you lists: a loaded
    // subsession outside the observed family does not, its declared actors do.
    await page.evaluate(() => (window as any).missionFixture.seedCoordinators(["ses_passage", "ses_child"], { ses_child: "ses_passage" }))
    await selectMission(page, "Waiting review")
    await page.locator('.mission-tree [data-task-key="task-one"]').waitFor()
    await page.evaluate(() => (window as any).missionFixture.queuePermission("ses_child", "child-permission"))
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(await page.locator(".mission-row-select[aria-current=true] .mission-row-flag").getAttribute("data-mark"), "working")
    await page.evaluate(() => (window as any).missionFixture.queuePermission("ses_independent", "independent-permission"))
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "permission")
    // Other rows read the live passage's own conversation.
    await selectMission(page, "Stopped review")
    await page.evaluate(() => (window as any).missionFixture.queuePermission("ses_passage"))
    await page.waitForFunction(() => [...document.querySelectorAll(".mission-rows .mission-row-flag")]
      .some(element => element.getAttribute("data-mark") === "permission"))
    assert.equal(await mark(page, "Waiting review"), "permission")
    assert.match(await (await inlineMissionEntry(page, "Waiting review")).locator(".sr-only").textContent() ?? "", /Awaiting your input/)
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
