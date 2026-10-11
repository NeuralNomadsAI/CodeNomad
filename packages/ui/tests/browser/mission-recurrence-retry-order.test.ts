import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-editor-lifetime"
import { clickMissionAction, missionDetail, missionRefresh, missionToolbarAction, selectMission } from "./mission-actions"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { recurrenceSnapshotSchema, recurrenceControlHttpSchema, recurrenceControlStatusSchema } from "../../../server/src/missions/recurrence-control-contract"

// Explicit refresh-then-resend order and late-refusal freshness for held schedule controls.
let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-recurrence-retry-order", configureServer(s) { s.middlewares.use("/recurrence", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/recurrence", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script><script type="module" src="/tests/browser/fixtures/mission-recurrence-alerts.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/recurrence`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const TITLE = "Daily source review", OTHER = "Weekly digest"
const CHECK = (title = TITLE) => `Check control outcome for ${title}`
const STOP = `Stop schedule ${TITLE}`
const UNCONFIRMED = "Control outcome unconfirmed; check status before another action."
const NOT_SENT = "This action was not sent, so nothing was applied. Review the schedule's current state, then try again if needed."
const RESEND = "Refresh and resend the unconfirmed action"
const notDispatched = { status: 409, json: { error: "Recurrence request refused before dispatch; nothing was sent", code: "recurrence-not-dispatched" } }

function schedule(id = "rec_fixture", title = TITLE): RecurrenceSchedule {
  return { id, title, revision: 2, state: "running", clock: { time: "08:15", zone: "UTC" }, nextDueAt: Date.UTC(2026, 9, 9, 8, 15),
    pending: null, latestResult: null, history: [], controls: [], actions: ["pause", "stop", "run-now"] }
}
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function until(condition: () => boolean, message: string) {
  for (let attempt = 0; !condition() && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(condition(), message)
}

/** One page whose schedules answer a first Pause/Stop partially, with gates on row and status reads. */
async function openPage(schedules: RecurrenceSchedule[]) {
  const page = await browser.newPage({ locale: "en-US" })
  page.setDefaultTimeout(10_000)
  const state = { errors: [] as string[], log: [] as string[], posts: [] as any[], statusReads: [] as any[], rows: 0,
    rowGate: undefined as Promise<void> | undefined, statusGate: undefined as Promise<void> | undefined,
    statusReply: "record" as "record" | "fail", controlReply: new Map<string, (route: Route, input: any) => Promise<void> | void>() }
  page.on("pageerror", error => state.errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/recurrence")) {
      state.rows++; const gate = state.rowGate
      if (gate) await gate
      return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture",
        location: { directory: "/fixture" }, schedules }) })
    }
    if (path.endsWith("/current")) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: schedules[0]!.id, passageID: null } })
    if (path.endsWith("/control/status")) {
      state.log.push("status"); state.statusReads.push(request.postDataJSON())
      const gate = state.statusGate
      if (gate) await gate
      if (state.statusReply === "fail") return route.fulfill({ status: 500, json: {} })
      const target = schedules.find(item => path.includes(`/${item.id}/`))!
      const { outcome: _outcome, ...record } = target.controls[0]!
      return route.fulfill({ json: { ...record, targetsKnown: true } })
    }
    if (path.endsWith("/control")) {
      const input = recurrenceControlHttpSchema.parse(request.postDataJSON())
      state.log.push(input.retry ? "retry" : "post"); state.posts.push(input)
      const target = schedules.find(item => path.includes(`/${item.id}/`))!
      const custom = state.controlReply.get(target.id)
      if (custom) return custom(route, input)
      // The first attempt applies partially; its exact retry completes.
      const { directory: _directory, retry: _retry, ...identity } = input
      const status = recurrenceControlStatusSchema.parse({ version: 1, ...identity, revision: input.expectedRevision + 1,
        state: input.action === "pause" ? "paused" : "stopped", outcome: input.retry ? "committed" : "unknown", controlsComplete: Boolean(input.retry),
        targets: [{ sessionID: "ses_running", outcome: input.retry ? "acknowledged" : "unknown" }], schedulerCancellation: "acknowledged" })
      target.revision = status.revision!; target.state = status.state!; target.nextDueAt = null; target.controls = [status]
      target.actions = input.action === "pause" ? ["play", "stop", "run-now"] : []
      const { outcome: _outcome, ...record } = status
      return route.fulfill({ json: { ...record, targetsKnown: true } })
    }
    return route.fulfill({ json: {} })
  })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
  return { page, state }
}
async function holdPartial(page: Page, action: "pause" | "stop", title = TITLE) {
  await selectMission(page, title)
  if (action === "pause") await clickMissionAction(page, `Pause schedule ${title}`)
  else {
    await clickMissionAction(page, `Stop schedule ${title}`)
    await page.getByRole("dialog").getByRole("button", { name: "Stop", exact: true }).click()
  }
  await missionToolbarAction(page, CHECK(title)).waitFor()
  await missionDetail(page).locator(".mission-action-feedback [role=status]").getByText(UNCONFIRMED, { exact: true }).waitFor()
  assert.equal(await missionRefresh(page).getAttribute("aria-label"), RESEND)
}
/** Starts an event-driven row read that stays in flight until released. */
async function rowReadInFlight(page: Page, state: Awaited<ReturnType<typeof openPage>>["state"]) {
  const gate = deferred(), before = state.rows
  state.rowGate = gate.promise
  await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
  await until(() => state.rows > before, "the event-driven row read is in flight")
  return () => { state.rowGate = undefined; gate.release() }
}

