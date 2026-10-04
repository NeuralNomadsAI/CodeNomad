import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { clickMissionAction } from "./mission-actions"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: cache.cacheDir,
    plugins: [solid(), { name: "mission-fixture", configureServer(s) {
      s.middlewares.use("/mission-session-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-session-fixture", '<html><body><div id="root" style="display:flex;height:100vh"></div><script type="module" src="/tests/browser/fixtures/mission-session.tsx"></script></body></html>'))
      })
      s.middlewares.use("/mission-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { try { await browser?.close(); await server?.close() } finally { await cache?.dispose() } })

function mission(id: string): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "Notes",
    coordinatorSessionId: "ses_fixture", status: "active", actors: [], frontier: [], claims: [], revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false,
    tasks: [{ id: `task-${id}`, key: "task-one", title: "Inspect evidence", brief: "A detailed brief", role: "research", status: "completed", blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }],
    reports: [{ id: `report-${id}`, taskKey: "task-one", sessionId: "ses_fixture", outcome: "completed", summary: "Report opening paragraph.\n\n" + "Long report paragraph.\n\n".repeat(90), evidence: ["Source proof"], next: [], createdAt: 1 }],
  }
}
async function setup(page: Page) {
  page.on("pageerror", error => console.error("fixture error", error))
  await page.addInitScript(`
    Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(localStorage.getItem("fixture-native") ?? "null") }),
      saveClientState: async (_token, snapshot) => { localStorage.setItem("fixture-native", JSON.stringify(snapshot)); return true },
    } })
  `)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
}
const fixtureCall = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) => (window as any).missionFixture[method](arg), { method, arg })
const missionRows = (page: Page) => page.locator(".mission-control-index > .mission-list-item")
const taskRow = (page: Page, key: string) => page.locator(`.mission-route-task[data-task-key="${key}"] > .mission-list-item`)

test("one Play control starts and resumes; partial Pause survives remount and Stop stays terminal", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    let current: MissionMap = { ...mission("lifecycle"), runState: "prepared" }
    const calls: any[] = []
    let failPause = true
    await page.route("**/api/workspaces/fixture/missions**", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, missions: [current], generatedAt: 1, discardedEvents: 0 } })
      const input = route.request().postDataJSON()
      calls.push(input)
      current = { ...current, revision: current.revision + 1,
        runState: input.action === "start" ? "running" : input.action === "pause" ? "paused" : "stopped",
        status: input.action === "stop" ? "stopped" : "active",
        control: { id: "evt_control", missionID: current.id, requestID: input.requestId, expectedRevision: input.expectedRevision, action: input.action,
          targets: [{ sessionID: "ses_fixture", location: { directory: "/fixture" } }], pending: [] },
      }
      if (input.action === "pause" && failPause) {
        failPause = false
        current.control!.pending = ["ses_fixture"]
        return route.fulfill({ status: 503, json: { code: "control-pending" } })
      }
      return route.fulfill({ json: { mission: current } })
    })
    await page.goto(url)
    const play = page.locator(".mission-lifecycle-actions > button").nth(0)
    assert.equal(await play.getAttribute("aria-label"), "Start mission")
    await play.click()
    await page.getByRole("button", { name: "Pause mission", exact: true }).waitFor()
    await page.waitForFunction(() => !(document.querySelector('[aria-label="Pause mission"]') as HTMLButtonElement)?.disabled)
    assert.equal(await play.isDisabled(), true)
    await page.getByRole("button", { name: "Pause mission", exact: true }).click()
    await page.getByRole("alert").getByText("Control incomplete. Retry or refresh the mission.").waitFor()
    await fixtureCall(page, "mount", false)
    await fixtureCall(page, "mount", true)
    await page.locator(".mission-lifecycle").getByRole("button", { name: "Try again", exact: true }).click()
    await page.waitForFunction(() => !(document.querySelector('[aria-label="Resume mission"]') as HTMLButtonElement)?.disabled)
    assert.equal(calls[1].requestId, calls[2].requestId)
    assert.equal(calls[1].expectedRevision, calls[2].expectedRevision)
    assert.equal(await play.getAttribute("aria-label"), "Resume mission")
    assert.equal(await page.getByRole("button", { name: "Start mission", exact: true }).count(), 0)
    await play.evaluate(el => { (window as any).savedPlayControl = el })
    await play.click()
    await page.waitForFunction(() => !(document.querySelector('[aria-label="Pause mission"]') as HTMLButtonElement)?.disabled)
    assert.equal(await play.evaluate(el => el === (window as any).savedPlayControl), true)
    await page.getByRole("button", { name: "Stop mission permanently", exact: true }).click()
    await page.getByRole("button", { name: "Objective lifecycle", exact: true }).waitFor()
    await missionRows(page).getByText("Stopped", { exact: true }).waitFor()
    assert.equal(await play.isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "Pause mission", exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "Stop mission permanently", exact: true }).isDisabled(), true)
    await fixtureCall(page, "mount", false)
    await fixtureCall(page, "mount", true)
    assert.equal(await play.isDisabled(), true)
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-lifecycle-stopped.png") })
    assert.deepEqual(calls.map(call => call.action), ["start", "pause", "pause", "start", "stop"])
  } finally { await page.close() }
})

