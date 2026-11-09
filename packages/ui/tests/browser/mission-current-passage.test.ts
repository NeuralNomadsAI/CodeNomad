import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type { MissionMap } from "../../../server/src/api-types"
import type { MissionRecurrenceSnapshot } from "../../src/stores/mission-recurrence"
/** The plugin wire also carries project identity, which the HTTP route does not project. */
type RecurrenceWireSnapshot = MissionRecurrenceSnapshot & { projectCanonical: string; location: { directory: string } }
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { currentRecurrenceContent } from "../../../server/src/missions/recurrence-current"
import { recurrenceCurrentPageInput } from "../../../server/src/missions/recurrence-current"
import { captureMissionView } from "./mission-view-capture"
import { inlineMissionEntry, missionMenuTrigger, missionRow, missionToolbar, missionToolbarAction, openTaskReader, selectMission, selectTaskMission,
  selectedMissionTitle } from "./mission-actions"
import { missionContentFixture, panelMissions } from "./mission-content-fixture"
import { NativeMissionDocumentStore } from "../../../server/src/missions/mission-document-store"
import { missionDocumentChanges } from "../../../server/src/missions/mission-document-state"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import type { MissionJsonValue } from "../../../server/src/missions/model"
import { projectMissionPanel } from "../../../server/src/missions/mission-panel-projection"
import { missionPanelPage } from "../../../server/src/missions/mission-panel-page"
import { contentDigest } from "../../../server/src/missions/content-digest"
import { readMissionContent } from "../../../server/src/missions/mission-content"
import { missionActivityContext } from "../../../server/src/missions/mission-activity-context"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "current-passage", configureServer(s) {
      s.middlewares.use("/api/events", (_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.write(": isolated event dispatcher\n\n") })
      s.middlewares.use("/passage", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/passage", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-current-passage.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } }).catch(async error => { await cache.dispose(); throw error })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/passage`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
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
  ], reports: [], briefing: { id: "brf_current", requestID: "briefing_request", basedOnRevision: 3, basedOnUpdatedAt: 3, createdAt: 3, summary: "Exact passage briefing",
    achieved: [{ text: "Reviewed", taskKeys: ["first"] }], ongoing: [], obstacles: [], next: [{ text: "Continue", taskKeys: ["second"] }] } }

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

