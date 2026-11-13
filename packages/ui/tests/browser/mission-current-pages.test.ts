import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import Fastify from "fastify"
import { createServer, type Server } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import path from "node:path"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { selectMission } from "./mission-actions"
import { currentPassageFixture } from "../../../server/src/opencode/missions/native-current-passage-test-fixture"
import { registerMissionRecurrenceCurrent } from "../../../server/src/server/routes/mission-recurrence-current"
import { WorktreeDeletionFence } from "../../../server/src/workspaces/worktree-session-evacuation"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import { missionPanelWindow } from "../../../server/src/missions/mission-panel-page"

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
  let failRawPage = false
  let releaseActivity!: () => void, activityEntered!: () => void, holdActivity = true
  const activityGate = new Promise<void>(resolve => { releaseActivity = resolve }), activityStarted = new Promise<void>(resolve => { activityEntered = resolve })
  const screenshot = async (stage: string) => {
    if (process.env.CODENOMAD_TEST_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CODENOMAD_TEST_SCREENSHOTS, `current-${owner}-activity-${stage}.png`) })
  }
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
        const selector = request.method() === "POST" ? request.postDataJSON().selector : undefined
        if (holdActivity && selector?.source === "activity" && selector.actorOffset === 160) {
          holdActivity = false; activityEntered(); await activityGate
        }
        if (failRawPage && selector?.text && selector.field === "actors" && selector.window?.offset === 1) {
          failRawPage = false
          return route.fulfill({ status: 503, json: { error: "Owned raw field retry" } })
        }
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
    assert.equal(await page.locator(".mission-tree-gap").count(), 0)
    assert.equal(await page.locator(".mission-tree-more button").count(), 0, "ordinary continuation needs no button")
    const continued = page.waitForResponse(response => response.request().method() === "POST"
      && response.request().postDataJSON()?.selector?.source === "tasks" && response.request().postDataJSON()?.selector?.task?.offset > 0)
    await page.locator(".mission-tree-more").scrollIntoViewIfNeeded()
    assert.equal((await continued).status(), 200, "scrolling reads the next task window independently of mounted row count")
    assert.ok(selections.some(input => input.selector.source === "tasks" && input.selector.task.offset > 0
      && input.selector.task.missionID === map.id && input.source.owner === owner && input.source.missionID === map.id), "scroll continuation retains the exact passage owner")
    const openTaskReader = () => page.evaluate(async ({ root, missionID, scheduleID, passageID, owner, taskID }) => {
      (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { reader: { missionId: missionID, kind: "task", itemId: taskID,
        recurrence: { instanceId: "fixture", projectID: "project", scheduleID, passageID, owner } } })
    }, { root: f.root, missionID: map.id, scheduleID: f.scheduleID, passageID: f.passage.passageID, owner, taskID: map.tasks.at(-1)!.id })
    await openTaskReader()
    await page.locator(".mission-task-reader").waitFor()
    await page.locator(".mission-reader details > summary").filter({ hasText: /^Task brief$/ }).click()
    await page.locator(".mission-reader").getByText(/Exact brief/).first().waitFor()
    assert.ok(selections.some(input => input.body?.kind === "task" && input.body.taskKey === map.tasks.at(-1)!.key && input.body.field === "brief"))
    const activityMore = page.locator(`.mission-control .mission-panel-paging[data-lane="activity:${map.id}"]`).getByRole("button", { name: "Load more", exact: true })
    const geometry = () => page.locator(".mission-tree").evaluate(element => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    })
    await activityMore.scrollIntoViewIfNeeded()
    const beforeActivity = await geometry()
    await screenshot("before")
    await activityMore.click()
    await activityStarted
    await page.locator('.mission-control-header button[aria-label="Refresh mission map"] .animate-spin').waitFor()
    assert.deepEqual(await geometry(), beforeActivity, "passage-owned background reads preserve task-tree geometry")
    assert.equal(await page.locator(".mission-control").getByText(/^Activity and requests cover|^Read in this traversal/).count(), 0)
    await screenshot("during")
    releaseActivity()
    // The off-page actor's question reaches the selected row's flag; the panel never lists it.
    await page.locator('.mission-row-select[aria-current=true] .mission-row-flag[data-mark="permission"]').waitFor().catch(async error => {
      throw new Error(`${error}\n${JSON.stringify({ activityRows, errors, selectors: selections.map(input => input.selector) })}\n${(await page.locator(".mission-control").innerText()).slice(0, 1000)}`)
    })
    assert.ok(selections.some(input => input.selector.source === "activity" && input.selector.actorOffset === 160))
    await screenshot("after")
    assert.equal(await page.locator(".mission-control").getByText("Off-page current question", { exact: true }).count(), 0)
    // Selecting the red row opens the off-page question's conversation, for either schedule
    // type: the guarded navigation reads exactly that native session (this fixture serves none).
    const opened = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/session/ses_current_179"))
    await page.locator(".mission-row-select[aria-current=true]").click()
    await opened
    // Eye mode follows the selected row back to its overview; wait for that
    // reader's intended body demand before measuring unrelated invalidation.
    await page.locator(".mission-overview-details").waitFor()
    await page.locator(".mission-reader").getByText(map.objective, { exact: true }).waitFor()
    // Root notes are unrelated to the task reader, but are visible overview
    // content. Restore the exact task demand before checking cache retention.
    await openTaskReader()
    await page.locator(".mission-reader details > summary").filter({ hasText: /^Task brief$/ }).click()
    await page.locator(".mission-reader").getByText(/Exact brief/).first().waitFor()
    const taskReads = selections.filter(input => input.selector.source === "tasks").length, bodyReads = selections.filter(input => input.body).length
    await f.control.update({ missionID: map.id, requestID: "notes-only", expectedRevision: map.revision, objective: map.objective, notes: "Unrelated root notes" })
    const refreshed = page.waitForResponse(response => response.request().method() === "POST" && response.request().postDataJSON()?.selector?.header === true)
    await page.evaluate(() => (window as any).passageFixture.invalidate("rpc.codenomad.missions.changed"))
    await refreshed
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(selections.filter(input => input.selector.source === "tasks").length, taskReads, "an unrelated journal revision does not storm expanded task pages")
    assert.equal(selections.filter(input => input.body).length, bodyReads, "an unchanged exact body retains its original digest")
    const source = (await f.read()).source!, headerSelector = { source: "mission", missionID: map.id, header: true }
    assert.ok(selections.filter(input => input.selector.source === "tasks").every(input => JSON.stringify(input.source) === JSON.stringify(source)), "every task continuation retains the exact frozen source")
    const beforeFields = await f.page({ source, selector: headerSelector })
    await page.evaluate(async ({ root, missionID, scheduleID, passageID, owner }) => {
      (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { reader: { missionId: missionID, kind: "overview",
        recurrence: { instanceId: "fixture", projectID: "project", scheduleID, passageID, owner } } })
    }, { root: f.root, missionID: map.id, scheduleID: f.scheduleID, passageID: source.passageID, owner })
    await page.locator(".mission-reader .mission-overview-details > details").filter({ has: page.locator("summary").filter({ hasText: /^Technical details$/ }) }).locator(":scope > summary").click()
    const fields = page.locator(".mission-reader .mission-panel-fields")
    await fields.locator(":scope > summary").click()
    const actors = fields.locator(":scope > details").filter({ has: page.locator("summary").filter({ hasText: /^actors \(/ }) })
    await actors.locator(":scope > summary").click()
    await actors.locator("pre").first().waitFor()
    await actors.getByRole("button", { name: "Read raw JSON pages", exact: true }).click()
    await actors.getByText(/Raw JSON page 1 of/).waitFor()
    failRawPage = true
    await actors.getByRole("button", { name: "Next page", exact: true }).click()
    await actors.getByRole("button", { name: "Try again", exact: true }).click()
    await actors.getByText(/Raw JSON page 2 of/).waitFor()
    await actors.locator("pre").first().waitFor()
    const fieldReads = selections.filter(input => input.selector.field === "actors")
    assert.ok(fieldReads.some(input => !input.selector.text && input.selector.window.offset === 0))
    assert.ok(fieldReads.some(input => input.selector.text && input.selector.window.offset === 0))
    assert.ok(fieldReads.filter(input => input.selector.text && input.selector.window.offset === 1).length >= 2, "Retry repeats the failed scoped raw continuation")
    assert.ok(fieldReads.every(input => JSON.stringify(input.source) === JSON.stringify(source)))
    assert.deepEqual(await f.page({ source, selector: headerSelector }), beforeFields, "field reads never enlarge the selected header")
    assert.ok(selections.every(input => ["mission", "tasks", "activity"].includes(input.selector.source)
      && (input.selector.source !== "mission" || input.selector.header || input.selector.field)), "no full-map or project fallback")
    // The refreshed passage left its earlier activity windows superseded (unknown):
    // their retained request is no longer evidence, so the row stops asking.
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") !== "permission")
    assert.ok(sizes.every(size => size <= 65536)); assert.deepEqual(writes, []); assert.deepEqual(errors, [])
    t.diagnostic(JSON.stringify({ owner, tasks: map.tasks.length, initialBodies: 0, transfers: selections.length, largestBody: Math.max(...sizes), ...f.metrics() }))
  } finally { releaseActivity?.(); await page.context().close(); await app.close(); await f.dispose() }
})

