import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionActor, MissionMap } from "../../../server/src/api-types"
import { missionSummary } from "../../../server/src/missions/mission-summary"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { inlineMissionEntry, missionDetail, missionRefresh, missionToolbarAction, selectMission } from "./mission-actions"

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
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [actor(`ses_${id}`)], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false, reports: [],
    tasks: [{ id: `task-${id}`, key: "work", title: `Work of ${id}`, brief: "Brief", role: "research", status: "completed",
      blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1,
      report: { id: `rpt_${id}`, taskKey: "work", sessionId: `ses_${id}`, outcome: "completed", summary: `Result of ${id}`, evidence: [], next: [], createdAt: 1 } }], ...patch }
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
      missions: listed, ...(query.get("summaries") === "v1" ? {} : { summaries: maps.map(missionSummary) }), summariesVersion: "v1",
      activity: { generatedAt: Date.now(), missions: listed.map(value => ({ missionId: value.id,
        actors: [{ sessionId: value.coordinatorSessionId, state: value.status === "active" ? "running" : "unknown" }] })) } } })
  })
  await page.goto(url)
  return { page, errors, requests }
}
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
