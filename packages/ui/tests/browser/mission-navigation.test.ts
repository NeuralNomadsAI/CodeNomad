import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page, type Request } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { clickMissionAction, missionPickerField, selectMission, toggleMissionOverview } from "./mission-actions"
import type {} from "./fixtures/mission-navigation"

let server: ViteDevServer, browser: Browser, url: string
const ownedHTTP = { listeningAt: 0, closedAt: 0, accepted: 0, open: 0, peak: 0, requests: 0, unfinished: 0, finished: 0, closedResponses: 0,
  documentArrivals: 0, firstDocumentArrivalAt: 0, lastDocumentArrivalAt: 0 }
let closeDocumentForCustodyCheck = false, failedSetupHeld: Promise<void> | undefined
let setupEvidenceWriter = writeFile, setupFailureLogger: (line: string) => unknown = line => console.log(line)
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-navigation", configureServer(s) { s.middlewares.use("/mission-navigation", async (_req, res) => {
      if (closeDocumentForCustodyCheck) { res.destroy(); return }
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/mission-navigation", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-navigation.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  server.httpServer!.on("listening", () => { ownedHTTP.listeningAt = Date.now() })
  server.httpServer!.on("close", () => { ownedHTTP.closedAt = Date.now() })
  server.httpServer!.on("connection", socket => {
    ownedHTTP.accepted++; ownedHTTP.open++; ownedHTTP.peak = Math.max(ownedHTTP.peak, ownedHTTP.open)
    socket.once("close", () => { ownedHTTP.open-- })
  })
  // Prepend: Connect mutates req.url while routing; observe the actual arrival first.
  server.httpServer!.prependListener("request", (request, response) => {
    ownedHTTP.requests++; ownedHTTP.unfinished++
    if (request.url?.split("?")[0] === "/mission-navigation") {
      ownedHTTP.documentArrivals++; ownedHTTP.lastDocumentArrivalAt = Date.now()
      ownedHTTP.firstDocumentArrivalAt ||= ownedHTTP.lastDocumentArrivalAt
    }
    let finished = false
    response.once("finish", () => { finished = true; ownedHTTP.finished++; ownedHTTP.unfinished-- })
    response.once("close", () => { if (!finished) { ownedHTTP.closedResponses++; ownedHTTP.unfinished-- } })
  })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-navigation`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

function mission(id: string): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "Reader details",
    coordinatorSessionId: `ses_${id}`, status: "active", actors: [], tasks: [], reports: [], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function ownedRequest(value: string) {
  let target: URL
  try { target = new URL(value) } catch { return undefined }
  const origin = new URL(url).origin
  if (target.origin !== origin) return undefined
  const pathname = target.pathname.slice(0, 256)
  const category = pathname === "/mission-navigation" ? "document" : pathname.includes("lucide-solid") ? "lucide"
    : pathname.startsWith("/api/") ? "api" : pathname.includes("/deps/") ? "optimized" : "other"
  return { origin, path: pathname, category }
}
async function reportSetupFailure(record: { droppedPackets: number; failures: unknown[] } & Record<string, unknown>) {
  let line = JSON.stringify(record)
  if (Buffer.byteLength(line) > 32_768) line = JSON.stringify({ kind: "mission-navigation-setup-failure", droppedSnapshot: true, droppedPackets: record.droppedPackets + record.failures.length })
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const sinks = [Promise.resolve().then(() => setupFailureLogger(line))]
    if (process.env.CODENOMAD_NAVIGATION_EVIDENCE) sinks.push(Promise.resolve().then(() => setupEvidenceWriter(
      path.join(process.env.CODENOMAD_NAVIGATION_EVIDENCE!, `setup-failure-${Date.now()}.json`), line, { signal: abort.signal })))
    await Promise.race([Promise.allSettled(sinks), new Promise<void>(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve() }, 2000)
    })])
  } finally { clearTimeout(timer); abort.abort() }
}
async function setup(missing = false) {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = [], networkErrors: string[] = [], requests: string[] = []
  let recurrenceDemandRetired = false
  const cancelledRecurrenceReads: string[] = []
  const held = gate(), reached = gate(), completed = gate()
  const traffic = Object.fromEntries(["document", "lucide", "api", "optimized", "other"].map(category =>
    [category, { started: 0, current: 0, peak: 0, finished: 0, failed: 0 }]))
  const failures: { at: number; origin: string; path: string; type: string; error: string }[] = []
  let droppedPackets = 0, outstanding = 0, peakOutstanding = 0, ignoredNonOwned = 0, navigationStartedAt = 0, documentBaseline = 0
  page.on("request", request => {
    const own = ownedRequest(request.url())
    if (!own) { ignoredNonOwned++; return }
    const count = traffic[own.category]; count.started++; count.current++; count.peak = Math.max(count.peak, count.current)
    outstanding++; peakOutstanding = Math.max(peakOutstanding, outstanding)
  })
  const terminal = (request: Request, failed: boolean) => {
    const own = ownedRequest(request.url())
    if (!own) return
    const count = traffic[own.category]; count.current--; count[failed ? "failed" : "finished"]++; outstanding--
    if (failed) {
      if (failures.length === 16) { failures.shift(); droppedPackets++ }
      failures.push({ at: Date.now(), origin: own.origin, path: own.path, type: request.resourceType().slice(0, 32),
        error: request.failure()?.errorText?.match(/^(?:net::)?ERR_[A-Z_]+$/)?.[0].slice(0, 128) ?? "unknown" })
    }
  }
  page.on("requestfinished", request => terminal(request, false))
  page.on("requestfailed", request => terminal(request, true))
  page.on("pageerror", error => errors.push(error.message))
  page.on("requestfailed", request => {
    const error = `${request.url()} ${request.failure()?.errorText}`, own = ownedRequest(request.url())
    // Only these explicit view retirements cancel the exact read-only list GET.
    // Preserve raw failure diagnostics and all actor/read/navigation failures.
    if (recurrenceDemandRetired && request.method() === "GET" && request.failure()?.errorText === "net::ERR_ABORTED"
      && own && /^\/api\/workspaces\/(fixture|replacement)\/missions\/recurrence$/.test(own.path)) cancelledRecurrenceReads.push(error)
    else networkErrors.push(error)
  })
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname
    requests.push(`${route.request().method()} ${pathname}`)
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [mission("A"), mission("B")], generatedAt: 1, discardedEvents: 0 } })
    if (pathname.endsWith("/missions/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project",
      projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] } })
    if (pathname.endsWith("/instance/api/session/ses_A")) {
      reached.release(); await held.promise
      await route.fulfill(missing ? { status: 404, json: { name: "NotFoundError", data: { message: "Missing session" } } }
        : { json: { data: { id: "ses_A", projectID: "project", title: "ses_A", slug: "ses_A", version: "1", location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } } })
      completed.release(); return
    }
    if (pathname.endsWith("/agent")) return route.fulfill({ json: [{ id: "build", name: "build", mode: "primary" }, { id: "plan", name: "plan", mode: "primary" }] })
    if (pathname.endsWith("/provider")) return route.fulfill({ json: { all: [], connected: [], default: {} } })
    if (pathname.includes("/instance/")) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
  try {
    navigationStartedAt = Date.now(); documentBaseline = ownedHTTP.documentArrivals
    await page.goto(url)
    // Loaded Missions enable the current-mission field (nothing is selected by default).
    await missionPickerField(page).and(page.locator(":enabled")).waitFor()
  } catch (error) {
    failedSetupHeld = held.promise
    try {
      const errorLine = String(error).split("\n")[0].slice(0, 1024).replace(/https?:\/\/[^\s]+/g, value => {
        const own = ownedRequest(value); return own ? `${own.origin}${own.path}` : "[non-owned URL]"
      })
      await reportSetupFailure({ kind: "mission-navigation-setup-failure", error: errorLine, at: Date.now(), navigationStartedAt,
        origin: new URL(url).origin, path: "/mission-navigation", browser: browser.version().slice(0, 64), ownedContexts: browser.contexts().length,
        traffic, outstanding, peakOutstanding, ignoredNonOwned, failures, droppedPackets, diagnosticBudgetMs: 2000,
        clientPhase: "unknown; no CDP capture", cache: "unknown", requestCountsAreNotSockets: true,
        server: { ...ownedHTTP, port: (server.httpServer!.address() as { port: number } | null)?.port ?? null,
          listening: server.httpServer!.listening, documentArrivalsSinceGoto: ownedHTTP.documentArrivals - documentBaseline,
          arrivalCorrelation: "time window only; no arrival does not prove no OS connect" }, intentionalDocumentFault: closeDocumentForCustodyCheck })
    } catch { /* Diagnostics must never replace the actual setup error. */ }
    finally { held.release(); try { await page.close() } catch { /* Preserve original error even if cleanup fails. */ } failedSetupHeld = undefined }
    throw error
  }
  return { page, held, reached, completed, errors, networkErrors, requests, cancelledRecurrenceReads,
    retireRecurrenceDemand: () => { recurrenceDemandRetired = true } }
}
async function read(page: Page, id: string) {
  // The overview reader belongs to the selected Mission's toolbar ("Summary" eye).
  await toggleMissionOverview(page, `Objective ${id}`)
}
async function actor(page: Page, id: string) {
  await clickMissionAction(page, "Open conversation", `Objective ${id}`)
}
async function settled(page: Page) {
  // Let the fulfilled HTTP response traverse the real Promise client and Solid
  // effects; this is not a mock replacement of navigation/selection logic.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
type Change = "reader" | "actor" | "selection" | "instance" | "instance-aba" | "directory-aba" | "project-aba" | "inactive-aba" | "remount" | "editor"
for (const origin of ["actor", "reader"] as const) for (const change of ["reader", "actor", "selection", "instance", "instance-aba", "directory-aba", "project-aba", "inactive-aba", "remount", "editor"] as const) {
  test(`deferred ${origin} A respects newer ${change}`, async () => {
    const state = await setup(), { page, held, reached, completed, errors, networkErrors, requests } = state
    try {
      if (origin === "reader") await page.evaluate(() => window.missionNavigation.clearActive())
      await (origin === "actor" ? actor(page, "A") : read(page, "A"))
      await reached.promise
      if (["instance", "instance-aba", "directory-aba", "project-aba", "inactive-aba", "remount"].includes(change)) state.retireRecurrenceDemand()
      if (change.startsWith("instance")) {
        await page.evaluate(() => window.missionNavigation.instance("replacement"))
        if (change.endsWith("aba")) await page.evaluate(() => window.missionNavigation.instance("fixture"))
      } else if (change === "directory-aba") {
        await page.evaluate(() => window.missionNavigation.directory("/other")); await page.evaluate(() => window.missionNavigation.directory("/fixture"))
      } else if (change === "project-aba") {
        await page.evaluate(() => window.missionNavigation.project("other-project")); await page.evaluate(() => window.missionNavigation.project("project"))
      } else if (change === "inactive-aba") {
        await page.evaluate(() => window.missionNavigation.activate(false)); await page.evaluate(() => window.missionNavigation.activate(true))
      } else if (change === "remount") {
        await page.evaluate(() => window.missionNavigation.mount(false)); await page.evaluate(() => window.missionNavigation.mount(true))
      }
      if (change === "selection") await selectMission(page, "Objective B")
      else if (change === "actor") {
        // Let B's newer navigation land before capturing the state the stale A must keep.
        await actor(page, "B")
        await page.waitForFunction(() => { const value = window.missionNavigation.snapshot(); return value.view.selected === "B" && value.selectedSession === "ses_B" })
        await settled(page)
      }
      else if (change === "editor") { await page.getByRole("button", { name: "Create mission", exact: true }).click(); await page.getByLabel("What should the mission do?", { exact: true }).fill("New editor intent") }
      else await read(page, "B")
      const before = await page.evaluate(() => window.missionNavigation.snapshot())
      await page.evaluate(() => window.missionNavigation.created("ses_A"))
      held.release(); await completed.promise; await settled(page)
      const after = await page.evaluate(() => window.missionNavigation.snapshot())
      if (process.env.CODENOMAD_NAVIGATION_EVIDENCE) {
        await writeFile(path.join(process.env.CODENOMAD_NAVIGATION_EVIDENCE, `${origin}-${change}.json`), JSON.stringify({ before, after, errors, networkErrors, cancelledRecurrenceReads: state.cancelledRecurrenceReads, requests }, null, 2))
        await page.screenshot({ path: path.join(process.env.CODENOMAD_NAVIGATION_EVIDENCE, `${origin}-${change}.png`) })
      }
      assert.deepEqual(after, before, "stale navigation must not activate, clear/install readers or reveal")
      if (change === "editor") assert.equal(await page.getByLabel("What should the mission do?", { exact: true }).inputValue(), "New editor intent")
      assert.equal(await page.getByRole("alert").count(), 0)
      assert.deepEqual(errors, []); assert.deepEqual(networkErrors, [])
      assert.ok(requests.every(request => request.startsWith("GET ")), "navigation is read-only")
    } finally { held.release(); await page.close() }
  })
}

test("current reader without active session opens coordinator then installs its own reader", async () => {
  const { page, held, reached, completed, errors, networkErrors } = await setup()
  try {
    await page.evaluate(() => window.missionNavigation.clearActive())
    await read(page, "A"); await reached.promise
    held.release(); await completed.promise
    await page.waitForFunction(() => window.missionNavigation.snapshot().view.reader?.missionId === "A")
    const after = await page.evaluate(() => window.missionNavigation.snapshot())
    assert.equal(after.selectedSession, "ses_A"); assert.deepEqual(JSON.parse(JSON.stringify(after.view.reader)), { missionId: "A", kind: "overview" }); assert.equal(after.reveals, 2)
    assert.deepEqual(errors, []); assert.deepEqual(networkErrors, [])
  } finally { held.release(); await page.close() }
})

test("missing coordinator does not install its reader after failed opening", async () => {
  const { page, held, reached, completed, errors } = await setup(true)
  try {
    await page.evaluate(() => window.missionNavigation.clearActive())
    await read(page, "A"); await reached.promise
    held.release(); await completed.promise
    await page.getByRole("alert").waitFor()
    const after = await page.evaluate(() => window.missionNavigation.snapshot())
    assert.equal(after.selectedSession, null); assert.equal(after.view.reader, undefined); assert.equal(after.reveals, 0)
    assert.deepEqual(errors, [])
  } finally { held.release(); await page.close() }
})

test("stale missing-coordinator error cannot overwrite a newer reader", async () => {
  const { page, held, reached, completed, errors } = await setup(true)
  try {
    await actor(page, "A"); await reached.promise; await read(page, "B")
    const before = await page.evaluate(() => window.missionNavigation.snapshot())
    held.release(); await completed.promise; await settled(page)
    assert.deepEqual(await page.evaluate(() => window.missionNavigation.snapshot()), before)
    assert.equal(await page.getByRole("alert").count(), 0); assert.deepEqual(errors, [])
  } finally { held.release(); await page.close() }
})

test("actual document failure preserves setup error and owned cleanup when evidence throws or stalls", async () => {
  const newPage = browser.newPage, writer = setupEvidenceWriter, logger = setupFailureLogger
  const evidence = process.env.CODENOMAD_NAVIGATION_EVIDENCE
  try {
    closeDocumentForCustodyCheck = true
    process.env.CODENOMAD_NAVIGATION_EVIDENCE = server.config.cacheDir // Injected writer never writes to this owned path.
    for (const mode of ["throw", "timeout"] as const) {
      let actualError: unknown, captured = "", writes = 0, contextClosed = false, gateReleasedBeforeClose = false, errorAt = 0, closeAt = 0
      let ownedPage!: Page
      browser.newPage = async options => {
        ownedPage = await newPage.call(browser, options)
        ownedPage.context().once("close", () => { contextClosed = true })
        const goto = ownedPage.goto.bind(ownedPage), close = ownedPage.close.bind(ownedPage)
        ownedPage.goto = async (target, options) => {
          assert.equal(target, url); assert.equal(options, undefined)
          try { return await goto(target, options) } catch (error) { actualError = error; errorAt = Date.now(); throw error }
        }
        ownedPage.close = async options => {
          closeAt = Date.now(); failedSetupHeld!.then(() => { gateReleasedBeforeClose = true }); await Promise.resolve()
          assert.equal(gateReleasedBeforeClose, true, "held route gate settles before native page/context close")
          return close(options)
        }
        return ownedPage
      }
      setupEvidenceWriter = async () => { writes++; if (mode === "throw") throw new Error("controlled evidence write failure"); await new Promise<void>(() => {}) }
      setupFailureLogger = line => { captured = line; if (mode === "throw") throw new Error("controlled logger failure"); return new Promise<void>(() => {}) }
      await assert.rejects(setup(), error => error === actualError)
      assert.match(String(actualError), /net::ERR_(EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_CLOSED)/)
      assert.equal(writes, 1); assert.equal(ownedPage.isClosed(), true); assert.equal(contextClosed, true)
      assert.equal(browser.contexts().length, 0); assert.equal(gateReleasedBeforeClose, true)
      assert.ok(closeAt - errorAt < 3000, "both diagnostic sinks share one 2s budget")
      if (mode === "timeout") assert.ok(closeAt - errorAt >= 1900, "actually exercised the diagnostic timeout")
      assert.ok(Buffer.byteLength(captured) <= 32_768)
      const packet = JSON.parse(captured)
      assert.equal(packet.kind, "mission-navigation-setup-failure"); assert.equal(packet.intentionalDocumentFault, true)
      assert.ok(packet.server.documentArrivalsSinceGoto > 0); assert.ok(packet.server.lastDocumentArrivalAt >= packet.navigationStartedAt)
      assert.equal(packet.traffic.document.failed, 1); assert.equal(packet.outstanding, 0)
      assert.ok(packet.failures.length > 0 && packet.failures.length <= 16); assert.equal(packet.droppedPackets, 0)
      for (const failure of packet.failures) {
        assert.equal(failure.origin, new URL(url).origin); assert.equal(failure.path, "/mission-navigation")
        assert.ok(failure.path.length <= 256); assert.match(failure.error, /^(?:net::)?ERR_[A-Z_]+$/)
      }
      assert.equal(ownedHTTP.open, 0); assert.equal(ownedHTTP.unfinished, 0)
      console.log(captured) // Actual injected transport failure receipt, not a success snapshot.
    }
  } finally {
    closeDocumentForCustodyCheck = false; browser.newPage = newPage; setupEvidenceWriter = writer; setupFailureLogger = logger
    if (evidence === undefined) delete process.env.CODENOMAD_NAVIGATION_EVIDENCE
    else process.env.CODENOMAD_NAVIGATION_EVIDENCE = evidence
  }
})
after(async () => {
  assert.equal(ownedHTTP.open, 0); assert.equal(ownedHTTP.unfinished, 0)
  assert.equal(ownedHTTP.requests, ownedHTTP.finished + ownedHTTP.closedResponses)
  assert.ok(ownedHTTP.closedAt >= ownedHTTP.listeningAt)
  await assert.rejects(stat(server.config.cacheDir), { code: "ENOENT" })
})
