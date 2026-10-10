import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-navigation"

// Real MissionControl/RightPanel fixtures for feedback that must survive hidden
// views: certified lifecycle rejection, superseded exact briefing responses and
// late recovery acknowledgements.
let server: ViteDevServer, browser: Browser, base: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  const page = (name: string, fixture: string) => ({ name, fixture })
  const pages = [page("/visibility", "mission-visibility"), page("/navigation", "mission-navigation")]
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-control-feedback", configureServer(s) {
      for (const { name, fixture } of pages) s.middlewares.use(name, async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml(name, `<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/${fixture}.tsx"></script></body></html>`))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

type Input = { action: "start" | "pause" | "stop"; expectedRevision: number; requestId: string }
const coordinator = (sessionId: string): MissionMap["actors"][number] => ({ sessionId, kind: "coordinator", managed: false, title: "Coordinator",
  roles: ["coordinator"], location: { directory: "/fixture" }, joinedAt: 1 })
function mission(id: string, projectID = "fixture"): MissionMap {
  return { version: 1, id, projectID, projectCanonical: "/fixture", objective: `Feedback ${id}`, template: "custom", coordinatorSessionId: `ses_${id}`,
    status: "active", runState: "running", actors: [coordinator(`ses_${id}`)], tasks: [], reports: [], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
// The view scope is the instance folder, or its ID for the store-less visibility fixture.
const select = (page: Page, id: string, scope = "/fixture") => page.evaluate(async ({ id, scope }) => {
  const view = "/src/stores/mission-view-state.ts"
  ;(await import(view)).updateMissionProjectView(scope, { selected: id })
}, { id, scope })
const detail = (page: Page) => page.locator("section.mission-detail")
const toolbar = (page: Page) => detail(page).getByRole("toolbar")
const alerts = (page: Page) => detail(page).locator(".mission-action-feedback [role=alert]")
const toasts = (page: Page) => page.evaluate(async () => {
  const path = "/src/lib/notifications.tsx"
  return (await import(path)).getToastHistory().map((item: { title?: string; message: string; variant: string }) => ({ title: item.title, message: item.message, variant: item.variant }))
})
const visibility = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) => (window as any).missionVisibility[method](arg), { method, arg })

/** RightPanel with real visibility-owned demand; `reads` counts display list reads only. */
async function visible(missions: () => MissionMap[], activity?: () => unknown) {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = [], counter = { reads: 0 }
  page.setDefaultTimeout(15_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/workspaces/mission-visibility/missions**", async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: { version: 1, projectID: "fixture", projectCanonical: "/fixture",
      location: { directory: "/fixture" }, schedules: [] } })
    if (route.request().method() !== "GET") return route.fallback()
    counter.reads++
    return route.fulfill({ json: { available: true, projectID: "fixture", missions: missions(), generatedAt: counter.reads, discardedEvents: 0,
      ...(activity ? { activity: activity() } : {}) } })
  })
  await page.goto(`${base}/visibility`, { timeout: 60_000 })
  await page.waitForFunction(() => Boolean((window as any).missionVisibility))
  await visibility(page, "restoration", false)
  await visibility(page, "activate", true)
  await page.waitForFunction(() => (window as any).missionVisibility.state().status === "ready")
  return { page, errors, counter }
}