test("disclosures, mission selection and reader survive native invalidations, remount and restoration", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    await setup(page)
    let revision = 1
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [mission("one"), { ...mission("two"), revision }], generatedAt: revision, discardedEvents: 0 } }))
    await page.goto(url)
    await page.getByRole("button", { name: "Objective two", exact: true }).click()
    const reports = page.getByRole("button", { name: "Reports", exact: true })
    await reports.click()
    const report = page.locator(".mission-report-list > .mission-list-item")
    await page.getByRole("button", { name: "Work", exact: true }).click()
    assert.equal(await reports.getAttribute("aria-expanded"), "true")
    assert.equal(await report.locator(".mission-disclosure-trigger").count(), 0)
    await clickMissionAction(report, "Read in chat area")
    await page.locator(".mission-reader .markdown-body p").first().waitFor()
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-reader-browser.png") })
    await page.locator(".mission-reader .window-body").evaluate(el => { el.scrollTop = 600 })
    await reports.focus()
    revision++
    await fixtureCall(page, "refresh")
    await page.waitForResponse(response => response.url().endsWith("/missions"))
    assert.equal(await reports.getAttribute("aria-expanded"), "true")
    assert.equal(await reports.evaluate(el => el === document.activeElement), true)
    assert.equal(await page.getByRole("button", { name: "Work", exact: true }).getAttribute("aria-expanded"), "false")
    assert.ok(await page.locator(".mission-reader .window-body").evaluate(el => el.scrollTop) > 0)
    await fixtureCall(page, "mount", false)
    await fixtureCall(page, "mount", true)
    assert.equal(await reports.getAttribute("aria-expanded"), "true")
    assert.ok(await page.locator(".mission-reader .window-body").evaluate(el => el.scrollTop) > 0)
    await fixtureCall(page, "flush")
    await page.reload()
    await page.locator(".mission-reader").waitFor()
    assert.equal(await reports.getAttribute("aria-expanded"), "true")
    assert.equal(await page.getByRole("button", { name: "Work", exact: true }).getAttribute("aria-expanded"), "false")
    assert.equal(await missionRows(page).locator('.mission-list-select[aria-current="true"]').innerText(), "Objective two")
    await page.getByRole("button", { name: "Back to chat" }).click()
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-control-browser.png"), fullPage: true })
  } catch (error) { console.error(await page.locator("body").innerText()); throw error } finally { await page.close() }
})

