import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionActor, MissionActorActivity, MissionMap } from "../../../server/src/api-types"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { inlineMissionEntry, missionPicker, missionPickerExpander, missionPickerField, missionToolbarAction, selectMission } from "./mission-actions"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-status-marks", configureServer(s) { s.middlewares.use("/mission-fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/mission-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

const actor = (sessionId: string, kind: MissionActor["kind"] = "coordinator"): MissionActor =>
  ({ sessionId, title: sessionId, kind, managed: kind === "specialist", roles: [kind], location: { directory: "fixture" }, joinedAt: 1 })
function mission(id: string, patch: Partial<MissionMap> = {}): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [actor(`ses_${id}`)], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false, reports: [],
    tasks: [{ id: `task-${id}`, key: "task-one", title: "Inspect evidence", brief: "Brief", role: "research", status: "completed",
      blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }], ...patch }
}

async function open(missions: () => MissionMap[], activity: () => Array<{ missionId: string; actors: MissionActorActivity[] }>,
  schedules: RecurrenceSchedule[] = []) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  const errors: string[] = [], recoveries: unknown[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
    claimClientStateAccess: async () => true,
    loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(localStorage.getItem("fixture-native") ?? "null") }),
    saveClientState: async (_token, snapshot) => { localStorage.setItem("fixture-native", JSON.stringify(snapshot)); return true },
  } })`)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: missions(),
    generatedAt: Date.now(), discardedEvents: 0, activity: { generatedAt: Date.now(), missions: activity() } } }))
  await page.route(url => url.pathname === "/api/workspaces/fixture/missions/recurrence", route => route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1,
    projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules }) }))
  await page.route("**/api/workspaces/fixture/missions/*/recover", route => {
    recoveries.push(route.request().postDataJSON())
    return route.fulfill({ json: { mission: missions()[0], admitted: true } })
  })
  await page.goto(url)
  return { page, errors, recoveries }
}
const fixtureCall = (page: Page, method: string) => page.evaluate(method => (window as any).missionFixture[method](), method)
async function refresh(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith("/missions"))
  await fixtureCall(page, "refresh")
  await response
}
const mark = async (page: Page, title: string) => (await inlineMissionEntry(page, title)).locator(".mission-picker-mark").getAttribute("data-mark")
async function collapse(page: Page) {
  const expander = missionPickerExpander(page)
  if (await expander.getAttribute("aria-expanded") === "true") await expander.click()
  return expander
}

test("marks follow the session palette and a completion stays green until this window shows it", async () => {
  let list = [
    mission("stuck", { updatedAt: 6 }),
    mission("working", { updatedAt: 5 }),
    mission("history", { updatedAt: 4, status: "completed" }),
    mission("failed", { updatedAt: 3, status: "failed" }),
    mission("paused", { updatedAt: 2, runState: "paused" }),
  ]
  let activity = [{ missionId: "stuck", actors: [{ sessionId: "ses_stuck", state: "idle-without-report" as const }] },
    { missionId: "working", actors: [{ sessionId: "ses_working", state: "running" as const }] }]
  const { page, errors } = await open(() => list, () => activity)
  try {
    // Collapsed, the chevron counts the other missions' attention, like a session parent.
    const expander = missionPickerExpander(page)
    await page.waitForFunction(() => document.querySelector(".mission-picker-expander")?.getAttribute("data-attention") === "interrupted")
    assert.equal(await expander.getAttribute("aria-label"), "Show all missions (2 interrupted, 1 running)")
    assert.deepEqual(await Promise.all(["Objective stuck", "Objective working", "Objective history", "Objective failed", "Objective paused"]
      .map(title => mark(page, title))), ["interrupted", "working", "idle", "interrupted", "paused"])
    assert.equal(await expander.getAttribute("data-attention"), null, "the open list shows each mark itself")
    assert.equal(await expander.getAttribute("aria-label"), "Hide the mission list")

    list = list.map(value => value.id === "working" ? { ...value, status: "completed", updatedAt: 7, revision: 2 } : value)
    activity = activity.filter(item => item.missionId !== "working")
    await refresh(page)
    await page.waitForFunction(() => [...document.querySelectorAll(".mission-picker-inline .mission-picker-mark")]
      .some(element => element.getAttribute("data-mark") === "done"))
    assert.equal(await mark(page, "Objective working"), "done")
    assert.equal(await mark(page, "Objective history"), "idle", "missions already completed on the first read count as seen")
    await collapse(page)
    assert.equal(await expander.getAttribute("aria-label"), "Show all missions (2 interrupted, 1 finished)")

    await selectMission(page, "Objective working")
    await page.waitForFunction(() => document.querySelector(".mission-picker-field .mission-picker-mark")?.getAttribute("data-mark") === "idle")
    assert.equal(await mark(page, "Objective working"), "idle")
    await fixtureCall(page, "flush")
    await page.reload()
    await missionPickerField(page).locator(".mission-picker-title").waitFor()
    assert.equal(await mark(page, "Objective working"), "idle", "seen completions stay seen in this window")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a stopped coordinator offers recovery in Pause's place only while nothing else runs; done tasks stay neutral", async () => {
  const base = mission("run")
  const value = mission("run", { actors: [actor("ses_run"), actor("ses_worker", "specialist")], tasks: [...base.tasks,
    { ...base.tasks[0]!, id: "task-blocked", key: "task-blocked", title: "Publish release", status: "needs-input" }] })
  let activity = [{ missionId: "run", actors: [{ sessionId: "ses_run", state: "idle-without-report" as const },
    { sessionId: "ses_worker", state: "running" as const }] }]
  const { page, errors, recoveries } = await open(() => [value], () => activity)
  try {
    await selectMission(page, "Objective run")
    await missionToolbarAction(page, "Pause mission").waitFor()
    assert.equal(await mark(page, "Objective run"), "working")
    activity = [{ missionId: "run", actors: [{ sessionId: "ses_run", state: "idle-without-report" }, { sessionId: "ses_worker", state: "idle-without-report" }] }]
    await refresh(page)
    await missionToolbarAction(page, "Recover interrupted mission").click()
    await page.waitForFunction(() => document.querySelector(".mission-picker-field .mission-picker-mark")?.getAttribute("data-mark") === "interrupted")
    for (let attempt = 0; !recoveries.length && attempt < 100; attempt++) await page.waitForTimeout(20)
    assert.deepEqual(recoveries, [{ expectedRevision: 1, target: "coordinator" }])

    const [done, blocked, muted] = await page.evaluate(() => {
      const probe = document.createElement("span"); probe.style.color = "var(--text-muted)"; document.body.append(probe)
      const color = getComputedStyle(probe).color; probe.remove()
      return [...["done", "blocked"].map(state =>
        getComputedStyle(document.querySelector(`.mission-tree li[data-state="${state}"] .mission-tree-mark`)!).color), color]
    })
    assert.equal(done, muted, "a finished task is history, not a green status")
    assert.equal(blocked, muted, "a reported blockage is an outcome, shown by its icon")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a recurring passage waiting for an answer is red; stopped and paused schedules keep a past failure quiet", async () => {
  const schedule = (id: string, title: string, patch: Partial<RecurrenceSchedule>): RecurrenceSchedule => ({ id, title, revision: 2,
    state: "running", clock: { time: "08:15", zone: "UTC" }, nextDueAt: Date.UTC(2026, 9, 28, 8, 15), pending: null, latestResult: null, history: [], controls: [],
    actions: ["pause", "stop", "run-now"], ...patch })
  const failedRun = { passageID: "pas_old", dueAt: 1, settledAt: 2, outcome: "failed" as const, reason: "not-started" as const, trigger: "daily" as const }
  const { page, errors } = await open(() => [], () => [], [
    schedule("rec_wait", "Waiting review", { pending: { passageID: "pas_wait", status: "running", trigger: "daily", conversationID: "ses_passage" },
      actions: ["pause", "stop"] }),
    schedule("rec_stopped", "Stopped review", { state: "stopped", nextDueAt: null, latestResult: failedRun, history: [failedRun], actions: [] }),
    schedule("rec_paused", "Paused review", { state: "paused", nextDueAt: null, latestResult: failedRun, history: [failedRun],
      actions: ["play", "stop", "run-now"] }),
  ])
  try {
    // Schedules are read only through a connected instance.
    await fixtureCall(page, "connectCatalog")
    await page.waitForFunction(() => !document.querySelector(".mission-picker-expander")?.hasAttribute("disabled"))
    await (await inlineMissionEntry(page, "Waiting review")).waitFor()
    assert.deepEqual(await Promise.all(["Waiting review", "Stopped review", "Paused review"].map(title => mark(page, title))),
      ["working", "idle", "paused"])
    await page.evaluate(() => (window as any).missionFixture.queuePermission("ses_passage"))
    await page.waitForFunction(() => [...document.querySelectorAll(".mission-picker-inline .mission-picker-mark")]
      .some(element => element.getAttribute("data-mark") === "permission"))
    assert.equal(await mark(page, "Waiting review"), "permission")
    assert.match(await (await inlineMissionEntry(page, "Waiting review")).locator(".sr-only").textContent() ?? "", /Awaiting your input/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a failed mission reads as interrupted and resumes through coordinator recovery", async () => {
  const value = mission("failed", { status: "failed", summary: "Stopped short" })
  const { page, errors, recoveries } = await open(() => [value], () => [])
  try {
    await selectMission(page, "Objective failed")
    assert.match(await missionPickerField(page).locator(".sr-only").textContent() ?? "", /^Failed · /)
    assert.equal(await missionPicker(page).locator(".mission-picker-field .mission-picker-mark").getAttribute("data-mark"), "interrupted")
    assert.equal(await missionToolbarAction(page, "Stop mission permanently").isDisabled(), true)
    await missionToolbarAction(page, "Recover interrupted mission").click()
    for (let attempt = 0; !recoveries.length && attempt < 100; attempt++) await page.waitForTimeout(20)
    assert.deepEqual(recoveries, [{ expectedRevision: 1, target: "coordinator" }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