for (const action of ["pause", "stop"] as const) test(`refresh during an in-flight row read reads the held partial ${action} status before resending it unchanged`, async () => {
  const { page, state } = await openPage([schedule()])
  try {
    await holdPartial(page, action)
    const release = await rowReadInFlight(page, state)
    state.log.length = 0
    await missionRefresh(page).click()
    await until(() => state.log.includes("retry"), "the explicit refresh resends after its read")
    assert.deepEqual(state.log, ["status", "retry"], "the actual status read completes before the retry")
    // The schedule is named by the status path; the body carries the rest of the tuple.
    const { scheduleID: _scheduleID, ...original } = state.posts[0]
    assert.deepEqual(state.statusReads.at(-1), original, "the read names the exact original tuple")
    assert.deepEqual(state.posts[1], { ...state.posts[0], retry: true }, "the original wire tuple is unchanged")
    release()
    await missionToolbarAction(page, CHECK()).waitFor({ state: "hidden" })
    assert.deepEqual(state.errors, [])
  } catch (error) { console.error(state.errors, state.log, state.posts, await page.locator("body").innerText()); throw error } finally { await page.close() }
})

test("failed, superseded or ABA status reads never resend; events and remounts never autosend", async () => {
  const { page, state } = await openPage([schedule()])
  try {
    await holdPartial(page, "pause")
    // A failed read leaves the request held and unsent.
    state.statusReply = "fail"
    const release = await rowReadInFlight(page, state)
    await missionRefresh(page).click()
    await until(() => state.log.includes("status"), "the refresh reads status")
    await page.waitForTimeout(300)
    release()
    assert.equal(state.posts.length, 1, "a failed status read is not followed by a retry")
    // An inactive/active ABA while the read is in flight supersedes it.
    state.statusReply = "record"
    const statusGate = deferred(); state.statusGate = statusGate.promise
    const reads = state.statusReads.length
    await missionRefresh(page).click()
    await until(() => state.statusReads.length > reads, "the second refresh reads status")
    await page.evaluate(() => window.missionEditorLifetime.activate(false))
    await page.evaluate(() => window.missionEditorLifetime.activate(true))
    state.statusGate = undefined; statusGate.release()
    await missionToolbarAction(page, CHECK()).waitFor()
    await page.waitForTimeout(300)
    assert.equal(state.posts.length, 1, "a read from a superseded context never resends")
    // A reconnect-like instance ABA during the read is equally stale.
    const instanceGate = deferred(); state.statusGate = instanceGate.promise
    const instanceReads = state.statusReads.length
    await missionRefresh(page).click()
    await until(() => state.statusReads.length > instanceReads, "the third refresh reads status")
    await page.evaluate(() => window.missionEditorLifetime.instance("other"))
    await page.evaluate(() => window.missionEditorLifetime.instance("fixture"))
    state.statusGate = undefined; instanceGate.release()
    await page.waitForTimeout(300)
    assert.equal(state.posts.length, 1, "an instance ABA never resends")
    // Events and remounts never resend on their own.
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    await selectMission(page, TITLE)
    await missionToolbarAction(page, CHECK()).waitFor()
    await page.waitForTimeout(300)
    assert.equal(state.posts.length, 1, "no autosend on events or remount")
    assert.ok(!state.log.includes("retry"))
    // The explicit Check status button stays a read without a write.
    const checks = state.statusReads.length
    await missionToolbarAction(page, CHECK()).click()
    await until(() => state.statusReads.length > checks, "Check status reads")
    await page.waitForTimeout(300)
    assert.equal(state.posts.length, 1, "Check status never writes")
    assert.deepEqual(state.errors, [])
  } catch (error) { console.error(state.errors, state.log, state.posts, await page.locator("body").innerText()); throw error } finally { await page.close() }
})