for (const owner of ["daily", "scheduled"] as const) test(`${owner} covered page back aborts its held continuation without a false error after real 31 seconds`, { timeout: 90_000 }, async t => {
  const f = await currentPassageFixture(owner), page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
  let release!: () => void, entered!: () => void, heldID: string | undefined, heldOffset: number | undefined
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const errors: string[] = [], failures: Array<{ id?: string; url: string; error?: string }> = []
  let marksEntered!: () => void, releaseMarks!: () => void, heldMarks = false
  const marksStarted = new Promise<void>(resolve => { marksEntered = resolve }), marksGate = new Promise<void>(resolve => { releaseMarks = resolve })
  page.on("pageerror", error => errors.push(error.message))
  page.on("requestfailed", request => failures.push({ id: request.headers()["x-body-read"], url: request.url(), error: request.failure()?.errorText }))
  try {
    const lead = "FIRST_PAGE_MARKER\n\n" + "\u0001".repeat(12_000) + "\n", middle = "\n\nSECOND_PAGE_MARKER\n\n"
    const brief = lead + "\u0001".repeat(17_000 - lead.length) + middle + "\u0001".repeat(3_000 - middle.length)
    assert.equal(brief.length, 20_000)
    let map = (await f.control.snapshot()).missions[0]
    map = (await f.control.revise(map.coordinatorSessionId, { missionID: map.id, requestID: "page-back", expectedRevision: map.revision,
      reason: "Demand contraction", retireTasks: [], dependencyUpdates: [], addTasks: [{ taskKey: "page-back", title: "Paged brief", brief,
        role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }] })).mission
    const source = (await f.read()).source!
    await page.addInitScript("Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})")
    await page.addInitScript(() => {
      const original = window.fetch, records: any[] = []
      ;(window as any).__bodyReads = records
      window.fetch = (input, init) => {
        if (typeof input === "string" && input.includes("/missions/") && init?.method === "POST") {
          const id = String(records.length + 1), headers = new Headers(init.headers)
          headers.set("x-body-read", id)
          const record = { id, body: JSON.parse(String(init.body)), at: performance.now(), abortedAtDispatch: init.signal?.aborted,
            abortedAt: undefined as number | undefined, reason: undefined as string | undefined }
          records.push(record)
          init.signal?.addEventListener("abort", () => { record.abortedAt = performance.now(); record.reason = init.signal?.reason?.name }, { once: true })
          return original(input, { ...init, headers })
        }
        return original(input, init)
      }
    })
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path === "/api/events") { await marksStarted; return route.continue({ url: eventsURL }) }
      if (path === "/api/storage/config/ui") return route.fulfill({ json: { settings: { locale: "en" } } })
      if (path.endsWith("/current")) { const { projectCanonical: _canonical, location: _location, ...identity } = await f.read(); return route.fulfill({ json: identity }) }
      if (path.endsWith("/missions/panel-page")) {
        const input = request.postDataJSON()
        return route.fulfill({ json: input.source === "summaries" || input.source === "cleanups" ? missionPanelWindow({ projectID: "project", source: input.source,
          discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false, ...(input.initial ? { finishHighWater: 0 } : {}) },
        [], input.window ?? { offset: 0 }, input.cursor) : { available: false, reason: "observation-unavailable" } })
      }
      if (/\/current\/[^/]+\/page$/.test(path)) {
        const input = request.postDataJSON()
        assert.deepEqual(input.source, source)
        if (!heldID && input.body?.kind === "task" && input.body.field === "brief" && input.body.offset > 0) {
          heldID = request.headers()["x-body-read"]; heldOffset = input.body.offset; entered(); await gate
          if (failures.some(failure => failure.id === heldID)) return
        }
        return route.fulfill({ json: input.selector.source === "activity" ? { available: false, reason: "observation-unavailable" } : await f.page(input) })
      }
      if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project", projectCanonical: f.root, location: { directory: f.root },
        schedules: owner === "daily" ? [{ id: f.scheduleID, title: "Daily contraction", revision: 1, state: "interrupted", interruptionReason: "service-restart",
          clock: { time: "23:59", zone: "UTC" }, nextDueAt: null, actions: [], controls: [], pending: { passageID: source.passageID, missionID: map.id,
            conversationID: map.coordinatorSessionId, status: "running" }, latestResult: null, history: [] }] : [] } })
      if (path.endsWith("/missions/scheduled")) {
        const doc = owner === "scheduled" ? await f.documents.read(f.scheduleID) : undefined
        return route.fulfill({ json: { version: 1, projectID: "project", schedules: doc && "configuration" in doc ? [missionScheduleView(doc).document] : [] } })
      }
      return route.fulfill({ json: path.endsWith("/missions") ? { available: true, version: 1, projectID: "project", missions: [], summaries: [], generatedAt: 1, discardedEvents: 0 }
        : path.includes("/instance/") ? [] : {} })
    })
    // Stream open cancels the initial project-wide marks read. Its selector has
    // missionOffset rather than window; hold exactly that read across the open.
    await page.route(/\/missions\/panel-page$/, async route => {
      if (heldMarks || route.request().postDataJSON().source !== "marks") return route.fallback()
      heldMarks = true
      marksEntered(); await marksGate
      if (!route.request().failure()) return route.fallback()
    })
    await page.goto(url + "?directory=" + encodeURIComponent(f.root))
    await selectMission(page, owner === "daily" ? "Daily contraction" : "Scheduled current")
    await page.evaluate(async ({ root, missionID, taskID, scheduleID, passageID, owner }) => {
      (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { reader: { missionId: missionID, kind: "task", itemId: taskID,
        recurrence: { instanceId: "fixture", projectID: "project", scheduleID, passageID, owner } } })
    }, { root: f.root, missionID: map.id, taskID: map.tasks[0].id, scheduleID: f.scheduleID, passageID: source.passageID, owner })
    const section = page.locator(".mission-task-reader > details").filter({ has: page.locator("summary").filter({ hasText: /^Task brief$/ }) })
    await section.locator(":scope > summary").click(); await section.getByText("FIRST_PAGE_MARKER", { exact: true }).waitFor()
    const number = section.locator("input[type=number]")
    await number.fill("2"); await number.press("Enter"); await started
    await number.fill("1"); await number.press("Enter"); await section.getByText("FIRST_PAGE_MARKER", { exact: true }).waitFor()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const contractedAt = await page.evaluate(() => performance.now()), at = performance.now()
    const immediately = await page.evaluate(id => (window as any).__bodyReads.find((read: any) => read.id === id), heldID)
    await delay(31_000)
    const retry = await section.getByRole("button", { name: "Try again", exact: true }).count()
    const records = await page.evaluate(() => (window as any).__bodyReads)
    t.diagnostic(JSON.stringify({ owner, elapsed: performance.now() - at, heldOffset, immediately, contractedAt, retry, failures }))
    assert.equal(await number.inputValue(), "1"); assert.equal(retry, 0, "a covered page must not inherit the unnecessary continuation's timeout")
    assert.ok(immediately.abortedAt !== undefined && immediately.abortedAt <= contractedAt, "abort happens on contraction, before the real deadline")
    assert.equal(immediately.reason, "AbortError")
    assert.ok(failures.some(failure => failure.id === heldID))
    for (const failure of failures) {
      const read = records.find((record: any) => record.id === failure.id)
      assert.ok(read, "every failed request has its exact originating fetch record")
      assert.equal(failure.error, "net::ERR_ABORTED"); assert.equal(read.reason, "AbortError")
      assert.equal(read.abortedAtDispatch, false); assert.ok(read.abortedAt !== undefined)
      if (failure.id === heldID) {
        assert.deepEqual(read.body.source, source); assert.equal(read.body.body.field, "brief"); assert.equal(read.body.body.offset, heldOffset)
      } else {
        assert.ok(failure.url.endsWith("/missions/panel-page"))
        if (read.body.source === "marks") assert.deepEqual(read.body, { source: "marks", missionOffset: 0 })
        else {
          assert.equal(read.body.window.offset, 0)
          assert.ok(read.body.source === "summaries" && read.body.initial === true || read.body.source === "cleanups" && read.body.initial === undefined)
        }
      }
    }
    await number.fill("2"); await number.press("Enter"); await section.getByText("SECOND_PAGE_MARKER", { exact: true }).waitFor()
    const extended = await page.evaluate(id => (window as any).__bodyReads.filter((read: any) => read.id !== id && read.body.body?.offset > 0), heldID)
    assert.ok(extended.some((read: any) => read.body.body.offset === heldOffset && read.abortedAtDispatch === false && read.at >= contractedAt + 30_000))
    assert.equal(await section.getByRole("button", { name: "Try again", exact: true }).count(), 0); assert.deepEqual(errors, [])
  } finally { releaseMarks(); release(); await page.context().close(); await f.dispose() }
})
