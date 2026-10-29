import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import Fastify from "fastify"
import { chromium, type Browser } from "playwright"
import { fixture } from "../../../server/src/missions/journal-history-fixture"
import { registerMissionRoutes } from "../../../server/src/server/routes/missions"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

// "Request an update" sends an application-authored native prompt: its admission
// reads the authoritative full snapshot, never the panel's hints.
let browser: Browser, url: string
before(async () => {
  const borrowed = await borrowFixture({ name: "mission-request-admission", routes: [{ path: "/admission-fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-navigation.tsx"></script></body></html>' }] })
  url = borrowed.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("project damage the hints have not seen refuses the coordinator request: no prompt is sent", async () => {
  // A real journal and the real routes: a healthy running mission, then an
  // entry written outside the index's generation (another build or process).
  const f = fixture(8), control = f.control()
  const { mission } = await control.create({ requestID: "admission", objective: "Review update gate", template: "custom" })
  const shown = (await control.list()).missions.find(value => value.id === mission.id)!
  f.tamper(`${f.prefix}/stray`, {})
  const client = {
    location: { get: async () => ({ directory: "/repo", project: { id: "project-1" } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ mission: (input: { missionID: string }) => control.mission(input.missionID), snapshot: () => control.snapshot() }),
  }
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: { get: () => ({ id: "fixture" }), getServiceLocation: () => ({ directory: "/repo" }),
    getSharedServiceConnection: async () => ({ client, assertCurrent() {} }) } as never })
  // The navigation fixture's project, coordinator and Location identities.
  const local = <T extends { projectID?: string; mission?: any }>(body: T): T => {
    const map = body.mission
    if (map) Object.assign(map, { projectID: "project", projectCanonical: "/fixture", coordinatorSessionId: "ses_A",
      actors: map.actors.map((actor: any) => ({ ...actor, sessionId: "ses_A", location: { directory: "/fixture" } })) })
    return { ...body, projectID: "project" }
  }
  const display = local({ mission: structuredClone(shown) }).mission
  const page = await browser.newPage({ locale: "en-US" })
  const writes: string[] = [], reads: string[] = []
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (request.method() !== "GET") writes.push(pathname)
    if (pathname === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
    if (pathname.includes("/instructions/") && request.method() !== "GET") return route.fulfill({ status: 204, body: "" })
    // The panel still holds the healthy map it listed before the damage landed.
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [display], generatedAt: 2, discardedEvents: 0 } })
    if (pathname.includes(`/missions/${mission.id}`)) {
      reads.push(pathname)
      const response = await app.inject({ method: "GET", url: pathname.replace(/^.*\/api\/workspaces\/[^/]+/, "/api/workspaces/fixture") })
      return route.fulfill({ json: local(response.json()) })
    }
    if (pathname.endsWith("/session/ses_A")) return route.fulfill({ json: { data: { id: "ses_A", projectID: "project", title: "Coordinator", slug: "coordinator",
      version: "1", agent: "build", model: { id: "native", providerID: "native" }, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } } })
    if (pathname.endsWith("/agent")) return route.fulfill({ json: [{ id: "build", name: "build", mode: "primary" }] })
    if (pathname.endsWith("/provider")) return route.fulfill({ json: { all: [], connected: [], default: {} } })
    if (pathname.endsWith("/prompt")) return route.fulfill({ json: { data: { id: request.postDataJSON().id } } })
    return route.fulfill({ json: pathname.includes("/instance/") ? [] : {} })
  })
  try {
    // The real display read misses the damage; only the authoritative read sees it.
    assert.equal((await app.inject({ method: "GET", url: `/api/workspaces/fixture/missions/${mission.id}` })).json().mission.controlUnavailable, undefined)
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionNavigation))
    await page.evaluate(async id => (await import("/src/stores/mission-view-state.ts" as string)).updateMissionProjectView("/fixture", { selected: id }), mission.id)
    await page.locator("section.mission-detail .mission-action-request").click()
    await page.locator(".mission-briefing-feedback").getByText("No prompt was sent", { exact: false }).waitFor()
    assert.deepEqual(reads, [`/api/workspaces/fixture/missions/${mission.id}/admission`], "admission reads the full snapshot only")
    assert.deepEqual(writes.filter(path => path.endsWith("/prompt")), [], "no prompt reached the coordinator")
  } finally { await page.close(); await app.close() }
})
