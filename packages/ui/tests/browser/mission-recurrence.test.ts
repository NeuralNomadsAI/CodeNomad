import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
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
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { recurrenceSnapshotSchema, recurrenceControlHttpSchema, recurrenceControlRequestSchema, recurrenceControlStatusSchema } from "../../../server/src/missions/recurrence-control-contract"
import { recurrenceManualRequestSchema, recurrenceManualResultSchema } from "../../../server/src/missions/recurrence-manual-rpc"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-recurrence", configureServer(s) { s.middlewares.use("/recurrence", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/recurrence", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script></body></html>'))
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
    await page.getByRole("button", { name: "Daily source review", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "One-time review", exact: true }).count(), 1)
    await page.getByText("Next passage:", { exact: false }).waitFor()
    await captureMissionView(page, "schedule-header-next-passage")
    for (const state of ["paused", "stopped"] as const) {
      schedule.state = state
      schedule.nextDueAt = null
      await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
      await page.locator(".mission-control-index").getByText(state === "paused" ? "Paused" : "Stopped", { exact: true }).waitFor()
      assert.equal(await page.getByText("Next passage:", { exact: false }).count(), 0)
    }
    const runNow = page.getByRole("button", { name: "Run Daily source review now", exact: true })
    assert.equal(await runNow.locator(".mission-schedule-action-label").isVisible(), true)
    await page.getByRole("button", { name: "Stop schedule Daily source review", exact: true }).hover()
    await page.getByRole("tooltip").getByText("Stop schedule Daily source review", { exact: true }).waitFor()
    await page.mouse.move(1100, 900)
    await page.getByRole("tooltip").waitFor({ state: "hidden" })
    schedule.state = "interrupted"; schedule.interruptionReason = "service-restart"; schedule.pending!.status = "uncertain"
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
    await page.getByText(/OpenCode restarted/).waitFor()
    assert.equal(await page.getByText("Next passage:", { exact: false }).count(), 0, "stale due dates stay hidden outside running state")
    assert.equal(await page.getByText("Passage pending; outcome unconfirmed", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Resume schedule Daily source review", exact: true }).innerText(), "Resume")
    await captureMissionView(page, "interrupted-resume")
    schedule.interruptionReason = undefined
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
    await page.getByText("Resume checks the running passage; it never sends it twice.").waitFor()
    await captureMissionView(page, "uncertain-passage")
    await page.getByRole("button", { name: "Stop schedule Daily source review", exact: true }).click()
    assert.equal(posts.length, 0, "Stop first asks for confirmation")
    await captureMissionView(page, "stop-confirmation")
    await page.getByRole("group", { name: "Stop Daily source review?" }).getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Resume schedule Daily source review", exact: true }).click()
    await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).waitFor()
    assert.equal(posts.length, 1)
    assert.deepEqual(Object.keys(posts[0].body).sort(), ["action", "directory", "expectedRevision", "requestID", "scheduleID"])
    await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).click()
    await page.getByRole("button", { name: "Resume schedule Daily source review", exact: true }).waitFor({ state: "visible" })
    await page.getByRole("button", { name: /Passage history/ }).click()
    await captureMissionView(page, "schedule-history")
    await page.setViewportSize({ width: 390, height: 850 })
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await captureMissionView(page, "unified-list-390-rtl")
    assert.equal(posts.length, 1, "refresh and status never resend")
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
    assert.equal(await check.evaluate(element => element.classList.contains("button-primary")), true)
    await captureMissionView(page, "paused-check-passage")
    await check.click()
    await check.waitFor({ state: "hidden" })
    assert.equal(posts.length, 1)
    assert.equal(posts[0].action, "check")
    assert.equal(await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).count(), 0)
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
    if (mode === "manual") {
      await page.getByRole("button", { name: "Run Daily source review now", exact: true }).click()
      await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).waitFor()
      await page.evaluate(() => window.missionEditorLifetime.mount(false))
      await page.evaluate(() => window.missionEditorLifetime.mount(true))
      assert.equal(posts.length, 1)
      await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).click()
      await page.getByRole("button", { name: "Check control outcome for Daily source review", exact: true }).waitFor({ state: "hidden" })
      assert.deepEqual(statusReads, posts, "status reads preserve the entire original tuple")
    } else {
      const action = mode === "partial-pause" ? "pause" : "stop"
      await page.getByRole("button", { name: action === "pause" ? "Pause schedule Daily source review" : "Stop schedule Daily source review", exact: true }).click()
      if (action === "stop") await page.getByRole("group", { name: "Stop Daily source review?" }).getByRole("button", { name: "Stop", exact: true }).click()
      const retry = page.getByRole("button", { name: "Retry remaining controls for Daily source review", exact: true })
      await retry.waitFor()
      assert.equal(posts.length, 1)
      await page.evaluate(() => window.missionEditorLifetime.mount(false))
      await page.evaluate(() => window.missionEditorLifetime.mount(true))
      await retry.click()
      await retry.waitFor({ state: "hidden" })
      assert.equal(posts.length, 2)
      assert.deepEqual(posts[1], { ...posts[0], retry: true })
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
