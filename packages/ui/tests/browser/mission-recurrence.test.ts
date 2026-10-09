import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-editor-lifetime"
import { missionProfileRoles } from "../../../server/src/missions/playbook-profiles"
import { MISSION_LIFECYCLE_TEXT_LIMIT } from "../../../server/src/missions/lifecycle-input"
import { recurrenceInputBudget } from "../../../server/src/missions/recurrence-read-budget"
import { controlOperationID, controlReceiptID } from "../../../server/src/missions/receipt-identity"
import { captureMissionView } from "./mission-view-capture"
import { clickMissionAction } from "./mission-actions"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { recurrenceSnapshotSchema, recurrenceControlHttpSchema, recurrenceControlRequestSchema, recurrenceControlStatusSchema } from "../../../server/src/missions/recurrence-control-contract"
import { recurrenceManualRequestSchema, recurrenceManualResultSchema } from "../../../server/src/missions/recurrence-manual-rpc"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-recurrence", configureServer(s) { s.middlewares.use("/recurrence", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/recurrence", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script><script type="module" src="/tests/browser/fixtures/mission-recurrence-alerts.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/recurrence`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

function scheduleFixture(): RecurrenceSchedule {
  return { id: "rec_fixture", title: "Daily source review", revision: 2, state: "running", clock: { time: "08:15", zone: "UTC" },
    nextDueAt: Date.UTC(2026, 9, 9, 8, 15), pending: null, latestResult: null, history: [], controls: [], actions: ["pause", "stop", "run-now"] }
}
function scheduleEntry(page: Page, title = "Daily source review") {
  return page.locator("li.mission-index-entry", { has: page.getByRole("button", { name: title, exact: true }) })
}
async function menuItems(page: Page, entry: Locator) {
  await entry.getByRole("button", { name: "More actions", exact: true }).click()
  // Kobalte renders the menu content after the trigger's click settles.
  await page.getByRole("menuitem").first().waitFor()
  const items = await page.getByRole("menuitem").evaluateAll(nodes => nodes.map(node =>
    [node.textContent?.trim(), node.getAttribute("aria-description")]))
  await page.keyboard.press("Escape")
  await page.getByRole("menu").waitFor({ state: "hidden" })
  return items
}
function snapshotFixture(schedule: RecurrenceSchedule) {
  return recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture",
    location: { directory: "/fixture" }, schedules: [schedule] })
}
test("browser schedule fixtures satisfy the real snapshot schema and reject contract drift", () => {
  const fixture = snapshotFixture(scheduleFixture())
  assert.equal(recurrenceSnapshotSchema.safeParse(fixture).success, true)
  assert.equal(recurrenceSnapshotSchema.safeParse({ ...fixture, schedules: [{ ...fixture.schedules[0], state: "paused" }] }).success, false)
  assert.equal(recurrenceSnapshotSchema.safeParse({ ...fixture, schedules: [{ ...fixture.schedules[0], controls: undefined }] }).success, false)
})