test("edits keep drafts and original revision during refresh, and creation retries reuse request identity", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await setup(page)
    let revision = 1, failCreate = true, failDelete = true
    const creates: any[] = [], updates: any[] = [], deletions: any[] = []
    let list = [mission("one")]
    let cleanups: any[] = []
    await page.route("**/api/workspaces/fixture/missions**", async route => {
      const request = route.request(), body = request.postDataJSON()
      if (request.method() === "POST") {
        creates.push(body)
        if (failCreate) return route.fulfill({ status: 503, body: "Unavailable" })
        const created = { ...mission("created"), objective: body.objective }; list.push(created)
        return route.fulfill({ json: { mission: created } })
      }
      if (request.method() === "PATCH") { updates.push(body); return route.fulfill({ status: 409, body: "Changed" }) }
      if (request.method() === "DELETE") {
        deletions.push(body); list = list.filter(m => m.id !== "created")
        cleanups = [{ missionID: "created", deletionID: "evt_fixture_delete", requestID: body.requestId, expectedRevision: body.expectedRevision,
          deleteManagedSessions: body.deleteManagedSessions, objective: "New mission objective", removed: 0, retained: 0, pending: failDelete ? 1 : 0, reasons: [], createdAt: 1 }]
        if (failDelete) { failDelete = false; return route.fulfill({ status: 503, body: "Cleanup pending" }) }
        return route.fulfill({ json: { deleted: true } })
      }
      return route.fulfill({ json: { available: true, missions: list.map(m => ({ ...m, revision })), cleanups, generatedAt: revision, discardedEvents: 0 } })
    })
    await page.goto(url)
    await clickMissionAction(missionRows(page).first(), "Edit mission")
    await page.getByLabel("Objective", { exact: true }).fill("My edited objective")
    revision++
    await fixtureCall(page, "refresh")
    await page.waitForResponse(response => response.url().endsWith("/missions"))
    assert.equal(await page.getByLabel("Objective", { exact: true }).inputValue(), "My edited objective")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(updates[0].expectedRevision, 1)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.getByLabel("Objective", { exact: true }).fill("New mission objective")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("alert").waitFor()
    failCreate = false
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await missionRows(page).locator('.mission-list-select[aria-current="true"]', { hasText: "New mission objective" }).waitFor()
    assert.equal(creates.length, 2)
    assert.equal(creates[0].requestId, creates[1].requestId)
    await page.getByRole("button", { name: "Work", exact: true }).click()
    await fixtureCall(page, "flush")
    const storedDisclosures = () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("fixture-native")!).layout).filter(key => key.startsWith("mission-disclosures-")))
    const beforeDelete = await storedDisclosures()
    await clickMissionAction(missionRows(page).filter({ has: page.getByRole("button", { name: "New mission objective", exact: true }) }), "Delete mission")
    await page.getByText("Delete this mission? The coordinator and reused conversations will be kept.").waitFor()
    const cleanup = page.getByRole("checkbox", { name: "Also delete specialist conversations created for this mission" })
    assert.equal(await cleanup.isChecked(), false)
    await cleanup.check()
    await page.locator("form").getByRole("button", { name: "Delete mission", exact: true }).click()
    await page.getByRole("alert").getByText("Deletion could not be completed. Retry to finish the remaining cleanup.").waitFor()
    assert.equal(await cleanup.isDisabled(), true)
    await fixtureCall(page, "refresh")
    await page.locator("form").getByRole("button", { name: "Delete mission", exact: true }).click()
    await page.locator("form").waitFor({ state: "detached" })
    await missionRows(page).locator('.mission-list-select[aria-current="true"]', { hasText: "Objective one" }).waitFor()
    assert.equal(deletions.length, 2)
    assert.equal(deletions[0].deleteManagedSessions, true)
    assert.equal(deletions[0].requestId, deletions[1].requestId)
    await fixtureCall(page, "flush")
    assert.equal((await storedDisclosures()).length, beforeDelete.length - 1)
  } catch (error) { console.error(await page.locator("body").innerText()); throw error } finally { await page.close() }
})

test("a saved report remains visibly pending until native notification admission is acknowledged", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await setup(page)
    const value = mission("outbox")
    value.reports[0].notificationStatus = "pending"
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: {
      available: true, missions: [value], generatedAt: value.revision, discardedEvents: 0,
    } }))
    await page.goto(url)
    const pending = page.getByRole("status").filter({ hasText: "Coordinator notification pending" })
    await pending.waitFor()
    await page.getByRole("button", { name: "Reports", exact: true }).click()
    await page.locator(".mission-report-list > .mission-list-item").getByText("Complete", { exact: true }).waitFor()
    value.reports[0].notificationStatus = "admitted"
    value.revision++
    await fixtureCall(page, "refresh")
    await pending.waitFor({ state: "detached" })
    await page.locator(".mission-report-list > .mission-list-item").getByText("Complete", { exact: true }).waitFor()
  } finally { await page.close() }
})