async function setupReaderFollow(page: Page, nativePending = true) {
  page.setDefaultTimeout(10_000)
  const errors: string[] = [], writes: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const ordinary: MissionMap = { ...structuredClone(mission), id: "msn_one", objective: "One-time review", briefing: undefined,
    reports: [], tasks: [{ ...structuredClone(mission.tasks[1]), blockedBy: [] }], actors: [structuredClone(mission.actors[0])] }
  const values = new Map<string, MissionJsonValue>()
  const store = new NativeMissionDocumentStore({ get: async key => values.get(key),
    compareAndSet: async (key, value) => { values.set(key, structuredClone(value)) } }, "project", "/fixture")
  const doc = await store.create("msn_native", { title: "Native scheduled review", objective: "Saved native instructions", notes: "Saved native notes",
    template: "custom", profiles: { coordinator: { agent: "build", model: { providerID: "fixture", id: "fixture" } },
      roles: { specialist: { agent: "build", model: { providerID: "fixture", id: "fixture" } } } },
    taskMode: "native", profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory: "/fixture" }],
    watchedConversationIDs: [], launch: { when: [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }] } }, Date.now(), () => true)
  const startNative = () => {
    missionDocumentChanges.play(doc, "play_native", Date.now(), [])
    doc.synchronization = null
    missionDocumentChanges.reserve(doc, { kind: "manual", requestID: "run_native" }, Date.now(), [])
    missionDocumentChanges.admitted(doc, doc.pending!.id, Date.now())
  }
  if (nativePending) startNative()
  const passages = {
    rec_daily: { ...structuredClone(ordinary), id: "msn_daily_passage", objective: "Daily passage instructions" },
    msn_native: { ...structuredClone(ordinary), id: doc.pending?.missionID ?? "msn_native_passage", objective: "Native passage instructions" },
  }
  const passageID = (id: keyof typeof passages) => id === "rec_daily" ? "pas_daily" : doc.pending!.id
  const held = new Map<string, { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; settled: ReturnType<typeof deferred> }>()
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:JSON.parse(localStorage.getItem('passage-native')??'null')}),
    saveClientState:async(_token,snapshot)=>{localStorage.setItem('passage-native',JSON.stringify(snapshot));return true}}})`)
  await page.route("**/api/**", async route => {
    const request = route.request(), link = new URL(request.url()), path = link.pathname
    if (path === "/api/events") return route.continue()
    if (path === "/api/storage/config/ui") return route.fulfill({ json: { settings: { locale: "en" } } })
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions([ordinary]), generatedAt: 1, discardedEvents: 0 } })
    const content = missionContentFixture(request.url(), request.method(), [ordinary])
    if (content) return route.fulfill({ json: content })
    if (path.endsWith("/scheduled")) return route.fulfill({ json: { version: 1, projectID: "project", schedules: [missionScheduleView(doc).document] } })
    if (path.endsWith("/schedule")) return route.fulfill({ json: missionScheduleView(path.includes("/msn_native/") ? doc : undefined) })
    if (path.endsWith("/capabilities")) return route.fulfill({ json: { location: { directory: "/fixture" }, api: { available: true }, enabled: true,
      origin: null, activation: { available: true, targets: [] } } })
    if (path.endsWith("/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture",
      location: { directory: "/fixture" }, schedules: [{ id: "rec_daily", title: "Daily review", revision: 2, state: "paused", clock: { time: "08:15", zone: "UTC" },
        nextDueAt: null, actions: [], controls: [], pending: { passageID: "pas_daily", status: "running", missionID: passages.rec_daily.id }, latestResult: null, history: [] }] }) })
    const id = path.match(/\/recurrence\/(rec_daily|msn_native)\/current/)?.[1] as keyof typeof passages | undefined
    if (id) {
      const value = passages[id], scheduled = id === "msn_native"
      if (path.endsWith("/current")) {
        assert.equal(link.searchParams.get("owner"), scheduled ? "scheduled" : null)
        const gate = held.get(id)
        gate?.started.resolve()
        if (gate) await gate.release.promise
        try {
          if (scheduled && !doc.pending) return await route.fulfill({ json: { version: 1, ownerRevision: doc.revision,
            projectID: "project", scheduleID: id, passageID: null } }).catch(() => {})
          return await route.fulfill({ json: { version: 1, ownerRevision: doc.revision, projectID: "project", scheduleID: id, passageID: passageID(id),
          source: { owner: scheduled ? "scheduled" : "daily", projectID: "project", scheduleID: id, passageID: passageID(id), missionID: value.id,
            digest: "a".repeat(43), ...(scheduled ? { configurationGeneration: doc.configurationGeneration, timeGeneration: doc.timeGeneration } : {}) } } }) }
        finally { gate?.settled.resolve() }
      }
      if (path.endsWith("/page")) {
        const input = recurrenceCurrentPageInput.parse(request.postDataJSON()), damage = { discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
        if (input.body) return route.fulfill({ json: missionPanelPage({ source: "mission", field: "body", missionID: value.id, projectID: "project", revision: value.revision,
          ...damage, passage: input.source, window: { offset: 0, end: 1, total: 1, order: contentDigest(JSON.stringify(input.body)) } },
        [{ available: true, ...readMissionContent("project", input.body, value) }], input.selector.cursor) })
        if (input.selector.source === "activity") return route.fulfill({ json: missionPanelPage({ source: "activity", missionID: value.id, projectID: "project", revision: value.revision,
          ...damage, passage: input.source, phase: "observed", observedAt: 4 }, [{ context: missionActivityContext(value, damage), coverage: "observed",
          requests: { state: "observed", items: [] }, activity: { actors: [], family: { state: "observed", members: [] } } }], input.selector.cursor) })
        return route.fulfill({ json: projectMissionPanel(value, input.selector, damage, { passage: input.source }) })
      }
    }
    if (request.method() !== "GET") writes.push(path)
    return route.fulfill({ json: {} })
  })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
  await (await inlineMissionEntry(page, "One-time review")).waitFor()
  await page.evaluate(async () => (await import("/src/stores/forms.ts" as string)).removeFormFromQueue("fixture", "form_child"))
  return { errors, writes, ordinary, passages, passageID,
    startNative: () => { startNative(); passages.msn_native.id = doc.pending!.missionID },
    settleNative: () => missionDocumentChanges.settle(doc, doc.pending!.id, "completed", Date.now()),
    hold(id: keyof typeof passages) {
    const gate = { started: deferred(), release: deferred(), settled: deferred() }; held.set(id, gate); return gate
  } }
}

const readerTarget = (page: Page) => page.evaluate(async () => (await import("/src/stores/mission-view-state.ts" as string)).missionProjectView("/fixture").reader)
const eye = (page: Page) => missionToolbar(page).locator(".mission-overview-toggle")
const paint = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

test("pressed eye follows one-time → daily passage → native scheduled passage → one-time task", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
  try {
    const f = await setupReaderFollow(page)
    await selectMission(page, "One-time review"); await eye(page).click()
    await page.locator(".mission-reader").getByText("One-time review", { exact: true }).waitFor()
    for (const [id, title] of [["rec_daily", "Daily review"], ["msn_native", "Native scheduled review"]] as const) {
      await (await inlineMissionEntry(page, title)).click()
      await page.locator(".mission-reader").getByText(f.passages[id].objective, { exact: true }).waitFor()
      assert.equal(await eye(page).getAttribute("aria-pressed"), "true")
      assert.deepEqual(await readerTarget(page), { missionId: f.passages[id].id, kind: "overview", recurrence: {
        instanceId: "fixture", projectID: "project", scheduleID: id, passageID: f.passageID(id), ...(id === "msn_native" ? { owner: "scheduled" } : {}) } })
    }
    await selectMission(page, "One-time review")
    await page.locator(".mission-reader").getByText("One-time review", { exact: true }).waitFor()
    await page.locator('.mission-tree .mission-tree-node[data-task-key="second"] .mission-tree-task').click()
    await page.locator(".mission-reader").getByRole("heading", { name: "Next task has no actor", exact: true }).waitFor()
    await page.locator(".mission-reader").getByText("No result recorded for this task yet.", { exact: true }).waitFor()
    assert.deepEqual(await readerTarget(page), { missionId: f.ordinary.id, kind: "task", itemId: "tsk_second" })
    assert.equal(await eye(page).getAttribute("aria-pressed"), "true")
    assert.deepEqual(f.errors, []); assert.deepEqual(f.writes, [])
  } finally { await page.close() }
})

for (const [id, title] of [["rec_daily", "Daily review"], ["msn_native", "Native scheduled review"]] as const) {
  for (const close of [false, true]) test(`held ${id} current response cannot ${close ? "reopen the released eye" : "follow after switching selection"}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
    let gate: ReturnType<Awaited<ReturnType<typeof setupReaderFollow>>["hold"]> | undefined
    try {
      const f = await setupReaderFollow(page)
      await selectMission(page, "One-time review"); await eye(page).click()
      await page.locator(".mission-reader").getByText("One-time review", { exact: true }).waitFor()
      gate = f.hold(id)
      await (await inlineMissionEntry(page, title)).click(); await gate.started.promise
      assert.equal((await readerTarget(page))?.kind, "recurrence", "the pending read first follows to its schedule")
      if (close) {
        await eye(page).click()
        await page.locator(".mission-reader").waitFor({ state: "detached" })
      } else {
        await (await inlineMissionEntry(page, "One-time review")).click()
        await page.locator(".mission-reader").getByText("One-time review", { exact: true }).waitFor()
      }
      gate.release.resolve(); await gate.settled.promise; await paint(page)
      if (close) {
        // The selected schedule still demands its passage: prove it rendered after release.
        await page.locator(`section.mission-detail[aria-label="${title}"] .mission-tree .mission-tree-node[data-task-key="second"]`).waitFor({ state: "attached" })
        assert.equal(await readerTarget(page), undefined)
        assert.equal(await eye(page).getAttribute("aria-pressed"), "false")
        assert.equal(await page.locator(".mission-reader").count(), 0)
        await (await inlineMissionEntry(page, "One-time review")).click()
        assert.equal(await page.locator(".mission-reader").count(), 0, "later row selections keep the eye released")
        await page.locator('.mission-tree .mission-tree-node[data-task-key="second"] .mission-tree-task').click()
        assert.equal(await page.locator(".mission-reader").count(), 0, "later task selections keep the eye released")
      } else assert.deepEqual(await readerTarget(page), { missionId: f.ordinary.id, kind: "overview" })
      assert.deepEqual(f.errors, []); assert.deepEqual(f.writes, [])
    } finally { gate?.release.resolve(); await page.close() }
  })
}

