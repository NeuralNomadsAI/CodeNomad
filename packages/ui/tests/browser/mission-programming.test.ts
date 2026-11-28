import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import type { MissionCalendarView } from "../../../server/src/opencode/mission-calendars"
import type {} from "./fixtures/mission-navigation"
import { clickMissionAction, missionDetail, missionEntryStatus, missionRefresh, selectMission, selectedMissionTitle } from "./mission-actions"
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
const profile = { agent: "build", model: { providerID: "p", id: "m" } }
const programming = (missionID: string, extra: Partial<MissionCalendarView> = {}): MissionCalendarView => ({ id: "cal_review", title: "Daily review", paused: false, missionID,
  mission: { objective: "Review the changes", template: "custom", taskMode: "native", profiles: { coordinator: profile, roles: { specialist: profile } } },
  launch: { when: [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }] },
  rules: [{ automationID: "aut_1", trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, tz: "UTC", runCount: 2, nextDueAt: Date.UTC(2026, 10, 28, 9) }],
  last: { outcome: "launched", at: NOW, missionID, launches: 2, history: [{ at: Date.UTC(2026, 10, 26, 9), outcome: "completed" }] }, ...extra })

async function setup() {
  const page = await browser.newPage({ locale: "en-GB", viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(15000)
  const state = { missions: [mission("A", "Daily review"), mission("B", "Other work")], calendars: [programming("A")] }
  const writes: string[] = [], saved: any[] = []
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method()
    if (method !== "GET") writes.push(`${method} ${pathname.slice(pathname.indexOf("/missions"))}`)
    if (pathname === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
    const calendar = /\/missions\/calendars(?:\/([^/]+)(?:\/(pause|resume))?)?$/.exec(pathname)
    if (calendar) {
      if (method === "PUT") {
        const body = request.postDataJSON(); saved.push(body)
        // A programming saved for the first time comes with the Mission prepared for its first launch.
        if (!state.calendars.some(item => item.id === calendar[1])) {
          state.missions = [...state.missions, mission("P", body.configuration.title, "prepared")]
          state.calendars = [...state.calendars, { ...programming("P", { paused: body.paused === true, launch: body.configuration.launch, last: undefined }), id: calendar[1], title: body.configuration.title }]
        }
      }
      if (method === "DELETE") state.calendars = []
      else if (calendar[2]) state.calendars = state.calendars.map(item => ({ ...item, paused: calendar[2] === "pause" }))
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
  return { page, state, writes, saved, open: () => page.goto(url, { timeout: 60000 }) }
}
const facts = async (page: Page) => (await missionDetail(page).locator(".mission-schedule-facts").innerText()).replace(/\s+/g, " ")

test("a programmed Mission is one ordinary row that shows and controls its programming", async () => {
  const { page, state, writes, saved, open } = await setup()
  try {
    await open()
    await selectMission(page, "Daily review")
    assert.match(await missionEntryStatus(page, "Daily review"), /Every day · 09:00 · UTC · Next wake · Nov 28, 2026, 9:00 AM/)
    assert.doesNotMatch(await missionEntryStatus(page, "Other work"), /Next wake/)
    const icon = (key: string) => page.locator(`.mission-row[data-mission-key="mission:${key}"] .mission-row-flag`)
    assert.deepEqual([await icon("A").getAttribute("class"), await icon("B").getAttribute("class")].map(value => /lucide-repeat/.test(value ?? "")), [true, false])
    assert.match(await facts(page), /Launch when Every day · 09:00 · UTC Desired state Running Next wake Nov 28, 2026, 9:00 AM Launched passages 2/)
    assert.match(await missionDetail(page).locator(".mission-past-runs").innerText(), /Nov 26, 2026, 9:00 AM · Completed/)

    // A launch is under way: Pause holds the programmed Mission whole, its programming first, then the launch.
    assert.equal(await missionDetail(page).getByRole("button").filter({ hasText: /^(Pause|Resume)$/ }).count(), 0)
    const paused = page.waitForResponse(response => /\/missions\/A\/control$/.test(new URL(response.url()).pathname))
    await clickMissionAction(page, "Pause mission")
    await paused
    await missionDetail(page).getByText("Paused", { exact: true }).waitFor()
    assert.match(await facts(page), /Desired state Paused Next wake None/)
    assert.deepEqual(writes, ["POST /missions/calendars/cal_review/pause", "POST /missions/A/control"])

    // The next launch replaces the Mission: the selection follows it.
    state.missions = [mission("C", "Daily review"), mission("B", "Other work")]
    state.calendars = [programming("C", { paused: true })]
    await missionRefresh(page).click()
    await page.locator('.mission-row[data-mission-key="mission:C"] .mission-row-select[aria-current=true]').waitFor()
    assert.equal((await selectedMissionTitle(page).innerText()).trim(), "Daily review")

    // Between launches the row waits for its next wake, or is paused.
    state.missions = [{ ...mission("C", "Daily review"), status: "completed" } as MissionMap, mission("B", "Other work")]
    state.calendars = [programming("C")]
    await missionRefresh(page).click()
    await page.locator('.mission-row[data-mission-key="mission:C"] .mission-row-mark[data-mark="waiting"] .lucide-hourglass').waitFor()
    assert.match(await missionEntryStatus(page, "Daily review"), /^Waiting for scheduled run · Every day/)
    state.missions = [mission("C", "Daily review"), mission("B", "Other work")]
    await missionRefresh(page).click()
    await page.locator('.mission-row[data-mission-key="mission:C"] .mission-row-mark:not([data-mark="waiting"])').waitFor()

    // Edit reopens the form that created it and saves the same programming.
    await clickMissionAction(page, "Edit selected mission")
    const form = page.locator("form.mission-editor")
    assert.equal(await form.getByLabel("Objective", { exact: true }).inputValue(), "Review the changes")
    assert.deepEqual([await form.getByLabel("Criterion 1 type", { exact: true }).inputValue(), await form.getByLabel("Criterion 1 time", { exact: true }).inputValue()], ["daily", "09:00"])
    assert.equal(await form.getByRole("checkbox", { name: "Start automatically", exact: true }).count(), 0)
    await form.getByLabel("Objective", { exact: true }).fill("Review the changes, briefly")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.equal(writes.at(-1), "PUT /missions/calendars/cal_review")
    assert.deepEqual([saved[0].configuration.objective, saved[0].configuration.title, saved[0].configuration.launch, saved[0].paused],
      ["Review the changes, briefly", "Daily review", programming("C").launch, undefined])
    assert.deepEqual(saved[0].configuration.profiles, programming("C").mission.profiles)

    // Deleting it removes the programming first.
    writes.length = 0
    const removed = page.waitForResponse(response => response.request().method() === "DELETE" && /\/missions\/C$/.test(new URL(response.url()).pathname))
    await clickMissionAction(page, "Delete selected mission…")
    await removed
    assert.deepEqual(writes.slice(0, 2), ["DELETE /missions/calendars/cal_review", "DELETE /missions/C"])
  } finally { await page.close() }
})

test("a programmed Mission without tasks unfolds from its chevron like any other", async () => {
  const { page, state, open } = await setup()
  try {
    state.missions = [{ ...mission("A", "Daily review", "prepared"), tasks: [] } as MissionMap, { ...mission("B", "Other work"), tasks: [] } as MissionMap]
    await open()
    const chevron = (key: string) => page.locator(`.mission-row[data-mission-key="mission:${key}"] .session-item-expander:not(.session-item-expander--spacer)`)
    await chevron("A").waitFor()
    assert.equal(await chevron("B").count(), 0, "an ordinary Mission without tasks has none")
    // The chevron selects it and shows its programming; folding hides it again.
    await chevron("A").click()
    await page.locator('.mission-row[data-mission-key="mission:A"] .mission-row-select[aria-current=true]').waitFor()
    assert.match(await facts(page), /Launch when Every day · 09:00 · UTC/)
    await chevron("A").click()
    await missionDetail(page).locator(".mission-schedule-facts").waitFor({ state: "hidden" })
  } finally { await page.close() }
})

test("a paused programmed Mission between launches reads as paused, and Play resumes its programming", async () => {
  const { page, state, writes, open } = await setup()
  try {
    state.missions = [mission("A", "Daily review", "prepared"), mission("B", "Other work")]
    state.calendars = [programming("A", { paused: true, last: undefined })]
    await open()
    await selectMission(page, "Daily review")
    await page.locator('.mission-row[data-mission-key="mission:A"] .mission-row-mark[data-mark="paused"]').waitFor()
    assert.match(await missionEntryStatus(page, "Daily review"), /^Paused · Every day/)
    // Play resumes the programming; it starts no launch by hand.
    await clickMissionAction(page, "Scheduling · Resume")
    await page.locator('.mission-row[data-mission-key="mission:A"] .mission-row-mark[data-mark="waiting"]').waitFor()
    await clickMissionAction(page, "Scheduling · Pause")
    await page.locator('.mission-row[data-mission-key="mission:A"] .mission-row-mark[data-mark="paused"]').waitFor()
    assert.deepEqual(writes, ["POST /missions/calendars/cal_review/resume", "POST /missions/calendars/cal_review/pause"])
    // Stop ends the programming for good, once confirmed: the Mission stays, as an ordinary one.
    await clickMissionAction(page, "Stop scheduling permanently")
    await page.getByRole("dialog").getByRole("button", { name: "Stop scheduling permanently", exact: true }).click()
    await page.locator('.mission-row[data-mission-key="mission:A"] .mission-row-mark:not([data-mark="paused"])').waitFor()
    assert.equal(writes.at(-1), "DELETE /missions/calendars/cal_review")
    assert.doesNotMatch(await missionEntryStatus(page, "Daily review"), /Every day/)
  } finally { await page.close() }
})

test("Play on a paused launch resumes the programmed Mission whole: the launch, then its programming", async () => {
  const { page, state, writes, open } = await setup()
  try {
    state.missions = [{ ...mission("A", "Daily review"), runState: "paused" } as MissionMap, mission("B", "Other work")]
    state.calendars = [programming("A", { paused: true })]
    await open()
    await selectMission(page, "Daily review")
    await page.locator('.mission-row[data-mission-key="mission:A"] .mission-row-mark[data-mark="paused"]').waitFor()
    const resumed = page.waitForResponse(response => /\/resume$/.test(new URL(response.url()).pathname))
    await clickMissionAction(page, "Resume mission")
    await resumed
    assert.deepEqual(writes, ["POST /missions/A/control", "POST /missions/calendars/cal_review/resume"])
  } finally { await page.close() }
})