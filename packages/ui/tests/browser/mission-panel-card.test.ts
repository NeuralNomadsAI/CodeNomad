import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { captureMissionView } from "./mission-view-capture"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-card", configureServer(s) {
      s.middlewares.use("/mission-card", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-card", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-card`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const hour = 3_600_000
const task = (key: string, title: string, status: MissionTask["status"], blockedBy: string[] = []): MissionTask => ({ id: `task-${key}`, key, title,
  brief: `Brief for ${title}`, role: "worker", status, blockedBy, outstandingExecution: false, createdAt: 1, updatedAt: 1 })
function mission(id: string, patch: Partial<MissionMap>): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [{ sessionId: `ses_${id}`, kind: "coordinator", managed: true,
      title: "Coordinator", roles: ["coordinator"], location: { directory: "fixture" }, joinedAt: 1 }],
    frontier: [], claims: [], revision: 3, createdAt: 1, updatedAt: Date.now() - 2 * hour, history: [], historyTruncated: false, tasks: [], reports: [], ...patch }
}
const finished = mission("release", { status: "completed", objective: "Prepare the 2.4 release notes for the desktop and web apps. Gather every merged change, group them by audience and draft the announcement.",
  summary: "Release notes are drafted in docs/releases/2.4.md. All 31 merged pull requests are grouped into Desktop, Web and Developer sections; two breaking changes are called out at the top with migration steps. The announcement draft is ready for review.",
  tasks: ["Collect merged changes", "Group by audience", "Draft desktop notes", "Draft web notes", "Write migration steps", "Draft announcement", "Proofread", "Publish draft"]
    .map((title, index) => task(`t${index}`, title, "completed", index ? [`t${index - 1}`] : [])) })
const audit = mission("audit", { status: "completed", objective: "Audit the login flow for accessibility issues", summary: "No blocking issue found; three minor fixes were applied.", updatedAt: Date.now() - 26 * hour })
const active = mission("migrate", { objective: "Migrate the storage layer to the new engine, then remove the legacy adapters and their tests once everything passes",
  briefing: { id: "brf", requestID: "req", createdAt: Date.now() - 20 * 60_000, basedOnRevision: 3, basedOnUpdatedAt: Date.now() - 20 * 60_000,
    summary: "The new engine is wired behind a flag and the read path passes. Writes still go through the legacy adapter while the schema migration is reviewed.",
    achieved: [], ongoing: [], obstacles: [], next: [] } as unknown as MissionMap["briefing"],
  actors: [{ sessionId: "ses_migrate", kind: "coordinator", managed: true, title: "Coordinator", roles: ["coordinator"], location: { directory: "fixture" }, joinedAt: 1 },
    { sessionId: "ses_worker", kind: "specialist", managed: true, title: "Schema reviewer", roles: ["review"], location: { directory: "fixture" }, joinedAt: 1 }],
  tasks: [task("read", "Port the read path", "completed"), task("write", "Port the write path", "queued", ["read"]),
    { ...task("schema", "Review the schema migration", "needs-input", ["read"]), actorSessionId: "ses_worker" }, task("cleanup", "Remove legacy adapters", "blocked", ["write"])],
  history: [{ revision: 2, source: "coordinator", actorSessionId: "ses_migrate", reason: "Split the write path from cleanup", addedTaskKeys: ["cleanup"], retiredTasks: [], dependencyUpdates: [], createdAt: 2 }] })
const schedule: RecurrenceSchedule = { id: "rec_review", title: "Daily source review", revision: 2, state: "running", clock: { time: "08:15", zone: "UTC" },
  nextDueAt: Date.now() + 20 * hour, pending: null, controls: [], actions: ["pause", "stop", "run-now"],
  history: [{ passageID: "pas_1", dueAt: Date.now() - 28 * hour, settledAt: Date.now() - 27 * hour, outcome: "completed", missionID: "msn_1" },
    { passageID: "pas_2", dueAt: Date.now() - 4 * hour, settledAt: Date.now() - 3 * hour, outcome: "ended-without-report", missionID: "msn_2" }], latestResult: null }
schedule.latestResult = schedule.history.at(-1)!

async function open(page: Page, missions: MissionMap[], schedules: RecurrenceSchedule[] = []) {
  page.setDefaultTimeout(15_000)
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions, generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: "project",
      projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules }) })
    if (path.endsWith("/current")) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: "rec_review", passageID: null } })
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.evaluate(() => {
    const fixture = (window as any).missionFixture
    fixture.connectCatalog()
  })
  await page.evaluate(async () => {
    const path = "/src/stores/instances.ts", { updateInstance } = await import(path)
    updateInstance("fixture", { metadata: { project: { id: "project" } } })
  })
}
const rows = (page: Page) => page.locator(".mission-control-index > .mission-index-entry")

