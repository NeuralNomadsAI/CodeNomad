import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionActor, MissionActorActivity, MissionMap } from "../../../server/src/api-types"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget, waitForMissionPanelRefresh } from "./mission-panel-route"
import { inlineMissionEntry, missionToolbarAction, selectedMissionTitle, selectMission } from "./mission-actions"
import { panelMissions } from "./mission-content-fixture"
import { recurrenceCurrentPageInput } from "../../../server/src/missions/recurrence-current"
import { projectMissionPanel } from "../../../server/src/missions/mission-panel-projection"
import { missionPanelPage } from "../../../server/src/missions/mission-panel-page"
import { activityActorWindow, missionActivityContext } from "../../../server/src/missions/mission-activity-context"
import { BUILT_IN_COLOR_SCHEMES } from "../../src/lib/theme-scheme"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "mission-status-marks", routes: [{ path: "/mission-fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

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
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(missions()),
    generatedAt: Date.now(), discardedEvents: 0, activity: { generatedAt: Date.now(), missions: activity() } } }))
  // The real bounded source/projections include its coordinator and one independent actor.
  const current = (id: string) => {
    const schedule = schedules.find(item => item.id === id), passageID = schedule?.pending?.passageID ?? null
    return { passageID, source: passageID ? { owner: "daily" as const, projectID: "project", scheduleID: id, passageID, missionID: passageID, digest: "a".repeat(43) } : undefined,
      map: passageID ? mission(passageID, { coordinatorSessionId: schedule!.pending!.conversationID,
        actors: [actor(schedule!.pending!.conversationID!), actor("ses_independent", "specialist")] }) : undefined }
  }
  await page.route(url => url.pathname.endsWith("/current"), route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!, value = current(id)
    return route.fulfill({ json: { version: 1, ownerRevision: 1, projectID: "project", scheduleID: id, passageID: value.passageID, ...(value.source ? { source: value.source } : {}) } })
  })
  await page.route(url => /\/current\/[^/]+\/page$/.test(url.pathname), route => {
    const input = recurrenceCurrentPageInput.parse(route.request().postDataJSON()), { map, source } = current(input.source.scheduleID), selector = input.selector
    assert.ok(map && source); assert.deepEqual(input.source, source)
    if (selector.source === "summaries" || selector.source === "cleanups" || selector.source === "marks") throw Error("Unexpected project read")
    const damage = { discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
    if (selector.source === "activity") return route.fulfill({ json: missionPanelPage({ projectID: "project", missionID: map.id, revision: map.revision,
      ...damage, passage: source, source: "activity", phase: "observed", observedAt: 1 }, [{ context: activityActorWindow(missionActivityContext(map, damage), 0, 160), coverage: "unknown",
      requests: { state: "unknown", items: [] }, activity: { actors: map.actors.map(actor => ({ sessionId: actor.sessionId, state: "unknown" })),
        family: { state: "unknown", members: [] } } }], selector.cursor) })
    return route.fulfill({ json: projectMissionPanel(map, selector, damage, { passage: source }) })
  })
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
  const response = waitForMissionPanelRefresh(page)
  await fixtureCall(page, "refresh")
  await response
}
const mark = async (page: Page, title: string) => (await inlineMissionEntry(page, title)).locator(".mission-row-flag").getAttribute("data-mark")

