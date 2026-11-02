import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"
import { preparationFixture, scheduledPreparation } from "../../../server/src/missions/mission-preparation-test-fixture"
import { readMissionSchedulePage } from "../../../server/src/missions/mission-schedule-list"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "mission-ownership-selection", routes: [{ path: "/selection",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })
  url = fixture.url; events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

for (const restored of ["selectedScheduled", "selected"] as const) test(`passive conversions keep the selected unified Mission outside the loaded document page (restored ${restored})`, async () => {
  const f = await preparationFixture("fixture"), configuration = scheduledPreparation(f)
  await f.control.configurePreparation({ ...f.request, configuration }, f.native, () => true)
  for (let index = 0; index < 8; index++) await f.store.create(`aaa_${index}`, {
    ...configuration, title: `Other Mission ${index}` }, Date.now(), () => true)
  const page = await browser.newPage(), errors: string[] = [], reads: URL[] = [], writes: string[] = []
  page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15000)
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await events.route(page)
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { locale: "en" } } }))
  await page.route("**/api/workspaces/fixture/missions**", async route => {
    const request = route.request(), link = new URL(request.url()), pathname = link.pathname
    if (pathname.endsWith("/panel-page")) return route.fulfill({ json: await f.control.panelPage(request.postDataJSON()) })
    if (request.method() !== "GET") { writes.push(pathname); return route.fulfill({ status: 405, json: {} }) }
    reads.push(link)
    if (pathname.endsWith("/capabilities")) return route.fulfill({ json: { api: { available: true }, enabled: true,
      location: { directory: "fixture" }, activation: { available: false, reason: "missing-api", targets: [] } } })
    if (pathname.endsWith("/scheduled")) return route.fulfill({ json: await readMissionSchedulePage(f.storage,
      { id: "project", canonical: "fixture" }, { ...(link.searchParams.has("after") ? { after: link.searchParams.get("after") } : {}), limit: 8 }) })
    if (pathname.endsWith("/schedule")) return route.fulfill({ json: missionScheduleView(await f.read()) })
    if (pathname.endsWith("/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project", projectCanonical: "fixture",
      location: { directory: "fixture" }, schedules: [] } })
    if (pathname.endsWith(`/${f.mission.id}`)) return route.fulfill({ json: { available: true, ...await f.control.mission(f.mission.id) } })
    const listed = await f.control.list()
    return route.fulfill({ json: { available: true, ...listed, activity: { generatedAt: 1, missions: [] } } })
  })
  try {
    await page.goto(url)
    await page.waitForFunction(() => !!(window as any).missionFixture)
    await page.evaluate(async ({ id, restored }) => {
      ;(window as any).missionFixture.connectCatalog()
      ;(await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { [restored]: id })
    }, { id: f.mission.id, restored })
    const schedule = page.locator(".mission-unified-schedule")
    await schedule.waitFor()
    // Another window converts the same paused preparation; this window only receives invalidations.
    let doc = await f.read()
    await f.control.configurePreparation({ ...f.request, requestID: "external_immediate", expectedRevision: doc.revision }, f.native, () => true)
    await page.evaluate(() => (window as any).missionFixture.refresh())
    await page.locator(".mission-detail:not(.mission-unified-schedule)").waitFor()
    await schedule.waitFor({ state: "detached" })
    const selection = () => page.evaluate(async () => {
      const view = (await import("/src/stores/mission-view-state.ts")).missionProjectView("fixture")
      return { selected: view.selected, scheduled: view.selectedScheduled }
    })
    assert.deepEqual(await selection(), { selected: f.mission.id, scheduled: undefined })
    await page.evaluate(async () => {
      ;(window as any).missionFixture.mount(false)
      ;(await import("/src/stores/missions.ts")).missionStore.clear("fixture")
    })
    doc = await f.read()
    await f.control.configurePreparation({ ...f.request, requestID: "external_calendar", expectedRevision: doc.revision, configuration }, f.native, () => true)
    await page.evaluate(() => (window as any).missionFixture.mount(true))
    await schedule.waitFor()
    assert.deepEqual(await selection(), { selected: undefined, scheduled: f.mission.id })
    await page.evaluate(() => (window as any).missionFixture.mount(false))
    await page.evaluate(() => (window as any).missionFixture.mount(true))
    await schedule.waitFor()
    assert.deepEqual(await selection(), { selected: undefined, scheduled: f.mission.id })
    assert.ok(reads.some(read => read.pathname.endsWith(`/${f.mission.id}/schedule`)), "the selected off-page document is point-read")
    assert.equal(reads.some(read => read.searchParams.has("after")), false, "selection never loads other document pages")
    assert.deepEqual(writes, []); assert.equal(f.admissions.length, 0); assert.deepEqual(errors, [])
  } finally { await page.close() }
})