test("dependency navigation reveals the linked task and revised plans retain readable old and new context", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 800 } })
  try {
    await setup(page)
    const value = mission("plan")
    value.tasks.push({ ...value.tasks[0], id: "task-next", key: "task-next", title: "Check the implementation", status: "blocked", blockedBy: ["task-one"] })
    value.history = [{ revision: 12, actorSessionId: "ses_fixture", reason: "The investigation changed the scope.", createdAt: 100,
      objective: { before: "Old objective", after: "Revised objective" }, addedTaskKeys: ["task-next"], retiredTasks: [],
      dependencyUpdates: [{ taskKey: "task-next", before: [], after: ["task-one"] }] },
      { revision: 13, source: "user", createdAt: 101, notes: { before: "Old notes", after: "Human clarification" }, addedTaskKeys: [], retiredTasks: [], dependencyUpdates: [] }]
    value.historyTruncated = true
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [value], generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await clickMissionAction(taskRow(page, "task-next"), "Read in chat area")
    await page.getByRole("button", { name: "Depends on Inspect evidence", exact: true }).click()
    await page.locator('.mission-task-reader[data-task-id="task-plan"]').waitFor()
    assert.equal(await taskRow(page, "task-one").locator(".mission-disclosure-trigger").count(), 0)
    await page.locator(".mission-reader").getByRole("heading", { name: "Inspect evidence", exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Back to chat")
    assert.equal(await page.getByRole("button", { name: "Back to chat", exact: true }).evaluate(el => el === document.activeElement), true)
    await page.getByRole("button", { name: "Blocks Check the implementation", exact: true }).waitFor()
    const history = page.locator(".mission-disclosure", { has: page.getByRole("button", { name: "History", exact: true }) }).last()
    await history.getByRole("button", { name: "History", exact: true }).click()
    await history.getByText("Showing the latest 2 changes.").waitFor()
    await history.getByText("Coordinator", { exact: true }).waitFor()
    await history.getByText("You", { exact: true }).waitFor()
    assert.equal(await history.locator(".mission-history-list .mission-disclosure-trigger").count(), 0)
    await clickMissionAction(history.locator(".mission-history-list .mission-list-item").first(), "Read in chat area")
    await page.locator(".mission-reader").getByText("Human clarification", { exact: true }).waitFor()
    await page.locator(".mission-reader").getByText("Old notes", { exact: true }).waitFor()
    await clickMissionAction(history.locator(".mission-history-list .mission-list-item").last(), "Read in chat area")
    await page.locator(".mission-reader").getByText("Old objective", { exact: true }).waitFor()
    await page.locator(".mission-reader").getByText("Revised objective", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Back to chat", exact: true }).press("Escape")
    assert.equal(await page.locator(".mission-reader").count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  } finally { await page.close() }
})

test("background native questions settle and requested execution remains distinct from the current session", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 800, height: 850 } })
  try {
    await setup(page)
    const value = mission("attention")
    value.actors = [{ sessionId: "ses_background", title: "Background assistant", kind: "specialist", managed: false, roles: ["research"], location: { directory: "fixture" }, joinedAt: 1 }]
    value.tasks[0] = { ...value.tasks[0], actorSessionId: "ses_background", execution: { agent: "build", model: { providerID: "requested", id: "chosen", variant: "high" } } }
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [value], generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await clickMissionAction(taskRow(page, "task-one"), "Read in chat area")
    await fixtureCall(page, "seedActor")
    await page.locator(".mission-execution-cell", { hasText: "requested/chosen" }).waitFor()
    await page.locator(".mission-execution-cell", { hasText: "native/observed" }).waitFor()
    await page.locator('.mission-execution-cell[data-state="unknown"]', { hasText: "Unknown" }).waitFor()
    await fixtureCall(page, "event", { type: "form.created", data: { form: { id: "form-background", sessionID: "ses_background", title: "Choose the scope", fields: [{ type: "text", name: "scope", label: "Scope" }] } } })
    await page.getByText("Choose the scope", { exact: true }).waitFor()
    await page.locator(".mission-attention-list").getByRole("button", { name: "Open Background assistant", exact: true }).waitFor()
    await page.getByRole("button", { name: /^Conversations/ }).click()
    await fixtureCall(page, "event", { type: "form.replied", data: { id: "form-background", sessionID: "ses_background", answers: {} } })
    await page.getByText("Choose the scope", { exact: true }).waitFor({ state: "detached" })
    assert.equal(await page.getByRole("button", { name: "Your response is needed", exact: true }).count(), 0)
    await clickMissionAction(missionRows(page).first(), "Open coordinator")
    await page.getByRole("alert").getByText("Unable to reload session").waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.locator(".mission-execution").scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-execution-browser.png"), fullPage: true })
  } finally { await page.close() }
})

