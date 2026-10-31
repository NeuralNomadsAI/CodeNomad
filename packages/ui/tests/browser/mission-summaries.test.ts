import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionActor, MissionMap } from "../../../server/src/api-types"
import { missionSummary } from "../../../server/src/missions/mission-summary"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { inlineMissionEntry, missionDetail, missionRefresh, missionToolbarAction, selectMission } from "./mission-actions"
import { routeMissionContent, panelMissions } from "./mission-content-fixture"

// A backend that lists summaries: the open mission as a full map, closed ones as
// rows until the panel includes them, and unchanged rows skipped by version.
let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "mission-summaries", routes: [{ path: "/mission-fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const actor = (sessionId: string): MissionActor =>
  ({ sessionId, title: sessionId, kind: "coordinator", managed: false, roles: ["coordinator"], location: { directory: "fixture" }, joinedAt: 1 })
function mission(id: string, patch: Partial<MissionMap> = {}): MissionMap {
  // The mission's own reports hold every report, as the reducer keeps them.
  const report = { id: `rpt_${id}`, taskKey: "work", sessionId: `ses_${id}`, outcome: "completed" as const, summary: `Result of ${id}`, evidence: [], next: [], createdAt: 1 }
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [actor(`ses_${id}`)], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false, reports: [report],
    tasks: [{ id: `task-${id}`, key: "work", title: `Work of ${id}`, brief: "Brief", role: "research", status: "completed",
      blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1, report }], ...patch }
}

async function open() {
  const maps = [mission("open", { updatedAt: 9 }), mission("failed", { status: "failed", summary: "Stopped short of the release", updatedAt: 8 }),
    mission("done", { status: "completed", summary: "Shipped", updatedAt: 7 }), mission("stopped", { status: "stopped", runState: "stopped", updatedAt: 6 })]
  const requests: URLSearchParams[] = []
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
    claimClientStateAccess: async () => true, loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }), saveClientState: async () => true } })`)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.route(target => target.pathname === "/api/workspaces/fixture/missions", route => {
    const query = new URL(route.request().url()).searchParams
    requests.push(query)
    const include = (query.get("include") ?? "").split(",").filter(Boolean)
    const listed = maps.filter(value => value.status === "active" || include.includes(value.id))
    return route.fulfill({ json: { available: true, version: 1, projectID: "project", generatedAt: Date.now(), discardedEvents: 0, cleanups: [],
      missions: panelMissions(listed), ...(query.get("summaries") === "v1" ? {} : { summaries: maps.map(missionSummary) }), summariesVersion: "v1",
      activity: { generatedAt: Date.now(), missions: listed.map(value => ({ missionId: value.id,
        actors: [{ sessionId: value.coordinatorSessionId, state: value.status === "active" ? "running" : "unknown" }] })) } } })
  })
  await routeMissionContent(page, () => maps)
  await page.goto(url)
  return { page, errors, requests }
}
/** A summaries backend whose list reads `answer` may delay or fail; returns the read log. */
async function panel(maps: MissionMap[], answer: (include: string[], read: number) => Promise<number | void> = async () => {}) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  const includes: string[][] = []
  await page.addInitScript(`Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
    claimClientStateAccess: async () => true, loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }), saveClientState: async () => true } })`)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.route(target => target.pathname === "/api/workspaces/fixture/missions", async route => {
    const include = (new URL(route.request().url()).searchParams.get("include") ?? "").split(",").filter(Boolean)
    includes.push(include)
    const status = await answer(include, includes.length)
    if (status) return route.fulfill({ status, json: { error: "unavailable" } })
    const listed = maps.filter(value => value.status === "active" || include.includes(value.id))
    return route.fulfill({ json: { available: true, version: 1, projectID: "project", generatedAt: 2, discardedEvents: 0, cleanups: [], missions: panelMissions(listed),
      summaries: maps.map(missionSummary), summariesVersion: "v1", activity: { generatedAt: 2, missions: [] } } })
  })
  await routeMissionContent(page, () => maps)
  await page.goto(url)
  await page.waitForFunction(() => (window as any).missionFixture?.snapshot().status === "ready")
  return { page, includes }
}
const choose = (page: Page, id: string) => page.evaluate(async id =>
  (await import("/src/stores/mission-view-state.ts" as string)).updateMissionProjectView("fixture", { selected: id }), id)
const shownDetail = (page: Page, title: string) => page.locator(`section.mission-detail[aria-label="${title}"]`)

test("a failed selected-map read stays parked until an explicit retry; a successful one costs one follow-up", async () => {
  const closed = [mission("closed", { status: "completed", updatedAt: 2 })]
  const failing = await panel(closed, async (_include, read) => {
    if (read > 1) { await new Promise(resolve => setTimeout(resolve, 25)); return 503 }
  })
  try {
    await choose(failing.page, "closed")
    await failing.page.waitForTimeout(900)
    assert.deepEqual(failing.includes, [[], ["closed"]], "one include read, then parked")
    assert.equal(await failing.page.evaluate(() => (window as any).missionFixture.snapshot().status), "error")
    // Parked: the stale banner and the refresh button, never a claim that the map is being read.
    assert.deepEqual(await failing.page.locator(".mission-control > p[role=status]").allTextContents(), [])
    await failing.page.locator(".mission-control-stale").waitFor()
    assert.equal(await missionRefresh(failing.page).isDisabled(), false)
    await missionRefresh(failing.page).click()
    await failing.page.waitForTimeout(500)
    assert.deepEqual(failing.includes, [[], ["closed"], ["closed"]], "an explicit retry reads once more")
  } finally { await failing.page.close() }
  const loading = await panel(closed)
  try {
    await choose(loading.page, "closed")
    await shownDetail(loading.page, "Objective closed").waitFor()
    await loading.page.waitForTimeout(500)
    assert.deepEqual(loading.includes, [[], ["closed"]], "a loaded map needs no further read")
  } finally { await loading.page.close() }
})

test("an obsolete include response never unmounts the current selection's loaded detail (A → B → A)", async () => {
  const maps = [mission("A", { status: "completed", updatedAt: 2 }), mission("B", { status: "completed", updatedAt: 1 })]
  let race = false, heldA = false, heldB = false, releaseA!: () => void, releaseB!: () => void
  const waitA = new Promise<void>(resolve => { releaseA = resolve }), waitB = new Promise<void>(resolve => { releaseB = resolve })
  const { page, includes } = await panel(maps, async include => {
    if (race && include.includes("B")) { heldB = true; await waitB }
    else if (race && include.includes("A")) { heldA = true; await waitA }
  })
  try {
    await choose(page, "A")
    await shownDetail(page, "Objective A").waitFor()
    race = true
    await choose(page, "B")
    while (!heldB) await page.waitForTimeout(10)
    await choose(page, "A")
    assert.equal(await shownDetail(page, "Objective A").count(), 1)
    // Record any moment A's detail leaves the DOM while B's obsolete answer and A's follow-up land.
    await page.evaluate(() => {
      const w = window as any; w.lostA = false
      w.watchA = new MutationObserver(() => { if (!document.querySelector('section.mission-detail[aria-label="Objective A"]')) w.lostA = true })
      w.watchA.observe(document.body, { childList: true, subtree: true })
    })
    releaseB()
    while (!heldA) await page.waitForTimeout(10)
    assert.equal(await shownDetail(page, "Objective A").count(), 1, "the obsolete B answer keeps A mounted")
    releaseA()
    await page.waitForFunction(() => (window as any).missionFixture.snapshot().status === "ready")
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => (window as any).lostA), false, "A stayed mounted throughout")
    assert.equal(await shownDetail(page, "Objective A").count(), 1)
    assert.deepEqual(includes.slice(-2), [["B"], ["A"]], "one follow-up for the current include")
  } finally { releaseA(); releaseB(); await page.close() }
})

test("hiding the panel cancels the follow-up an obsolete include answer would start; activation and a visible reader still load", async () => {
  const maps = [mission("A", { status: "completed", updatedAt: 2 }), mission("B", { status: "completed", summary: "Closed B summary", updatedAt: 1 })]
  let race = false, heldB = false, releaseB!: () => void
  const waitB = new Promise<void>(resolve => { releaseB = resolve })
  const { page, includes } = await panel(maps, async include => {
    if (race && include.includes("B")) { heldB = true; await waitB }
  })
  const fixtureCall = (method: string, arg?: unknown) => page.evaluate(({ method, arg }) => (window as any).missionFixture[method](arg), { method, arg })
  try {
    await choose(page, "A")
    await shownDetail(page, "Objective A").waitFor()
    race = true
    await choose(page, "B")
    while (!heldB) await page.waitForTimeout(10)
    await choose(page, "A")
    await fixtureCall("active", false)
    assert.deepEqual(await page.evaluate(async () => (await import("/src/stores/missions.ts" as string)).missionStore.demandedInstanceIds()), [])
    releaseB()
    await page.waitForFunction(() => (window as any).missionFixture.snapshot().status === "ready")
    await page.waitForTimeout(300)
    assert.deepEqual(includes, [[], ["A"], ["B"]], "the hidden panel reads nothing more")
    // Activation reads the current include.
    await fixtureCall("active", true)
    while (includes.length < 4) await page.waitForTimeout(10)
    assert.deepEqual(includes[3], ["A"])
    await shownDetail(page, "Objective A").waitFor()
    // A central reader is demand of its own, with the panel hidden.
    await fixtureCall("active", false)
    race = false
    await page.evaluate(async () => (await import("/src/stores/mission-view-state.ts" as string)).updateMissionProjectView("fixture", { reader: { missionId: "B", kind: "overview" } }))
    await page.locator(".mission-reader").getByText("Closed B summary").waitFor()
    assert.ok(includes.at(-1)!.includes("B"), "the reader's map was read")
  } finally { releaseB(); await page.close() }
})

const mark = async (page: Page, title: string) => (await inlineMissionEntry(page, title)).locator(".mission-picker-mark").getAttribute("data-mark")

test("closed missions list as rows with their marks and open their full map only when selected", async () => {
  const { page, errors, requests } = await open()
  try {
    await (await inlineMissionEntry(page, "Objective stopped")).waitFor()
    assert.deepEqual(await Promise.all(["Objective open", "Objective failed", "Objective done", "Objective stopped"].map(title => mark(page, title))),
      ["working", "interrupted", "idle", "idle"], "rows alone carry every closed mark")
    assert.equal(requests[0]?.toString(), "", "the first read cannot know the backend lists summaries")

    await selectMission(page, "Objective failed")
    assert.deepEqual([requests.at(-1)?.get("include"), requests.at(-1)?.get("summaries")], ["failed", "v1"])
    await missionToolbarAction(page, "Recover interrupted mission").waitFor()
    await missionDetail(page).locator('.mission-tree li[data-task-key="work"]').waitFor()
    // The included closed map serves the readers: its overview, then its task.
    await missionDetail(page).locator(".mission-overview-toggle").first().click()
    await page.locator(".mission-reader").getByText("Stopped short of the release").waitFor()
    await missionDetail(page).locator('.mission-tree li[data-task-key="work"] > button.mission-tree-task').click()
    await page.locator(".mission-reader").getByText("Result of failed").waitFor()

    // Refreshes keep the held rows (omitted, same version) and re-read the selection.
    const reads = requests.length
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/missions"))
    await missionRefresh(page).click()
    await refreshed
    assert.ok(requests.length > reads)
    assert.equal(requests.at(-1)?.get("include"), "failed")
    assert.equal(await page.locator(".mission-picker-inline button.mission-picker-option").count(), 4)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
