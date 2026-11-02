import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionMap, MissionPanelMap, MissionReport, MissionTask } from "../../../server/src/api-types"
import { compactMissionMap } from "../../../server/src/missions/mission-compact-map"
import { missionTaskOrder } from "../../../server/src/missions/mission-task-order"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { missionContentFixture, missionTaskFixture, missionTaskQuery, olderPluginMap, panelMissions } from "./mission-content-fixture"

// Real MissionControl and reader over a compact map that holds a page of its tasks:
// the tree's gaps, the graph's omitted edges, reads further and Needs you beyond the page.
let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
    name: "mission-task-pages",
    routes: [
      { path: "/mission-task-pages", html: "<html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-control.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url; events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

/** 120 tasks in 12 chains of 10: `t{10g+p}` waits on `t{10g+p-1}`, so the display order takes
 * every chain's p-th task in round p (position 12p+g). The last task reported a blockage,
 * after four failed attempts; `ses_far` works on t118, outside the map's page. */
function paged(): MissionMap {
  const report = (id: string, outcome: MissionReport["outcome"], createdAt: number): MissionReport => ({ id, taskKey: "t119", sessionId: "ses_coordinator",
    outcome, summary: `Summary of ${id}`, evidence: [], next: [], createdAt, delivery: "coordinator-readout" })
  const reports = [...[1, 2, 3, 4].map(index => report(`rep_attempt_${index}`, "failed", index)), report("rep_blocked", "blocked", 5)]
  const tasks = Array.from({ length: 120 }, (_, index): MissionTask => ({ id: `task-t${index}`, key: `t${index}`, title: `Task t${index}`, brief: `Brief t${index}`,
    role: "worker", status: "queued", blockedBy: index % 10 ? [`t${index - 1}`] : [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }))
  tasks[119] = { ...tasks[119], status: "needs-input", report: reports[4], updatedAt: 5 }
  tasks[118] = { ...tasks[118], actorSessionId: "ses_far" }
  return { version: 1, id: "paged", projectID: "project", projectCanonical: "/fixture", objective: "Objective paged", template: "custom",
    coordinatorSessionId: "ses_coordinator", status: "active", runState: "running", frontier: [], claims: [], revision: 3, createdAt: 1, updatedAt: 5,
    actors: [{ sessionId: "ses_far", title: "Far worker", kind: "specialist", managed: true, roles: ["worker"], location: { directory: "/fixture" }, joinedAt: 1 }],
    history: [], historyTruncated: false, tasks, reports } as MissionMap
}

/** The panel over `value`, which `replace` swaps (a list refresh shows it); `failTasks`
 * makes the task route answer 503, or those of its reads a predicate picks; `activity` is
 * the list's actor activity; `project` lists the map otherwise than the current plugin. */
async function open(value: MissionMap, activity: Array<{ sessionId: string; state: string }> = [], project?: (map: MissionMap) => MissionPanelMap) {
  const page = await (await browser.newContext({ locale: "en-US", viewport: { width: 900, height: 800 } })).newPage()
  const errors: string[] = [], reads: string[] = [], contents: string[] = []
  let current = value, failTasks: boolean | ((query: URLSearchParams) => boolean) = false
  page.on("pageerror", error => errors.push(error.message))
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  await page.addInitScript(`Object.assign(window,{__name:f=>f,__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const tasks = missionTaskFixture(request.url(), request.method(), [project ? project(current) as MissionMap : current], "project", request.postData())
    if (tasks) {
      reads.push(decodeURIComponent(missionTaskQuery(request)))
      const failing = typeof failTasks === "function" ? failTasks(new URLSearchParams(missionTaskQuery(request))) : failTasks
      return failing ? route.fulfill({ status: 503, json: { error: "Temporary task read failure" } }) : route.fulfill({ json: tasks })
    }
    const content = missionContentFixture(request.url(), request.method(), [current])
    if (content) { contents.push(decodeURIComponent(new URL(request.url()).search)); return route.fulfill({ json: content }) }
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project",
      missions: project ? (panelMissions([current]), [compactMissionMap(project(current))]) : panelMissions([current]), generatedAt: 1, discardedEvents: 0,
      activity: { generatedAt: 1, missions: [{ missionId: current.id, actors: activity }] } } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: "project",
      projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] }) })
    return route.fulfill({ json: {} })
  })
  await events.route(page)
  await page.goto(url)
  await page.evaluate(async id => {
    ;(window as any).missionFixture.connectCatalog()
    ;(await import("/src/stores/instances.ts")).updateInstance("fixture", { metadata: { project: { id: "project" } } })
    ;(await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { selected: id })
  }, value.id)
  await page.locator(".mission-tree-node").first().waitFor()
  reads.length = 0 // selectors below measure reads further, after initial header/task/pin adoption
  return { page, errors, reads, contents, current: () => current, replace: (next: MissionMap) => { current = next },
    failTasks: (fail: boolean | ((query: URLSearchParams) => boolean)) => { failTasks = fail },
    refresh: () => page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.refresh("fixture")) }
}
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const rows = (page: Page) => page.locator(".mission-tree-node").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.taskKey))
const gaps = (page: Page) => page.locator(".mission-tree-gap").evaluateAll(nodes => nodes.map(node => [Number((node as HTMLElement).dataset.start),
  Number((node as HTMLElement).dataset.end), node.querySelector("span")!.textContent]))
const stubs = (page: Page) => page.locator(".mission-graph path.mission-graph-omitted").evaluateAll(paths => paths.map(path =>
  `${(path as SVGPathElement).dataset.task}:${(path as SVGPathElement).dataset.omitted}`).sort())
/** Every declared edge starts and ends at its tasks' status icons, in client space. */
const railGaps = (page: Page) => page.evaluate(() => {
  const svg = document.querySelector<SVGSVGElement>(".mission-graph")!, matrix = svg.getScreenCTM()!
  const anchor = (key: string) => document.querySelector(`.mission-tree-node[data-task-key="${key}"] [data-graph-anchor]`)!.getBoundingClientRect()
  const client = (x: number, y: number) => { const point = svg.createSVGPoint(); point.x = x; point.y = y; return point.matrixTransform(matrix) }
  return Math.max(0, ...[...svg.querySelectorAll<SVGPathElement>("path[data-from]")].flatMap(path => {
    const [, x1, y1, , y2, x2] = path.getAttribute("d")!.match(/^M ([\d.]+) ([\d.]+) H ([\d.]+) V ([\d.]+) H ([\d.]+)$/)!.map(Number)
    return ([[path.dataset.from!, client(x1, y1)], [path.dataset.to!, client(x2, y2)]] as const).flatMap(([key, point]) => {
      const box = anchor(key)
      return [Math.abs(point.x - box.left), Math.abs(point.y - (box.top + box.height / 2))]
    })
  }))
})

test("the tree shows a page of the display order with counted gaps and omitted edges, and reads further on request, rails measured on every page", async () => {
  const value = paged(), order = missionTaskOrder(value.tasks).map(task => task.key)
  const { page, errors, reads } = await open(value)
  try {
    await settle(page)
    assert.equal(await page.locator(".mission-tree > h3 .mission-disclosure-trigger small").innerText(), "120", "the group counts every task")
    // The window (positions 0-49), then the pinned blockage at the end of the order.
    assert.deepEqual(await rows(page), [...order.slice(0, 50), "t119"])
    assert.deepEqual(await gaps(page), [[50, 119, "69 tasks not shown"]])
    // Round 3's tasks of chains 2-11 and round 4's two shown tasks have dependents not shown; t119 waits on t118.
    assert.deepEqual(await stubs(page), [...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(chain => `t${chain * 10 + 3}`), "t4", "t14"].map(key => `${key}:dependents`)
      .concat("t119:dependencies").sort())
    assert.equal(await page.locator(".mission-graph path[data-from]").count(), 38, "every edge between shown tasks")
    assert.ok(await railGaps(page) <= 0.75)
    assert.match(await page.locator('.mission-tree-node[data-task-key="t119"] .sr-only').textContent() ?? "", /1 dependency not shown/)
    // Show more reads the next page of the order the map named, from the gap's start.
    await page.locator(".mission-tree-gap").getByRole("button", { name: "Show more", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".mission-tree-node").length === 101)
    assert.equal(reads.length, 1)
    assert.match(reads[0], /^\?order=[^&]+&offset=50$/)
    assert.deepEqual(await rows(page), [...order.slice(0, 100), "t119"])
    assert.deepEqual(await gaps(page), [[100, 119, "19 tasks not shown"]])
    await settle(page)
    assert.equal(await page.locator(".mission-graph path[data-from]").count(), 88)
    assert.ok(await railGaps(page) <= 0.75, "rails meet the icons of rows read further")
    await page.locator(".mission-tree-gap").getByRole("button", { name: "Show more", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".mission-tree-node").length === 120)
    assert.deepEqual(await rows(page), order)
    assert.deepEqual(await gaps(page), [])
    await settle(page)
    assert.deepEqual(await stubs(page), [], "every edge's both ends are shown")
    assert.equal(await page.locator(".mission-graph path[data-from]").count(), 108)
    assert.ok(await railGaps(page) <= 0.75)
    assert.deepEqual(errors, [])
  } finally { await page.context().close() }
})

test("the reader opens a dependency the page does not hold by reading it, and shows all earlier results on request", async () => {
  const { page, errors, reads } = await open(paged())
  try {
    await page.locator('.mission-tree-node[data-task-key="t119"] .mission-tree-task').click()
    const reader = page.locator(".mission-reader")
    await reader.getByRole("heading", { name: "Task t119", exact: true }).waitFor()
    // Its row holds three of its five reports: the rest are counted, and read whole on request.
    const earlier = reader.locator("section", { has: page.getByRole("heading", { name: "Previous and late results", exact: true }) })
    assert.equal(await earlier.locator("details").count(), 2)
    await earlier.getByText("2 earlier results not shown", { exact: true }).waitFor()
    await earlier.getByRole("button", { name: "Show all", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".mission-reader section details").length === 4)
    assert.deepEqual(await earlier.locator("details > summary .mission-advance-summary").allTextContents(),
      [4, 3, 2, 1].map(index => `Summary of rep_attempt_${index}`), "every earlier attempt, newest first")
    assert.equal(await earlier.getByText("2 earlier results not shown", { exact: true }).count(), 0)
    // The dependency is not loaded: its link reads it by key, then opens it.
    assert.equal(await page.locator('.mission-tree-node[data-task-key="t118"]').count(), 0)
    await reader.locator(".mission-task-link", { hasText: "t118" }).click()
    await reader.getByRole("heading", { name: "Task t118", exact: true }).waitFor()
    assert.ok(reads.some(query => /^\?order=[^&]+&keys=t118$/.test(query)), reads.join(" "))
    await page.locator('.mission-tree-node[data-task-key="t118"]').waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.context().close() }
})

test("a reader target the page does not hold, a task or an earlier report, is read by ID and shown", async () => {
  const { page, errors, reads } = await open(paged())
  try {
    const target = (reader: Record<string, string>) => page.evaluate(async reader =>
      (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { reader: { missionId: "paged", ...reader } }), reader)
    const reader = page.locator(".mission-reader")
    await target({ kind: "task", itemId: "task-t108" })
    await reader.getByRole("heading", { name: "Task t108", exact: true }).waitFor()
    assert.ok(reads.some(query => /^\?order=[^&]+&ids=task-t108$/.test(query)), reads.join(" "))
    // An earlier attempt of a shown task: its row holds the newest reports, the read names this one.
    await target({ kind: "report", itemId: "rep_attempt_1" })
    await reader.getByText("Summary of rep_attempt_1", { exact: true }).waitFor()
    assert.ok(reads.some(query => /^\?order=[^&]+&reports=rep_attempt_1$/.test(query)), reads.join(" "))
    assert.equal(await reader.getByRole("heading", { level: 2 }).innerText(), "Task t119")
    assert.deepEqual(errors, [])
  } finally { await page.context().close() }
})

test("Show all reads the whole history again once a new report arrives, keeping the earlier ones", async () => {
  const value = paged(), f = await open(value)
  try {
    await f.page.locator('.mission-tree-node[data-task-key="t119"] .mission-tree-task').click()
    const reader = f.page.locator(".mission-reader")
    const earlier = reader.locator("section", { has: f.page.getByRole("heading", { name: "Previous and late results", exact: true }) })
    const excerpts = () => earlier.locator("details > summary .mission-advance-summary").allTextContents()
    await earlier.getByRole("button", { name: "Show all", exact: true }).click()
    await f.page.waitForFunction(() => document.querySelectorAll(".mission-reader section details").length === 4)
    // A late result of t119 arrives with the next revision: the history's descriptor names another body.
    f.replace(withLateResult(value))
    await f.refresh()
    await f.page.waitForFunction(() => document.querySelectorAll(".mission-reader section details").length === 5)
    assert.deepEqual(await excerpts(), WHOLE_HISTORY, "the new result and every earlier one")
    assert.equal(await earlier.getByRole("button", { name: "Show all", exact: true }).count(), 0, "still the whole history")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.context().close() }
})

/** `value` at revision 4, with a late result of t119. */
function withLateResult(value: MissionMap): MissionMap {
  const late: MissionReport = { id: "rep_late_new", taskKey: "t119", sessionId: "ses_coordinator", outcome: "completed", summary: "Summary of rep_late_new",
    evidence: [], next: [], createdAt: 6, late: true, delivery: "coordinator-readout" }
  return { ...value, revision: 4, updatedAt: 6, reports: [...value.reports, late], tasks: value.tasks.map(task => task.key === "t119" ? { ...task, lateReports: [late] } : task) }
}
/** t119's earlier results once the late one arrived, newest first. */
const WHOLE_HISTORY = ["Summary of rep_late_new", ...[4, 3, 2, 1].map(index => `Summary of rep_attempt_${index}`)]
/** Opens t119's reader and its whole history; the history's section and its excerpts. */
async function showAllOf119(page: Page) {
  await page.locator('.mission-tree-node[data-task-key="t119"] .mission-tree-task').click()
  const earlier = page.locator(".mission-reader section", { has: page.getByRole("heading", { name: "Previous and late results", exact: true }) })
  await earlier.getByRole("button", { name: "Show all", exact: true }).click()
  return { earlier, excerpts: () => earlier.locator("details > summary .mission-advance-summary").allTextContents() }
}

test("a history read before a newer page of its task answers is read again: the page's row decides what it must be", async () => {
  const value = paged(), f = await open(value)
  try {
    // The first history read is held, answering from the map it was sent for.
    let release!: () => void, held = false
    const gate = new Promise<void>(resolve => { release = resolve })
    await f.page.route("**/missions/*/content**", async route => {
      const request = route.request()
      if (held || new URL(request.url()).searchParams.get("field") !== "reports") return route.fallback()
      held = true
      const answer = missionContentFixture(request.url(), request.method(), [f.current()])
      await gate
      return route.fulfill({ json: answer })
    })
    const { excerpts } = await showAllOf119(f.page)
    for (let wait = 0; wait < 100 && !held; wait++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(held)
    // The mission moves on, and a page holding t119 answers at revision 4 before the list is read again.
    f.replace(withLateResult(value))
    await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.loadTasks("fixture", "paged", { offset: 100 }))
    assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.state("fixture").missions[0].revision), 3, "the base stays at its revision")
    release()
    await f.page.waitForFunction(() => document.querySelectorAll(".mission-reader section details").length === 5)
    assert.deepEqual(await excerpts(), WHOLE_HISTORY)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.context().close() }
})

test("an older plugin's history, which no descriptor describes, is read again once its report count or newest report changes", async () => {
  const value = paged(), f = await open(value, [], olderPluginMap)
  try {
    const { earlier, excerpts } = await showAllOf119(f.page)
    await f.page.waitForFunction(() => document.querySelectorAll(".mission-reader section details").length === 4)
    const row = () => f.page.evaluate(async () => {
      const task = (await import("/src/stores/missions.ts")).missionStore.state("fixture").missions[0].tasks.find((task: { key: string }) => task.key === "t119")
      return { history: task.bodies?.reports ?? null, count: task.reportCount }
    })
    assert.deepEqual(await row(), { history: null, count: 5 }, "the older plugin's row describes no history")
    f.replace(withLateResult(value))
    await f.refresh()
    await f.page.waitForFunction(() => document.querySelectorAll(".mission-reader section details").length === 5)
    assert.deepEqual([await excerpts(), (await row()).count], [WHOLE_HISTORY, 6])
    assert.equal(f.contents.filter(query => query.includes("field=reports")).length, 2, "one read for each history")
    assert.equal(await earlier.getByRole("button", { name: "Show all", exact: true }).count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.context().close() }
})

/** 400 independent tasks: b050-b249 blocked; from revision 4, b250-b349 too, newer, which
 * changes the attention sequence and not the display order. */
function blockages(revision: number): MissionMap {
  const key = (index: number) => `b${String(index).padStart(3, "0")}`
  const tasks = Array.from({ length: 400 }, (_, index): MissionTask => {
    const base: MissionTask = { id: `task-${key(index)}`, key: key(index), title: `Task ${key(index)}`, brief: "Brief", role: "worker", status: "ready",
      blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }
    if (index < 50 || index >= (revision > 3 ? 350 : 250)) return base
    const time = index >= 250 ? 1_000 + index : index + 2
    return { ...base, status: "needs-input", updatedAt: time, report: { id: `rep_${key(index)}`, taskKey: key(index), sessionId: "ses_coordinator", outcome: "blocked",
      summary: `Blocked ${key(index)}`, evidence: [], next: [], createdAt: time, delivery: "coordinator-readout" } }
  })
  return { ...paged(), id: "blockages", objective: "Objective blockages", revision, actors: [], tasks, reports: tasks.flatMap(task => task.report ? [task.report] : []) }
}

test("ordinary Show more reaches every task and hides the attention notice, with failed-window Retry independent", async () => {
  const value = blockages(4), f = await open(value)
  try {
    const notice = f.page.locator(".mission-tree-attention"), failure = f.page.locator(".mission-tree-read")
    await notice.waitFor()
    for (let click = 0; await f.page.locator(".mission-tree-gap").count(); click++) {
      assert.ok(click < 8, "at most seven ordinary pages")
      const before = (await rows(f.page)).length
      await f.page.locator(".mission-tree-gap").first().getByRole("button", { name: "Show more", exact: true }).click()
      await f.page.waitForFunction(count => document.querySelectorAll(".mission-tree-node").length > count, before)
    }
    assert.deepEqual(await rows(f.page), missionTaskOrder(value.tasks).map(task => task.key), "every task once, in order")
    assert.equal(await f.page.locator('.mission-tree-node[data-status="needs-input"]').count(), 300)
    assert.deepEqual(f.reads.map(query => new URLSearchParams(query).get("offset")), ["50", "100", "150", "200", "250", "300", "350"], "ordinary reads only")
    assert.equal(await notice.count(), 0, "no unseen attention tasks remain")
    // Even on a fully shown plan, a failed attention read keeps its separate Retry.
    f.failTasks(true)
    await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.loadTasks("fixture", "blockages", { attention: 50 }))
    await failure.waitFor()
    assert.equal(await notice.count(), 0)
    f.failTasks(false)
    await failure.getByRole("button", { name: "Try again", exact: true }).click()
    await failure.waitFor({ state: "detached" })
    assert.equal(await notice.count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.context().close() }
})

test("a changed attention sequence counts nothing read before it as covered, and a failed middle window stays shown until it is read", async () => {
  const f = await open(blockages(3))
  try {
    const notice = f.page.locator(".mission-tree-attention"), failure = f.page.locator(".mission-tree-read")
    const blocked = () => f.page.locator('.mission-tree-node[data-status="needs-input"]').count()
    const idle = () => f.page.waitForFunction(async () => {
      const state = (await import("/src/stores/missions.ts")).missionStore.state("fixture")
      return state.status === "ready" && !state.taskReads?.blockages?.loading
        && document.querySelectorAll(".mission-tree-node").length === state.missions.find(value => value.id === "blockages")?.tasks.length
        && !document.querySelector(".mission-tree-attention button:disabled")
    })
    const showThem = async () => { await notice.getByRole("button", { name: "Show them", exact: true }).click(); await idle() }
    for (let click = 0; click < 10 && await notice.count(); click++) await showThem()
    assert.deepEqual([await notice.count(), await blocked()], [0, 200])
    // Revision 4: 100 newer blockages, the same order. The automatic reread of the window at 50 fails, once.
    let failed = false
    f.failTasks(query => { if (failed || query.get("attention") !== "50") return false; failed = true; return true })
    f.replace(blockages(4))
    await f.refresh()
    await failure.waitFor()
    await idle()
    // The windows at 100 and 150 were read again for the new sequence, the one at 50 failed: its failure stays.
    assert.match(await failure.innerText(), /These tasks could not be read\./)
    assert.equal(await notice.locator("span").innerText(), "180 more tasks need attention", "the new first keys and the windows at 50, 200 and 250")
    for (let click = 0; click < 10 && await notice.count(); click++) await showThem()
    assert.deepEqual([await notice.count(), await failure.count(), await blocked()], [0, 0, 300], "every blockage, the failure answered")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.context().close() }
})

test("a reader target whose read fails shows the failure with Retry, which reads it again; absence shows only once a read answered", async () => {
  const f = await open(paged())
  try {
    const target = (reader: Record<string, string>) => f.page.evaluate(async reader =>
      (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { reader: { missionId: "paged", ...reader } }), reader)
    const reader = f.page.locator(".mission-reader"), failure = reader.locator("p[role=status]", { hasText: "This content could not be read." })
    const missing = reader.getByText("This mission content is no longer available.", { exact: true })
    const readsOf = (name: string) => f.reads.filter(query => query.endsWith(name)).length
    for (const [kind, itemId, name, shown] of [["task", "task-t108", "ids=task-t108", "Task t108"], ["report", "rep_attempt_1", "reports=rep_attempt_1", "Summary of rep_attempt_1"]]) {
      f.failTasks(true)
      await target({ kind, itemId })
      await failure.waitFor()
      assert.equal(await missing.count(), 0, `${kind}: a failed read is no proof of absence`)
      // Reopening shows the same failure without reading again by itself.
      await target({ kind: "overview" })
      await target({ kind, itemId })
      await failure.waitFor()
      assert.equal(readsOf(name), 1, kind)
      f.failTasks(false)
      await reader.getByRole("button", { name: "Try again", exact: true }).click()
      await reader.getByText(shown, { exact: true }).first().waitFor()
      assert.equal(readsOf(name), 2, kind)
    }
    // A read that answers without the target proves it absent.
    await target({ kind: "task", itemId: "task-gone" })
    await missing.waitFor()
    assert.equal(readsOf("ids=task-gone"), 1)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.context().close() }
})

/** 125 independent tasks: the first 50 the window; then 5 whose results' notifications are
 * pending and 15 blockages, which take every pin; then 55 admitted to `ses_recover` without
 * a report, each offering a report recovery. */
function crowded(): MissionMap {
  const key = (index: number) => `c${String(index).padStart(3, "0")}`
  const report = (index: number, outcome: MissionReport["outcome"], pending: boolean): MissionReport => ({ id: `rep_${key(index)}`, taskKey: key(index),
    sessionId: "ses_coordinator", outcome, summary: `Result of ${key(index)}`, evidence: [], next: [], createdAt: index, delivery: "coordinator-readout",
    ...(pending ? { notificationStatus: "pending" as const } : {}) })
  const tasks = Array.from({ length: 125 }, (_, index): MissionTask => {
    const base: MissionTask = { id: `task-${key(index)}`, key: key(index), title: `Task ${key(index)}`, brief: "Brief", role: "worker", status: "ready",
      blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: index }
    if (index >= 50 && index < 55) return { ...base, status: "completed", report: report(index, "completed", true) }
    if (index >= 55 && index < 70) return { ...base, status: "needs-input", report: report(index, "blocked", false) }
    return index >= 70 ? { ...base, status: "queued", actorSessionId: "ses_recover", admissionId: `adm_${key(index)}` } : base
  })
  return { ...paged(), id: "crowded", objective: "Objective crowded", tasks, reports: tasks.flatMap(task => task.report ? [task.report] : []),
    actors: [{ sessionId: "ses_recover", title: "Recovering worker", kind: "specialist", managed: true, roles: ["worker"], location: { directory: "/fixture" }, joinedAt: 1 }] }
}

test("tasks needing action beyond the pins show a notice of their own with the mission's counts; Show them reads them by name, then by attention window", async () => {
  const f = await open(crowded(), [{ sessionId: "ses_recover", state: "idle-without-report" }])
  try {
    const notice = f.page.locator(".mission-tree-attention")
    await notice.waitFor()
    assert.deepEqual([await notice.locator("span").innerText(), await notice.locator("small").innerText()],
      ["55 more tasks need attention", "In this mission: 15 blocked, 0 failed, 55 awaiting a report, 5 with a notification pending"])
    assert.deepEqual(await gaps(f.page), [[70, 125, "55 tasks not shown"]], "the gap of the order is separate")
    assert.equal(await f.page.locator(".mission-tree-recovery button").count(), 0, "no recovery task is shown yet")
    // The first 50 by name, in the order the map named.
    await notice.getByRole("button", { name: "Show them", exact: true }).click()
    await f.page.waitForFunction(() => document.querySelectorAll(".mission-tree-node").length === 120)
    const named = `&keys=${Array.from({ length: 50 }, (_, index) => `c${String(70 + index).padStart(3, "0")}`).join(",")}`
    assert.ok(f.reads.some(query => /^\?order=[^&]+&keys=/.test(query) && query.endsWith(named)), f.reads.join(" "))
    assert.equal(await notice.locator("span").innerText(), "5 more tasks need attention")
    // The rest by attention window.
    await notice.getByRole("button", { name: "Show them", exact: true }).click()
    await f.page.waitForFunction(() => document.querySelectorAll(".mission-tree-node").length === 125)
    assert.ok(f.reads.some(query => /^\?order=[^&]+&attention=50$/.test(query)), f.reads.join(" "))
    await notice.waitFor({ state: "detached" })
    assert.equal(await f.page.locator(".mission-tree-recovery button").count(), 55, "every recovery action is reachable")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.context().close() }
})

test("Needs you lists the request of an actor whose task is outside the loaded page", async () => {
  const { page, errors } = await open(paged())
  try {
    assert.equal(await page.locator('.mission-tree-node[data-task-key="t118"]').count(), 0, "the actor's task is beyond the page")
    await page.evaluate(() => (window as any).missionFixture.queuePermission("ses_far", "far-permission"))
    const needs = page.locator(".mission-attention-list .mission-needs-item")
    await needs.waitFor()
    assert.equal(await needs.count(), 1)
    assert.equal(await needs.getByRole("button", { name: "Answer", exact: true }).getAttribute("aria-description"), "Open Far worker")
    assert.equal(await page.locator('.mission-tree-node[data-task-key="t118"]').count(), 0, "reading nothing further")
    assert.deepEqual(errors, [])
  } finally { await page.context().close() }
})

for (const failure of ["network", "changed"] as const) test(`sliced task ${failure} keeps rows/toolbars mounted and retries only from an explicit click`, async () => {
  const value = paged()
  value.tasks = value.tasks.map(task => ({ ...task, title: task.title + "\0".repeat(180) }))
  const f = await open(value)
  let fail = true
  const wire: Array<{ task: unknown; cursor?: unknown }> = [], bytes: number[] = [], mutations: string[] = [], oldTasks: string[] = []
  f.page.on("request", request => {
    if (/\/missions\/[^/]+\/tasks\?/.test(request.url())) oldTasks.push(request.url())
    if (request.method() !== "GET" && /\/missions\/[^/]+\/(control|recover)|\/session\/[^/]+\/(prompt|message|synthetic)/.test(request.url())) mutations.push(request.url())
  })
  await f.page.route("**/missions/panel-page", route => {
    const request = route.request(), input = request.postDataJSON()
    wire.push(input)
    assert.deepEqual([input.source, input.task.missionID], ["tasks", value.id])
    assert.equal(request.method(), "POST"); assert.ok(Buffer.byteLength(request.postData()!) <= 16_384)
    if (fail && input.cursor) return failure === "network" ? route.fulfill({ status: 503, json: { error: "Offline" } })
      : route.fulfill({ json: { available: false, reason: "changed" } })
    const answer = missionTaskFixture(request.url(), request.method(), [value], "project", request.postData())
    bytes.push(Buffer.byteLength(JSON.stringify(answer)))
    return route.fulfill({ json: answer })
  })
  try {
    const original = await rows(f.page), toolbar = f.page.locator(".mission-action-bar"), element = await toolbar.elementHandle()
    await f.page.locator(".mission-tree-gap").first().getByRole("button", { name: "Show more", exact: true }).click()
    const read = f.page.locator(".mission-tree-read")
    await read.waitFor()
    assert.match(await read.innerText(), failure === "changed" ? /task list changed/ : /tasks could not be read/)
    assert.deepEqual(await rows(f.page), original, "no partial row publication")
    assert.equal(await toolbar.evaluate((current, original) => current === original, element), true)
    const failedCalls = wire.length
    await f.refresh(); await settle(f.page)
    assert.equal(wire.length, failedCalls, "same-revision refresh leaves the failed logical selector parked")
    fail = false
    await read.getByRole("button", { name: "Try again", exact: true }).click()
    await f.page.waitForFunction(() => document.querySelectorAll(".mission-tree-node").length === 101)
    assert.equal(wire[failedCalls].cursor, undefined, "explicit Retry starts at the first slice")
    assert.ok(wire.length > failedCalls + 1, "the full logical window needed several bounded transfers")
    assert.ok(Math.max(...bytes) <= 65_536)
    assert.deepEqual(oldTasks, []); assert.deepEqual(mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.page.context().close() }
})

test("a real reconnect fences a held task continuation and never publishes its rows or sends a mutation", async () => {
  const value = paged()
  value.tasks = value.tasks.map(task => ({ ...task, title: task.title + "\0".repeat(180) }))
  const f = await open(value)
  let release!: () => void, entered!: () => void, reconnected = false
  const gate = new Promise<void>(resolve => { release = resolve }), held = new Promise<void>(resolve => { entered = resolve })
  let reads = 0
  const mutations: string[] = []
  f.page.on("request", request => {
    if (request.method() !== "GET" && /\/missions\/[^/]+\/(control|recover)|\/session\/[^/]+\/(prompt|message|synthetic)/.test(request.url())) mutations.push(request.url())
  })
  await f.page.route("**/missions/panel-page", async route => {
    reads++
    if (reconnected) return route.fulfill({ status: 503, json: {} })
    const request = route.request(), answer = missionTaskFixture(request.url(), request.method(), [value], "project", request.postData())
    if (request.postDataJSON().cursor) { entered(); await gate }
    return route.fulfill({ json: answer }).catch(() => {})
  })
  try {
    const original = await rows(f.page)
    await f.page.locator(".mission-tree-gap").first().getByRole("button", { name: "Show more", exact: true }).click()
    await held; reconnected = true
    await f.page.evaluate(async () => {
      const { serverEvents } = await import("/src/lib/server-events.ts")
      ;(serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: "fixture", status: "connected" }])
    })
    release()
    await f.page.locator(".mission-tree-read").waitFor()
    assert.deepEqual(await rows(f.page), original)
    assert.ok(reads <= 3, "one bounded revalidation after reconnect, no loop")
    assert.deepEqual(mutations, [])
    assert.deepEqual(f.errors, [])
  } finally { release?.(); await f.page.context().close() }
})

for (const recovery of ["fresh", "retry"] as const) test(`a central reader without a mounted panel keeps reconnect ${recovery} distinct from absence`, async () => {
  const value = paged(), f = await open(value)
  let entered!: () => void, release!: () => void, sends = 0, allow = recovery === "fresh"
  const selectors: unknown[] = []
  const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  await f.page.route("**/missions/panel-page", async route => {
    const request = route.request(), answer = missionTaskFixture(request.url(), request.method(), [value], "project", request.postData())
    selectors.push(request.postDataJSON())
    if (++sends === 1) { entered(); await gate }
    else if (!allow) return route.fulfill({ status: 503, json: {} })
    return route.fulfill({ json: answer }).catch(() => {})
  })
  try {
    await f.page.evaluate(async () => {
      ;(window as any).missionFixture.mount(false)
      ;(await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { reader: { missionId: "paged", kind: "task", itemId: "task-t108" } })
    })
    await ready
    assert.equal(await f.page.locator(".mission-tree").count(), 0)
    assert.deepEqual(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.demandedInstanceIds()), ["fixture"])
    const replacementFailed = !allow ? f.page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/missions/panel-page") && response.status() === 503) : undefined
    await f.page.evaluate(async () => {
      const { serverEvents } = await import("/src/lib/server-events.ts")
      ;(serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: "fixture", status: "connected" }])
    })
    release()
    const reader = f.page.locator(".mission-reader")
    if (!allow) {
      await replacementFailed
      await reader.getByRole("button", { name: "Try again", exact: true }).waitFor()
      assert.equal(await reader.getByText("This mission content is no longer available.", { exact: true }).count(), 0)
      await f.page.waitForFunction(async () => {
        const read = (await import("/src/stores/missions.ts")).missionStore.state("fixture").taskReads?.paged
        return !read?.loading && read?.failure?.reason === "unavailable"
      })
      allow = true
      await reader.getByRole("button", { name: "Try again", exact: true }).click()
    }
    await reader.getByRole("heading", { name: "Task t108", exact: true }).waitFor()
    assert.equal(await reader.getByText("This mission content is no longer available.", { exact: true }).count(), 0)
    assert.equal(sends, recovery === "fresh" ? 2 : 3, `one owned replacement attempt, then explicit Retry only: ${JSON.stringify(selectors)}`)
    assert.deepEqual(f.errors, [])
  } finally { release?.(); await f.page.context().close() }
})
