import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
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
import { clickMissionAction, inlineMissionEntry, missionDetail, missionEntryStatus, missionPicker, missionRefresh, missionToolbarAction,
  selectMission, selectedMissionTitle } from "./mission-actions"
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
const TITLE = "Daily source review"
const CHECK = `Check control outcome for ${TITLE}`, RESUME = `Resume schedule ${TITLE}`, STOP = `Stop schedule ${TITLE}`, RUN_NOW = `Run ${TITLE} now`
/** The selected item's lifecycle buttons (before the separator): [label, enabled]. Inapplicable ones stay, disabled. */
async function lifecycleButtons(page: Page) {
  return missionDetail(page).locator(".mission-action-bar").evaluate(bar => {
    const result: Array<[string | null, boolean]> = []
    for (const node of bar.children) {
      if (node.classList.contains("mission-action-separator")) break
      if (node instanceof HTMLButtonElement) result.push([node.getAttribute("aria-label"), !node.disabled])
    }
    return result
  })
}
/** Wait until the inline entry's screen-reader status matches. */
async function waitForEntryStatus(page: Page, title: string, pattern: RegExp) {
  await (await inlineMissionEntry(page, title)).locator(".sr-only", { hasText: pattern }).waitFor({ state: "attached" })
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
  const page = await browser.newPage({ locale: "en-US", timezoneId: "UTC", viewport: { width: 1200, height: 950 } })
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
    // The open conversation is the one-time coordinator, so that Mission (only) is selected with its detail.
    await selectedMissionTitle(page).filter({ hasText: /^One-time review$/ }).waitFor()
    await (await inlineMissionEntry(page, "One-time review")).waitFor()
    await captureMissionView(page, "unified-list-desktop")
    const entry = await inlineMissionEntry(page, TITLE)
    // A running entry says Daily, its state, its next run and its rule.
    await waitForEntryStatus(page, TITLE, /Next: /)
    assert.match(await missionEntryStatus(page, TITLE), /^Daily · Running · Next: .+ · Every day at 8:15 AM$/)
    assert.equal(await missionDetail(page).getAttribute("aria-label"), "One-time review")
    await selectMission(page, TITLE)
    assert.equal(await (await inlineMissionEntry(page, "One-time review")).count(), 1)
    assert.equal(await entry.getAttribute("aria-current"), "true")
    const detail = missionDetail(page)
    await detail.waitFor()
    assert.equal(await missionPicker(page).locator("section.mission-detail").count(), 0, "the detail is a separate section, not inside the picker")
    assert.equal(await detail.getByText(/Next: /).count(), 0, "the entry alone says when the next run is")
    await captureMissionView(page, "schedule-detail-next-passage")
    for (const state of ["paused", "stopped"] as const) {
      schedule.state = state
      schedule.nextDueAt = null
      await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
      const word = state === "paused" ? "Paused" : "Stopped"
      await waitForEntryStatus(page, TITLE, new RegExp(`^Daily · ${word} · Every day at 8:15 AM$`))
      assert.equal(await page.getByText(/next: |Next: /).count(), 0)
    }
    // Lifecycle actions are toolbar icons with their descriptive names; Run now is always present.
    assert.deepEqual(await lifecycleButtons(page), [[RESUME, true], [STOP, true], [RUN_NOW, true]])
    assert.equal(await missionToolbarAction(page, RESUME).getAttribute("title"), RESUME)
    schedule.state = "interrupted"; schedule.interruptionReason = "service-restart"; schedule.pending!.status = "uncertain"
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
    await detail.locator(".mission-schedule-notice").getByText(/OpenCode restarted/).waitFor()
    assert.equal(await page.getByText(/next: |Next: /).count(), 0, "stale due dates stay hidden outside running state")
    assert.equal(await page.getByText("Passage pending; outcome unconfirmed", { exact: true }).count(), 0)
    assert.equal(await missionToolbarAction(page, RESUME).isEnabled(), true)
    await captureMissionView(page, "interrupted-resume")
    schedule.interruptionReason = undefined
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
    await page.getByText("Resume checks the running passage; it never sends it twice.").waitFor()
    await captureMissionView(page, "uncertain-passage")
    await clickMissionAction(page, STOP)
    const dialog = page.getByRole("dialog")
    await dialog.getByText("Stop Daily source review?", { exact: true }).waitFor()
    assert.equal(posts.length, 0, "Stop first asks for confirmation")
    await captureMissionView(page, "stop-confirmation")
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.equal(posts.length, 0, "cancelled confirmation sends nothing")
    await clickMissionAction(page, RESUME)
    const check = missionToolbarAction(page, CHECK)
    await check.waitFor()
    // The held request is the primary; every other control waits for its outcome.
    await check.click({ trial: true }) // enabled once the lost reply settles
    assert.deepEqual(await lifecycleButtons(page), [[CHECK, true], [STOP, false], [RUN_NOW, false]])
    await detail.locator(".mission-action-feedback [role=status]").getByText("Control outcome unconfirmed; check status before another action.").waitFor()
    assert.equal(posts.length, 1)
    assert.deepEqual(Object.keys(posts[0].body).sort(), ["action", "directory", "expectedRevision", "requestID", "scheduleID"])
    await check.click()
    await missionToolbarAction(page, RESUME).waitFor({ state: "visible" })
    // Without an admitted passage, the detail lists past runs directly; no result prose or More.
    assert.equal(await detail.locator(".mission-result-text, .mission-more").count(), 0)
    assert.equal(await detail.locator(".mission-overview-toggle").count(), 1)
    assert.match(await detail.locator("button.mission-past-run").innerText(), /^Oct 8, 2026, 8:15 AM · Completed/)
    await captureMissionView(page, "schedule-history")
    await page.setViewportSize({ width: 390, height: 850 })
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await captureMissionView(page, "unified-list-390-rtl")
    assert.equal(posts.length, 1, "refresh and status never resend")
    assert.deepEqual(errors, [])
  } catch (error) { console.error(errors, await page.locator("body").innerText()); throw error } finally { await page.close() }
})

