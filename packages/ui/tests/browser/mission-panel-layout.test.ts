import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionActorActivity, MissionMap, MissionTask } from "../../../server/src/api-types"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { captureMissionView } from "./mission-view-capture"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-layout", configureServer(s) {
      s.middlewares.use("/mission-layout", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-layout", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-layout`
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
const actor = (sessionId: string, title: string) => ({ sessionId, kind: "specialist" as const, managed: true, title, roles: ["worker"], location: { directory: "fixture" }, joinedAt: 1 })
const active = mission("migrate", { objective: "Migrate the storage layer to the new engine, then remove the legacy adapters and their tests once everything passes",
  briefing: { id: "brf", requestID: "req", createdAt: Date.now() - 20 * 60_000, basedOnRevision: 3, basedOnUpdatedAt: Date.now() - 20 * 60_000,
    summary: "The new engine is wired behind a flag and the read path passes. Writes still go through the legacy adapter while the schema migration is reviewed.",
    achieved: [], ongoing: [], obstacles: [], next: [] } as unknown as MissionMap["briefing"],
  actors: [{ sessionId: "ses_migrate", kind: "coordinator", managed: true, title: "Coordinator", roles: ["coordinator"], location: { directory: "fixture" }, joinedAt: 1 },
    actor("ses_worker", "Schema reviewer"), actor("ses_runner", "Benchmark runner"), actor("ses_writer", "Write-path porter")],
  tasks: [task("read", "Port the read path", "completed"),
    { ...task("bench", "Benchmark the new engine", "dispatching", ["read"]), actorSessionId: "ses_runner" },
    { ...task("schema", "Review the schema migration", "queued", ["read"]), actorSessionId: "ses_worker" },
    { ...task("write", "Port the write path", "needs-input", ["read"]), actorSessionId: "ses_writer" },
    task("legacy", "Keep the legacy reader alive", "failed"),
    task("cleanup", "Remove legacy adapters", "blocked", ["write", "bench"])],
  history: [{ revision: 2, source: "coordinator", actorSessionId: "ses_migrate", reason: "Split the write path from cleanup", addedTaskKeys: ["cleanup"], retiredTasks: [], dependencyUpdates: [], createdAt: 2 }] })
// Observed native activity: one task runs, one actor waits on a native question.
const activeActivity: MissionActorActivity[] = [{ sessionId: "ses_runner", state: "running" }, { sessionId: "ses_worker", state: "form" }, { sessionId: "ses_writer", state: "idle-without-report" }]
// Coherent clock: every run and the next one fall at 08:15 in the schedule's own zone (UTC).
const nextRun = (() => { const now = Date.now(), at = new Date(now); at.setUTCHours(8, 15, 0, 0); return at.getTime() <= now ? at.getTime() + 24 * hour : at.getTime() })()
const schedule: RecurrenceSchedule = { id: "rec_review", title: "Daily source review", revision: 2, state: "running", clock: { time: "08:15", zone: "UTC" },
  nextDueAt: nextRun, pending: null, controls: [], actions: ["pause", "stop", "run-now"],
  history: [{ passageID: "pas_1", dueAt: nextRun - 48 * hour, settledAt: nextRun - 47 * hour, outcome: "completed", missionID: "msn_1", conversationID: "ses_run_1" },
    { passageID: "pas_2", dueAt: nextRun - 24 * hour, settledAt: nextRun - 23 * hour, outcome: "ended-without-report", missionID: "msn_2", conversationID: "ses_run_2" }], latestResult: null }
schedule.latestResult = schedule.history.at(-1)!

async function open(page: Page, missions: MissionMap[], schedules: RecurrenceSchedule[] = []) {
  page.setDefaultTimeout(15_000)
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions, generatedAt: 1, discardedEvents: 0,
      activity: { generatedAt: 1, missions: missions.map(value => ({ missionId: value.id, actors: value === active ? activeActivity : [] })) } } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: "project",
      projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules }) })
    if (path.endsWith("/current")) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: "rec_review", passageID: null } })
    if (path.includes("/passages/")) {
      // The latest run's archive is unreadable; the earlier one returns its exact journal page.
      const passageID = path.split("/").at(-1)!, receipt = schedule.history.find(item => item.passageID === passageID)
      if (!receipt || passageID === "pas_2") return route.fulfill({ status: 503, json: { error: "unavailable" } })
      const text = "Reviewed 14 merged changes. Two follow-ups were filed for the release checklist."
      return route.fulfill({ json: { version: 1, projectID: "project", scheduleID: schedule.id, passageID, missionID: receipt.missionID,
        conversationID: receipt.conversationID, revision: 3, section: 0, sectionCount: 1, sections: [{ index: 0, label: "summary", title: "", raw: false }],
        page: 0, pageCount: 1, sourceText: text, markdownText: text } })
    }
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.evaluate(() => (window as any).missionFixture.connectCatalog())
  await page.evaluate(async () => {
    const path = "/src/stores/instances.ts", { updateInstance } = await import(path)
    updateInstance("fixture", { metadata: { project: { id: "project" } } })
  })
}
const rows = (page: Page) => page.locator(".mission-control-index > .mission-index-entry")
const row = (page: Page, title: string | RegExp) => rows(page).filter({ hasText: title })
const detail = (page: Page) => page.locator("section.mission-detail")
async function menu(page: Page, entry: ReturnType<typeof row>) {
  await entry.getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitem").first().waitFor()
  return page.getByRole("menuitem").allInnerTexts()
}