test("unified list retains one-time missions, next passage, explicit Resume and confirmed Stop without replay", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1200, height: 950 } })
  page.setDefaultTimeout(10_000)
  const errors: string[] = [], posts: any[] = []
  page.on("pageerror", error => errors.push(error.message))
   const schedule: RecurrenceSchedule = { id: "rec_fixture", title: "Daily source review", clock: { time: "08:15", zone: "UTC" },
    nextDueAt: Date.UTC(2026, 9, 9, 8, 15), state: "running",
    pending: { passageID: "pas_current", status: "running" }, latestResult: null,
    history: [{ passageID: "pas_previous", dueAt: Date.UTC(2026, 9, 8, 8, 15), settledAt: Date.UTC(2026, 9, 8, 8, 30), outcome: "completed" }],
    revision: 2, controls: [], actions: ["resume", "stop", "run-now"] }
  schedule.latestResult = schedule.history.at(-1)!
  const mission = { version: 1, id: "msn_once", projectID: "project", projectCanonical: "/fixture", objective: "One-time review",
    template: "custom", status: "active", runState: "prepared", coordinatorSessionId: "ses_fixture", revision: 0,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false, frontier: [], claims: [], actors: [], tasks: [], reports: [] }
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [mission], generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1,
      projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [schedule] }) })
    if (path.endsWith("/current")) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: schedule.id, passageID: "pas_current" } })
    if (path.includes("/control/")) {
      const body = route.request().postDataJSON()
      const { directory: _directory, ...identity } = body
      const input = recurrenceControlRequestSchema.parse({ ...identity, scheduleID: schedule.id })
      if (path.endsWith("/status")) return route.fulfill({ json: recurrenceControlStatusSchema.parse({ version: 1,
        ...input, revision: input.expectedRevision + 1, state: "running", outcome: "committed", controlsComplete: true,
        targets: [], schedulerCancellation: "acknowledged" }) })
      posts.push({ path, body })
      return route.abort()
    }
    if (path.endsWith("/control")) {
      posts.push({ path, body: recurrenceControlHttpSchema.parse(route.request().postDataJSON()) })
      return route.abort()
    }
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 })
    await page.getByRole("button", { name: "One-time review", exact: true }).waitFor()
    await captureMissionView(page, "unified-list-desktop")
    const entry = scheduleEntry(page)
    // Running rows show their next run instead of the state word.
    await entry.locator(".mission-index-meta").getByText(/^Next: /).waitFor()
    assert.equal(await entry.locator(".neutral-badge").innerText(), "Daily 08:15")
    await page.getByRole("button", { name: "Daily source review", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "One-time review", exact: true }).count(), 1)
    assert.equal(await page.getByRole("button", { name: "Daily source review", exact: true }).getAttribute("aria-current"), "true")
    const when = entry.locator(".mission-schedule-detail .mission-schedule-when")
    assert.match(await when.innerText(), /^Every day at 08:15 · next: /)
    await captureMissionView(page, "schedule-detail-next-passage")
    for (const state of ["paused", "stopped"] as const) {
      schedule.state = state
      schedule.nextDueAt = null
      await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
      const word = state === "paused" ? "Paused" : "Stopped"
      await entry.locator(".mission-index-meta").getByText(word, { exact: true }).waitFor()
      assert.equal(await when.innerText(), `Every day at 08:15 · ${word}`)
      assert.equal(await page.getByText(/next: |Next: /).count(), 0)
    }
    // Secondary actions live in the overflow menu with their descriptive names; no tooltips or icon buttons.
    assert.deepEqual(await menuItems(page, entry), [["Stop…", "Stop schedule Daily source review"], ["Run now", "Run Daily source review now"]])
    assert.equal(await entry.locator(".mission-index-row button").count(), 3, "select, one primary and More actions")
    schedule.state = "interrupted"; schedule.interruptionReason = "service-restart"; schedule.pending!.status = "uncertain"
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
    await entry.locator(".mission-schedule-notice").getByText(/OpenCode restarted/).waitFor()
    assert.equal(await page.getByText(/next: |Next: /).count(), 0, "stale due dates stay hidden outside running state")
    assert.equal(await page.getByText("Passage pending; outcome unconfirmed", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Resume schedule Daily source review", exact: true }).innerText(), "Resume")
    await captureMissionView(page, "interrupted-resume")
    schedule.interruptionReason = undefined
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
    await page.getByText("Resume checks the running passage; it never sends it twice.").waitFor()
    await captureMissionView(page, "uncertain-passage")
    await clickMissionAction(entry, "Stop…")
    const dialog = page.getByRole("dialog")
    await dialog.getByText("Stop Daily source review?", { exact: true }).waitFor()
    assert.equal(posts.length, 0, "Stop first asks for confirmation")
    await captureMissionView(page, "stop-confirmation")
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.equal(posts.length, 0, "cancelled confirmation sends nothing")
    await page.getByRole("button", { name: "Resume schedule Daily source review", exact: true }).click()
    const check = page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true })
    await check.waitFor()
    assert.equal(await check.innerText(), "Check status")
    await entry.locator(".mission-index-feedback [role=status]").getByText("Control outcome unconfirmed; check status before another action.").waitFor()
    assert.equal(posts.length, 1)
    assert.deepEqual(Object.keys(posts[0].body).sort(), ["action", "directory", "expectedRevision", "requestID", "scheduleID"])
    await check.click()
    await page.getByRole("button", { name: "Resume schedule Daily source review", exact: true }).waitFor({ state: "visible" })
    // Without an admitted passage card, the schedule card keeps the last result and past runs under More.
    assert.match(await entry.locator(".mission-result-text").innerText(), /^Last run Oct 8, 2026, 8:15 AM: Completed/)
    await entry.locator(".mission-more > h3 > .mission-disclosure-trigger").click()
    assert.match(await entry.locator("button.mission-past-run").innerText(), /^Oct 8, 2026, 8:15 AM · Completed/)
    await captureMissionView(page, "schedule-history")
    await page.setViewportSize({ width: 390, height: 850 })
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await captureMissionView(page, "unified-list-390-rtl")
    assert.equal(posts.length, 1, "refresh and status never resend")
    assert.deepEqual(errors, [])
  } catch (error) { console.error(errors, await page.locator("body").innerText()); throw error } finally { await page.close() }
})