test("finished one-time Mission: titled rows, result first, checklist and one collapsed More", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [finished, audit])
    const first = rows(page).first()
    await first.locator(".mission-card").waitFor()
    assert.equal(await first.locator(".mission-index-title bdi").innerText(), "Prepare the 2.4 release notes for the desktop and web apps")
    assert.equal(await page.locator(".neutral-badge", { hasText: "One-time" }).count(), 0)
    assert.match(await first.locator(".mission-index-meta").innerText(), /^Completed · 2 hours ago$/)
    assert.equal(await first.locator(".mission-index-primary").count(), 0, "finished Missions have no primary action")
    assert.match(await first.locator(".mission-result-text").innerText(), /^Release notes are drafted/)
    assert.equal(await first.locator(".mission-checklist li").count(), 8)
    assert.equal(await first.locator(".mission-checklist-word").count(), 0, "completed tasks show only a check mark")
    assert.equal(await first.locator(".mission-graph").isVisible(), false, "the dependency graph stays folded inside More")
    const more = first.getByRole("button", { name: "More", exact: true })
    assert.equal(await more.getAttribute("aria-expanded"), "false")
    assert.doesNotMatch(await page.locator(".mission-control").innerText(), /ses_|task-t0/, "no technical identifiers outside More")
    await captureMissionView(page, "finished-one-time-card")
    await first.getByRole("button", { name: "Read all", exact: true }).click()
    await page.locator(".mission-reader").waitFor()
    assert.equal(await first.getByRole("button", { name: "Read all", exact: true }).getAttribute("aria-pressed"), "true")
    await first.locator(".mission-checklist-task").first().click()
    assert.equal(await page.locator(".mission-reader .window-title").innerText(), "Collect merged changes")
    assert.equal(await first.locator(".mission-checklist-task").first().getAttribute("aria-pressed"), "true")
    await more.click()
    await first.getByRole("button", { name: "Show dependencies", exact: false }).click()
    await first.locator(".mission-graph").waitFor()
    await captureMissionView(page, "more-expanded")
    await first.getByRole("button", { name: "More actions", exact: true }).click()
    const items = await page.getByRole("menuitem").allInnerTexts()
    assert.deepEqual(items, ["Open conversation", "Delete…"], "unavailable actions are hidden, not disabled")
    await page.keyboard.press("Escape")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("active Mission: Needs you appears only for a pending native request; one coordinator field; contextual Pause", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [active, finished])
    const row = rows(page).first()
    await row.locator(".mission-card").waitFor()
    assert.equal(await row.locator(".mission-needs").count(), 0)
    await page.evaluate(async () => {
      const path = "/src/stores/forms.ts", { replaceFormQueue } = await import(path)
      replaceFormQueue("fixture", [{ id: "form-1", sessionID: "ses_worker", title: "Which index strategy should the migration keep?", fields: [{}], location: { directory: "fixture" } }])
    })
    await row.locator(".mission-needs").waitFor()
    assert.match(await row.locator(".mission-needs").innerText(), /Question from Schema reviewer/)
    assert.equal(await row.getByRole("button", { name: "Pause", exact: true }).count(), 0, "primary actions keep their full accessible label")
    assert.equal(await row.getByRole("button", { name: "Pause mission", exact: true }).innerText(), "Pause")
    assert.deepEqual(await row.locator(".mission-checklist-word").allInnerTexts(), ["Assigned", "Blocked", "Waiting"])
    assert.match(await row.locator(".mission-result-meta").innerText(), /1 of 4 tasks done/)
    assert.equal(await row.locator("form.mission-guidance textarea").count(), 1)
    assert.equal(await row.getByLabel("Write to the coordinator", { exact: true }).count(), 1)
    await row.getByRole("button", { name: "More actions", exact: true }).click()
    assert.deepEqual(await page.getByRole("menuitem").allInnerTexts(), ["Request an update", "Open conversation", "Verify and recover coordinator", "Edit", "Stop…", "Delete…"])
    await page.keyboard.press("Escape")
    await captureMissionView(page, "active-one-time-needs-you")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("recurring schedule card and narrow RTL layout", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [audit], [schedule])
    const row = rows(page).filter({ hasText: "Daily source review" })
    await row.waitFor()
    assert.match(await row.locator(".mission-index-title").innerText(), /Daily 8:15|Daily 08:15/)
    assert.match(await row.locator(".mission-index-meta").innerText(), /^Next: tomorrow/)
    await row.getByRole("button", { name: "Daily source review", exact: true }).click()
    await row.locator(".mission-schedule-detail").waitFor()
    assert.match(await row.locator(".mission-schedule-when").innerText(), /^Every day at 08:15 · next: tomorrow/)
    assert.equal(await row.getByRole("button", { name: "Pause schedule Daily source review", exact: true }).innerText(), "Pause")
    await row.getByRole("button", { name: "More", exact: true }).click()
    assert.equal(await row.locator(".mission-past-run").count(), 2)
    await row.locator(".mission-past-run").first().click()
    await page.locator(".mission-reader").waitFor()
    assert.equal(await row.locator(".mission-past-run").first().getAttribute("aria-pressed"), "true")
    await captureMissionView(page, "recurring-card")
    await page.evaluate(() => { (window as any).missionFixture.panelWidth("390px"); document.documentElement.dir = "rtl" })
    await page.setViewportSize({ width: 390, height: 900 })
    assert.equal(await page.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
    await captureMissionView(page, "narrow-390-rtl")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("preferences open in place from the header gear", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  try {
    await open(page, [audit])
    const gear = page.getByRole("button", { name: "Preferences", exact: true })
    assert.equal(await gear.getAttribute("aria-expanded"), "false")
    assert.equal(await page.locator(".mission-preferences").count(), 0)
    await gear.click()
    await page.locator(".mission-control-preferences .mission-preferences").waitFor()
    const order = await page.locator(".mission-control > *").evaluateAll(elements => elements.map(element => element.className))
    assert.ok(order.indexOf("mission-control-preferences") < order.indexOf("mission-control-index"), "preferences open above the list")
    await gear.click()
    assert.equal(await page.locator(".mission-preferences").count(), 0)
  } finally { await page.close() }
})