test("rows say Next, stuck passages explain their one action, history is plain and one-time controls stay scoped", async () => {
  const page = await browser.newPage({ locale: "en-US", timezoneId: "UTC", viewport: { width: 1200, height: 950 } })
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
    await waitForEntryStatus(page, TITLE, /Next: /)
    assert.match(await missionEntryStatus(page, TITLE), /^Daily · Running · Next: /, "a running entry names its state, then its next run")
    // The open coordinator conversation selects its Mission, whose toolbar owns its primary control.
    await waitForEntryStatus(page, "One-time review", /^Prepared · /)
    const once = await inlineMissionEntry(page, "One-time review")
    const detail = missionDetail(page)
    await detail.waitFor()
    assert.equal(await once.getAttribute("aria-current"), "true")
    assert.equal(await missionToolbarAction(page, "Start mission").isEnabled(), true)
    const scoped = await page.locator(".mission-control").evaluate(panel => {
      const picker = panel.querySelector(".mission-picker")!, detail = panel.querySelector("section.mission-detail")!
      const entries = [...picker.querySelectorAll(".mission-picker-inline button.mission-picker-option")]
      return entries.length === 2 && !picker.contains(detail)
        && Boolean(picker.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    assert.equal(scoped, true, "the selected one-time detail follows the whole list")
    assert.equal(await detail.getByRole("button", { name: "Technical details", exact: true }).count(), 0, "identifiers live in readers")
    await captureMissionView(page, "one-time-scoped")
    await selectMission(page, schedule.title)
    await page.locator("section.mission-detail.mission-schedule-detail").waitFor()
    assert.equal(await missionToolbarAction(page, "Start mission").count(), 0, "one-time controls stay with their Mission")
    assert.equal(await detail.count(), 1, "one detail at a time")
    await detail.locator(".mission-schedule-notice").getByText("This passage has not started yet. It is retried automatically under the same identity.", { exact: true }).waitFor()
    await page.getByText(/^The last scheduled check failed at Oct 9, 2026/).waitFor()
    const items = detail.locator("button.mission-past-run")
    assert.match(await items.nth(0).innerText(), /^Oct 8, 2026, 8:15 AM · Not started$/)
    assert.match(await items.nth(1).innerText(), /^Oct 7, 2026, 9:00 AM · Completed · Run now$/)
    assert.equal(await detail.getByRole("button", { name: "Technical details", exact: true }).count(), 0)
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
    await selectMission(page, schedule.title)
    const check = missionToolbarAction(page, `Check the pending passage of ${TITLE}`)
    await check.waitFor()
    // Check passage is the primary; Stop stays available and Run now stays in place, disabled.
    assert.deepEqual(await lifecycleButtons(page), [[`Check the pending passage of ${TITLE}`, true], [STOP, true], [RUN_NOW, false]])
    await captureMissionView(page, "paused-check-passage")
    await check.click()
    await check.waitFor({ state: "hidden" })
    assert.equal(posts.length, 1)
    assert.equal(posts[0].action, "check")
    await missionToolbarAction(page, CHECK).waitFor({ state: "hidden" })
    await missionToolbarAction(page, RESUME).waitFor()
    assert.equal(posts.length, 1, "refresh never resends")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const mode of ["manual", "partial-pause", "partial-stop"] as const) test(`real ${mode} routes preserve unknown identity without automatic resend`, async () => {
  const page = await browser.newPage({ locale: "en-US" }), posts: any[] = [], statusReads: any[] = [], controlStatusReads: any[] = [], errors: string[] = []
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
    if (path.endsWith("/control/status")) {
      // Read-only: the stored record still reports the partial outcome.
      controlStatusReads.push(request.postDataJSON())
      const { outcome: _outcome, ...record } = schedule.controls[0]
      return route.fulfill({ json: { ...record, targetsKnown: true } })
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
    await selectMission(page, schedule.title)
    const check = missionToolbarAction(page, CHECK)
    if (mode === "manual") {
      await clickMissionAction(page, RUN_NOW)
      await check.waitFor()
      await check.click({ trial: true }) // enabled once the lost reply settles
      assert.deepEqual(await lifecycleButtons(page), [[CHECK, true], [STOP, false], [RUN_NOW, false]], "a held run-now offers no other action")
      await page.evaluate(() => window.missionEditorLifetime.mount(false))
      await page.evaluate(() => window.missionEditorLifetime.mount(true))
      await selectMission(page, schedule.title)
      await check.waitFor()
      assert.equal(posts.length, 1, "remounting never resends")
      await check.click()
      await check.waitFor({ state: "hidden" })
      assert.deepEqual(statusReads, posts, "status reads preserve the entire original tuple")
    } else {
      const action = mode === "partial-pause" ? "pause" : "stop"
      if (action === "pause") await clickMissionAction(page, `Pause schedule ${TITLE}`)
      else {
        await clickMissionAction(page, STOP)
        await page.getByRole("dialog").getByRole("button", { name: "Stop", exact: true }).click()
      }
      await check.waitFor()
      // The only resend is the panel's explicit refresh, which names it.
      assert.equal(await missionRefresh(page).getAttribute("aria-label"), "Refresh and resend the unconfirmed action")
      assert.equal(posts.length, 1)
      await page.evaluate(() => window.missionEditorLifetime.mount(false))
      await page.evaluate(() => window.missionEditorLifetime.mount(true))
      await selectMission(page, schedule.title)
      await check.waitFor()
      assert.equal(posts.length, 1, "remounting never resends")
      assert.equal(await missionRefresh(page).getAttribute("aria-label"), "Refresh and resend the unconfirmed action")
      await missionRefresh(page).click()
      await check.waitFor({ state: "hidden" })
      assert.equal(controlStatusReads.length, 1, "the refresh first reads the exact request's status")
      assert.equal(posts.length, 2)
      assert.deepEqual(posts[1], { ...posts[0], retry: true })
      assert.equal(await missionRefresh(page).getAttribute("aria-label"), "Refresh mission map")
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