for (const transition of ["inactive", "instance"] as const) test(`a late refusal after an ${transition} ABA releases its request without stale message or read`, async () => {
  const { page, state } = await openPage([schedule()])
  const reply = deferred()
  state.controlReply.set("rec_fixture", async route => { await reply.promise; await route.fulfill(notDispatched) })
  try {
    await selectMission(page, TITLE)
    await clickMissionAction(page, `Pause schedule ${TITLE}`)
    await until(() => state.posts.length === 1, "the pause was sent")
    if (transition === "inactive") {
      await page.evaluate(() => window.missionEditorLifetime.activate(false))
      await page.evaluate(() => window.missionEditorLifetime.activate(true))
    } else {
      await page.evaluate(() => window.missionEditorLifetime.instance("other"))
      await page.evaluate(() => window.missionEditorLifetime.instance("fixture"))
    }
    await missionToolbarAction(page, CHECK()).waitFor()
    await page.waitForTimeout(300)
    const rows = state.rows
    reply.release()
    // The exact request is released, so its held state goes away...
    await missionToolbarAction(page, CHECK()).waitFor({ state: "hidden" })
    await page.waitForTimeout(300)
    // ...but the newer context shows no stale message and starts no read.
    assert.equal(await page.getByText(NOT_SENT, { exact: true }).count(), 0, "no stale refusal message")
    assert.equal(state.rows, rows, "no refresh from a late refusal")
    assert.equal(state.posts.length, 1)
    // A current request still explains its own refusal.
    const current = deferred(); current.release()
    state.controlReply.set("rec_fixture", async route => { await current.promise; await route.fulfill(notDispatched) })
    await clickMissionAction(page, `Pause schedule ${TITLE}`)
    await missionDetail(page).locator(".mission-action-feedback [role=status]").getByText(NOT_SENT, { exact: true }).waitFor()
    assert.equal(state.posts.length, 2)
    assert.deepEqual(state.errors, [])
  } catch (error) { console.error(state.errors, state.log, state.posts, await page.locator("body").innerText()); throw error } finally { await page.close() }
})

test("a late refusal for another row leaves the selected row's held request and message unchanged", async () => {
  const other = schedule("rec_other", OTHER)
  const { page, state } = await openPage([schedule(), other])
  const reply = deferred()
  try {
    await holdPartial(page, "pause", OTHER)
    state.controlReply.set("rec_fixture", async route => { await reply.promise; await route.fulfill(notDispatched) })
    await selectMission(page, TITLE)
    await clickMissionAction(page, `Pause schedule ${TITLE}`)
    await until(() => state.posts.length === 2, "the first row's pause was sent")
    await selectMission(page, OTHER)
    await missionToolbarAction(page, CHECK(OTHER)).waitFor()
    await page.waitForTimeout(300)
    const rows = state.rows
    reply.release()
    await page.waitForTimeout(500)
    assert.equal(await missionToolbarAction(page, CHECK(OTHER)).count(), 1, "the selected row stays held")
    await missionDetail(page).locator(".mission-action-feedback [role=status]").getByText(UNCONFIRMED, { exact: true }).waitFor()
    assert.equal(await page.getByText(NOT_SENT, { exact: true }).count(), 0, "no stale refusal message")
    assert.equal(state.rows, rows, "no refresh from the other row's late refusal")
    assert.equal(await missionRefresh(page).getAttribute("aria-label"), RESEND)
    // The released row comes back without a held request or stale message.
    await selectMission(page, TITLE)
    await missionToolbarAction(page, `Pause schedule ${TITLE}`).waitFor()
    assert.equal(await missionToolbarAction(page, CHECK()).count(), 0)
    assert.equal(await page.getByText(NOT_SENT, { exact: true }).count(), 0)
    assert.equal(state.posts.length, 2, "nothing resent")
    assert.deepEqual(state.errors, [])
  } catch (error) { console.error(state.errors, state.log, state.posts, await page.locator("body").innerText()); throw error } finally { await page.close() }
})
