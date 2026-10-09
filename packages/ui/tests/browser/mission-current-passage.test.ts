import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type { MissionMap } from "../../../server/src/api-types"
import type { MissionRecurrenceSnapshot } from "../../src/stores/mission-recurrence"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { currentRecurrenceContent } from "../../../server/src/missions/recurrence-current"
import { captureMissionView } from "./mission-view-capture"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "current-passage", configureServer(s) {
      s.middlewares.use("/api/events", (_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.write(": isolated event dispatcher\n\n") })
      s.middlewares.use("/passage", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/passage", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-current-passage.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/passage`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
const mission: MissionMap = { version: 1, id: "msn_passage", projectID: "project", projectCanonical: "/fixture", objective: "Finite recurring review", template: "custom",
  status: "active", runState: "running", coordinatorSessionId: "ses_coordinator", revision: 4, createdAt: 1, updatedAt: 4, history: [], historyTruncated: false,
  frontier: [], claims: [], actors: [
    { sessionId: "ses_coordinator", kind: "coordinator", managed: true, title: "Passage coordinator", roles: [], location: { directory: "/fixture" }, joinedAt: 1 },
    { sessionId: "ses_task", kind: "specialist", managed: true, title: "Exact task actor", roles: [], location: { directory: "/fixture" }, joinedAt: 1 },
  ], tasks: [
    { id: "tsk_first", key: "first", title: "Review commits", brief: "Bounded source brief", role: "specialist", blockedBy: [], status: "completed", actorSessionId: "ses_task", createdAt: 1, updatedAt: 3, outstandingExecution: false,
      report: { id: "rpt_first", taskKey: "first", sessionId: "ses_task", outcome: "completed", summary: "Exact isolated result", evidence: ["Evidence:start\n" + "long ".repeat(1900) + "Evidence:end"], next: ["Next review"], createdAt: 3 } },
    { id: "tsk_second", key: "second", title: "Next task has no actor", brief: "Second task brief", role: "specialist", blockedBy: ["first"], status: "ready", createdAt: 1, updatedAt: 3, outstandingExecution: false },
  ], reports: [], briefing: { version: 1, id: "brf_current", requestID: "briefing_request", assessedRevision: 3, createdAt: 3, summary: "Exact passage briefing",
    achieved: [{ text: "Reviewed", taskKeys: ["first"] }], ongoing: [], obstacles: [], next: [{ text: "Continue", taskKeys: ["second"] }] } as never }

test("actual MissionControl reuses current Work, briefing, attention, ancestry and central exact-source reader", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1200, height: 950 } }), errors: string[] = [], writes: string[] = []
  page.setDefaultTimeout(8_000)
  let reads = 0, fail = false, passageID: string | null = "pas_current", observed = true, ordinary: MissionMap | undefined
  const nativeReads: string[] = []
  const sourceReads: Array<Record<string, unknown>> = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/events") return route.continue()
    if (path === "/api/storage/config/ui") return route.fulfill({ json: { settings: { locale: "en" } } })
    if (route.request().method() !== "GET") writes.push(path)
    if (path.endsWith("/missions")) {
      if (route.request().method() === "POST") {
        ordinary = { ...mission, id: "msn_ordinary", objective: route.request().postDataJSON().objective, tasks: [], reports: [] }
        return route.fulfill({ json: { mission: ordinary } })
      }
      return route.fulfill({ json: { available: true, projectID: "project", missions: ordinary ? [ordinary] : [], generatedAt: 1, discardedEvents: 0 } })
    }
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [{ id: "rec_current", title: "Daily commit review", revision: 2,
      state: "interrupted", interruptionReason: "service-restart", clock: { time: "08:15", zone: "UTC" }, nextDueAt: null, actions: [], controls: [],
      pending: passageID ? { passageID, status: "running", missionID: mission.id, conversationID: "ses_coordinator" } : null,
      latestResult: passageID ? null : { passageID: "pas_current", dueAt: 1, settledAt: 4, outcome: "completed" },
      history: passageID ? [] : [{ passageID: "pas_current", dueAt: 1, settledAt: 4, outcome: "completed" }] }] } satisfies MissionRecurrenceSnapshot) })
    if (path.endsWith("/rec_current/current")) {
      reads++
      if (!passageID) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: "rec_current", passageID: null } })
      return fail ? route.fulfill({ status: 503, json: { error: "Unknown coverage" } }) : route.fulfill({ json: { version: 1, projectID: "project", scheduleID: "rec_current", passageID, mission,
        activity: { generatedAt: 4, missions: [{ missionId: mission.id, actors: [{ sessionId: "ses_coordinator", state: "unknown" }, { sessionId: "ses_task", state: "running" }],
          family: { state: observed ? "observed" : "unknown", members: [
            { sessionId: "ses_coordinator", actorSessionId: "ses_coordinator", kind: "declared" },
            { sessionId: "ses_task", parentSessionId: "ses_coordinator", actorSessionId: "ses_task", kind: "declared" },
            { sessionId: "ses_child", parentSessionId: "ses_task", actorSessionId: "ses_task", kind: "ordinary" },
          ] } }] } } })
    }
    if (path.endsWith(`/rec_current/current/${passageID}/content`)) {
      const query = Object.fromEntries(new URL(route.request().url()).searchParams)
      const input = { ...query, scheduleID: "rec_current", passageID, page: Number(query.page), revision: Number(query.revision) }
      sourceReads.push(input)
      return route.fulfill({ json: currentRecurrenceContent(mission, input) })
    }
    const sessionID = path.match(/\/session\/(ses_task|ses_coordinator)$/)?.[1]
    if (sessionID) {
      nativeReads.push(sessionID)
      return route.fulfill({ json: { id: sessionID, ...(sessionID === "ses_task" ? { parentID: "ses_coordinator" } : {}), projectID: "project",
        agent: "build", title: sessionID, model: { providerID: "fixture", id: "fixture" }, location: { directory: "/fixture" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } } })
    }
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await page.getByRole("button", { name: "Daily commit review", exact: true }).click()
    await page.getByText("Review commits", { exact: true }).waitFor()
    assert.equal(reads, 1)
    assert.match(await page.locator(".mission-briefing-objective").innerText(), /Finite recurring review/)
    assert.equal(await page.getByText("Real child request", { exact: true }).count(), 1)
    assert.equal(await page.getByRole("button", { name: /Play|Pause|Stop|Request briefing|Give direction/ }).count(), 0, "isolated read never opens ordinary mutations")
    const order = await page.locator(".mission-control").evaluate(node => {
      const request = node.querySelector(".mission-attention-list")!, work = node.querySelector(".mission-route-list")!
      return Boolean(request.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    assert.equal(order, true, "human requests precede Work and any controls")
    assert.equal(await page.getByRole("button", { name: "Technical details", exact: true }).count(), 1,
      "the schedule view merges its technical identity into the passage's single Technical details")
    await captureMissionView(page, "current-tracking-desktop")
    if (process.env.CODENOMAD_MISSION_VIEW_EVIDENCE) {
      await page.setViewportSize({ width: 390, height: 850 })
      await page.evaluate(() => { document.documentElement.dir = "rtl" })
      await captureMissionView(page, "current-tracking-390-rtl")
      await page.evaluate(() => { document.documentElement.dir = "ltr" })
      await page.setViewportSize({ width: 1200, height: 950 })
    }
    await page.getByRole("button", { name: "Project briefing", exact: true }).click()
    await page.locator(".mission-reader").getByText("Exact passage briefing", { exact: true }).waitFor()
    assert.equal(reads, 1, "reader joins the existing visible snapshot demand")
    await page.locator(".mission-briefing-sources").getByRole("button", { name: "Review commits" }).click()
    await page.locator(".mission-reader").getByText("Exact isolated result", { exact: true }).waitFor()
    const target = await page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).missionProjectView("/fixture").reader)
    assert.deepEqual(target?.recurrence, { instanceId: "fixture", projectID: "project", scheduleID: "rec_current", passageID: "pas_current" })
    assert.ok(sourceReads.some(input => input.kind === "report" && input.itemId === "rpt_first" && input.section === "summary"), "result reader reads the exact isolated report page")
    assert.ok(sourceReads.every(input => input.scheduleID === "rec_current" && input.passageID === "pas_current" && input.revision === 4 && input.page === 0))
    const evidence = page.locator(".mission-reader article").filter({ has: page.getByRole("heading", { name: "Evidence", exact: true }) })
    await evidence.locator("input[type=number]").fill("2")
    assert.equal(sourceReads.some(input => input.section === "evidence" && input.page === 1), false, "typing a remote numeric draft does not submit its first digit")
    await evidence.locator("input[type=number]").press("Enter")
    await evidence.getByText(/Evidence:end/).waitFor()
    assert.ok(sourceReads.some(input => input.kind === "report" && input.itemId === "rpt_first" && input.section === "evidence" && input.page === 1))
    assert.ok((await evidence.locator("pre").innerText()).length <= 9_001)
    await captureMissionView(page, "current-report-desktop")
    if (process.env.CODENOMAD_CURRENT_PASSAGE_EVIDENCE) {
      await mkdir(process.env.CODENOMAD_CURRENT_PASSAGE_EVIDENCE, { recursive: true })
      await page.screenshot({ path: join(process.env.CODENOMAD_CURRENT_PASSAGE_EVIDENCE, "current-passage-reader.png"), fullPage: true })
    }
    await page.locator(".mission-task-dependencies").getByRole("button").click()
    await page.locator(".mission-reader").getByText("No result recorded for this task yet.").waitFor()
    assert.equal(await page.locator(".mission-reader .mission-inline-session").count(), 0, "unbound task never navigates to coordinator")
    await page.locator(".mission-reader").getByRole("button", { name: "Back to chat" }).click()
    const savedBriefing = mission.briefing
    mission.briefing = undefined
    await page.evaluate(() => (window as any).passageFixture.invalidate())
    await page.locator(".mission-briefing").getByRole("button", { name: "Overview", exact: true }).click()
    await page.locator(".mission-reader").getByText("Finite recurring review", { exact: true }).waitFor()
    await captureMissionView(page, "current-no-briefing-overview")
    await page.locator(".mission-reader").getByRole("button", { name: "Back to chat" }).click()
    mission.briefing = savedBriefing
    await page.evaluate(() => (window as any).passageFixture.invalidate())
    await page.locator('.mission-route-task[data-task-key="first"]').getByRole("button", { name: "Open Exact task actor" }).click()
    await page.waitForFunction(async () => (await import("/src/stores/sessions.ts")).activeSessionId().get("fixture") === "ses_task")
    await page.waitForFunction(() => !document.querySelector(".mission-control-stale"))
    assert.deepEqual(nativeReads, [], "current passage Work reuses only the exact loaded task actor and native parent")
    await page.getByRole("button", { name: "Technical details", exact: true }).first().click()
    await page.getByText("rec_current", { exact: true }).waitFor()
    await page.getByRole("button", { name: /Conversations/ }).click()
    await page.getByText("ses_child", { exact: true }).first().waitFor()
    fail = true
    await page.evaluate(() => (window as any).passageFixture.invalidate())
    await page.getByText(/last confirmed snapshot/).waitFor()
    assert.equal(await page.getByText("Review commits", { exact: true }).count(), 1, "failed refresh preserves map")
    await page.evaluate(() => (window as any).passageFixture.activate(false))
    const beforeHidden = reads
    await page.evaluate(() => (window as any).passageFixture.invalidate())
    await page.waitForTimeout(180)
    assert.equal(reads, beforeHidden, "hidden panel and closed reader do not read or poll")
    fail = false; observed = false
    await page.evaluate(() => (window as any).passageFixture.activate(true))
    await page.waitForResponse(response => response.url().endsWith("/rec_current/current"))
    assert.ok(reads > beforeHidden)
    await page.getByText("Native family unknown; only declared actors are shown.", { exact: true }).waitFor()
    assert.equal(writes.length, 0)
    passageID = null
    await page.evaluate(() => (window as any).passageFixture.settled())
    await page.getByText("No passage is currently admitted.", { exact: true }).waitFor()
    await page.getByRole("button", { name: /Passage history/, exact: false }).click()
    await page.getByText("Completed (archived)", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-route-task").count(), 0, "settlement after the final session event removes former passage Work through native invalidation")
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.getByLabel("Objective", { exact: true }).fill("One-shot from recurring")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.locator(".mission-control-index").getByRole("button", { name: "One-shot from recurring", exact: true }).waitFor()
    const selected = await page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).missionProjectView("/fixture").selectedRecurrence)
    assert.equal(selected, undefined, "successful one-shot creation clears overriding recurrence selection")
    assert.deepEqual(writes, ["/api/workspaces/fixture/missions"], "only the explicit creation uses a mock mutation")
    assert.deepEqual(errors, [])
  } catch (error) { console.error(errors, sourceReads, await page.locator("body").innerText(), await page.evaluate(async () => {
    const s = await import("/src/stores/sessions.ts")
    return { sessions: [...(s.sessions().get("fixture") ?? [])], active: s.activeSessionId().get("fixture") }
  })); throw error }
  finally { await page.close() }
})