test("the real session retains its transcript nodes and draft while a long mission report scrolls independently", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1000, height: 800 } })
  try {
    await setup(page)
    await page.route("**/api/workspaces/browser-instance/missions", route => route.fulfill({ json: { available: true, missions: [mission("reader")], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/browser-instance/files/preview?*", route => route.fulfill({ json: { contents: "# Workspace reader\n\nFile preview content", encoding: "utf-8" } }))
    await page.goto(url.replace("/mission-fixture", "/mission-session-fixture"))
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.seedHistory())
    const transcript = page.locator(".mission-transcript-content")
    await transcript.getByText("History 59", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.locator(".mission-reader").waitFor()
    await page.evaluate(() => (window as any).fixture.readFile())
    await page.locator(".workspace-file-view").getByText("File preview content", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.locator(".mission-reader").waitFor()
    assert.equal(await page.locator(".workspace-file-view").count(), 0)
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    await transcript.evaluate(el => { (window as any).savedTranscript = el.firstElementChild })
    const composer = page.locator("textarea:visible").first()
    await composer.fill("Keep this draft while reading")
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.locator(".mission-reader").getByText("Report opening paragraph.", { exact: true }).waitFor()
    assert.equal(await transcript.getAttribute("inert"), "")
    assert.equal(await composer.inputValue(), "Keep this draft while reading")
    assert.equal(await transcript.evaluate(el => el.firstElementChild === (window as any).savedTranscript), true)
    await page.locator(".mission-reader .window-body").evaluate(el => { el.scrollTop = 900 })
    assert.ok(await page.locator(".mission-reader .window-body").evaluate(el => el.scrollTop) > 0)
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-session-reader-browser.png") })
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    assert.equal(await transcript.evaluate(el => el.firstElementChild === (window as any).savedTranscript), true)
    assert.equal(await composer.inputValue(), "Keep this draft while reading")
    await transcript.getByText("History 59", { exact: true }).waitFor()
  } finally { await page.close() }
})

test("compact mission rows retain a completed branching plan, direct readers and measured dependency edges", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    const value = mission("compact")
    value.objective = "Ship the Mission Centre"
    value.status = "completed"
    value.notes = "Full mission context belongs in the reader."
    const task = value.tasks[0]
    value.tasks = [
      { ...task, id: "publish", key: "publish", title: "Publish the changes", blockedBy: ["review", "verify"] },
      { ...task, id: "review", key: "review", title: "Independent review", blockedBy: ["implement"] },
      { ...task, id: "verify", key: "verify", title: "Browser verification", blockedBy: ["implement"] },
      { ...task, id: "implement", key: "implement", title: "Implement the interface", blockedBy: ["research", "design"] },
      { ...task, id: "research", key: "research", title: "Explore existing patterns", blockedBy: [] },
      { ...task, id: "design", key: "design", title: "Design the mission view", blockedBy: [] },
    ]
    value.reports[0].taskKey = "review"
    let missions = [value, { ...mission("other"), objective: "Validate desktop packaging", status: "completed" }]
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions, generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await page.locator('.mission-graph path[data-from="review"][data-to="publish"]').waitFor()
    assert.equal(await page.locator(".mission-graph path[data-from]").count(), 6)
    assert.deepEqual(await page.locator(".mission-route-task").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.taskKey)), ["research", "design", "implement", "review", "verify", "publish"])
    const indexRows = await missionRows(page).evaluateAll(rows => rows.map(row => row.getBoundingClientRect().toJSON()))
    assert.ok(indexRows[1].top >= indexRows[0].bottom)
    assert.equal(await page.locator(".mission-control-metrics").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Create mission", exact: true }).innerText(), "")
    const lastTask = await page.locator(".mission-route-task").last().boundingBox()
    assert.ok(lastTask && lastTask.y + lastTask.height < 650, "the complete plan fits at a normal panel height")
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-compact-overview.png") })
    await page.getByRole("button", { name: "Reports", exact: true }).click()
    const report = page.locator(".mission-report-list > .mission-list-item")
    assert.equal(await report.locator(".mission-disclosure-trigger").count(), 0)
    await clickMissionAction(report, "Read in chat area")
    await page.locator(".mission-reader").getByText("Source proof", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Back to chat" }).click()
    const overview = missionRows(page).filter({ has: page.locator('.mission-list-select[aria-current="true"]') })
    await clickMissionAction(overview, "Read in chat area")
    await page.locator(".mission-reader").getByText(value.notes, { exact: true }).waitFor()
    await page.getByRole("button", { name: "Back to chat" }).click()
    const edge = page.locator('.mission-graph path[data-from="review"][data-to="publish"]')
    const compactPath = await edge.getAttribute("d")
    await clickMissionAction(taskRow(page, "review"), "Read in chat area")
    await page.locator(".mission-reader").getByRole("heading", { name: "Independent review", exact: true }).waitFor()
    assert.equal(await edge.getAttribute("d"), compactPath, "reading no longer expands task rows or changes graph geometry")
    await page.getByRole("button", { name: "Back to chat" }).click()
    await page.evaluate(() => { document.querySelector<HTMLElement>(".mission-control")!.style.zoom = "1.25" })
    await page.waitForFunction(() => {
      const svg = document.querySelector<SVGSVGElement>(".mission-graph")!
      const node = svg.querySelectorAll("rect")[5]
      const title = document.querySelector('[data-task-key="publish"] .mission-list-item')!.getBoundingClientRect()
      const point = svg.createSVGPoint()
      point.x = Number(node.getAttribute("x")) + 3
      point.y = Number(node.getAttribute("y")) + 3
      const screen = point.matrixTransform(svg.getScreenCTM()!)
      return Math.abs(screen.y - (title.top + title.height / 2)) < 1
    })
    await page.evaluate(() => { document.querySelector<HTMLElement>(".mission-control")!.style.zoom = "1" })
    await page.setViewportSize({ width: 320, height: 850 })
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.locator("aside").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-compact-rtl.png") })
    missions = [{ ...value, revision: 2, tasks: value.tasks.filter(task => task.key !== "publish") }]
    await fixtureCall(page, "refresh")
    await page.locator('[data-task-key="publish"]').waitFor({ state: "detached" })
    assert.equal(await page.locator(".mission-graph path[data-to=publish]").count(), 0)
  } finally { await page.close() }
})

test("top-level mission rows expose two-line titles, semantic states, readers and the correct coordinator", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    const missions = (["active", "completed", "failed"] as const).map((status, i) => ({ ...mission(`row-${i}`), status,
      objective: `Mission ${i}: improve the desktop navigation and keep the whole project easy to understand`,
      notes: `Full context for mission ${i}`, coordinatorSessionId: `ses_coordinator_${i}` }))
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions, generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    const rows = missionRows(page)
    await rows.nth(2).waitFor()
    for (const [index, mission] of missions.entries()) {
      await rows.nth(index).getByRole("button", { name: mission.objective, exact: true }).waitFor()
      assert.equal(await rows.nth(index).locator(".mission-list-select .mission-list-status").count(), 0)
    }
    assert.equal(await page.locator(".mission-control-header h2, .mission-control-overview").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Missions", exact: true }).count(), 0)
    assert.deepEqual(await page.locator(".mission-control > .mission-disclosure > h3 > .mission-disclosure-trigger").allTextContents(), ["Work1/1", "Reports", "Conversations0", "History"])
    assert.equal(await page.getByRole("button", { name: "Work", exact: true }).getAttribute("aria-expanded"), "true")
    assert.equal(await page.getByRole("button", { name: "Reports", exact: true }).getAttribute("aria-expanded"), "false")
    const geometry = await rows.first().locator(".mission-list-text").evaluate(el => ({
      height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), clamp: getComputedStyle(el).webkitLineClamp,
    }))
    assert.equal(geometry.clamp, "2")
    assert.ok(Math.abs(geometry.height - geometry.line * 2) < 1)
    const colors = await rows.locator(".mission-list-status").evaluateAll(items => items.map(el => getComputedStyle(el).color))
    assert.equal(new Set(colors).size, 3)
    assert.equal(await rows.nth(1).evaluate(el => getComputedStyle(el).borderBottomWidth), "1px")
    assert.ok((await page.locator(".mission-control > .mission-disclosure").evaluateAll(items => items.map(el => getComputedStyle(el).borderTopWidth))).every(width => width === "1px"))
    await clickMissionAction(rows.nth(1), "Read in chat area")
    await page.locator(".mission-reader").getByText("Full context for mission 1", { exact: true }).waitFor()
    assert.equal(await rows.nth(1).locator(".mission-list-select").getAttribute("aria-current"), "true")
    await fixtureCall(page, "seedCoordinators", missions.map(mission => mission.coordinatorSessionId))
    await clickMissionAction(rows.nth(2), "Open coordinator")
    assert.equal(await fixtureCall(page, "selectedSession"), "ses_coordinator_2")
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-top-level-rows.png") })
  } finally { await page.close() }
})

