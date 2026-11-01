import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page, type Request } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import { clickMissionAction, missionPickerField, toggleMissionOverview } from "./mission-actions"
import type {} from "./fixtures/mission-cross-navigation"
import { panelMissions } from "./mission-content-fixture"
import { collectPanelReadFailures, PANEL_READ_HEADER } from "./panel-read-fixture"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-cross-navigation",
      routes: [
        { path: "/mission-cross-navigation", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-cross-navigation.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); })
function mission(id: string): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "Private objective reader",
    coordinatorSessionId: `ses_${id}`, status: "active", actors: [], tasks: [], reports: [], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function setup(missing = false, holdEvents = false) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1600, height: 950 } })
  const errors: string[] = [], networkErrors: string[] = [], requests: string[] = [], hold = gate(), reached = gate(), complete = gate()
  const panelReads = collectPanelReadFailures(page, url)
  const events = gate()
  if (!holdEvents) events.release()
  let defer = false
  page.on("pageerror", error => errors.push(error.message))
  page.on("requestfailed", request => {
    if (!panelReads.record(request, networkErrors)) networkErrors.push(`${request.url()} ${request.failure()?.errorText}`)
  })
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname; requests.push(`${route.request().method()} ${pathname}`)
    const location = { directory: "/fixture" }
    if (pathname === "/api/events") { await events.promise; return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }) }
    if (pathname === "/api/panel-extensions") return route.fulfill({ json: [] })
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions([mission("A"), mission("B")]), generatedAt: 1, discardedEvents: 0 } })
    if (pathname.endsWith("/instance/api/session/ses_A")) {
      if (defer) { reached.release(); await hold.promise }
      await route.fulfill(missing ? { status: 404, json: { name: "NotFoundError", data: { message: "Missing session" } } }
        : { json: { data: { id: "ses_A", projectID: "project", title: "ses_A", slug: "ses_A", version: "1", location, time: { created: 1, updated: 1 } } } })
      if (defer) complete.release(); return
    }
    if (pathname.endsWith("/worktrees")) return route.fulfill({ json: { isGitRepo: true, worktrees: [{ slug: "root", directory: "/fixture", kind: "root" }] } })
    if (pathname === "/api/previews") return route.fulfill({ json: { token: "private-preview", sessionId: "ses_initial", targetUrl: "https://example.invalid/", proxyUrl: "/private-preview-frame", createdAt: "2026-10-03" } })
    if (pathname.endsWith("/command")) return route.fulfill({ json: { location, data: [] } })
    if (pathname.endsWith("/agent")) return route.fulfill({ json: { location, data: [{ id: "build", name: "build", mode: "primary" }, { id: "plan", name: "plan", mode: "primary" }] } })
    if (pathname.endsWith("/provider") || pathname.endsWith("/model")) return route.fulfill({ json: { location, data: [] } })
    if (pathname.endsWith("/model/default")) return route.fulfill({ json: { location, data: null } })
    if (pathname.includes("/message")) return route.fulfill({ json: { data: [], cursor: {} } })
    if (pathname.includes("/form")) return route.fulfill({ json: { data: [] } })
    if (pathname.includes("/session")) return route.fulfill({ json: { data: [], cursor: {} } })
    return route.fulfill({ json: {} })
  })
  await page.route("**/private-preview-frame", route => route.fulfill({ contentType: "text/html", body: "<p>Private browser preview</p>" }))
  try {
    const eventStreamResponse = page.waitForResponse(response => response.request().resourceType() === "eventsource" && new URL(response.url()).pathname === "/api/events", { timeout: 120_000 })
    void eventStreamResponse.catch(() => {}) // Page cleanup may cancel a deliberately held setup stream.
    await page.goto(url)
    if (!holdEvents) await eventStreamResponse
    // Loaded Missions enable the current-mission field (nothing is selected by default).
    await missionPickerField(page).and(page.locator(":enabled")).waitFor()
    await page.evaluate(() => window.missionCrossNavigation.coldCatalogue())
    return { page, eventStreamResponse, events, panelReads, errors, networkErrors, requests, hold, reached, complete, defer: () => { defer = true } }
  } catch (error) {
    if (process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE) await writeFile(path.join(process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE, `setup-failure-${Date.now()}.json`), JSON.stringify({ error: String(error), errors, networkErrors, requests,
      rawRequestFailures: panelReads.rawRequestFailures, panelListCancellations: panelReads.panelListCancellations }, null, 2))
    events.release(); hold.release(); await page.close(); throw error
  }
}
test("shell fixture serves an event stream and still detects request cancellations and transport failures", async () => {
  const { page, eventStreamResponse, panelReads, errors, networkErrors, hold } = await setup()
  try {
    assert.equal((await eventStreamResponse).status(), 200)
    assert.equal((await eventStreamResponse).headers()["content-type"], "text/event-stream")
    await panelReads.drain()
    assert.deepEqual(networkErrors, [])
    const probe = new URL("/api/navigation-network-probe", url).href
    await page.route(probe, route => route.abort("aborted"))
    const failed = page.waitForEvent("requestfailed", request => request.url() === probe)
    await page.evaluate(probe => fetch(probe).catch(() => undefined), probe)
    await failed
    await panelReads.drain()
    assert.deepEqual(networkErrors, [`${probe} net::ERR_ABORTED`], "an unrelated aborted read remains a failure")
    const streamProbe = new URL("/api/events?probe=network-failure", url).href
    await page.route(streamProbe, route => route.abort("failed"))
    const streamFailed = page.waitForEvent("requestfailed", request => request.url() === streamProbe)
    await page.evaluate(streamProbe => new Promise<void>(resolve => {
      const source = new EventSource(streamProbe)
      source.onerror = () => { source.close(); resolve() }
    }), streamProbe)
    await streamFailed
    await panelReads.drain()
    assert.deepEqual(networkErrors, [`${probe} net::ERR_ABORTED`, `${streamProbe} net::ERR_FAILED`], "a real event-stream failure remains a failure")
    assert.deepEqual(errors, [])
  } finally { hold.release(); await page.close() }
})
test("catalog cancellation receipts reject genuine same-URL aborts and missing, unknown or reused identities", async () => {
  const { page, panelReads, errors, networkErrors, hold } = await setup()
  const catalog = new URL("/api/panel-extensions", url).href, held = gate()
  let arrived!: (request: Request) => void, first = true
  const arrival = new Promise<Request>(resolve => { arrived = resolve })
  try {
    await page.route(catalog, async route => {
      if (first) { first = false; arrived(route.request()); await held.promise }
      await route.fulfill({ json: [] })
    })
    await page.evaluate(() => window.missionCrossNavigation.transport("connected"))
    const pending = await arrival, readId = pending.headers()[PANEL_READ_HEADER]
    assert.ok(readId)
    const cancelled = page.waitForEvent("requestfailed", request => request === pending)
    await page.evaluate(() => window.missionCrossNavigation.transport("connected"))
    await cancelled; held.release(); await panelReads.drain()
    assert.equal(await page.evaluate(id => window.fixturePanelReadCancelled(id), readId), true)
    assert.ok(panelReads.panelListCancellations.some(read => read.readId === readId))
    assert.deepEqual(networkErrors, [])

    await page.route(catalog, route => route.abort("aborted"))
    const broken = page.waitForEvent("requestfailed", request => request.url() === catalog)
    await page.evaluate(() => window.missionCrossNavigation.transport("connected"))
    const request = await broken
    await panelReads.drain()
    assert.equal(await page.evaluate(id => window.fixturePanelReadCancelled(id), request.headers()[PANEL_READ_HEADER]), false)
    const expected = [`${catalog} net::ERR_ABORTED`]
    assert.deepEqual(networkErrors, expected, "a real controller read aborted by the network stays a failure")
    for (const identity of [undefined, "unknown", readId]) {
      const failed = page.waitForEvent("requestfailed", request => request.url() === catalog)
      await page.evaluate(({ catalog, header, identity }) => fetch(catalog, {
        headers: identity ? { [header]: identity } : {},
      }).catch(() => undefined), { catalog, header: PANEL_READ_HEADER, identity })
      await failed; await panelReads.drain()
      expected.push(`${catalog} net::ERR_ABORTED`)
      assert.deepEqual(networkErrors, expected, `a missing, unknown or reused identity (${identity}) cannot borrow another request's cancellation`)
    }
    assert.ok(panelReads.rawRequestFailures.length >= networkErrors.length + 1, "raw diagnostics retain both expected and genuine failures")
    assert.deepEqual(errors, [])
  } finally { held.release(); hold.release(); await page.close() }
})
async function navigate(page: Page, origin: "actor" | "reader", id = "A") {
  if (origin === "actor") return clickMissionAction(page, "Open conversation", `Objective ${id}`)
  // The overview reader belongs to the selected Mission's toolbar ("Summary" eye).
  await toggleMissionOverview(page, `Objective ${id}`)
}
async function ordinarySession(page: Page, name: string) { await page.locator(".session-sidebar").getByText(`Conversation ${name}`, { exact: true }).click() }
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))) }
for (const origin of ["actor", "reader"] as const) for (const change of ["session", "session-aba", "preview", "preview-aba"] as const) {
  test(`shell deferred ${origin} respects external ${change}`, async () => {
    const forceSupersession = origin === "reader" && change !== "session"
    const { page, eventStreamResponse, events, panelReads, errors, networkErrors, requests, hold, reached, complete, defer } = await setup(false, forceSupersession)
    const catalogHold = gate()
    try {
      defer()
      if (origin === "reader") await page.evaluate(() => window.missionCrossNavigation.clearActive())
      await navigate(page, origin)
      await reached.promise
      if (change.startsWith("session")) {
        await ordinarySession(page, "B")
        if (change.endsWith("aba")) await ordinarySession(page, "initial")
      } else {
        if (origin === "reader") await ordinarySession(page, "initial")
        await page.getByRole("button", { name: "Open web preview", exact: true }).click()
        if (change.endsWith("aba")) await page.getByRole("button", { name: "Back to chat", exact: true }).click()
      }
      const before = await page.evaluate(() => ({ state: window.missionCrossNavigation.snapshot(), writes: window.missionCrossNavigation.history().length }))
      if (forceSupersession) {
        const catalog = new URL("/api/panel-extensions", url).href
        let arrived!: (request: Request) => void, first = true
        const arrival = new Promise<Request>(resolve => { arrived = resolve })
        await page.route(catalog, async route => {
          if (first) { first = false; arrived(route.request()); await catalogHold.promise }
          await route.fulfill({ json: [] })
        })
        // Start a real controller-owned read, then let the held native SSE open
        // supersede it. Only the first trigger uses the fixture's status hook.
        await page.evaluate(() => window.missionCrossNavigation.transport("connected"))
        const pending = await arrival
        const readId = pending.headers()[PANEL_READ_HEADER]
        assert.ok(readId, "the controller-owned pending read has a unique identity")
        const cancelled = page.waitForEvent("requestfailed", request => request === pending)
        events.release(); await eventStreamResponse; await cancelled
        catalogHold.release()
        await panelReads.drain()
        assert.ok(panelReads.panelListCancellations.some(read => read.readId === readId))
        assert.ok(panelReads.rawRequestFailures.includes(`${catalog} net::ERR_ABORTED`))
        assert.equal(await page.evaluate(id => window.fixturePanelReadCancelled(id), readId), true)
      }
      await page.evaluate(() => window.missionCrossNavigation.created())
      hold.release(); await complete.promise; await settle(page)
      const after = await page.evaluate(() => ({ state: window.missionCrossNavigation.snapshot(), writes: window.missionCrossNavigation.history().length }))
      await panelReads.drain()
      if (process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE) {
        await writeFile(path.join(process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE, `${origin}-${change}.json`), JSON.stringify({ before, after, errors, networkErrors, requests,
          rawRequestFailures: panelReads.rawRequestFailures, panelListCancellations: panelReads.panelListCancellations }, null, 2))
        await page.screenshot({ path: path.join(process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE, `${origin}-${change}.png`) })
      }
      assert.deepEqual(after, before, "ordinary session/preview navigation wins without late shared-state writes")
      assert.equal(await page.getByRole("tab", { name: "Missions", exact: true }).getAttribute("aria-selected"), "true")
      assert.deepEqual(errors, []); assert.deepEqual(networkErrors, [])
      assert.equal(await page.locator(".mission-control > [role=alert]").count(), 0)
    } finally { events.release(); catalogHold.release(); hold.release(); await page.close() }
  })
}
for (const origin of ["actor", "reader"] as const) test(`shell current ${origin} survives its own synchronous navigation writes`, async () => {
  const { page, panelReads, errors, networkErrors, hold, reached, complete, defer } = await setup()
  try {
    defer()
    if (origin === "reader") await page.evaluate(() => window.missionCrossNavigation.clearActive())
    await navigate(page, origin)
    await reached.promise
    hold.release(); await complete.promise
    await page.waitForFunction(origin => {
      const current = window.missionCrossNavigation.snapshot()
      return current.session === "ses_A" && current.mode === "chat" && (origin === "actor" || current.reader?.missionId === "A")
    }, origin)
    await panelReads.drain()
    assert.deepEqual(errors, [])
    // The reader hides the just-opened transcript, which deactivates it and
    // disposes only its read-only unanchored receipt page; nothing else may fail.
    assert.deepEqual(networkErrors.filter(error => !(origin === "reader"
      && /\/api\/workspaces\/cross-navigation\/sessions\/ses_A\/permission-receipts\?unanchored=true net::ERR_ABORTED$/.test(error))), [])
  } finally { hold.release(); await page.close() }
})

for (const change of ["session", "preview"] as const) test(`shell stale missing actor cannot publish an error over external ${change}`, async () => {
  const { page, panelReads, errors, networkErrors, hold, reached, complete, defer } = await setup(true)
  try {
    defer(); await navigate(page, "actor"); await reached.promise
    if (change === "session") await ordinarySession(page, "B")
    else await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    const before = await page.evaluate(() => ({ state: window.missionCrossNavigation.snapshot(), writes: window.missionCrossNavigation.history().length }))
    hold.release(); await complete.promise; await settle(page)
    const after = await page.evaluate(() => ({ state: window.missionCrossNavigation.snapshot(), writes: window.missionCrossNavigation.history().length }))
    await panelReads.drain()
    if (process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE) await writeFile(path.join(process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE, `missing-${change}.json`), JSON.stringify({ before, after, errors, networkErrors,
      rawRequestFailures: panelReads.rawRequestFailures, panelListCancellations: panelReads.panelListCancellations }, null, 2))
    assert.deepEqual(after, before); assert.equal(await page.locator(".mission-control > [role=alert]").count(), 0)
    assert.deepEqual(errors, []); assert.deepEqual(networkErrors, [])
  } finally { hold.release(); await page.close() }
})