test("the list is a list: two-line rows, nothing below until a selection, creation on one screen", async () => {
  const page = await browser.newPage({ locale: "en-US", timezoneId: "UTC", viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [active, finished, audit], [schedule])
    await row(page, "Daily source review").waitFor()
    assert.equal(await rows(page).count(), 4)
    assert.equal(await detail(page).count(), 0, "no selection, no detail")
    for (const entry of await rows(page).all()) {
      const select = entry.locator(".mission-index-select")
      assert.deepEqual(await select.evaluate(el => [...el.children].map(child => child.className)), ["mission-index-title", "mission-index-meta"])
      assert.ok(await select.evaluate(el => el.getBoundingClientRect().height < 48), "exactly two short lines")
    }
    assert.equal(await row(page, /^Prepare the 2\.4/).locator(".neutral-badge").count(), 0, "one-time rows carry no badge")
    assert.equal(await row(page, "Daily source review").locator(".mission-index-meta .neutral-badge").innerText(), "Daily")
    assert.match(await row(page, /^Prepare the 2\.4/).locator(".mission-index-meta").textContent() ?? "", /^Completed · 2 hours ago$/)
    assert.doesNotMatch(await page.locator(".mission-control").innerText(), /Release notes are drafted|engine is wired|ses_|task-/, "no prose or identifiers in the panel")
    await captureMissionView(page, "list-nothing-selected")
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.locator("form.mission-editor").waitFor()
    await captureMissionView(page, "creation")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("one-time selected: Needs you, Overview eye and the dependency tree as the single task view", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [active, finished])
    const entry = row(page, /^Migrate the storage layer/)
    await entry.locator(".mission-index-select").click()
    await detail(page).waitFor()
    assert.equal(await entry.locator("section.mission-detail").count(), 0, "the detail is a separate section below the list")
    assert.equal(await detail(page).locator(".mission-needs").count(), 0, "Needs you appears only for an open request")
    await page.evaluate(async () => {
      const path = "/src/stores/forms.ts", { replaceFormQueue } = await import(path)
      replaceFormQueue("fixture", [{ id: "form-1", sessionID: "ses_worker", title: "Which index strategy should the migration keep?", fields: [{}], location: { directory: "fixture" } }])
    })
    const need = detail(page).locator(".mission-needs-item")
    await need.waitFor()
    assert.equal(await need.count(), 1)
    assert.equal(await need.locator(".mission-needs-title").innerText(), "Which index strategy should the migration keep?")
    assert.match(await need.locator(".mission-needs-title").getAttribute("title") ?? "", /Question from Schema reviewer/)
    assert.equal(await need.getByRole("button", { name: "Answer", exact: true }).count(), 1)
    assert.equal(await detail(page).locator(".mission-overview-toggle").innerText(), "Overview")
    // The tree merges status into the dependency graph.
    const states = await detail(page).locator(".mission-tree li").evaluateAll(items => items.map(item => [(item as HTMLElement).dataset.taskKey, (item as HTMLElement).dataset.state]))
    assert.deepEqual(states, [["read", "done"], ["legacy", "failed"], ["bench", "active"], ["schema", "input"], ["write", "blocked"], ["cleanup", "waiting"]])
    assert.equal(await detail(page).locator(".mission-graph path[data-to='cleanup']").count(), 2)
    assert.equal(await detail(page).locator(".mission-tree-mark svg").count(), 6, "every node shows a status icon")
    const visibleText = await detail(page).evaluate(element => {
      const copy = element.cloneNode(true) as HTMLElement
      copy.querySelectorAll(".sr-only").forEach(node => node.remove())
      return copy.textContent ?? ""
    })
    assert.doesNotMatch(visibleText, /Done|Completed|Waiting|Blocked|tasks done|%|engine is wired/, "no visible status words, counts or prose")
    assert.equal(await detail(page).locator('li[data-task-key="schema"] .sr-only').textContent(), "Awaiting your input", "status words remain available to assistive technology")
    assert.equal(await page.locator(".mission-control").locator("textarea, form, .mission-disclosure").count(), 0, "no coordinator field and no More")
    assert.equal(await entry.getByRole("button", { name: "Pause mission", exact: true }).innerText(), "Pause")
    await captureMissionView(page, "one-time-selected")
    const items = await menu(page, entry)
    assert.deepEqual(items.filter(item => !item.startsWith("Verify")), ["Request an update", "Open conversation", "Edit", "Stop…", "Delete…"])
    await captureMissionView(page, "overflow-menu-open")
    await page.keyboard.press("Escape")
    // Overview opens the briefing centrally; its eye highlights the exact target.
    await detail(page).locator(".mission-overview-toggle").click()
    await page.locator(".mission-reader").getByText(/The new engine is wired/).waitFor()
    assert.equal(await detail(page).locator(".mission-overview-toggle").getAttribute("aria-pressed"), "true")
    await page.locator(".mission-reader details.mission-report-technical > summary", { hasText: "Plan changes" }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("finished one-time Mission: titled row, prose only in the reader, all-done tree opens task readers", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [finished, audit])
    const first = rows(page).first()
    assert.equal(await first.locator(".mission-index-title bdi").innerText(), "Prepare the 2.4 release notes for the desktop and web apps")
    assert.equal(await first.locator(".mission-index-primary").count(), 0, "finished Missions have no primary action")
    assert.deepEqual(await menu(page, first), ["Open conversation", "Delete…"], "unavailable actions are hidden, not disabled")
    await page.keyboard.press("Escape")
    await first.locator(".mission-index-select").click()
    const tree = detail(page).locator(".mission-tree")
    assert.equal(await tree.locator("li[data-state='done']").count(), 8)
    assert.equal(await detail(page).locator("p, .mission-result").count(), 0, "no result prose in the panel")
    assert.doesNotMatch(await page.locator(".mission-control").innerText(), /ses_|task-t0|Release notes are drafted/)
    await captureMissionView(page, "finished-one-time")
    await detail(page).locator(".mission-overview-toggle").click()
    await page.locator(".mission-reader").getByText(/^Release notes are drafted/).waitFor()
    await tree.locator(".mission-tree-task").first().click()
    assert.equal(await page.locator(".mission-reader .window-title").innerText(), "Collect merged changes")
    assert.equal(await tree.locator(".mission-tree-task").first().getAttribute("aria-pressed"), "true")
    assert.equal(await detail(page).locator(".mission-overview-toggle").getAttribute("aria-pressed"), "false")
    const taskReader = page.locator(".mission-task-reader")
    await taskReader.getByText("Done", { exact: true }).waitFor()
    assert.doesNotMatch(await taskReader.innerText(), /No result recorded|Unblocks|Blocks /)
    await tree.locator(".mission-tree-task").nth(1).click()
    await page.locator(".mission-reader .window-title").getByText("Group by audience", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("recurring selected: Daily badge, Next in the schedule zone, current tree slot and compact past runs that open central readers", async () => {
  // A viewer outside UTC sees every schedule time in UTC, labelled once per time.
  const page = await browser.newPage({ locale: "en-US", timezoneId: "Europe/Paris", viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page, [audit, active], [schedule])
    const entry = row(page, "Daily source review")
    await entry.waitFor()
    assert.match(await entry.locator(".mission-index-meta").textContent() ?? "", /^DailyNext: (today|tomorrow) 8:15 AM \(UTC\)$/)
    assert.equal(await entry.getByRole("button", { name: "Pause schedule Daily source review", exact: true }).innerText(), "Pause")
    await entry.locator(".mission-index-select").click()
    await detail(page).waitFor()
    assert.equal((await page.locator(".mission-control").innerText()).match(/Next:/g)?.length, 1, "the row alone says when the next run is")
    assert.deepEqual((await detail(page).locator(".mission-past-run").allInnerTexts()).map(text => text.replace(/^.* · /, "")), ["Ended without a report", "Completed"])
    assert.doesNotMatch(await page.locator(".mission-control").innerText(), /\(archived\)|pas_|msn_|Last run/)
    await captureMissionView(page, "recurring-selected")

    // Schedule reader: rule, latest run (its archive fails plainly with Retry), every run, identifiers folded.
    await detail(page).locator(".mission-overview-toggle").click()
    const reader = page.locator(".mission-reader")
    await reader.getByText("The result of this run couldn't be loaded.", { exact: false }).waitFor()
    await reader.getByRole("button", { name: "Retry", exact: true }).waitFor()
    assert.match(await reader.locator(".mission-recurrence-rule").innerText(), /^Every day at 8:15 AM \(UTC\) · Next: /)
    assert.equal(await reader.locator("details.mission-report-technical").getAttribute("open"), null)
    // A past run in the panel opens that run's reader.
    await detail(page).locator(".mission-past-run").nth(1).click()
    await reader.getByText("Reviewed 14 merged changes.", { exact: false }).waitFor()
    assert.equal(await detail(page).locator(".mission-past-run").nth(1).getAttribute("aria-pressed"), "true")
    await reader.locator("details.mission-report-technical > summary").click()
    await reader.locator(".mission-technical").getByText("pas_1", { exact: true }).waitFor()
    await captureMissionView(page, "passage-reader")

    await row(page, /^Migrate the storage layer/).locator(".mission-index-select").click()
    await page.evaluate(() => { (window as any).missionFixture.panelWidth("390px"); document.documentElement.dir = "rtl" })
    await page.setViewportSize({ width: 390, height: 900 })
    assert.equal(await page.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
    await captureMissionView(page, "narrow-390-rtl")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a viewer in the schedule's own zone sees no zone label", async () => {
  const page = await browser.newPage({ locale: "en-US", timezoneId: "UTC", viewport: { width: 1100, height: 900 } })
  try {
    await open(page, [], [schedule])
    const entry = row(page, "Daily source review")
    await entry.waitFor()
    assert.match(await entry.locator(".mission-index-meta").textContent() ?? "", /^DailyNext: (today|tomorrow) 8:15 AM$/)
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
    assert.equal(await page.locator(".mission-control-preferences").evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)",
      "the panel never borrows the input-field surface")
    await gear.click()
    assert.equal(await page.locator(".mission-preferences").count(), 0)
  } finally { await page.close() }
})
