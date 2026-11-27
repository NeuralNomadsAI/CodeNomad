import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import type { MissionCalendarView } from "../../../server/src/opencode/mission-calendars"
import type {} from "./fixtures/mission-navigation"
import { clickMissionAction, missionDetail, missionEntryStatus, missionMenuItemState, missionRefresh, selectMission, selectedMissionTitle } from "./mission-actions"
import { missionReadFixture } from "./mission-read-fixture"
import { missionContentFixture, panelMissions } from "./mission-content-fixture"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "mission-programming", routes: [{ path: "/mission-programming",
    html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-navigation.tsx\"></script></body></html>" }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const NOW = Date.UTC(2026, 10, 27, 12)
const mission = (id: string, title: string, runState: "prepared" | "running" = "running"): MissionMap => ({ version: 1, id, projectID: "project", projectCanonical: "/fixture",
  title, objective: title, template: "custom", coordinatorSessionId: "ses_review", status: "active", runState,
  actors: [{ sessionId: "ses_review", kind: "coordinator", title: "Coordinator", managed: false, roles: ["coordinator"], location: { directory: "/fixture" }, joinedAt: 1 }],
  tasks: [{ id: `task-${id}`, key: "read", title: "Read the changes", brief: "Read", role: "specialist", status: "ready", blockedBy: [], createdAt: NOW, updatedAt: NOW, outstandingExecution: false }],
  reports: [], frontier: [], claims: [], revision: 2, createdAt: NOW, updatedAt: NOW, history: [], historyTruncated: false } as unknown as MissionMap)
const programming = (missionID: string, extra: Partial<MissionCalendarView> = {}): MissionCalendarView => ({ id: "cal_review", title: "Daily review", paused: false, missionID, mission: {},
  launch: { when: [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }] },
  rules: [{ automationID: "aut_1", trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, tz: "UTC", runCount: 2, nextDueAt: Date.UTC(2026, 10, 28, 9) }],
  last: { outcome: "launched", at: NOW, missionID, launches: 2, history: [{ at: Date.UTC(2026, 10, 26, 9), outcome: "completed" }] }, ...extra })

async function setup() {
  const page = await browser.newPage({ locale: "en-GB", viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(15000)
  const state = { missions: [mission("A", "Daily review"), mission("B", "Other work")], calendars: [programming("A")] }
  const writes: string[] = []
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method()
    if (method !== "GET") writes.push(`${method} ${pathname.slice(pathname.indexOf("/missions"))}`)
    if (pathname === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
    const calendar = /\/missions\/calendars(?:\/cal_review(?:\/(pause|resume))?)?$/.exec(pathname)
    if (calendar) {
      if (method === "DELETE") state.calendars = []
      else if (calendar[1]) state.calendars = state.calendars.map(item => ({ ...item, paused: calendar[1] === "pause" }))
      return route.fulfill({ json: { calendars: state.calendars } })
    }
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(state.missions),
      generatedAt: NOW, discardedEvents: 0, activity: { generatedAt: NOW, missions: [] } } })
    const read = missionReadFixture(pathname, method, state.missions) ?? missionContentFixture(request.url(), method, state.missions)
    if (read) return route.fulfill({ json: read })
    if (pathname.endsWith("/agent")) return route.fulfill({ json: [{ id: "build", name: "build", mode: "primary" }] })
    if (pathname.endsWith("/provider")) return route.fulfill({ json: { all: [], connected: [], default: {} } })
    return route.fulfill({ json: pathname.includes("/instance/") ? [] : {} })
  })
  await page.goto(url, { timeout: 60000 })
  return { page, state, writes }
}
const facts = async (page: Page) => (await missionDetail(page).locator(".mission-schedule-facts").innerText()).replace(/\s+/g, " ")

test("a programmed Mission is one ordinary row that shows and controls its programming", async () => {
  const { page, state, writes } = await setup()
  try {
    await selectMission(page, "Daily review")
    assert.match(await missionEntryStatus(page, "Daily review"), /Every day · 09:00 · UTC · Next wake · Nov 28, 2026, 9:00 AM/)
    assert.doesNotMatch(await missionEntryStatus(page, "Other work"), /Next wake/)
    assert.match(await facts(page), /Launch when Every day · 09:00 · UTC Desired state Running Pause Next wake Nov 28, 2026, 9:00 AM Launched passages 2/)
    assert.match(await missionDetail(page).locator(".mission-past-runs").innerText(), /Nov 26, 2026, 9:00 AM · Completed/)
    assert.equal((await missionMenuItemState(page, "edit")).enabled, false)

    await missionDetail(page).getByRole("button", { name: "Scheduling · Pause" }).click()
    await missionDetail(page).getByRole("button", { name: "Scheduling · Resume" }).waitFor()
    assert.match(await facts(page), /Paused Resume Next wake None/)
    assert.deepEqual(writes, ["POST /missions/calendars/cal_review/pause"])

    // The next launch replaces the Mission: the selection follows it.
    state.missions = [mission("C", "Daily review"), mission("B", "Other work")]
    state.calendars = [programming("C", { paused: true })]
    await missionRefresh(page).click()
    await page.locator('.mission-row[data-mission-key="mission:C"] .mission-row-select[aria-current=true]').waitFor()
    assert.equal((await selectedMissionTitle(page).innerText()).trim(), "Daily review")

    // Deleting it removes the programming first.
    writes.length = 0
    const removed = page.waitForResponse(response => response.request().method() === "DELETE" && /\/missions\/C$/.test(new URL(response.url()).pathname))
    await clickMissionAction(page, "Delete selected mission…")
    await removed
    assert.deepEqual(writes.slice(0, 2), ["DELETE /missions/calendars/cal_review", "DELETE /missions/C"])
  } finally { await page.close() }
})
