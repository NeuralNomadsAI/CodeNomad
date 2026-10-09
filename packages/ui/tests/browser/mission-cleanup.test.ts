import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { cleanupBackend } from "./fixtures/mission-cleanup-backend"
import { clickMissionAction, toggleMissionOverview } from "./mission-actions"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  const shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "mission-cleanup-fixture", configureServer(s) { s.middlewares.use("/cleanup-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/cleanup-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>'))
      }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/cleanup-fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

async function setup(f: ReturnType<typeof cleanupBackend>, loseAcknowledgement = false, target?: string) {
  const page = await browser.newPage({ locale: "en-US" })
  await page.addInitScript(`Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: 'electron', __CODENOMAD_WINDOW_CONTEXT__: 'local', electronAPI: {
    claimClientStateAccess: async () => true, loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }), saveClientState: async () => true } })`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  const requests: Array<{ input: any; status: number }> = []
  await page.route("**/api/workspaces/fixture/missions**", async route => {
    const request = route.request()
    if (request.method() === "GET") return route.fulfill({ json: { available: true, ...await f.control.snapshot() } })
    const input = request.postDataJSON()
    const response = await f.app.inject({ method: "DELETE", url: new URL(request.url()).pathname, payload: input })
    requests.push({ input, status: response.statusCode })
    if (loseAcknowledgement) { loseAcknowledgement = false; return route.abort("connectionreset") }
    return route.fulfill({ status: response.statusCode, json: response.json() })
  })
  await page.goto(url)
  const entries = page.locator(".mission-control-index .mission-index-entry")
  await clickMissionAction(target ? entries.filter({ hasText: target }) : entries.first(), "Delete…")
  await page.getByRole("checkbox", { name: "Also delete specialist conversations created for this mission" }).check()
  return { page, requests }
}
const submit = (page: Page) => page.locator("form.mission-editor").getByRole("button", { name: "Delete mission", exact: true }).click()
const fixture = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) => (window as any).missionFixture[method](arg), { method, arg })
// Settled cleanup history is folded at the bottom of a remaining Mission's
// central overview reader; only pending retries stay in the panel.
async function openCleanupHistory(page: Page) {
  if (!await page.locator(".mission-reader").count())
    await toggleMissionOverview(page.locator(".mission-control-index .mission-index-entry").filter({ hasText: "Private cleanup keeper" }))
  const history = page.locator(".mission-reader").getByRole("button", { name: "Conversation cleanup history", exact: true })
  if (await history.getAttribute("aria-expanded") !== "true") await history.click()
  assert.equal(await history.getAttribute("aria-expanded"), "true")
  assert.equal(await page.locator(".mission-cleanup .mission-disclosure-trigger").count(), 1, "no nested cleanup disclosure")
}

test("committed partial cleanup survives cancel, remount and reconnect with the exact original request", async () => {
  const f = cleanupBackend(), mission = await f.create("remount", 2), actors = mission.actors.filter(actor => actor.kind === "specialist")
  f.failing.add(actors[0].sessionId)
  await f.create("keeper")
  const { page, requests } = await setup(f, false, "Private cleanup remount")
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
    await clickMissionAction(page.locator(".mission-control .mission-cleanup .mission-list-item"), "Try again")
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
  const { page, requests } = await setup(f, true)
  try {
    await submit(page); await page.locator("form.mission-editor").waitFor({ state: "detached" })
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.equal(requests.length, 1); assert.equal(f.removed.length, 1)
    await page.reload()
    assert.equal(requests.length, 1); assert.ok(f.native.has(mission.coordinatorSessionId))
    assert.equal((await f.control.snapshot()).cleanups?.[0].pending, 0)
  } finally { await page.close(); await f.app.close() }
})

test("child-bearing specialists remain intact and expose the durable retention reason", async () => {
  const f = cleanupBackend(), mission = await f.create("children"), actor = mission.actors.find(actor => actor.kind === "specialist")!
  f.children.add(actor.sessionId)
  await f.create("keeper")
  const { page, requests } = await setup(f, false, "Private cleanup children")
  try {
    await submit(page); await page.locator("form.mission-editor").waitFor({ state: "detached" })
    await page.locator(".mission-control-index .mission-index-entry").filter({ hasText: "Private cleanup children" }).waitFor({ state: "detached" })
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
    const { page, requests } = await setup(f)
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