test("a certified Pause rejection while hidden is announced once and explained inline, without retry, replay or hidden reads", async () => {
  let current = mission("one"), release!: () => void, submitted!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), sent = new Promise<void>(resolve => { submitted = resolve })
  const calls: Input[] = []
  const { page, errors, counter } = await visible(() => [current])
  try {
    await page.route("**/missions/one/control", async route => {
      calls.push(route.request().postDataJSON() as Input)
      if (calls.length === 1) { submitted(); await held; current = { ...current, revision: 2 }; return route.fulfill({ status: 409, json: { code: "revision-conflict" } }) }
      current = { ...current, revision: 3, runState: "paused" }
      return route.fulfill({ json: { mission: current } })
    })
    await select(page, "one", "mission-visibility")
    await toolbar(page).getByRole("button", { name: "Pause mission", exact: true }).click(); await sent
    await visibility(page, "activate", false)
    const before = counter.reads, response = page.waitForResponse(value => value.url().endsWith("/control"))
    release(); await response; await frames(page)
    assert.equal(counter.reads, before, "a hidden rejection starts no display read")
    assert.deepEqual(await toasts(page), [{ title: "Feedback one", variant: "error",
      message: "Pause was not applied: the mission changed first. Nothing was resent; review it and try again." }])
    await visibility(page, "activate", true)
    await alerts(page).getByText("Pause was not applied", { exact: false }).waitFor()
    await page.waitForFunction(() => (window as any).missionVisibility.state().missions[0]?.revision === 2)
    assert.equal(await toolbar(page).getByRole("button", { name: "Check control status", exact: true }).count(), 0, "rejection is not an unresolved retry")
    assert.equal(calls.length, 1)
    await toolbar(page).getByRole("button", { name: "Pause mission", exact: true }).click()
    await toolbar(page).getByRole("button", { name: "Resume mission", exact: true }).waitFor()
    assert.equal(await alerts(page).count(), 0, "a new explicit action supersedes the explanation")
    assert.deepEqual(calls.map(call => call.expectedRevision), [1, 2]); assert.notEqual(calls[0].requestId, calls[1].requestId)
    assert.equal((await toasts(page)).length, 1, "announced once per exact request")
    assert.deepEqual(errors, [])
  } finally { release(); await page.close() }
})

test("revision drift during Stop confirmation sends nothing and asks to review and reconfirm", async () => {
  let current = mission("one")
  const calls: Input[] = []
  const { page, errors } = await visible(() => [current])
  try {
    await page.route("**/missions/one/control", route => { calls.push(route.request().postDataJSON() as Input); return route.fulfill({ json: { mission: current } }) })
    await select(page, "one", "mission-visibility")
    await toolbar(page).getByRole("button", { name: "Stop mission permanently", exact: true }).click()
    const dialog = page.getByRole("dialog"); await dialog.waitFor()
    current = { ...current, revision: 2 }
    const refreshed = page.waitForResponse(value => new URL(value.url()).pathname.endsWith("/missions"))
    await visibility(page, "event", "session.status"); await refreshed
    await page.waitForFunction(() => (window as any).missionVisibility.state().missions[0]?.revision === 2)
    await dialog.getByRole("button", { name: "Stop mission permanently", exact: true }).click()
    await alerts(page).getByText("Stop was not sent; review it and confirm again.", { exact: false }).waitFor()
    assert.deepEqual(calls, [], "a stale confirmation never reaches the server")
    assert.equal(await toolbar(page).getByRole("button", { name: "Stop mission permanently", exact: true }).isEnabled(), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a recovery acknowledgement after deactivation preserves the cached snapshot and leaves revalidation to activation", async () => {
  const current = mission("one")
  const activity = () => ({ generatedAt: 1, missions: [{ missionId: "one", actors: [{ sessionId: "ses_one", state: "idle-without-report" }] }] })
  let release!: () => void, submitted!: () => void, posts = 0
  const held = new Promise<void>(resolve => { release = resolve }), sent = new Promise<void>(resolve => { submitted = resolve })
  const { page, errors, counter } = await visible(() => [current], activity)
  try {
    await page.route("**/missions/one/recover", async route => {
      posts++; submitted(); await held
      return route.fulfill({ json: { mission: current, admitted: true } })
    })
    await select(page, "one", "mission-visibility")
    await toolbar(page).getByRole("button", { name: "Recover interrupted mission", exact: true }).click(); await sent
    await visibility(page, "activate", false)
    const before = counter.reads, response = page.waitForResponse(value => value.url().endsWith("/recover"))
    release(); await response; await frames(page); await frames(page)
    assert.equal(counter.reads, before, "admission is not consumption and starts no hidden read")
    assert.deepEqual(await visibility(page, "demanded"), [])
    const hidden = await page.evaluate(() => { const state = (window as any).missionVisibility.state(); return { status: state.status, ids: state.missions.map((value: MissionMap) => value.id) } })
    assert.deepEqual(hidden, { status: "ready", ids: ["one"] })
    const revalidated = page.waitForResponse(value => new URL(value.url()).pathname.endsWith("/missions"))
    await visibility(page, "activate", true); await revalidated
    assert.equal(counter.reads, before + 1, "activation revalidates exactly once")
    assert.equal(posts, 1, "never replayed")
    assert.deepEqual(errors, [])
  } finally { release(); await page.close() }
})

/** MissionControl with a native coordinator session and prompt admission. */
async function navigable(values: MissionMap[]) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 900 } }), errors: string[] = []
  const prompts: any[] = [], counter = { reads: 0 }
  page.setDefaultTimeout(15_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (pathname === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
    if (pathname.includes("/instructions/") && request.method() !== "GET") return route.fulfill({ status: 204, body: "" })
    if (pathname.endsWith("/missions/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project", projectCanonical: "/fixture",
      location: { directory: "/fixture" }, schedules: [] } })
    if (pathname.endsWith("/missions")) { counter.reads++; return route.fulfill({ json: { available: true, projectID: "project", missions: values,
      generatedAt: counter.reads, discardedEvents: 0 } }) }
    if (/\/session\/ses_A$/.test(pathname)) return route.fulfill({ json: { data: { id: "ses_A", projectID: "project", title: "Coordinator", slug: "coordinator",
      version: "1", agent: "build", model: { id: "native", providerID: "native" }, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } } })
    if (pathname.endsWith("/agent")) return route.fulfill({ json: [{ id: "build", name: "build", mode: "primary" }] })
    if (pathname.endsWith("/provider")) return route.fulfill({ json: { all: [], connected: [], default: {} } })
    if (pathname.endsWith("/prompt")) { prompts.push(request.postDataJSON()); return route.fulfill({ json: { data: { id: request.postDataJSON().id } } }) }
    return route.fulfill({ json: pathname.includes("/instance/") ? [] : {} })
  })
  await page.goto(`${base}/navigation`, { timeout: 60_000 })
  await page.waitForFunction(() => Boolean(window.missionNavigation))
  await select(page, "A"); await detail(page).waitFor()
  return { page, errors, prompts, counter }
}
function publish(value: MissionMap, requestID: string) {
  const briefing = { id: `briefing-${requestID}`, requestID, basedOnRevision: value.revision, basedOnUpdatedAt: value.updatedAt,
    createdAt: value.updatedAt + 1000, summary: `Briefing ${requestID}`, achieved: [], ongoing: [], obstacles: [], next: [] }
  value.briefing = briefing
  value.briefingResponses = [...value.briefingResponses ?? [], { requestID, briefingID: briefing.id }]
  value.revision++; value.updatedAt = briefing.createdAt
}

