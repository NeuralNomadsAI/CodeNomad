import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget, waitForMissionPanelRefresh } from "./mission-panel-route"

let browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-visibility",
      routes: [
        { path: "/mission-visibility", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-visibility.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close(); } finally { await cache?.dispose() } })
const call = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) =>
  (window as any).missionVisibility[method](arg), { method, arg })

test("actual mounted RightPanel suspends hidden Mission demand and refreshes native status only when visible", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let requests = 0
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions", route => {
      if (new URL(route.request().url()).searchParams.get("panelSource") === "summaries") requests += 1
      return route.fulfill({ json: { available: true, version: 1, projectID: "fixture", missions: [],
        generatedAt: requests, discardedEvents: 0, activity: { generatedAt: requests, missions: [] } } })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await page.locator(".mission-control").waitFor({ state: "attached" })
    await call(page, "restoration", false)
    assert.equal(await page.locator(".mission-control").count(), 1, "Missions is mounted, not unmounted to simulate hiding")
    assert.deepEqual(await call(page, "demanded"), [])
    await call(page, "event", "session.execution.started")
    await page.waitForTimeout(120)
    assert.equal(requests, 0)

    const shown = waitForMissionPanelRefresh(page)
    await call(page, "activate", true)
    await shown
    await page.waitForFunction(() => (window as any).missionVisibility.state().status !== "loading")
    assert.equal((await call(page, "state")).status, "ready", JSON.stringify(await call(page, "state")))
    assert.match(await page.locator(".mission-control").innerText(), /No missions yet/)
    assert.equal(requests, 1, "loading/ready state does not retrigger visibility demand")
    assert.deepEqual(await call(page, "demanded"), ["mission-visibility"])
    const status = waitForMissionPanelRefresh(page)
    await call(page, "event", "session.execution.started")
    await status
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.equal(requests, 2)
    await call(page, "event", "session.text.delta")
    await page.waitForTimeout(120)
    assert.equal(requests, 2)

    // Cancel an already-scheduled invalidation on hide, then another hidden event.
    await call(page, "event", "session.execution.started")
    await call(page, "activate", false)
    await call(page, "event", "session.execution.started")
    await page.waitForTimeout(120)
    assert.equal(requests, 2)
    assert.equal(await page.locator(".mission-control").count(), 1)
    assert.deepEqual(await call(page, "demanded"), [])
    const restored = waitForMissionPanelRefresh(page)
    await call(page, "activate", true)
    await restored
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.equal(requests, 3)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

const missionsRoute = (page: Page, onRequest: () => number, delay = 0) => page.route("**/api/workspaces/mission-visibility/missions", async route => {
  const count = new URL(route.request().url()).searchParams.get("panelSource") === "summaries" ? onRequest() : 0
  if (delay) await new Promise(resolve => setTimeout(resolve, delay))
  return route.fulfill({ json: { available: true, version: 1, projectID: "fixture", missions: [],
    generatedAt: count, discardedEvents: 0, activity: { generatedAt: count, missions: [] } } })
})

test("a visible Missions tab waits for session-list restoration, then revalidates once", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let requests = 0
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await missionsRoute(page, () => ++requests)
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await call(page, "activate", true)
    await call(page, "event", "session.execution.started")
    await page.waitForTimeout(150)
    assert.equal(requests, 0, "no Missions read before the session list starts restoring")
    assert.deepEqual(await call(page, "demanded"), [])

    await call(page, "restoration", true)
    await call(page, "event", "rpc.codenomad.missions.changed")
    await page.waitForTimeout(150)
    assert.equal(requests, 0, "restoration keeps priority while it runs")

    const shown = waitForMissionPanelRefresh(page)
    await call(page, "restoration", false)
    await shown
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.deepEqual(await call(page, "demanded"), ["mission-visibility"])
    // A later list refresh does not withdraw established demand.
    await call(page, "restoration", true)
    await page.waitForTimeout(150)
    assert.equal(requests, 1)
    assert.deepEqual(await call(page, "demanded"), ["mission-visibility"])
  } finally { await page.close() }
})

test("continuous native activity of a large family is revalidated at a bounded rate", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let requests = 0
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    // The server projection is slow while the family is busy.
    await missionsRoute(page, () => ++requests, 150)
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await call(page, "restoration", false)
    const shown = waitForMissionPanelRefresh(page)
    await call(page, "activate", true)
    await shown
    await page.waitForFunction(() => (window as any).missionVisibility.state().status === "ready")

    // A busy family: status events keep arriving, spaced beyond the debounce.
    const first = waitForMissionPanelRefresh(page)
    for (let index = 0; index < 16; index++) {
      await call(page, "event", "session.execution.started")
      await page.waitForTimeout(100)
    }
    await first
    await page.waitForTimeout(400)
    assert.equal(requests, 2, "the storm coalesces into one read, never one per event or a back-to-back loop")

    // Journal changes stay prompt even while activity is throttled.
    const changed = waitForMissionPanelRefresh(page)
    await call(page, "event", "rpc.codenomad.missions.changed")
    await changed
    assert.equal(requests, 3)
  } finally { await page.close() }
})
