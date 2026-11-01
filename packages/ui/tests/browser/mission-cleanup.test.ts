import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { chromium, type Browser, type Page } from "playwright"
import { cleanupBackend } from "./fixtures/mission-cleanup-backend"
import { clickListItemAction, clickMissionAction, inlineMissionEntry, toggleMissionOverview } from "./mission-actions"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-cleanup",
      routes: [
        { path: "/cleanup-fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-control.tsx\"></script></body></html>" },
      ],
    })
  try {
    url = fixture.url; events = await fixtureEventStream(url)
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
  } catch (error) { throw error }
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

async function setup(f: ReturnType<typeof cleanupBackend>, target?: string, loseAcknowledgement = false, afterLostCommit?: () => Promise<unknown>) {
  const page = await browser.newPage({ locale: "en-US" })
  await page.addInitScript(`Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: 'electron', __CODENOMAD_WINDOW_CONTEXT__: 'local', electronAPI: {
    claimClientStateAccess: async () => true, loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }), saveClientState: async () => true } })`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await events.route(page)
  const requests: Array<{ input: any; status: number }> = []
  await page.route("**/api/workspaces/fixture/missions**", async route => {
    const request = route.request()
    // The panel's list as a full snapshot; one mission's reconciliation read through the real route.
    if (request.method() === "GET" && new URL(request.url()).pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, ...await f.control.snapshot() } })
    if (request.method() === "GET") return route.fulfill({ json: (await f.app.inject({ method: "GET", url: new URL(request.url()).pathname })).json() })
    const input = request.postDataJSON()
    const response = await f.app.inject({ method: "DELETE", url: new URL(request.url()).pathname, payload: input })
    requests.push({ input, status: response.statusCode })
    if (loseAcknowledgement) { loseAcknowledgement = false; await afterLostCommit?.(); return route.abort("connectionreset") }
    return route.fulfill({ status: response.statusCode, json: response.json() })
  })
  await page.goto(url)
  if (target) {
    await clickMissionAction(page, "Delete selected mission…", target)
    await page.getByRole("checkbox", { name: "Also delete specialist conversations created for this mission" }).check()
  }
  return { page, requests }
}
const submit = (page: Page) => page.locator("form.mission-editor").getByRole("button", { name: /^(Delete mission|Try again)$/ }).click()
const fixture = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) => (window as any).missionFixture[method](arg), { method, arg })