test("rows say Next, stuck passages explain their one action, history is plain and one-time controls stay scoped", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1200, height: 950 } })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const schedule: RecurrenceSchedule = { ...scheduleFixture(),
    lastError: { code: "admission-failed", at: Date.UTC(2026, 9, 9, 8, 15) },
    pending: { passageID: "pas_stuck", status: "uncertain", trigger: "daily", reason: "admission-failing" },
    history: [
      { passageID: "pas_manual", dueAt: Date.UTC(2026, 9, 7, 9, 0), settledAt: Date.UTC(2026, 9, 7, 9, 5), outcome: "completed", trigger: "manual" },
      { passageID: "pas_daily", dueAt: Date.UTC(2026, 9, 8, 8, 15), settledAt: Date.UTC(2026, 9, 8, 8, 16), outcome: "failed", reason: "not-started", trigger: "daily" },
    ], actions: ["pause", "stop"] }
  schedule.latestResult = schedule.history.at(-1)!
  const mission = { version: 1, id: "msn_once", projectID: "project", projectCanonical: "/fixture", objective: "One-time review",
    template: "custom", status: "active", runState: "prepared", coordinatorSessionId: "ses_fixture", revision: 0,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false, frontier: [], claims: [], actors: [], tasks: [], reports: [] }
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [mission], generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: snapshotFixture(schedule) })
    if (path.endsWith("/current")) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: schedule.id, passageID: null } })
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
    const entry = scheduleEntry(page), once = scheduleEntry(page, "One-time review")
    await entry.locator(".mission-index-meta").getByText(/^Next: /).waitFor()
    assert.equal(await page.locator(".mission-control-index").getByText(/^Running/).count(), 0, "a running row shows its next run, not its state")
    // The selected one-time Mission owns its controls and card inside its own list entry, before the schedules.
    await once.locator(".mission-index-meta").getByText(/^Prepared · /).waitFor()
    assert.equal(await once.getByRole("button", { name: "Start mission", exact: true }).innerText(), "Start")
    const card = page.locator("li.mission-index-entry-selected > div.mission-card")
    assert.equal(await card.count(), 1)
    await card.locator(".mission-more > h3 > .mission-disclosure-trigger").click()
    await card.getByRole("button", { name: "Technical details", exact: true }).click()
    await card.getByText("Agents and models", { exact: false }).first().waitFor()
    const scoped = await page.locator(".mission-control-index").evaluate(index => {
      const entries = [...index.querySelectorAll(":scope > li.mission-index-entry")]
      const selected = index.querySelector(":scope > li.mission-index-entry-selected")!
      return entries.indexOf(selected) === 0 && entries.length === 2
        && Boolean(selected.querySelector(".mission-card")) && !entries[1]!.querySelector(".mission-card")
        && !entries[1]!.querySelector("button[aria-label='Start mission']")
    })
    assert.equal(scoped, true)
    await captureMissionView(page, "one-time-scoped")
    await page.getByRole("button", { name: schedule.title, exact: true }).click()
    await entry.locator(".mission-card .mission-schedule-detail").waitFor()
    assert.equal(await once.locator(".mission-card").count(), 0, "one-time controls never appear under a recurring row")
    assert.equal(await entry.getByRole("button", { name: "Start mission", exact: true }).count(), 0)
    await entry.locator(".mission-schedule-notice").getByText("This passage has not started yet. It is retried automatically under the same identity.", { exact: true }).waitFor()
    await page.getByText(/^The last scheduled check failed at Oct 9, 2026/).waitFor()
    await entry.locator(".mission-more > h3 > .mission-disclosure-trigger").click()
    const items = entry.locator("button.mission-past-run")
    assert.match(await items.nth(0).innerText(), /^Oct 8, 2026, 8:15 AM · Not started: its start message could not be sent$/)
    assert.match(await items.nth(1).innerText(), /^Oct 7, 2026, 9:00 AM · Completed \(archived\) · Run now$/)
    assert.equal(await entry.getByRole("button", { name: "Technical details", exact: true }).count(), 1)
    await entry.getByRole("button", { name: "Technical details", exact: true }).click()
    await entry.locator(".mission-technical").getByText("rec_fixture", { exact: true }).waitFor()
    await captureMissionView(page, "stuck-passage-history")
    // Without a live observer the sentence names the one action that reconciles it.
    schedule.state = "paused"; schedule.nextDueAt = null; schedule.lastError = undefined
    schedule.pending = { passageID: "pas_stuck", status: "uncertain", trigger: "daily", reason: "not-observed" }
    schedule.actions = ["resume", "check", "stop"]
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
    await page.getByText("This passage is not being observed. Check passage reconciles it without sending it again.", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Check the pending passage of Daily source review", exact: true }).count(), 1)
    assert.equal(await page.getByText(/last scheduled check failed/).count(), 0)
    await captureMissionView(page, "uncertain-check-passage")
    assert.deepEqual(errors, [])
  } catch (error) { console.error(errors, await page.locator("body").innerText()); throw error } finally { await page.close() }
})