test("native schedule without a passage opens its saved configuration centrally and follows back to one-time", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
  try {
    const f = await setupReaderFollow(page, false)
    await (await inlineMissionEntry(page, "Native scheduled review")).click(); await eye(page).click()
    await page.locator(".mission-reader").getByText("Saved native instructions", { exact: true }).waitFor()
    await page.locator(".mission-reader").getByText("Saved native notes", { exact: true }).waitFor()
    assert.deepEqual(await readerTarget(page), { kind: "recurrence", missionId: "msn_native", instanceId: "fixture", projectID: "project", scheduleOwner: "scheduled" })
    assert.equal(await eye(page).getAttribute("aria-pressed"), "true")
    await (await inlineMissionEntry(page, "One-time review")).click()
    await page.locator(".mission-reader").getByText("One-time review", { exact: true }).waitFor()
    assert.deepEqual(await readerTarget(page), { missionId: f.ordinary.id, kind: "overview" })
    assert.deepEqual(f.errors, []); assert.deepEqual(f.writes, [])
  } finally { await page.close() }
})

test("a pressed schedule eye stays pressed when its first passage becomes current", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
  try {
    const f = await setupReaderFollow(page, false)
    await selectMission(page, "Native scheduled review"); await eye(page).click()
    await page.locator(".mission-reader").getByText("Saved native instructions", { exact: true }).waitFor()
    f.startNative()
    await page.evaluate(() => (window as any).passageFixture.invalidate("plugin.updated"))
    await page.locator('section.mission-detail[aria-label="Native scheduled review"] .mission-tree-task').waitFor()
    assert.equal(await eye(page).getAttribute("aria-pressed"), "true", "a new passage preserves the eye mode")
    await eye(page).click()
    await page.locator(".mission-reader").waitFor({ state: "detached" })
    assert.deepEqual(f.errors, []); assert.deepEqual(f.writes, [])
  } finally { await page.close() }
})

