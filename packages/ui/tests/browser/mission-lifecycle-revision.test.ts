import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { missionDetail, missionRefresh, missionToolbarAction, selectMission } from "./mission-actions"

let browser: Browser, server: ViteDevServer, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  let ready = false
  await runWithDiagnosticCleanup({
    run: async () => {
      server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
        logLevel: "error", plugins: [shutdown.plugin, solid(), { name: "lifecycle-revision-fixture", configureServer(s) {
          s.middlewares.use("/lifecycle-revision", async (_request, response) => {
            response.setHeader("Content-Type", "text/html")
            response.end(await s.transformIndexHtml("/lifecycle-revision", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-visibility.tsx"></script></body></html>'))
          })
        } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
        server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
      shutdown.own(server)
      await server.listen()
      url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/lifecycle-revision`
      browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
      ready = true
    }, diagnose: async () => {},
    cleanup: async () => { if (!ready) { if (server) await server.close(); else await cache.dispose() } },
    onObservationError: () => {}, onCleanupError: error => console.error("revision fixture startup cleanup", error),
  })
})
after(() => runWithDiagnosticCleanup({ run: async () => { await browser?.close() }, diagnose: async () => {},
  cleanup: async () => { await server?.close() }, onObservationError: () => {}, onCleanupError: error => console.error("revision fixture shutdown", error) }))

type Input = { action: "start" | "pause" | "stop"; expectedRevision: number; requestId: string }
function mission(id = "revision"): MissionMap {
  return { version: 1, id, projectID: "fixture", projectCanonical: "/fixture", objective: `Lifecycle ${id}`, template: "custom",
    coordinatorSessionId: "ses_fixture", status: "active", runState: "running", actors: [], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false, tasks: [], reports: [] }
}
const fixture = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) =>
  (window as any).missionVisibility[method](arg), { method, arg })
// Only the selected Mission has a lifecycle toolbar; inapplicable buttons stay disabled.
const pause = (page: Page) => missionToolbarAction(page, "Pause mission")
// Unresolved requests replace the contextual primary with a status check.
const check = (page: Page) => missionToolbarAction(page, "Check control status")
const stop = (page: Page) => missionToolbarAction(page, "Stop mission permanently")
// The explicit header refresh offers to resend only the selected Mission's unconfirmed exact request.
const RESEND = "Refresh and resend the unconfirmed action"
const retryOffered = async (page: Page) => await missionRefresh(page).getAttribute("aria-label") === RESEND
async function retry(page: Page) {
  assert.equal(await retryOffered(page), true)
  // The refresh reconciles read-only first; wait for the actual resend.
  const sent = page.waitForRequest(request => request.url().endsWith("/control"))
  await missionRefresh(page).click(); await sent
}
async function open(page: Page, title = /^Lifecycle /) {
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).missionVisibility))
  // Ordinary journeys start after the session list restored; the startup gate has its own regression.
  await fixture(page, "restoration", false)
  await fixture(page, "activate", true)
  await selectMission(page, title)
}
async function settled(page: Page) {
  await page.waitForFunction(() => (window as any).missionVisibility.state().status === "ready"
    && !document.querySelector('.mission-action-feedback [role="status"]'))
}

test("real RightPanel discards only certified rejected intent; two revision conflicts require explicit fresh Pause", async () => {
  const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let current: MissionMap = { ...mission("stable-lifecycle"), objective: "Lifecycle audit", coordinatorSessionId: "ses_audit",
    actors: [{ sessionId: "ses_audit", kind: "coordinator", managed: false, title: "Audit actor", roles: [], location: { directory: "/fixture" }, joinedAt: 1 }] }
  let rejected = 0
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, missions: [current], generatedAt: current.revision, discardedEvents: 0 } })
      const input = route.request().postDataJSON() as Input
      calls.push(input)
      if (rejected++ < 2) {
        current = { ...current, revision: input.expectedRevision + 1 }
        return route.fulfill({ status: 409, json: { code: "revision-conflict", error: "private upstream detail" } })
      }
      current = { ...current, revision: current.revision + 1, runState: "paused" }
      return route.fulfill({ json: { mission: current } })
    })
    await open(page)
    const retryCount = async () => await retryOffered(page) ? 1 : 0
    await pause(page).click(); await settled(page)
    // Retain the original failing wire proof, rather than stop at the first UI assertion.
    if (await retryCount()) { await retry(page); await settled(page); console.info("BEFORE stale retry wire", JSON.stringify({ calls, displayRevision: current.revision })) }
    assert.equal(await retryCount(), 0, "a certified pre-intent rejection must not expose a stale retry")
    assert.equal(calls.length, 1, "refresh must not automatically submit a new intent")
    await pause(page).click(); await settled(page)
    assert.equal(await retryCount(), 0)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(call => [call.action, call.expectedRevision]), [["pause", 1], ["pause", 2]])
    assert.notEqual(calls[0].requestId, calls[1].requestId)
    await pause(page).click(); await settled(page)
    assert.equal(calls.length, 3)
    assert.equal(calls[2].expectedRevision, 3)
    assert.notEqual(calls[1].requestId, calls[2].requestId)
    assert.equal(await page.getByRole("button", { name: "Resume mission", exact: true }).isEnabled(), true)
    console.info("AFTER explicit revision-conflict wire", JSON.stringify(calls))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const code of [undefined, "request-conflict", "control-pending", "lost-ack"] as const) {
  test(`real RightPanel retains exact uncertain request for 409 ${code ?? "without certified code"}`, async () => {
    const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
    let current = mission()
    try {
      await page.route("**/api/**", route => route.fulfill({ json: {} }))
      await page.route("**/api/workspaces/mission-visibility/missions**", route => {
        if (route.request().method() === "GET") return route.fulfill({ json: { available: true, missions: [current], generatedAt: current.revision, discardedEvents: 0 } })
        const input = route.request().postDataJSON() as Input; calls.push(input)
        if (calls.length === 1) { current = { ...current, revision: 2 }; return code === "lost-ack" ? route.abort("connectionfailed") : route.fulfill({ status: 409, json: code ? { code } : {} }) }
        current = { ...current, revision: 3, runState: "paused" }
        return route.fulfill({ json: { mission: current } })
      })
      await open(page)
      await pause(page).click(); await settled(page)
      // Never a second Pause or a fresh Stop while the exact request is unresolved.
      assert.equal(await pause(page).count(), 0); assert.equal(await check(page).count(), 1)
      assert.equal(await stop(page).isDisabled(), true); assert.equal(await retryOffered(page), true)
      const reread = page.waitForResponse(value => value.url().endsWith("/missions"))
      await fixture(page, "event", "session.status"); await reread; await settled(page)
      assert.equal(calls.length, 1, "native invalidation reads never resend")
      await retry(page)
      await settled(page)
      assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0])
      console.info("UNKNOWN exact retry wire", code, JSON.stringify(calls))
    } finally { await page.close() }
  })
}

test("real RightPanel ignores late rejection after row disposal in a newly selected mission", async () => {
  const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
  let release!: () => void, submitted!: () => void, reads = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const sent = new Promise<void>(resolve => { submitted = resolve })
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", async route => {
      if (route.request().method() === "GET") { reads++; return route.fulfill({ json: { available: true, missions: [mission("one"), mission("two")], generatedAt: reads, discardedEvents: 0 } }) }
      calls.push(route.request().postDataJSON() as Input); submitted(); await held
      return route.fulfill({ status: 409, json: { code: "revision-conflict" } })
    })
    await open(page, "Lifecycle one")
    await pause(page).click(); await sent
    // Unmounting the panel disposes the dispatching toolbar; then another Mission is selected.
    await fixture(page, "mount", false); await missionDetail(page).waitFor({ state: "detached" }); await fixture(page, "mount", true)
    await selectMission(page, "Lifecycle two")
    await page.waitForFunction(() => (window as any).missionVisibility.state().status === "ready")
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const before = reads, response = page.waitForResponse(value => value.url().endsWith("/control"))
    release(); await response
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(reads, before, "disposed-row completion must not refresh the new context")
    for (const title of ["Lifecycle one", "Lifecycle two"]) {
      await selectMission(page, title)
      assert.equal(await retryOffered(page), false)
      assert.equal(await pause(page).isEnabled(), true)
    }
    assert.equal(calls.length, 1)
  } finally { release(); await page.close() }
})

test("real RightPanel does not refresh hidden demand on late lifecycle completion", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let release!: () => void, submitted!: () => void, reads = 0
  const held = new Promise<void>(resolve => { release = resolve }), sent = new Promise<void>(resolve => { submitted = resolve })
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", async route => {
      if (route.request().method() === "GET") { reads++; return route.fulfill({ json: { available: true, missions: [mission()], generatedAt: reads, discardedEvents: 0 } }) }
      submitted(); await held
      return route.fulfill({ status: 409, json: { code: "revision-conflict" } })
    })
    await open(page)
    await pause(page).click(); await sent
    await fixture(page, "activate", false)
    const before = reads, response = page.waitForResponse(value => value.url().endsWith("/control"))
    release(); await response
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(reads, before)
    assert.deepEqual(await fixture(page, "demanded"), [])
  } finally { release(); await page.close() }
})

for (const action of ["pause", "stop"] as const) {
  test(`real RightPanel preserves durable partial ${action} identity through a reload`, async () => {
    const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
    let current = mission()
    try {
      await page.route("**/api/**", route => route.fulfill({ json: {} }))
      await page.route("**/api/workspaces/mission-visibility/missions**", route => {
        if (route.request().method() === "GET") return route.fulfill({ json: { available: true, missions: [current], generatedAt: current.revision, discardedEvents: 0 } })
        const input = route.request().postDataJSON() as Input; calls.push(input)
        current = { ...current, revision: current.revision + 1, runState: action === "pause" ? "paused" : "stopped", status: action === "stop" ? "stopped" : "active",
          control: { id: "evt_partial", missionID: current.id, requestID: input.requestId, expectedRevision: input.expectedRevision, action,
            targets: [{ sessionID: "ses_fixture", location: { directory: "/fixture" } }], pending: calls.length === 1 ? ["ses_fixture"] : [] } }
        return calls.length === 1 ? route.fulfill({ status: 503, json: { code: "control-pending" } }) : route.fulfill({ json: { mission: current } })
      })
      await open(page)
      const sent = page.waitForRequest(request => request.url().endsWith("/control"))
      if (action === "pause") await pause(page).click()
      else { await stop(page).click(); await page.getByRole("dialog").getByRole("button", { name: "Stop mission permanently", exact: true }).click() }
      await sent; await settled(page)
      await page.reload(); await open(page)
      assert.equal(await check(page).count(), 1, "the durable partial request is checked, never resent as a fresh action")
      assert.equal(calls.length, 1, "reload reads never resend")
      await retry(page)
      if (action === "stop") await check(page).waitFor({ state: "detached" })
      await settled(page)
      assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0])
      assert.equal(current.control?.pending.length, 0)
      console.info("DURABLE exact retry wire", action, JSON.stringify(calls))
    } finally { await page.close() }
  })
}

test("Stop asks for confirmation in a dialog: cancel and Escape never submit; confirmation submits once", async () => {
  const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
  let current = mission()
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, missions: [current], generatedAt: current.revision, discardedEvents: 0 } })
      calls.push(route.request().postDataJSON() as Input)
      current = { ...current, revision: 2, runState: "stopped", status: "stopped" }
      return route.fulfill({ json: { mission: current } })
    })
    await open(page)
    const dialog = page.getByRole("dialog")
    await stop(page).click(); await dialog.waitFor()
    assert.deepEqual(calls, [])
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await stop(page).click(); await dialog.waitFor()
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    assert.deepEqual(calls, [])
    await stop(page).click(); await dialog.waitFor()
    await dialog.getByRole("button", { name: "Stop mission permanently", exact: true }).click()
    // A terminal Mission keeps its lifecycle buttons in place, disabled.
    await pause(page).waitFor({ state: "detached" })
    await page.waitForFunction(() => [...document.querySelectorAll(".mission-action-bar button")]
      .find(button => button.getAttribute("aria-label") === "Stop mission permanently")?.hasAttribute("disabled"))
    assert.equal(await missionToolbarAction(page, "Start").isDisabled(), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].action, "stop")
  } finally { await page.close() }
})