test("paused pending passage exposes a labelled reconcile-only Check passage control sent once", async () => {
  const page = await browser.newPage({ locale: "en-US" }), posts: any[] = [], errors: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", error => errors.push(error.message))
  const schedule: RecurrenceSchedule = { ...scheduleFixture(), state: "paused", nextDueAt: null,
    pending: { passageID: "pas_manual", status: "running" }, actions: ["resume", "check", "stop"] }
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: snapshotFixture(schedule) })
    if (path.endsWith("/current")) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: schedule.id, passageID: "pas_manual" } })
    if (path.endsWith("/control")) {
      const input = recurrenceControlHttpSchema.parse(request.postDataJSON()); posts.push(input)
      const { directory: _directory, ...identity } = input
      const status = recurrenceControlStatusSchema.parse({ version: 1, ...identity, revision: input.expectedRevision + 1,
        state: "paused", outcome: "committed", controlsComplete: true, targets: [] })
      schedule.revision = status.revision!; schedule.actions = ["resume", "stop"]; schedule.controls = [status]
      const { outcome: _outcome, ...record } = status
      return route.fulfill({ json: { ...record, targetsKnown: true } })
    }
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await page.getByRole("button", { name: schedule.title, exact: true }).click()
    const check = page.getByRole("button", { name: "Check the pending passage of Daily source review", exact: true })
    assert.equal(await check.innerText(), "Check passage")
    assert.equal(await check.evaluate(element => element.classList.contains("mission-index-primary")), true)
    assert.deepEqual(await menuItems(page, scheduleEntry(page)), [["Resume", "Resume schedule Daily source review"], ["Stop…", "Stop schedule Daily source review"]])
    await captureMissionView(page, "paused-check-passage")
    await check.click()
    await check.waitFor({ state: "hidden" })
    assert.equal(posts.length, 1)
    assert.equal(posts[0].action, "check")
    await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "Resume schedule Daily source review", exact: true }).waitFor()
    assert.equal(posts.length, 1, "refresh never resends")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const mode of ["manual", "partial-pause", "partial-stop"] as const) test(`real ${mode} routes preserve unknown identity without automatic resend`, async () => {
  const page = await browser.newPage({ locale: "en-US" }), posts: any[] = [], statusReads: any[] = [], errors: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", error => errors.push(error.message))
  const schedule = scheduleFixture()
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: snapshotFixture(schedule) })
    if (path.endsWith("/current")) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: schedule.id, passageID: null } })
    if (path.endsWith("/run-now")) {
      assert.deepEqual(Object.keys(request.postDataJSON()).sort(), ["directory", "expectedRevision", "requestID"])
      const { directory: _directory, ...body } = request.postDataJSON()
      posts.push(recurrenceManualRequestSchema.parse({ ...body, scheduleID: schedule.id }))
      return route.abort()
    }
    if (path.endsWith("/run-now/status")) {
      assert.equal(request.method(), "GET")
      assert.deepEqual([...url.searchParams.keys()].sort(), ["directory", "expectedRevision", "requestID"])
      const input = recurrenceManualRequestSchema.parse({ scheduleID: schedule.id, requestID: url.searchParams.get("requestID"), expectedRevision: Number(url.searchParams.get("expectedRevision")) })
      statusReads.push(input)
      return route.fulfill({ json: recurrenceManualResultSchema.parse({ version: 1, ...input, projectID: "project", projectCanonical: "/fixture",
        location: { directory: "/fixture" }, outcome: "accepted", passageID: "pas_manual", messageID: "msg_manual", admission: null }) })
    }
    if (path.endsWith("/control")) {
      const input = recurrenceControlHttpSchema.parse(request.postDataJSON()); posts.push(input)
      const { directory: _directory, retry: _retry, ...identity } = input
      const status = recurrenceControlStatusSchema.parse({ version: 1, ...identity, revision: input.expectedRevision + 1,
        state: input.action === "pause" ? "paused" : "stopped", outcome: input.retry ? "committed" : "unknown", controlsComplete: Boolean(input.retry),
        targets: [{ sessionID: "ses_running", outcome: input.retry ? "acknowledged" : "unknown" }], schedulerCancellation: "acknowledged" })
      schedule.revision = status.revision!; schedule.state = status.state!; schedule.nextDueAt = null; schedule.controls = [status]
      const { outcome: _outcome, ...record } = status
      return route.fulfill({ json: { ...record, targetsKnown: true } })
    }
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await page.getByRole("button", { name: schedule.title, exact: true }).click()
    const entry = scheduleEntry(page)
    if (mode === "manual") {
      await clickMissionAction(entry, "Run now")
      await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).waitFor()
      assert.equal(await entry.getByRole("button", { name: "More actions", exact: true }).count(), 0, "a held run-now offers no other action")
      await page.evaluate(() => window.missionEditorLifetime.mount(false))
      await page.evaluate(() => window.missionEditorLifetime.mount(true))
      assert.equal(posts.length, 1)
      await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).click()
      await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).waitFor({ state: "hidden" })
      assert.deepEqual(statusReads, posts, "status reads preserve the entire original tuple")
    } else {
      const action = mode === "partial-pause" ? "pause" : "stop"
      if (action === "pause") await page.getByRole("button", { name: "Pause schedule Daily source review", exact: true }).click()
      else {
        await clickMissionAction(entry, "Stop…")
        await page.getByRole("dialog").getByRole("button", { name: "Stop", exact: true }).click()
      }
      const check = page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true })
      await check.waitFor()
      assert.deepEqual(await menuItems(page, entry), [["Retry last action", "Retry remaining controls for Daily source review"]])
      assert.equal(posts.length, 1)
      await page.evaluate(() => window.missionEditorLifetime.mount(false))
      await page.evaluate(() => window.missionEditorLifetime.mount(true))
      await check.waitFor()
      assert.equal(posts.length, 1, "remounting never resends")
      await clickMissionAction(entry, "Retry last action")
      // The open menu hides the page from the accessibility tree; wait for it to close first.
      await page.getByRole("menu").waitFor({ state: "hidden" })
      await check.waitFor({ state: "hidden" })
      assert.equal(posts.length, 2)
      assert.deepEqual(posts[1], { ...posts[0], retry: true })
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