for (const remount of [false, true]) test(`native settlement retires its selected task and follows to configuration ${remount ? "on remount" : "before the held current response"}`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
  let gate: ReturnType<Awaited<ReturnType<typeof setupReaderFollow>>["hold"]> | undefined
  const listGate = deferred()
  try {
    const f = await setupReaderFollow(page)
    await selectMission(page, "Native scheduled review")
    await page.locator('section.mission-detail[aria-label="Native scheduled review"] .mission-tree-task').click()
    await eye(page).click()
    await page.locator(".mission-reader").getByText("No result recorded for this task yet.", { exact: true }).waitFor()
    await page.evaluate(async () => (await import("/src/stores/client-state.ts" as string)).flushClientState())
    f.settleNative()
    if (remount) {
      // Restore the former task/reader against a newly read document without a passage.
      // No current-source snapshot exists to run the ordinary passage cleanup effect.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 })
    } else {
      gate = f.hold("msn_native")
      await page.route("**/missions/scheduled", async route => { await listGate.promise; return route.fallback() })
      await page.evaluate(() => (window as any).passageFixture.invalidate("plugin.updated"))
      await gate.started.promise
      listGate.resolve()
    }
    const assertSettled = async () => {
      await page.locator(".mission-reader").getByText("Saved native instructions", { exact: true }).waitFor()
      const view = await page.evaluate(async () => (await import("/src/stores/mission-view-state.ts" as string)).missionProjectView("/fixture"))
      assert.equal(view.selectedTask, undefined)
      assert.equal(view.selectedScheduled, "msn_native")
      assert.deepEqual(view.reader, { kind: "recurrence", missionId: "msn_native", instanceId: "fixture", projectID: "project", scheduleOwner: "scheduled" })
      assert.equal(await eye(page).isEnabled(), true)
      assert.equal(await eye(page).getAttribute("aria-pressed"), "true")
      assert.equal(await missionToolbar(page).getByRole("button", { name: "Stop…", exact: true }).isEnabled(), true)
      assert.equal(await page.locator(".mission-tree").count(), 0)
    }
    await assertSettled()
    if (gate) {
      gate.release.resolve(); await gate.settled.promise; await paint(page)
      await assertSettled()
    }
    await eye(page).click()
    await page.locator(".mission-reader").waitFor({ state: "detached" })
    assert.equal(await readerTarget(page), undefined)
    assert.deepEqual(f.errors, []); assert.deepEqual(f.writes, [])
  } finally { listGate.resolve(); gate?.release.resolve(); await page.close() }
})