test("native activity stays separate from the plan and refreshes only while Missions is visible", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 850 } })
  try {
    await setup(page)
    const value = mission("activity")
    value.tasks = []
    value.reports = []
    value.actors = (["running", "background", "idle", "unknown"] as const).map((name, index) => ({
      sessionId: `ses_${name}`, title: index === 2 ? "Previous investigation title" : `${name} actor`, kind: "specialist" as const,
      managed: true, roles: ["implementer"], location: { directory: "/fixture" }, joinedAt: index + 1,
    }))
    value.tasks = value.actors.map((actor, index) => ({
      id: `task-${index}`, key: `task-${index}`, title: index === 2 ? "Verify current native state" : `Current ${index}`,
      brief: "Brief", role: "implementer", status: "queued" as const, blockedBy: [], actorSessionId: actor.sessionId,
      admissionId: `admission-${index}`, outstandingExecution: false, createdAt: 1, updatedAt: 1,
    }))
    let requests = 0
    const response = () => ({ available: true, missions: [value], generatedAt: requests, discardedEvents: 0,
      activity: { generatedAt: requests, missions: [{ missionId: value.id, actors: [
        { sessionId: "ses_running", state: "running" },
        { sessionId: "ses_background", state: "background" },
        { sessionId: "ses_idle", state: "idle-without-report" },
        { sessionId: "ses_unknown", state: "unknown" },
      ] }] } })
    await page.route("**/api/workspaces/fixture/missions", route => { requests += 1; return route.fulfill({ json: response() }) })
    await page.goto(url)
    const activity = page.getByRole("button", { name: /^Conversations/ })
    await activity.click()
    await page.locator('.mission-activity-list [data-state="running"]').waitFor()
    await page.locator('.mission-activity-list [data-state="background"]').waitFor()
    await page.locator('.mission-activity-list [data-state="idle-without-report"]').waitFor()
    await page.locator('.mission-activity-list [data-state="unknown"]').waitFor()
    await page.locator(".mission-activity-list").getByText("Previous investigation title", { exact: true }).waitFor()
    await page.locator(".mission-activity-list").getByText("Current assignment: Verify current native state", { exact: true }).waitFor()
    await taskRow(page, "task-2").getByRole("heading", { name: "Verify current native state", exact: true }).waitFor()
    await clickMissionAction(taskRow(page, "task-2"), "Read in chat area")
    assert.equal(await page.getByText("Assignment admitted", { exact: true }).count() > 0, true)

    const beforeToken = requests
    const refreshed = page.waitForResponse(response => response.url().endsWith("/missions"))
    await fixtureCall(page, "refresh")
    await refreshed
    assert.ok(requests > beforeToken)
    assert.equal(await activity.getAttribute("aria-expanded"), "true")

    await fixtureCall(page, "mount", false)
    const hidden = requests
    await fixtureCall(page, "refresh")
    await page.waitForTimeout(100)
    assert.equal(requests, hidden)
    const visibleRefresh = page.waitForResponse(response => response.url().endsWith("/missions"))
    await fixtureCall(page, "mount", true)
    await visibleRefresh
    assert.equal(await activity.getAttribute("aria-expanded"), "true")
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-native-activity.png") })
  } finally { await page.close() }
})
