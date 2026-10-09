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

let browser: Browser, server: ViteDevServer, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  let ready = false
  await runWithDiagnosticCleanup({
    run: async () => {
      server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
        logLevel: "error", plugins: [shutdown.plugin, solid(), { name: "lifecycle-navigation-fixture", configureServer(s) {
          s.middlewares.use("/lifecycle-navigation", async (_request, response) => {
            response.setHeader("Content-Type", "text/html")
            response.end(await s.transformIndexHtml("/lifecycle-navigation", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-visibility.tsx"></script></body></html>'))
          })
        } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
        server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
      shutdown.own(server); await server.listen()
      url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/lifecycle-navigation`
      browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined }); ready = true
    }, diagnose: async () => {},
    cleanup: async () => { if (!ready) { if (server) await server.close(); else await cache.dispose() } },
    onObservationError: () => {}, onCleanupError: error => console.error("navigation fixture cleanup", error),
  })
})
after(() => runWithDiagnosticCleanup({ run: async () => { await browser?.close() }, diagnose: async () => {},
  cleanup: async () => { await server?.close() }, onObservationError: () => {}, onCleanupError: error => console.error("navigation fixture shutdown", error) }))

type Input = { action: "start" | "pause" | "stop"; expectedRevision: number; requestId: string }
type InstanceModule = typeof import("../../src/stores/instances")
type IntentModule = typeof import("../../src/stores/mission-lifecycle-intents")
function mission(id = "one"): MissionMap {
  return { version: 1, id, projectID: "fixture", projectCanonical: "/fixture", objective: `Navigation ${id}`, template: "custom",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [], tasks: [], reports: [], frontier: [], claims: [],
    revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
const call = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) =>
  (window as any).missionVisibility[method](arg), { method, arg })
const tick = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
const row = (page: Page, id = "one") => page.locator(".mission-control-index > li.mission-index-entry")
  .filter({ has: page.getByRole("button", { name: `Navigation ${id}`, exact: true }) }).locator(".mission-index-row")
const pause = (page: Page, id = "one") => row(page, id).getByRole("button", { name: "Pause mission", exact: true })
// An unresolved request replaces the primary Pause with a status check.
const check = (page: Page, id = "one") => row(page, id).getByRole("button", { name: "Check control status", exact: true })
// An in-flight exact intent shows only a busy, disabled status check.
const inFlight = async (page: Page, id = "one") => await pause(page, id).count() === 0 && await check(page, id).isDisabled()
const admissible = async (page: Page, id = "one") => await pause(page, id).count() === 1 && await pause(page, id).isEnabled()
async function menu(page: Page, id = "one") {
  await row(page, id).getByRole("button", { name: "More actions", exact: true }).click()
  const items = page.getByRole("menuitem"); await items.first().waitFor()
  const result = await Promise.all((await items.all()).map(async item => ({ label: (await item.innerText()).trim(),
    enabled: await item.getAttribute("aria-disabled") !== "true" })))
  await page.keyboard.press("Escape"); await items.first().waitFor({ state: "detached" })
  return result
}
const retryItem = async (page: Page, id = "one") => (await menu(page, id)).find(item => item.label === "Retry last action")
const retryCount = async (page: Page, id = "one") => await retryItem(page, id) ? 1 : 0
async function retry(page: Page, id = "one") {
  // Menu actions launch after the menu closes; wait for the actual dispatch.
  const sent = page.waitForRequest(request => request.url().endsWith("/control"))
  await row(page, id).getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Retry last action", exact: true }).click()
  await sent
}
async function remount(page: Page) {
  await call(page, "mount", false); await row(page).waitFor({ state: "detached" })
  await call(page, "mount", true); await row(page).waitFor()
  await page.waitForFunction(() => (window as any).missionVisibility.state().status === "ready"); await tick(page)
}
async function settle(page: Page) {
  await page.waitForFunction(() => (window as any).missionVisibility.state().status === "ready" && !document.querySelector('.mission-index-feedback [role="status"]'))
}
async function open(page: Page) {
  await page.goto(url); await page.waitForFunction(() => Boolean((window as any).missionVisibility))
  await call(page, "activate", true); await pause(page).waitFor()
}

test("certified rejection while hidden releases only its owned intent; reactivation permits explicit revision2 Pause", async () => {
  const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = [], errors: string[] = []
  let current = mission(), reads = 0, release!: () => void, submitted!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), sent = new Promise<void>(resolve => { submitted = resolve })
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", async route => {
      if (route.request().method() === "GET") { reads++; return route.fulfill({ json: { available: true, missions: [current], generatedAt: reads, discardedEvents: 0 } }) }
      calls.push(route.request().postDataJSON() as Input)
      if (calls.length === 1) { submitted(); await held; current = { ...current, revision: 2 }; return route.fulfill({ status: 409, json: { code: "revision-conflict" } }) }
      current = { ...current, revision: 3, runState: "paused" }; return route.fulfill({ json: { mission: current } })
    })
    await open(page); await pause(page).click(); await sent; await call(page, "activate", false)
    const before = reads, response = page.waitForResponse(value => value.url().endsWith("/control"))
    release(); await response; await tick(page)
    const readsWhileHidden = reads - before
    assert.equal(readsWhileHidden, 0); assert.deepEqual(await call(page, "demanded"), [])
    await call(page, "activate", true); await settle(page)
    assert.equal(await retryCount(page), 0); assert.equal(calls.length, 1)
    assert.equal(await page.evaluate(() => (window as any).missionVisibility.state().missions[0].revision), 2)
    await pause(page).click(); await settle(page)
    assert.deepEqual(calls.map(input => input.expectedRevision), [1, 2]); assert.notEqual(calls[0].requestId, calls[1].requestId)
    assert.deepEqual(errors, [])
    console.info("HIDDEN certified ownership wire", JSON.stringify({ calls, readsWhileHidden, demandedWhileHidden: [] }))
  } finally { release(); await page.close() }
})

test("uncertain row remount and native reconnect invalidations retain exact original revision/UUID, with Pause blocked", async () => {
  const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
  let current = mission()
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, missions: [current, mission("two")], generatedAt: current.revision, discardedEvents: 0 } })
      calls.push(route.request().postDataJSON() as Input); current = { ...current, revision: current.revision + 1 }
      return route.fulfill({ status: 409, json: {} })
    })
    await open(page); await pause(page).click(); await settle(page)
    await remount(page); await settle(page)
    assert.equal(await retryCount(page), 1); assert.equal(await pause(page).count(), 0); assert.equal(await check(page).isEnabled(), true)
    const refreshed = page.waitForResponse(value => value.url().endsWith("/missions"))
    await call(page, "event", "session.status"); await refreshed; await settle(page)
    await call(page, "activate", false); await call(page, "activate", true); await settle(page)
    assert.equal(calls.length, 1, "navigation and reconnect reads cannot dispatch")
    await retry(page); await settle(page)
    assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0])
    console.info("REMOUNT uncertain exact wire", JSON.stringify(calls))
  } finally { await page.close() }
})

for (const outcome of ["rejected", "acknowledged", "unknown", "foreign-ack"] as const) {
  test(`late ${outcome} after row disposal settles only exact bookkeeping, never the newly selected view`, async () => {
    const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
    let current = mission(), reads = 0, release!: () => void, submitted!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), sent = new Promise<void>(resolve => { submitted = resolve })
    try {
      await page.route("**/api/**", route => route.fulfill({ json: {} }))
      await page.route("**/api/workspaces/mission-visibility/missions**", async route => {
        if (route.request().method() === "GET") { reads++; return route.fulfill({ json: { available: true, missions: [current, mission("two")], generatedAt: reads, discardedEvents: 0 } }) }
        calls.push(route.request().postDataJSON() as Input); submitted(); await held; current = { ...current, revision: 2 }
        return outcome === "rejected" ? route.fulfill({ status: 409, json: { code: "revision-conflict" } })
          : outcome === "unknown" ? route.fulfill({ status: 409, json: {} })
          : route.fulfill({ json: { mission: outcome === "foreign-ack" ? mission("foreign") : current } })
      })
      // Rows survive selection; unmounting the panel disposes the dispatching row.
      await open(page); await pause(page).click(); await sent; await remount(page)
      await row(page, "two").getByRole("button", { name: "Navigation two", exact: true }).click(); await tick(page)
      assert.equal(await inFlight(page), true, "the remounted row observes the in-flight exact intent")
      const before = reads, response = page.waitForResponse(value => value.url().endsWith("/control"))
      release(); await response; await tick(page)
      assert.equal(reads, before); assert.equal(await retryCount(page, "two"), 0); assert.equal(await admissible(page, "two"), true)
      await row(page).getByRole("button", { name: "Navigation one", exact: true }).click(); await settle(page)
      const unresolved = outcome === "unknown" || outcome === "foreign-ack"
      assert.equal(await retryCount(page), unresolved ? 1 : 0)
      assert.equal(await admissible(page), !unresolved); assert.equal(await check(page).count(), unresolved ? 1 : 0)
      assert.equal(calls.length, 1)
      console.info("DISPOSED exact bookkeeping", outcome, JSON.stringify(calls))
    } finally { release(); await page.close() }
  })
}

test("directory/project source ABA retains original uncertainty; stale completion cannot refresh the returned view", async () => {
  const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
  let current = mission(), reads = 0, release!: () => void, submitted!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), sent = new Promise<void>(resolve => { submitted = resolve })
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", async route => {
      if (route.request().method() === "GET") { reads++; return route.fulfill({ json: { available: true, missions: [current], generatedAt: reads, discardedEvents: 0 } }) }
      calls.push(route.request().postDataJSON() as Input)
      if (calls.length === 1) { submitted(); await held; current = { ...current, revision: 2 } }
      return route.fulfill({ status: 409, json: {} })
    })
    await page.goto(url); await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await page.evaluate(async () => {
      const { addInstance }: InstanceModule = await import("/src/stores/instances" + ".ts")
      addInstance({ id: "mission-visibility", folder: "/source-a", proxyPath: "/fixture", port: 0, pid: 0, status: "ready", client: null,
        metadata: { project: { id: "project-a" } as any } })
    })
    await call(page, "activate", true); await pause(page).waitFor(); await pause(page).click(); await sent
    for (const [directory, projectID] of [["/source-b", "project-b"], ["/source-a", "project-a"]]) {
      await page.evaluate(async ({ directory, projectID }) => {
        const { updateInstance }: InstanceModule = await import("/src/stores/instances" + ".ts")
        updateInstance("mission-visibility", { folder: directory, metadata: { project: { id: projectID } as any } })
      }, { directory, projectID })
      await tick(page)
      if (directory === "/source-b") { assert.equal(await retryCount(page), 0); assert.equal(await admissible(page), true) }
    }
    assert.equal(await inFlight(page), true, "source A still owns its in-flight operation after ABA")
    const before = reads, response = page.waitForResponse(value => value.url().endsWith("/control"))
    release(); await response; await tick(page)
    assert.equal(reads, before, "old component epoch cannot refresh after source ABA")
    assert.equal(await retryCount(page), 1); assert.equal(await pause(page).count(), 0); assert.equal(await check(page).count(), 1)
    await retry(page); await settle(page)
    assert.deepEqual(calls[1], calls[0]); console.info("SOURCE ABA exact wire", JSON.stringify(calls))
  } finally { release(); await page.close() }
})

test("window capacity fails closed without eviction; exact release enables admission, while original uncertainty survives", async () => {
  const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, missions: [mission(), mission("two")], generatedAt: 1, discardedEvents: 0 } })
      calls.push(route.request().postDataJSON() as Input); return route.fulfill({ status: 409, json: {} })
    })
    await open(page); await pause(page).click(); await settle(page)
    const count = await page.evaluate(async () => {
      // Browser-evaluated imports must use Vite's canonical .ts URL; the alias
      // creates another module/store. Type imports still cover the real graph.
      const { missionLifecycleIntents: store }: IntentModule = await import("/src/stores/mission-lifecycle-intents" + ".ts")
      const records = []
      for (let i = 0; i < 63; i++) records.push(store.reserve(`capacity-${i}`, "fixture", { action: "pause", expectedRevision: 1, requestId: `capacity-${i}` }))
      ;(window as any).capacityRecords = records
      return { filled: records.filter(Boolean).length, available: store.available(), overflow: Boolean(store.reserve("overflow", "fixture", { action: "pause", expectedRevision: 1, requestId: "overflow" })) }
    })
    assert.deepEqual(count, { filled: 63, available: false, overflow: false })
    assert.equal(await pause(page, "two").isDisabled(), true)
    assert.equal((await retryItem(page))?.enabled, true)
    await retry(page); await settle(page); assert.deepEqual(calls[1], calls[0])
    await page.evaluate(async () => {
      const { missionLifecycleIntents: store }: IntentModule = await import("/src/stores/mission-lifecycle-intents" + ".ts")
      store.finish((window as any).capacityRecords[0], "rejected")
    })
    await tick(page); assert.equal(await admissible(page, "two"), true)
    assert.equal(await retryCount(page), 1); assert.equal(await pause(page).count(), 0); assert.equal(await check(page).count(), 1)
    assert.equal(calls.length, 2); console.info("CAPACITY no eviction wire", JSON.stringify(calls))
  } finally { await page.close() }
})

test("authoritative operation replacement wins over a late rejected local intent without refreshing the replacement view", async () => {
  const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
  let current = mission(), reads = 0, release!: () => void, submitted!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), sent = new Promise<void>(resolve => { submitted = resolve })
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", async route => {
      if (route.request().method() === "GET") { reads++; return route.fulfill({ json: { available: true, missions: [current], generatedAt: reads, discardedEvents: 0 } }) }
      calls.push(route.request().postDataJSON() as Input)
      if (calls.length === 1) { submitted(); await held; return route.fulfill({ status: 409, json: { code: "revision-conflict" } }) }
      return route.fulfill({ status: 503, json: { code: "control-pending" } })
    })
    await open(page); await pause(page).click(); await sent
    current = { ...current, revision: 10, status: "stopped", runState: "stopped", control: {
      id: "evt_replacement", missionID: current.id, requestID: "durable-replacement", expectedRevision: 9, action: "stop",
      targets: [{ sessionID: "ses_one", location: { directory: "/fixture" } }], pending: ["ses_one"] } }
    const snapshot = page.waitForResponse(value => value.url().endsWith("/missions"))
    await call(page, "event", "session.status"); await snapshot; await tick(page)
    const before = reads, response = page.waitForResponse(value => value.url().endsWith("/control"))
    release(); await response; await tick(page)
    assert.equal(reads, before); assert.equal(await retryCount(page), 1)
    await retry(page); await settle(page)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1], { action: "stop", expectedRevision: 9, requestId: "durable-replacement" })
    console.info("AUTHORITATIVE replacement wire", JSON.stringify(calls))
  } finally { release(); await page.close() }
})

test("same-project metadata hydration cannot enable fresh admission or erase the remounted original intent", async () => {
  const page = await browser.newPage({ locale: "en-US" }), calls: Input[] = []
  let current = mission()
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/missions**", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, missions: [current, mission("two")], generatedAt: current.revision, discardedEvents: 0 } })
      calls.push(route.request().postDataJSON() as Input); current = { ...current, revision: current.revision + 1 }
      return route.fulfill({ status: 409, json: {} })
    })
    await page.goto(url); await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await page.evaluate(async () => {
      const { addInstance }: InstanceModule = await import("/src/stores/instances" + ".ts")
      addInstance({ id: "mission-visibility", folder: "/fixture", proxyPath: "/fixture", port: 0, pid: 0, status: "ready", client: null })
    })
    await call(page, "activate", true); await pause(page).waitFor(); await pause(page).click(); await settle(page)
    await page.evaluate(async () => {
      const { updateInstance }: InstanceModule = await import("/src/stores/instances" + ".ts")
      updateInstance("mission-visibility", { metadata: { project: { id: "fixture" } as any } })
    })
    await remount(page); await settle(page)
    assert.equal(await pause(page).count(), 0); assert.equal(await check(page).count(), 1); assert.equal(await retryCount(page), 1)
    assert.equal(calls.length, 1)
    await retry(page); await settle(page)
    assert.deepEqual(calls[1], calls[0]); console.info("HYDRATION exact wire", JSON.stringify(calls))
  } finally { await page.close() }
})