test("actual MissionControl reuses the current task tree and attention, with briefing and identifiers in the central exact-source reader", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1200, height: 950 } }), errors: string[] = [], writes: string[] = []
  page.setDefaultTimeout(8_000)
  let reads = 0, fail = false, passageID: string | null = "pas_current", observed = true, ordinary: MissionMap | undefined
  let hold: Promise<void> | undefined
  const nativeReads: string[] = []
  const sourceReads: Array<Record<string, unknown>> = []
  page.on("pageerror", error => errors.push(error.message))
  const init = `Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`
  await page.addInitScript(init)
  const api = async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (hold && path.endsWith("/rec_current/current")) await hold
    if (path.endsWith("/missions/scheduled")) return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
    if (path === "/api/events") return route.continue()
    if (path === "/api/storage/config/ui") return route.fulfill({ json: { settings: { locale: "en" } } })
    if (/\/rec_current\/current\/[^/]+\/page$/.test(path)) {
      const parsed = recurrenceCurrentPageInput.safeParse(route.request().postDataJSON())
      if (!parsed.success) return route.fulfill({ status: 400, json: { error: "Invalid display selector" } })
      const input = parsed.data, selector = input.selector
      if (input.source.passageID !== passageID) return route.fulfill({ json: { available: false, reason: "changed" } })
      if (fail) return route.fulfill({ status: 503, json: { error: "Unknown coverage" } })
      const current = { ...mission, reports: [...mission.reports, ...mission.tasks.flatMap(task => task.report ? [task.report] : [])] }
      const damage = { discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
      if (input.body) {
        sourceReads.push({ ...input.body, scheduleID: input.source.scheduleID, passageID: input.source.passageID })
        return route.fulfill({ json: missionPanelPage({ source: "mission", field: "body", missionID: mission.id, projectID: "project", revision: mission.revision,
          ...damage, passage: input.source, window: { offset: 0, end: 1, total: 1, order: contentDigest(JSON.stringify(input.body)) } },
        [{ available: true, ...readMissionContent("project", input.body, current) }], selector.cursor) })
      }
      if (selector.source === "activity") {
        const context = missionActivityContext(mission, damage)
        return route.fulfill({ json: missionPanelPage({ source: "activity", missionID: mission.id, projectID: "project", revision: mission.revision, ...damage,
          passage: input.source, phase: "observed", observedAt: 4 }, [{ context, coverage: observed ? "observed" : "unknown",
          requests: { state: observed ? "observed" : "unknown", items: [] }, activity: { actors: [{ sessionId: "ses_coordinator", state: "unknown" }, { sessionId: "ses_task", state: "running" }],
            family: { state: observed ? "observed" : "unknown", members: [{ sessionId: "ses_coordinator", actorSessionId: "ses_coordinator", kind: "declared" },
              { sessionId: "ses_task", parentSessionId: "ses_coordinator", actorSessionId: "ses_task", kind: "declared" },
              { sessionId: "ses_child", parentSessionId: "ses_task", actorSessionId: "ses_task", kind: "ordinary" }] } } }], selector.cursor) })
      }
      return route.fulfill({ json: projectMissionPanel(current, selector, damage, { passage: input.source }) })
    }
    if (route.request().method() !== "GET") writes.push(path)
    if (path.endsWith("/missions")) {
      if (route.request().method() === "POST") {
        ordinary = { ...mission, id: "msn_ordinary", objective: route.request().postDataJSON().objective, tasks: [], reports: [], briefing: undefined }
        return route.fulfill({ json: { mission: ordinary } })
      }
      return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(ordinary ? [ordinary] : []), generatedAt: 1, discardedEvents: 0 } })
    }
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [{ id: "rec_current", title: "Daily commit review", revision: 2,
      state: "interrupted", interruptionReason: "service-restart", clock: { time: "08:15", zone: "UTC" }, nextDueAt: null, actions: [], controls: [],
      pending: passageID ? { passageID, status: "running", missionID: mission.id, conversationID: "ses_coordinator" } : null,
      latestResult: passageID ? null : { passageID: "pas_current", dueAt: 1, settledAt: 4, outcome: "completed" },
      history: passageID ? [] : [{ passageID: "pas_current", dueAt: 1, settledAt: 4, outcome: "completed" }] }] } satisfies RecurrenceWireSnapshot) })
    if (path.endsWith("/rec_current/current")) {
      reads++
      if (!passageID) return route.fulfill({ json: { version: 1, ownerRevision: 4, projectID: "project", scheduleID: "rec_current", passageID: null } })
      return fail ? route.fulfill({ status: 503, json: { error: "Unknown coverage" } }) : route.fulfill({ json: { version: 1, ownerRevision: 4, projectID: "project", scheduleID: "rec_current", passageID,
        source: { owner: "daily", projectID: "project", scheduleID: "rec_current", passageID, missionID: mission.id, digest: "a".repeat(43) } } })
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
  }
  await page.route("**/api/**", api)
  try {
    {
      // A red row's deferred answer is dropped when the conversation changes before its
      // passage's question is discovered: never replayed into a newer view.
      const probe = await browser.newPage({ locale: "en-US", viewport: { width: 1200, height: 950 } })
      await probe.addInitScript(init); await probe.route("**/api/**", api)
      let release!: () => void
      hold = new Promise(resolve => { release = resolve })
      try {
        await probe.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
        const row = await inlineMissionEntry(probe, "Daily commit review")
        await row.locator('.mission-row-flag[data-mark="permission"]').waitFor({ timeout: 30_000 })
        await row.click()
        await probe.evaluate(async () => (await import("/src/stores/mission-view-state.ts" as string)).updateMissionProjectView("/fixture", { reader: { missionId: "custom", kind: "playbook", taskMode: "native" } }))
        release(); hold = undefined
        await probe.locator(".mission-tree").getByText("Review commits", { exact: true }).waitFor({ state: "attached" })
        await probe.waitForTimeout(500)
        assert.notEqual(await probe.evaluate(async () => (await import("/src/stores/sessions.ts" as string)).activeSessionId().get("fixture")), "ses_child")
      } finally { release(); hold = undefined; await probe.close() }
      reads = 0; nativeReads.length = 0; sourceReads.length = 0
    }
    {
      // A click whose question is answered before its passage is read retires once
      // discovery settles: a later, unrelated question never triggers it.
      const probe = await browser.newPage({ locale: "en-US", viewport: { width: 1200, height: 950 } })
      await probe.addInitScript(init); await probe.route("**/api/**", api)
      let release!: () => void
      hold = new Promise(resolve => { release = resolve })
      const active = () => probe.evaluate(async () => (await import("/src/stores/sessions.ts" as string)).activeSessionId().get("fixture"))
      try {
        await probe.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
        const row = await inlineMissionEntry(probe, "Daily commit review")
        await row.locator('.mission-row-flag[data-mark="permission"]').waitFor({ timeout: 30_000 })
        await row.click()
        await probe.evaluate(async () => (await import("/src/stores/forms.ts" as string)).removeFormFromQueue("fixture", "form_child"))
        release(); hold = undefined
        await probe.locator(".mission-tree").getByText("Review commits", { exact: true }).waitFor({ state: "attached" })
        await probe.waitForTimeout(500)
        await probe.evaluate(async () => (await import("/src/stores/forms.ts" as string)).addFormToQueue("fixture", { id: "form_later", sessionID: "ses_child",
          location: { directory: "/fixture" }, title: "Later question", tool: { name: "question" }, fields: [], time: { created: 2 } } as never))
        await probe.locator('.mission-row-select[aria-current=true] .mission-row-flag[data-mark="permission"]').waitFor()
        await probe.waitForTimeout(500)
        assert.notEqual(await active(), "ses_child", "the retired click opens nothing later")
      } finally { release(); hold = undefined; await probe.close() }
      reads = 0; nativeReads.length = 0; sourceReads.length = 0
    }
    {
      // A click whose first passage read fails retires too: the read after a refresh
      // never opens a later, unrelated question.
      const probe = await browser.newPage({ locale: "en-US", viewport: { width: 1200, height: 950 } })
      await probe.addInitScript(init); await probe.route("**/api/**", api)
      let release!: () => void
      hold = new Promise(resolve => { release = resolve })
      const active = () => probe.evaluate(async () => (await import("/src/stores/sessions.ts" as string)).activeSessionId().get("fixture"))
      try {
        await probe.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
        const row = await inlineMissionEntry(probe, "Daily commit review")
        await row.locator('.mission-row-flag[data-mark="permission"]').waitFor({ timeout: 30_000 })
        await row.click()
        await probe.evaluate(async () => (await import("/src/stores/forms.ts" as string)).removeFormFromQueue("fixture", "form_child"))
        fail = true
        release(); hold = undefined
        // (The selected row is folded: its detail's read status is mounted, not shown.)
        await probe.getByText(/Schedules could not be loaded|last confirmed snapshot/).first().waitFor({ state: "attached" })
        fail = false
        await probe.evaluate(async () => (await import("/src/stores/forms.ts" as string)).addFormToQueue("fixture", { id: "form_later", sessionID: "ses_child",
          location: { directory: "/fixture" }, title: "Later question", tool: { name: "question" }, fields: [], time: { created: 2 } } as never))
        await probe.evaluate(() => (window as any).passageFixture.invalidate())
        await probe.locator(".mission-tree").getByText("Review commits", { exact: true }).waitFor({ state: "attached" })
        await probe.locator('.mission-row-select[aria-current=true] .mission-row-flag[data-mark="permission"]').waitFor()
        await probe.waitForTimeout(500)
        assert.notEqual(await active(), "ses_child", "the failed click opens nothing later")
      } finally { release(); hold = undefined; fail = false; await probe.close() }
      reads = 0; nativeReads.length = 0; sourceReads.length = 0
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
    // A first click on the red row opens the passage's question once it is discovered.
    const card = await selectMission(page, "Daily commit review")
    for (let attempt = 0; await page.evaluate(async () => (await import("/src/stores/sessions.ts" as string)).activeSessionId().get("fixture")) !== "ses_child" && attempt < 100; attempt++) await page.waitForTimeout(50)
    assert.equal(await page.evaluate(async () => (await import("/src/stores/sessions.ts" as string)).activeSessionId().get("fixture")), "ses_child")
    await card.locator(".mission-tree").getByText("Review commits", { exact: true }).waitFor()
    assert.equal(reads, 1)
    assert.equal(await page.locator(".mission-picker section.mission-detail").count(), 0, "the detail is the selected row's children, never in the header")
    assert(!(await card.innerText()).includes("Exact passage briefing"), "briefing prose belongs to the central reader")
    // The passage's open child request shows on the schedule's row; the question opens in the dock.
    await page.locator('.mission-row-select[aria-current=true] .mission-row-flag[data-mark="permission"]').waitFor()
    assert.equal(await card.getByText("Real child request", { exact: true }).count(), 0)
    // Schedule controls name their schedule; the isolated passage never offers one-time Mission mutations.
    // Toolbar buttons stay in place; a schedule without actions keeps them all disabled.
    const mutations = await page.getByRole("button", { name: /^(Start|Pause|Resume|Stop|Run|Send|Request an update)/ })
      .evaluateAll(nodes => nodes.map(node => [node.getAttribute("aria-label"), (node as HTMLButtonElement).disabled]))
    assert.deepEqual(mutations, [["Start", true], ["Stop schedule Daily commit review", true], ["Run Daily commit review now", true]],
      "isolated read never opens ordinary mutations")
    assert.equal(await missionToolbarAction(page, "Delete selected mission…").isDisabled(), true, "Delete stays disabled for a schedule")
    assert.equal(await card.locator("form, textarea").count(), 0, "no coordinator field in the panel")
    assert.equal(await missionMenuTrigger(page).isDisabled(), true, "the overflow menu (Edit included) has nothing to offer")
    assert.equal(await card.getByRole("button", { name: /Technical details|More|Conversations/ }).count(), 0, "no secondary disclosures in the panel")
    await captureMissionView(page, "current-tracking-desktop")
    if (process.env.CODENOMAD_MISSION_VIEW_EVIDENCE) {
      await page.setViewportSize({ width: 390, height: 850 })
      await page.evaluate(() => { document.documentElement.dir = "rtl" })
      await captureMissionView(page, "current-tracking-390-rtl")
      await page.evaluate(() => { document.documentElement.dir = "ltr" })
      await page.setViewportSize({ width: 1200, height: 950 })
    }
    const overview = missionToolbar(page).getByRole("button", { name: "Summary", exact: true })
    await overview.click()
    await page.locator(".mission-reader").getByText("Exact passage briefing", { exact: true }).waitFor()
    assert.equal(await overview.getAttribute("aria-pressed"), "true")
    assert.equal(reads, 1, "reader joins the existing visible snapshot demand")
    const historical = mission.tasks[0].report!
    mission.reports.push(historical)
    mission.tasks[0].report = { ...historical, id: "rpt_newer", summary: "Newer result must not replace the historical body", createdAt: 4 }
    // A long source title wraps within a narrow reader instead of overflowing it.
    const source = page.locator(".mission-briefing-sources").getByRole("button", { name: "Review commits" })
    assert.equal(await source.evaluate(element => {
      const original = element.textContent, parent = element.parentElement!
      element.textContent = "Review every commit of the release branch and reconcile the changelog ".repeat(3)
      parent.style.width = "240px"
      const fits = element.getBoundingClientRect().right <= parent.getBoundingClientRect().right + 1 && element.scrollWidth <= element.clientWidth + 1
      element.textContent = original; parent.style.width = ""
      return fits
    }), true, "a long briefing source wraps within its container")
    await source.click()
    await page.locator(".mission-reader").getByText("Exact isolated result", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").getByText("Newer result must not replace the historical body", { exact: true }).count(), 0)
    mission.tasks[0].report = historical
    const target = await page.evaluate(async () => (await import("/src/stores/mission-view-state.ts" as string)).missionProjectView("/fixture").reader)
    assert.deepEqual(target?.recurrence, { instanceId: "fixture", projectID: "project", scheduleID: "rec_current", passageID: "pas_current" })
    assert.ok(sourceReads.some(input => input.kind === "report" && input.reportId === "rpt_first" && input.field === "summary"), "result reader reads the exact isolated report body")
    assert.ok(sourceReads.every(input => input.scheduleID === "rec_current" && input.passageID === "pas_current" && input.missionID === mission.id))
    const evidence = page.locator(".mission-reader article").filter({ has: page.getByRole("heading", { name: "Evidence", exact: true }) })
    const readsBeforeDraft = sourceReads.length
    await evidence.locator("input[type=number]").fill("2")
    assert.equal(await evidence.getByText(/Evidence:end/).count(), 0, "typing a remote numeric draft does not commit its page")
    assert.equal(sourceReads.length, readsBeforeDraft)
    await evidence.locator("input[type=number]").press("Enter")
    await evidence.getByText(/Evidence:end/).waitFor()
    assert.ok(sourceReads.some(input => input.kind === "report" && input.reportId === "rpt_first" && input.field === "evidence"))
    assert.ok((await evidence.innerText()).length < 9_500)
    await captureMissionView(page, "current-report-desktop")
    if (process.env.CODENOMAD_CURRENT_PASSAGE_EVIDENCE) {
      await mkdir(process.env.CODENOMAD_CURRENT_PASSAGE_EVIDENCE, { recursive: true })
      await page.screenshot({ path: join(process.env.CODENOMAD_CURRENT_PASSAGE_EVIDENCE, "current-passage-reader.png"), fullPage: true })
    }
    // A finished task no longer points at work it unblocked; open the unbound follow-up from the tree.
    assert.equal(await page.locator(".mission-task-dependencies").getByRole("button", { name: /^Unblocks/ }).count(), 0)
    // The open reader follows the selection: selecting the task shows its own reader.
    await page.locator('.mission-tree .mission-tree-node[data-task-key="second"] .mission-tree-task').click()
    await page.locator(".mission-reader").getByText("No result recorded for this task yet.").waitFor()
    assert.equal(await page.locator(".mission-reader .mission-reader-open").count(), 0, "unbound task never navigates to coordinator")
    await page.locator(".mission-reader").getByRole("button", { name: "Back to chat" }).click()
    // Selecting the schedule's row gives the toolbar (and its Summary eye) back to the schedule.
    await selectTaskMission(page)
    const savedBriefing = mission.briefing
    mission.briefing = undefined
    const withoutBriefing = page.waitForResponse(response => response.url().endsWith("/rec_current/current"))
    await page.evaluate(() => (window as any).passageFixture.invalidate())
    await withoutBriefing
    // Let the refreshed snapshot reach Solid before the reader chooses its sections.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await overview.click()
    await page.locator(".mission-reader").getByText("Finite recurring review", { exact: true }).waitFor()
    // Identifiers are folded at the bottom of the overview reader, including the schedule's.
    await page.locator(".mission-reader details.mission-report-technical > summary").filter({ hasText: "Technical details" }).click()
    await page.locator(".mission-reader .mission-technical").getByText("rec_current", { exact: true }).waitFor()
    await captureMissionView(page, "current-no-briefing-overview")
    await page.locator(".mission-reader").getByRole("button", { name: "Back to chat" }).click()
    mission.briefing = savedBriefing
    await page.evaluate(() => (window as any).passageFixture.invalidate())
    const firstTask = page.locator('.mission-tree .mission-tree-node[data-task-key="first"] .mission-tree-task')
    await openTaskReader(firstTask)
    // The selected passage task takes the header toolbar from its schedule: read-only,
    // with the task's own conversation, and Summary toggling the task's reader.
    const toolbar = page.locator(".mission-picker-selection-actions .mission-action-bar")
    await toolbar.getByRole("button", { name: "Open the task's conversation", exact: true }).waitFor()
    // Every button keeps its schedule position: Run now stays as a disabled slot.
    const positions = () => toolbar.locator(":scope > button, :scope .action-overflow-trigger").evaluateAll(items =>
      items.map(item => Math.round(item.getBoundingClientRect().x)))
    const taskPositions = await positions()
    assert.equal(await toolbar.getByRole("button", { name: "Run now", exact: true }).isDisabled(), true)
    assert.equal(await toolbar.count(), 1, "the schedule's toolbar yields the line")
    assert.equal(await toolbar.getByRole("button", { name: /^Stop schedule/ }).count(), 0)
    assert.equal(await toolbar.locator("button").first().isDisabled(), true, "a passage task is never recovered from the panel")
    assert.equal(await toolbar.locator(".mission-overview-toggle").getAttribute("aria-pressed"), "true")
    // Its eye closes the task's reader; the task keeps the toolbar until the schedule row is selected.
    await toolbar.locator(".mission-overview-toggle").click()
    await page.locator(".mission-reader").waitFor({ state: "detached" })
    assert.equal(await toolbar.getByRole("button", { name: "Open the task's conversation", exact: true }).count(), 1)
    await selectTaskMission(page)
    await toolbar.getByRole("button", { name: /^Stop schedule/ }).waitFor()
    assert.deepEqual(await positions(), taskPositions, "the hand-off moves no button")
    await openTaskReader(firstTask)
    await toolbar.getByRole("button", { name: "Open the task's conversation", exact: true }).waitFor()
    await page.locator(".mission-reader").getByRole("button", { name: "Open conversation", exact: true }).click()
    await page.waitForFunction(async () => (await import("/src/stores/sessions.ts" as string)).activeSessionId().get("fixture") === "ses_task")
    await page.waitForFunction(() => !document.querySelector(".mission-control-stale"))
    assert.deepEqual(nativeReads, [], "current passage task navigation reuses only the exact loaded task actor and native parent")
    // The red schedule row opens its passage's question: the asking descendant's conversation.
    const active = () => page.evaluate(async () => (await import("/src/stores/sessions.ts" as string)).activeSessionId().get("fixture"))
    assert.equal(await active(), "ses_task")
    // The passage task is still the selection; the schedule row keeps its red flag.
    const scheduleRow = await inlineMissionEntry(page, "Daily commit review")
    assert.equal(await scheduleRow.getAttribute("aria-current"), null)
    assert.equal(await scheduleRow.locator(".mission-row-flag").getAttribute("data-mark"), "permission")
    await scheduleRow.click()
    // (An async waitForFunction predicate resolves at once: poll from the test instead.)
    for (let attempt = 0; await active() !== "ses_child" && attempt < 100; attempt++) await page.waitForTimeout(50)
    assert.equal(await active(), "ses_child")
    assert.deepEqual(nativeReads, [], "the loaded asking conversation is reused")
    fail = true
    await page.evaluate(() => (window as any).passageFixture.invalidate())
    await page.getByText(/last confirmed snapshot/).waitFor()
    assert.equal(await card.locator(".mission-tree").getByText("Review commits", { exact: true }).count(), 1, "failed refresh preserves map")
    assert.equal(await card.locator('.mission-tree .mission-tree-node[data-task-key="first"]').count(), 1)
    await page.evaluate(() => (window as any).passageFixture.activate(false))
    const beforeHidden = reads
    await page.evaluate(() => (window as any).passageFixture.invalidate())
    await page.waitForTimeout(180)
    assert.equal(reads, beforeHidden, "hidden panel and closed reader do not read or poll")
    fail = false; observed = false
    await page.evaluate(() => (window as any).passageFixture.activate(true))
    await page.waitForResponse(response => response.url().endsWith("/rec_current/current"))
    assert.ok(reads > beforeHidden)
    assert.equal(writes.length, 0)
    passageID = null
    // The list and the current passage revalidate independently from the same
    // native event; bind the tree assertion to the passage read it triggers.
    const settledPassage = page.waitForResponse(async response => response.url().endsWith("/rec_current/current")
      && (await response.json()).passageID === null)
    await page.evaluate(() => (window as any).passageFixture.settled())
    await card.locator("button.mission-past-run").getByText(/Completed$/).waitFor()
    await settledPassage
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.locator(".mission-tree").count(), 0, "settlement after the final session event removes the former passage tree through native invalidation")
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.getByLabel("Objective", { exact: true }).fill("One-shot from recurring")
    await page.getByRole("button", { name: "Create", exact: true }).click()
    // The created one-time Mission becomes the picker's current selection.
    await selectedMissionTitle(page).getByText("One-shot from recurring", { exact: true }).waitFor()
    // Its plan holds no task yet: the row has no chevron, so its detail stays folded.
    await page.locator('section.mission-detail[aria-label="One-shot from recurring"]').waitFor({ state: "attached" })
    assert.equal(await missionRow(page, "One-shot from recurring").locator("button.session-item-expander").count(), 0)
    const selected = await page.evaluate(async () => (await import("/src/stores/mission-view-state.ts" as string)).missionProjectView("/fixture").selectedRecurrence)
    assert.equal(selected, undefined, "successful one-shot creation clears overriding recurrence selection")
    assert.deepEqual(writes, ["/api/workspaces/fixture/missions"], "only the explicit creation uses a mock mutation")
    assert.deepEqual(errors, [])
  } catch (error) {
    // Diagnostics never replace the failure they describe.
    console.error(errors, sourceReads, await page.locator("body").innerText().catch(String), await page.evaluate(async () => {
      const s = await import("/src/stores/sessions.ts" as string)
      return { sessions: [...(s.sessions().get("fixture") ?? [])], active: s.activeSessionId().get("fixture") }
    }).catch(String)); throw error
  }
  finally { await page.close() }
})
