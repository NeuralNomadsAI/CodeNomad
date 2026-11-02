import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import Fastify from "fastify"
import { createServer, type Server } from "node:http"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { selectMission } from "./mission-actions"
import { currentPassageFixture } from "../../../server/src/opencode/missions/native-current-passage-test-fixture"
import { registerMissionRecurrenceCurrent } from "../../../server/src/server/routes/mission-recurrence-current"
import { WorktreeDeletionFence } from "../../../server/src/workspaces/worktree-session-evacuation"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"

let browser: Browser, url: string, events: Server, eventsURL: string
before(async () => {
  url = (await borrowFixture({ name: "mission-current-pages", routes: [{ path: "/current", html: '<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-current-passage.tsx"></script></body></html>' }] })).url
  events = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": new URL(url).origin, "Access-Control-Allow-Credentials": "true" })
    response.write(": owned persistent fixture events\n\n")
  })
  await new Promise<void>(resolve => events.listen(0, "127.0.0.1", resolve))
  eventsURL = `http://127.0.0.1:${(events.address() as { port: number }).port}/api/events`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined }); armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); if (events) { events.closeAllConnections(); await new Promise<void>(resolve => events.close(() => resolve())) } })

for (const owner of ["daily", "scheduled"] as const) test(`${owner} real current reader pages tasks, exact bodies and off-page native requests without a full-map escape`, async t => {
  const f = await currentPassageFixture(owner), app = Fastify({ logger: false }), page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
  const errors: string[] = [], writes: string[] = [], selections: any[] = [], sizes: number[] = []
  const activityRows: unknown[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    let map = (await f.control.snapshot()).missions[0]
    for (let revision = 0; revision < 15; revision++) map = (await f.control.revise(map.coordinatorSessionId, { missionID: map.id,
      requestID: `tasks-${revision}`, expectedRevision: map.revision, reason: "More tasks", retireTasks: [], dependencyUpdates: [],
      addTasks: Array.from({ length: 12 }, (_, index) => ({ taskKey: `work-${revision}-${index}`, title: `Work ${revision}-${index}`, brief: "Exact brief 😀 ".repeat(800),
        role: "specialist", blockedBy: [], executionMode: { kind: "native" as const, parentTaskKey: null } })) })).mission
    for (const [index, task] of map.tasks.entries()) {
      const id = `ses_current_${index}`
      f.sessions.set(id, { id, projectID: "project", location: { directory: f.root }, parentID: map.coordinatorSessionId })
      await f.passage.journal.append({ version: 1, projectID: "project", missionID: map.id, id: `evt_binding_${index}`, type: "task.native-bound", taskKey: task.key,
        binding: { generation: 1, parentSessionID: map.coordinatorSessionId, parentMessageID: `msg_${index}`, toolCallID: `call_${index}` },
        actor: { sessionID: id, title: `Actor ${index}`, managed: true, location: { directory: f.root } }, createdAt: Date.now() + index })
    }
    map = (await f.control.snapshot()).missions[0]
    const native = { location: { get: async () => f.location }, plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      rpc: () => ({ recurrenceCurrent: () => f.read(), recurrenceCurrentPage: (input: unknown) => f.page(input), recurrenceCurrentContent: (input: unknown) => f.content(input) }),
      session: { get: async ({ sessionID }: { sessionID: string }) => f.sessions.get(sessionID), list: async () => ({ data: [], cursor: { next: null } }), active: async () => ({}), inbox: { list: async () => [] } },
      shell: { list: async () => ({ location: { directory: f.root }, data: [] }) }, form: { list: async () => ({ location: { directory: f.root }, data: [{ id: "form_off_page", sessionID: "ses_current_179", title: "Off-page current question", fields: [] }] }) },
      permission: { request: { list: async () => ({ location: { directory: f.root }, data: [] }) } } }
    const workspace = { id: "fixture" }, owned = { directory: f.root }
    registerMissionRecurrenceCurrent(app, { worktreeDeletionFence: new WorktreeDeletionFence(), workspaceManager: { get: () => workspace,
      getServiceLocation: () => owned, getSharedServiceConnection: async () => ({ client: native, assertCurrent() {} }), ownsLocation: async () => true,
      getWorktreeIdentityForPath: async () => f.root } as never })
    await page.addInitScript("Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})")
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path === "/api/events") return route.continue({ url: eventsURL })
      if (path === "/api/storage/config/ui") return route.fulfill({ json: { settings: { locale: "en" } } })
      if (path.includes("/current")) {
        if (request.method() === "POST") selections.push(request.postDataJSON())
        const response = await app.inject({ method: request.method() as "GET" | "POST", url: new URL(request.url()).pathname + new URL(request.url()).search,
          ...(request.method() === "POST" ? { payload: request.postDataJSON() } : {}) })
        sizes.push(response.rawPayload.length)
        if (request.method() === "POST" && request.postDataJSON().selector.source === "activity") {
          const result = response.json()
          try { const value = JSON.parse(result.page.pieces.map((piece: { text: string }) => piece.text).join("")); activityRows.push({ offset: request.postDataJSON().selector.actorOffset ?? 0, coverage: value.coverage, requests: value.requests, family: value.activity?.family?.state }) }
          catch { activityRows.push({ status: response.statusCode, body: response.body.slice(0, 500) }) }
        }
        return route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
      }
      if (request.method() !== "GET") writes.push(path)
      if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project", projectCanonical: f.root, location: owned, schedules: owner === "daily" ? [{
        id: f.scheduleID, title: "Daily current", revision: 1, state: "interrupted", interruptionReason: "service-restart", clock: { time: "23:59", zone: "UTC" }, nextDueAt: null, actions: [], controls: [],
        pending: { passageID: f.passage.passageID, missionID: map.id, conversationID: map.coordinatorSessionId, status: "running" }, latestResult: null, history: [] }] : [] } })
      if (path.endsWith("/missions/scheduled")) {
        const doc = owner === "scheduled" ? await f.documents.read(f.scheduleID) : undefined
        return route.fulfill({ json: { version: 1, projectID: "project", schedules: doc && "configuration" in doc ? [missionScheduleView(doc).document] : [] } })
      }
      if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, version: 1, projectID: "project", missions: [], summaries: [], generatedAt: 1, discardedEvents: 0 } })
      if (path.includes("/instance/")) return route.fulfill({ json: [] })
      return route.fulfill({ json: {} })
    })
    await page.goto(url + "?directory=" + encodeURIComponent(f.root))
    await selectMission(page, owner === "daily" ? "Daily current" : "Scheduled current").catch(async error => {
      throw new Error(`${error}\n${JSON.stringify({ errors, selections, sizes })}\n${(await page.locator("body").innerText()).slice(0, 4000)}`)
    })
    await page.locator(".mission-tree").waitFor()
    assert.equal(selections.some(input => input.body), false, "initial tracking never requests prose or full passage bodies")
    const gap = page.locator(".mission-tree-gap button").first()
    if (await gap.count()) { await gap.click(); await page.waitForFunction(() => document.querySelectorAll(".mission-tree-node").length > 50) }
    await page.evaluate(async ({ root, missionID, scheduleID, passageID, owner, taskID }) => {
      (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView(root, { reader: { missionId: missionID, kind: "task", itemId: taskID,
        recurrence: { instanceId: "fixture", projectID: "project", scheduleID, passageID, owner } } })
    }, { root: f.root, missionID: map.id, scheduleID: f.scheduleID, passageID: f.passage.passageID, owner, taskID: map.tasks.at(-1)!.id })
    await page.locator(".mission-task-reader").waitFor()
    await page.locator(".mission-reader details > summary").filter({ hasText: /^Task brief$/ }).click()
    await page.locator(".mission-reader").getByText(/Exact brief/).first().waitFor()
    assert.ok(selections.some(input => input.body?.kind === "task" && input.body.taskKey === map.tasks.at(-1)!.key && input.body.field === "brief"))
    const activityMore = page.locator(".mission-control .mission-panel-paging").filter({ hasText: /160/ }).getByRole("button", { name: "Load more", exact: true })
    await activityMore.click()
    await page.locator(".mission-control").getByText("Off-page current question", { exact: true }).waitFor().catch(async error => {
      throw new Error(`${error}\n${JSON.stringify({ activityRows, errors, selectors: selections.map(input => input.selector) })}\n${(await page.locator(".mission-control").innerText()).slice(0, 1000)}`)
    })
    assert.ok(selections.some(input => input.selector.source === "activity" && input.selector.actorOffset === 160))
    await page.waitForFunction(() => document.querySelector(".mission-picker-field .mission-picker-mark")?.getAttribute("data-mark") === "permission")
    const taskReads = selections.filter(input => input.selector.source === "tasks").length, bodyReads = selections.filter(input => input.body).length
    await f.control.update({ missionID: map.id, requestID: "notes-only", expectedRevision: map.revision, objective: map.objective, notes: "Unrelated root notes" })
    const refreshed = page.waitForResponse(response => response.request().method() === "POST" && response.request().postDataJSON()?.selector?.header === true)
    await page.evaluate(() => (window as any).passageFixture.invalidate("rpc.codenomad.missions.changed"))
    await refreshed
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(selections.filter(input => input.selector.source === "tasks").length, taskReads, "an unrelated journal revision does not storm expanded task pages")
    assert.equal(selections.filter(input => input.body).length, bodyReads, "an unchanged exact body retains its original digest")
    assert.ok(sizes.every(size => size <= 65536)); assert.deepEqual(writes, []); assert.deepEqual(errors, [])
    t.diagnostic(JSON.stringify({ owner, tasks: map.tasks.length, initialBodies: 0, transfers: selections.length, largestBody: Math.max(...sizes), ...f.metrics() }))
  } finally { await page.context().close(); await app.close(); await f.dispose() }
})