for (const variant of ["remount", "retitle", "leaf"] as const) test(`selection resolves the current business row after ${variant}`, async () => {
  let value = mission("selection", variant === "leaf" ? { tasks: [] } : {})
  const { page, errors } = await open(() => [value], () => [])
  try {
    const entry = await inlineMissionEntry(page, value.objective)
    await entry.waitFor()
    const original = await entry.elementHandle()
    if (variant === "retitle") value = { ...value, objective: "Renamed selection", revision: 2 }
    // Replace the real Solid panel at the selection/expansion boundary. The HTTP
    // refresh can also rename the business row while the helper still has its old title.
    await page.evaluate(`(async () => {
      const { missionStore } = await import("/src/stores/missions.ts")
      document.addEventListener("click", async function remount(event) {
        if (!event.target.closest(".mission-row-select")) return
        document.removeEventListener("click", remount)
        window.selectionClickTrusted = event.isTrusted
        const fixture = window.missionFixture
        fixture.mount(false)
        await missionStore.refresh("fixture")
        fixture.mount(true)
      })
    })()`)
    const detail = await selectMission(page, "Objective selection")
    assert.equal(await original!.evaluate(element => element.isConnected), false, "the original row really detached")
    assert.equal(await page.evaluate(() => (window as any).selectionClickTrusted), true)
    assert.equal(await selectedMissionTitle(page).innerText(), value.objective)
    assert.equal(await detail.isVisible(), variant !== "leaf")
    assert.equal(await page.locator('.mission-row[data-mission-key="mission:selection"] .session-item-expander:not(.session-item-expander--spacer)').count(), variant === "leaf" ? 0 : 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("marks follow the session palette and a completion stays green until this window shows it", async () => {
  let list = [
    mission("stuck", { updatedAt: 6 }),
    mission("working", { updatedAt: 5 }),
    mission("history", { updatedAt: 4, finishSequence: 1, status: "completed" }),
    mission("failed", { updatedAt: 3, status: "failed" }),
    mission("paused", { updatedAt: 2, runState: "paused" }),
    mission("prepared", { updatedAt: 1, runState: "prepared" }),
  ]
  let activity = [{ missionId: "stuck", actors: [{ sessionId: "ses_stuck", state: "idle-without-report" as const }] },
    { missionId: "working", actors: [{ sessionId: "ses_working", state: "running" as const }] }]
  const { page, errors } = await open(() => list, () => activity)
  try {
    // Each row's flag carries its own mark.
    await (await inlineMissionEntry(page, "Objective stuck")).waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll(".mission-rows .mission-row-flag")].some(element => element.getAttribute("data-mark") === "working"))
    assert.deepEqual(await Promise.all(["Objective stuck", "Objective working", "Objective history", "Objective failed", "Objective paused", "Objective prepared"]
      .map(title => mark(page, title))), ["interrupted", "working", "idle", "interrupted", "paused", "prepared"])
    assert.equal(await page.evaluate(() => {
      const element = [...document.querySelectorAll<HTMLElement>(".mission-rows .mission-row-flag")].find(item => item.dataset.mark === "prepared")!
      const probe = document.createElement("span"); probe.style.color = "var(--accent-primary)"; document.body.append(probe)
      const blue = getComputedStyle(probe).color; probe.remove()
      return getComputedStyle(element).color === blue
    }), true, "a prepared mission is accent blue, like a composed prompt")

    list = list.map(value => value.id === "working" ? { ...value, status: "completed", updatedAt: 7, finishSequence: 2, revision: 2 } : value)
    activity = activity.filter(item => item.missionId !== "working")
    await refresh(page)
    await page.waitForFunction(() => [...document.querySelectorAll(".mission-rows .mission-row-flag")]
      .some(element => element.getAttribute("data-mark") === "done"))
    assert.equal(await mark(page, "Objective working"), "done")
    assert.equal(await mark(page, "Objective history"), "idle", "missions already completed on the first read count as seen")

    await selectMission(page, "Objective working")
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "idle")
    assert.equal(await mark(page, "Objective working"), "idle")
    await fixtureCall(page, "flush")
    await page.reload()
    await selectedMissionTitle(page).waitFor()
    assert.equal(await mark(page, "Objective working"), "idle", "seen completions stay seen in this window")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a refresh that reorders the rows keeps keyboard focus and the selection's detail", async () => {
  let list = [mission("first", { updatedAt: 3 }), mission("second", { updatedAt: 2 }), mission("third", { updatedAt: 1 })]
  const { page, errors } = await open(() => list, () => [])
  try {
    await selectMission(page, "Objective second")
    await (await inlineMissionEntry(page, "Objective third")).focus()
    const order = () => page.locator(".mission-rows .mission-row .session-item-title").allInnerTexts()
    assert.deepEqual(await order(), ["Objective first", "Objective second", "Objective third"])
    list = list.map(value => value.id === "third" ? { ...value, updatedAt: 9, revision: 2 } : value)
    await refresh(page)
    await page.waitForFunction(() => document.querySelector(".mission-rows .mission-row .session-item-title")?.textContent === "Objective third")
    assert.deepEqual(await order(), ["Objective third", "Objective first", "Objective second"])
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".mission-row")?.querySelector(".session-item-title")?.textContent),
      "Objective third", "the focused row keeps focus when a refresh moves it")
    assert.equal(await page.locator(".mission-row:has(.mission-row-select[aria-current=true]) + .mission-row-children section.mission-detail").count(), 1,
      "the detail stays the selected row's children")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a selected mission completing behind the creation form stays green until its detail shows again", async () => {
  let list = [mission("selected"), mission("other", { updatedAt: 2 })]
  const { page, errors } = await open(() => list, () => [])
  try {
    await selectMission(page, "Objective selected")
    await page.locator("section.mission-detail").waitFor()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.locator("form.mission-editor").waitFor()
    assert.equal(await page.locator("section.mission-detail").isVisible(), false)
    list = list.map(value => value.id === "selected" ? { ...value, status: "completed", updatedAt: 3, finishSequence: 1, revision: 2 } : value)
    await refresh(page)
    // The hidden (still mounted) tree keeps the unseen completion green.
    const fieldMark = () => page.evaluate(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark"))
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "done")
    await page.waitForTimeout(200)
    assert.equal(await fieldMark(), "done", "a completion behind the form is not seen")
    await page.locator("form.mission-editor").getByRole("button", { name: "Cancel", exact: true }).click()
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "idle")
    assert.equal(await page.locator("section.mission-detail").isVisible(), true, "seen once its detail shows again")
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
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "interrupted")
    for (let attempt = 0; !recoveries.length && attempt < 100; attempt++) await page.waitForTimeout(20)
    assert.deepEqual(recoveries, [{ expectedRevision: 1, target: "coordinator" }])

    const [done, blocked, muted] = await page.evaluate(() => {
      const probe = document.createElement("span"); probe.style.color = "var(--text-muted)"; document.body.append(probe)
      const color = getComputedStyle(probe).color; probe.remove()
      return [...["done", "blocked"].map(state =>
        getComputedStyle(document.querySelector(`.mission-tree .mission-tree-node[data-state="${state}"] .mission-tree-mark`)!).color), color]
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
    await (await inlineMissionEntry(page, "Waiting review")).waitFor()
    assert.deepEqual(await Promise.all(["Waiting review", "Stopped review", "Paused review"].map(title => mark(page, title))),
      ["working", "idle", "paused"])
    // Selected, its read passage counts its open questions: a loaded subsession
    // outside the observed family does not, its declared actors do.
    await page.evaluate(() => (window as any).missionFixture.seedCoordinators(["ses_passage", "ses_child"], { ses_child: "ses_passage" }))
    await selectMission(page, "Waiting review")
    await page.locator('.mission-tree [data-task-key="task-one"]').waitFor()
    await page.evaluate(() => (window as any).missionFixture.queuePermission("ses_child", "child-permission"))
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(await page.locator(".mission-row-select[aria-current=true] .mission-row-flag").getAttribute("data-mark"), "working")
    await page.evaluate(() => (window as any).missionFixture.queuePermission("ses_independent", "independent-permission"))
    await page.waitForFunction(() => document.querySelector(".mission-row-select[aria-current=true] .mission-row-flag")?.getAttribute("data-mark") === "permission")
    // Other rows read the live passage's own conversation.
    await selectMission(page, "Stopped review")
    await page.evaluate(() => (window as any).missionFixture.queuePermission("ses_passage"))
    await page.waitForFunction(() => [...document.querySelectorAll(".mission-rows .mission-row-flag")]
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
    assert.match(await page.locator(".mission-row-select[aria-current=true] .sr-only").textContent() ?? "", /^Failed · /)
    assert.equal(await page.locator(".mission-row-select[aria-current=true] .mission-row-flag").getAttribute("data-mark"), "interrupted")
    assert.equal(await missionToolbarAction(page, "Stop mission permanently").isDisabled(), true)
    await missionToolbarAction(page, "Recover interrupted mission").click()
    for (let attempt = 0; !recoveries.length && attempt < 100; attempt++) await page.waitForTimeout(20)
    assert.deepEqual(recoveries, [{ expectedRevision: 1, target: "coordinator" }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("daily waiting, unread passage identities, restoration and paused/warning shapes use the real shared rows", async () => {
  const schedule: RecurrenceSchedule = { id: "rec_marks", title: "Daily marks", revision: 1, state: "running",
    clock: { time: "09:00", zone: "UTC" }, nextDueAt: Date.now() + 3_600_000, pending: null, latestResult: null,
    history: [], actions: ["pause", "stop", "run-now"], controls: [] }
  const { page, errors } = await open(() => [mission("other", { runState: "prepared" })], () => [], [schedule])
  const entry = page.locator('[data-mission-key="schedule:rec_marks"] .mission-row-select')
  const waitMark = (expected: string) => page.waitForFunction(expected =>
    document.querySelector('[data-mission-key="schedule:rec_marks"] .mission-row-flag')?.getAttribute("data-mark") === expected, expected)
  const refreshDaily = () => page.evaluate(async data => {
    const { serverEvents } = await import("/src/lib/server-events.ts")
    ;(serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: "fixture",
      event: { type: "rpc.codenomad.missions.scheduleChanged", data } }])
  }, { scheduleID: schedule.id, revision: schedule.revision })
  const success = async (id: string) => {
    const result = { passageID: id, outcome: "completed" as const, dueAt: Date.now() - 2, settledAt: Date.now() - 1 }
    schedule.history.push(result); schedule.latestResult = result; schedule.revision++
    const published = page.waitForResponse(async response => new URL(response.url()).pathname.endsWith("/missions/recurrence")
      && (await response.json()).schedules?.some((row: any) => row.latestResult?.passageID === id))
    await refreshDaily(); await (await published).finished()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await waitMark("done")
  }
  try {
    await fixtureCall(page, "connectCatalog")
    await entry.waitFor(); await waitMark("waiting")
    assert.match(await entry.getAttribute("title") ?? "", /Waiting for scheduled run.*Next:/)
    // All ready-made palettes, on idle, hover, focus and selected rows. The
    // secondary-text underline supplies the shape contrast even on pale accents.
    for (const scheme of BUILT_IN_COLOR_SCHEMES) {
      await page.evaluate(async id => {
        const module = await import("/src/lib/theme-scheme.ts")
        module.applyColorScheme(module.normalizeColorScheme(id))
      }, scheme.id)
      for (const state of ["idle", "hover", "focus", "selected"] as const) {
        if (state === "idle") { await (await inlineMissionEntry(page, "Objective other")).click(); await page.mouse.move(0, 0) }
        if (state === "hover") await entry.hover()
        if (state === "focus") { await page.mouse.move(0, 0); await entry.focus() }
        if (state === "selected") await entry.click()
        const sample = await entry.evaluate(element => {
          const cell = element.querySelector(".mission-row-mark")!, icon = cell.querySelector("svg")!, line = getComputedStyle(cell, "::after")
          const style = getComputedStyle(cell), svg = getComputedStyle(icon), row = getComputedStyle(element.parentElement!)
          const probe = document.createElement("span"); element.append(probe)
          probe.style.color = "var(--text-secondary)"; const secondary = getComputedStyle(probe).color
          probe.style.color = "var(--accent-primary)"; const accent = getComputedStyle(probe).color
          probe.style.color = "var(--surface-canvas)"; const surface = getComputedStyle(probe).color
          const canvas = document.createElement("canvas").getContext("2d")!
          canvas.fillStyle = surface; canvas.fillRect(0, 0, 1, 1)
          canvas.fillStyle = row.backgroundColor; canvas.fillRect(0, 0, 1, 1)
          if (row.backgroundImage !== "none" || element.parentElement!.matches(":hover")) {
            probe.style.color = "var(--surface-hover-overlay)"; canvas.fillStyle = getComputedStyle(probe).color; canvas.fillRect(0, 0, 1, 1)
          }
          const background = [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3)
          canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = line.backgroundColor; canvas.fillRect(0, 0, 1, 1)
          const foreground = [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3)
          probe.remove()
          return { width: style.width, height: style.height, lineWidth: line.width, lineHeight: line.height, lineTop: line.top,
            lineColor: line.backgroundColor, secondary, accent, color: svg.color, opacity: svg.opacity,
            animation: svg.animationName, lineOpacity: line.opacity, foreground, background }
        })
        assert.deepEqual([sample.width, sample.height, sample.lineWidth, sample.lineHeight, sample.lineTop], ["16px", "20px", "8px", "1px", "19px"])
        assert.equal(sample.lineColor, sample.secondary); assert.equal(sample.color, sample.accent)
        assert.equal(sample.opacity, "1"); assert.equal(sample.lineOpacity, "1"); assert.equal(sample.animation, "none")
        const lum = (rgb: number[]) => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
          .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
        const [a, b] = [lum(sample.foreground), lum(sample.background)].sort((a, b) => b - a)
        assert.ok((a + .05) / (b + .05) >= 3, `${scheme.id}/${state}: ${JSON.stringify(sample)}`)
      }
    }
    await success("pas_A")
    await fixtureCall(page, "flush")
    await page.reload()
    await fixtureCall(page, "connectCatalog")
    await entry.waitFor(); await waitMark("done")
    assert.equal(await entry.getAttribute("aria-current"), "true", "selection restores, unread result remains")
    await entry.click(); await waitMark("waiting")
    await success("pas_B")
    // Explicit Mark as read also works without selecting a schedule.
    await page.locator('[data-mission-key="schedule:rec_marks"] .session-item-expander').click({ button: "right" })
    await success("pas_B_next")
    await page.getByRole("menuitem", { name: "Mark as read", exact: true }).click()
    assert.equal(await mark(page, "Daily marks"), "done", "the open menu acknowledges B, not the later passage")
    assert.deepEqual(await page.evaluate(async () => {
      const { scheduleSuccessSeen } = await import("/src/stores/mission-view-state.ts")
      const scope = JSON.stringify(["fixture", "project"])
      return ["pas_B", "pas_B_next"].map(id => scheduleSuccessSeen(scope, "daily", "rec_marks", id))
    }), [true, false])
    await page.locator('[data-mission-key="schedule:rec_marks"] .session-item-expander').click({ button: "right" })
    await page.getByRole("menuitem", { name: "Mark as read", exact: true }).click()
    await waitMark("waiting")
    // A result arriving while the panel is hidden stays unread on returning.
    await page.evaluate(() => (window as any).missionFixture.active(false))
    const result = { passageID: "pas_C", outcome: "completed" as const, dueAt: Date.now() - 2, settledAt: Date.now() - 1 }
    schedule.history.push(result); schedule.latestResult = result; schedule.revision++
    await page.evaluate(() => (window as any).missionFixture.active(true))
    await waitMark("done")
    await entry.click(); await waitMark("waiting")
    await page.emulateMedia({ reducedMotion: "reduce" })
    schedule.pending = { passageID: "pas_D", status: "running" }; schedule.revision++
    await refreshDaily(); await waitMark("working")
    const motion = await entry.locator("svg").evaluate(element => {
      const style = getComputedStyle(element); return [style.animationDuration, style.animationIterationCount]
    })
    assert.ok(parseFloat(motion[0]) <= .00001); assert.equal(motion[1], "1")
    schedule.state = "paused"; schedule.nextDueAt = null; schedule.revision++
    await refreshDaily(); await waitMark("paused")
    assert.equal(await entry.locator("svg rect").count(), 2, "Pause has two bars")
    schedule.state = "interrupted"; schedule.pending.status = "uncertain"; schedule.revision++
    await refreshDaily(); await waitMark("interrupted")
    assert.equal(await entry.locator("svg path").count(), 3, "interruption has a warning triangle and exclamation")
    schedule.state = "running"; schedule.nextDueAt = Date.now() + 3_600_000; schedule.revision++
    await refreshDaily(); await waitMark("unconfirmed")
    assert.match(await entry.getAttribute("title") ?? "", /State unconfirmed/)
    schedule.state = "stopped"; schedule.nextDueAt = null; schedule.revision++
    await refreshDaily(); await waitMark("idle")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