for (const exact of [true, false]) {
  test(`${exact ? "an exact" : "a foreign"} briefing response superseded by an automatic milestone while hidden ${exact ? "resolves" : "keeps"} the request after activation`, async () => {
    const values = [mission("A", "project")]
    const { page, errors, prompts, counter } = await navigable(values)
    const request = detail(page).locator(".mission-action-request"), feedback = detail(page).locator(".mission-briefing-feedback")
    try {
      await request.click()
      await feedback.getByText("Request sent.", { exact: false }).waitFor()
      const requestID = /Request ID: ([^\n]+)/.exec(prompts[0].text)![1]
      await page.evaluate(() => window.missionNavigation.activate(false)); await frames(page)
      const before = counter.reads
      publish(values[0], exact ? requestID : "another-request"); publish(values[0], `auto:${values[0].revision}`)
      assert.notEqual(values[0].briefing!.requestID, requestID, "the latest briefing is the milestone")
      await frames(page)
      assert.equal(counter.reads, before, "hidden views do not read")
      const revalidated = page.waitForResponse(value => new URL(value.url()).pathname.endsWith("/missions"))
      await page.evaluate(() => window.missionNavigation.activate(true)); await revalidated
      if (exact) {
        await feedback.waitFor({ state: "detached" })
        assert.equal(await request.isEnabled(), true)
        const stored = await page.evaluate(async () => {
          const path = "/src/stores/mission-briefing-request.ts"
          return (await import(path)).missionBriefingRequest(JSON.stringify(["fixture", "/fixture", "project", "project", "A", "ses_A"]))
        })
        assert.equal(stored?.briefingId, `briefing-${requestID}`, "acknowledged by exact request identity only")
      } else {
        await frames(page)
        await feedback.getByText("Request sent.", { exact: false }).waitFor()
        assert.equal(await request.isDisabled(), true, "an automatic or foreign briefing never answers the request")
      }
      assert.equal(prompts.length, 1, "never resent")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}