test("a passive list refresh during exact cleanup preflight keeps the original explicit retry alive", async () => {
  const f = cleanupBackend(true), mission = await f.create("refresh-during-cleanup", 0)
  const original = { requestId: "delete_original", expectedRevision: mission.revision, deleteManagedSessions: false }
  f.state.failCompaction = true
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/workspaces/fixture/missions/${mission.id}`, payload: original })).statusCode, 503)
  const { page, requests } = await setup(f)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  try {
    const cleanup = page.locator(".mission-control .mission-cleanup")
    await cleanup.getByText("Deletion is still being confirmed. Retry to finish cleaning up the mission.", { exact: true }).waitFor()
    f.state.failCompaction = false
    await page.route(`**/api/workspaces/fixture/missions/${mission.id}`, async route => {
      if (route.request().method() === "GET") await hold
      return route.fallback()
    })
    const reading = page.waitForRequest(request => request.method() === "GET"
      && new URL(request.url()).pathname.endsWith(`/${mission.id}`), { timeout: 15000 })
    await clickListItemAction(cleanup.locator(".mission-list-item"), "Try again")
    await reading
    await page.evaluate(async () => (await import("/src/stores/missions.ts" as string)).missionStore.refresh("fixture"))
    release()
    await cleanup.waitFor({ state: "detached", timeout: 15000 })
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0], { input: original, status: 200 })
    assert.equal((await f.control.snapshot()).cleanups![0].documentPending, false)
  } catch (error) {
    console.error("cleanup refresh diagnostic", JSON.stringify({ requests, state: await page.evaluate(() => (window as any).missionFixture.snapshot()),
      cleanups: (await f.control.snapshot()).cleanups }))
    throw error
  } finally { release(); await page.close(); await f.app.close() }
})
// Settled cleanup history is folded at the bottom of a remaining Mission's
// central overview reader; only pending retries stay in the panel.
async function openCleanupHistory(page: Page) {
  if (!await page.locator(".mission-reader").count())
    await toggleMissionOverview(page, "Private cleanup keeper")
  const history = page.locator(".mission-reader").getByRole("button", { name: "Conversation cleanup history", exact: true })
  if (await history.getAttribute("aria-expanded") !== "true") await history.click()
  assert.equal(await history.getAttribute("aria-expanded"), "true")
  assert.equal(await page.locator(".mission-cleanup .mission-disclosure-trigger").count(), 1, "no nested cleanup disclosure")
}

test("journal deletion without document compaction keeps the editor and exact retry, including after remount", async () => {
  const f = cleanupBackend(true), mission = await f.create("compaction", 0)
  f.state.failCompaction = true
  const { page, requests } = await setup(f, "Private cleanup compaction")
  try {
    const form = page.locator("form.mission-editor")
    await submit(page)
    await form.getByRole("alert").getByText("Deletion is still being confirmed. Retry to finish cleaning up the mission.", { exact: true }).waitFor()
    assert.equal(await form.getByRole("button", { name: "Try again", exact: true }).isEnabled(), true)
    assert.equal(await form.getByRole("checkbox").isDisabled(), true)
    assert.equal(requests.length, 1, "passive reads never resend deletion")
    assert.equal(requests[0].status, 503)
    const snapshot = await f.control.snapshot()
    assert.equal(snapshot.missions.length, 0, "the journal deletion committed")
    assert.equal(snapshot.cleanups![0].pending, 0, "no native conversations remain to clean")
    assert.equal(snapshot.cleanups![0].documentPending, true, "document compaction is separately pending")
    assert.ok(!("deletedAt" in (await f.documents.read(mission.id))!))
    assert.ok(f.native.has(mission.coordinatorSessionId), "conversation preserved by default policy")

    await form.getByRole("button", { name: "Try again", exact: true }).click()
    await form.getByRole("alert").waitFor()
    assert.equal(requests.length, 2, "an explicit editor retry sends the original request")
    assert.deepEqual(requests[1].input, requests[0].input)
    await form.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.reload()
    const cleanup = page.locator(".mission-control .mission-cleanup")
    await cleanup.getByText("Deletion is still being confirmed. Retry to finish cleaning up the mission.", { exact: true }).waitFor()
    assert.equal(await cleanup.locator('.mission-list-item[data-status="needs-input"]').count(), 1)
    assert.equal(requests.length, 2)
    f.state.failCompaction = false
    await clickListItemAction(cleanup.locator(".mission-list-item"), "Try again")
    await cleanup.waitFor({ state: "detached" })
    assert.equal(requests.length, 3)
    assert.deepEqual(requests.map(item => item.status), [503, 503, 200])
    assert.deepEqual(requests[2].input, requests[0].input)
    assert.ok("deletedAt" in (await f.documents.read(mission.id))!)
    assert.equal(Boolean((await f.control.snapshot()).cleanups![0].documentPending), false)
    assert.ok(f.native.has(mission.coordinatorSessionId))
  } finally { await page.close(); await f.app.close() }
})

test("committed partial cleanup survives cancel, remount and reconnect with the exact original request", async () => {
  const f = cleanupBackend(), mission = await f.create("remount", 2), actors = mission.actors.filter(actor => actor.kind === "specialist")
  f.failing.add(actors[0].sessionId)
  await f.create("keeper")
  const { page, requests } = await setup(f, "Private cleanup remount")
  try {
    await fixture(page, "seedCoordinators", [mission.coordinatorSessionId, ...actors.map(actor => actor.sessionId)])
    await submit(page)
    await page.getByRole("alert").getByText("Deletion could not be completed. Retry to finish the remaining cleanup.").waitFor()
    assert.deepEqual(f.removed, [actors[1].sessionId])
    await fixture(page, "event", { type: "session.deleted", data: { sessionID: actors[1].sessionId } })
    const resident = await page.evaluate(async () => [...(await import("/src/stores/session-state.ts" as string)).sessions().get("fixture").keys()])
    assert.ok(!resident.includes(actors[1].sessionId)); assert.ok(resident.includes(mission.coordinatorSessionId))
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(async () => (await import("/src/lib/server-events.ts" as string)).serverEvents.dispatchBatch([
      { type: "instance.eventStatus", instanceId: "fixture", status: "connected" },
    ]))
    await fixture(page, "mount", false); await fixture(page, "mount", true)
    await page.locator(".mission-cleanup").getByText("1 removed · 0 kept · 1 pending", { exact: true }).waitFor()
    await page.reload() // new component/native-window attachment, authoritative snapshot only
    await page.locator(".mission-cleanup").getByText("1 removed · 0 kept · 1 pending", { exact: true }).waitFor()
    assert.deepEqual((await f.control.snapshot()).missions.map(item => item.objective), ["Private cleanup keeper"])
    f.failing.clear()
    await clickListItemAction(page.locator(".mission-control .mission-cleanup .mission-list-item"), "Try again")
    // Settled, the receipt leaves the panel for the overview reader's history.
    await page.locator(".mission-control .mission-cleanup").waitFor({ state: "detached" })
    await openCleanupHistory(page)
    await page.locator(".mission-cleanup").getByText("2 removed · 0 kept · 0 pending", { exact: true }).waitFor()
    assert.equal(requests.length, 2); assert.deepEqual(requests[0].input, requests[1].input)
    assert.deepEqual(requests.map(item => item.status), [503, 200])
    assert.equal(f.removed.length, 2); assert.ok(f.native.has(mission.coordinatorSessionId))
    assert.equal((await f.journal.events()).events.filter(event => event.type === "mission.deleted").length, 1)
  } finally { await page.close(); await f.app.close() }
})

test("a lost successful HTTP acknowledgement settles by reading receipts without a second deletion", async () => {
  const f = cleanupBackend(), mission = await f.create("lost-ack")
  const { page, requests } = await setup(f, "Private cleanup lost-ack", true)
  try {
    await submit(page); await page.locator("form.mission-editor").waitFor({ state: "detached" })
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.equal(requests.length, 1); assert.equal(f.removed.length, 1)
    await page.reload()
    assert.equal(requests.length, 1); assert.ok(f.native.has(mission.coordinatorSessionId))
    assert.equal((await f.control.snapshot()).cleanups?.[0].pending, 0)
  } finally { await page.close(); await f.app.close() }
})

test("a lost acknowledgement whose cleanup history was purged settles by an explicit exact replay", async () => {
  const f = cleanupBackend(), mission = await f.create("purged-ack")
  // Capacity pressure purges the settled deletion before the editor reconciles.
  const { page, requests } = await setup(f, "Private cleanup purged-ack", true, () => f.journal.purgeDeleted({ all: true }))
  try {
    const form = page.locator("form.mission-editor")
    await submit(page); await form.getByRole("alert").waitFor()
    assert.equal(requests.length, 1, "the passive reconciliation read never replays the deletion")
    assert.deepEqual((await f.control.snapshot()).cleanups, []); assert.deepEqual((await f.control.snapshot()).missions, [])
    await submit(page); await form.waitFor({ state: "detached" })
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.equal(requests.length, 2, "exactly one explicit replay")
    assert.deepEqual(requests[1].input, requests[0].input, "the immutable original request")
    assert.deepEqual(requests.map(item => item.status), [200, 200])
    assert.equal(f.removed.length, 1, "the record answers the replay without a second native removal")
    assert.ok(f.native.has(mission.coordinatorSessionId))
  } finally { await page.close(); await f.app.close() }
})

test("child-bearing specialists remain intact and expose the durable retention reason", async () => {
  const f = cleanupBackend(), mission = await f.create("children"), actor = mission.actors.find(actor => actor.kind === "specialist")!
  f.children.add(actor.sessionId)
  await f.create("keeper")
  const { page, requests } = await setup(f, "Private cleanup children")
  try {
    await submit(page); await page.locator("form.mission-editor").waitFor({ state: "detached" })
    await (await inlineMissionEntry(page, "Private cleanup children")).waitFor({ state: "detached" })
    assert.equal(await page.locator(".mission-control .mission-cleanup").count(), 0, "settled cleanup history stays out of the panel")
    await openCleanupHistory(page)
    await page.getByText("0 removed · 1 kept · 0 pending", { exact: true }).waitFor()
    await page.getByText("Kept because the conversation has child conversations.", { exact: true }).waitFor()
    assert.equal(requests[0].status, 200); assert.deepEqual(f.removed, []); assert.ok(f.native.has(actor.sessionId))
    assert.ok(!f.wire.some(item => item.startsWith("DELETE ")))
    assert.deepEqual((await f.control.snapshot()).cleanups?.[0].reasons, ["children"])
  } finally { await page.close(); await f.app.close() }
})

test("pre-tombstone 403 and 409 errors do not claim deleted or remaining cleanup", async () => {
  for (const status of [403, 409]) {
    const f = cleanupBackend(), mission = await f.create(`denied-${status}`)
    const { page, requests } = await setup(f, `Private cleanup denied-${status}`)
    try {
      if (status === 403) f.state.owned = false
      else await f.control.update({ missionID: mission.id, expectedRevision: mission.revision, requestID: "external-update", objective: "Changed externally" })
      await submit(page); await page.getByRole("alert").waitFor()
      assert.equal(requests[0].status, status)
      assert.ok(!(await page.getByRole("alert").innerText()).includes("remaining cleanup"))
      assert.deepEqual((await f.control.snapshot()).cleanups, []); assert.deepEqual(f.removed, [])
      assert.equal(await page.getByRole("checkbox").isDisabled(), false)
    } finally { await page.close(); await f.app.close() }
  }
})
