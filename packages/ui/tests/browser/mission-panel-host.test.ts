import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type BrowserContextOptions, type Page, type Route } from "playwright"
import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { MISSION_TASK_PAGE } from "../../../server/src/missions/mission-panel-map"
import { missionDetail, missionGeneralAction, inlineMissionEntry, selectMission, selectedMissionTitle } from "./mission-actions"
import { panelMissions } from "./mission-content-fixture"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-panel-host",
      routes: [
        { path: "/mission-panel-host", html: "<html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body style=\"margin:0\"><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-panel-host.tsx\"></script></body></html>" },
      ],
    })
  try {
    url = fixture.url
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
  } catch (error) { throw error }
})
after(async () => { await browser?.close() })

const TASKS = 60
const task = (index: number): MissionTask => ({ id: `task-${index}`, key: `t${index}`, title: `Step ${index + 1} of the long migration`,
  brief: `Brief ${index}`, role: "worker", status: index < 20 ? "completed" : index < 22 ? "dispatching" : "blocked",
  blockedBy: index ? [`t${index - 1}`] : [], outstandingExecution: false, createdAt: 1, updatedAt: 1,
  ...(index === 20 ? { actorSessionId: "ses_worker" } : {}) })
function mission(id: string, objective: string, tasks: MissionTask[]): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective, template: "custom",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running",
    actors: [{ sessionId: `ses_${id}`, kind: "coordinator", managed: true, title: "Coordinator", roles: ["coordinator"], location: { directory: "fixture" }, joinedAt: 1 },
      { sessionId: "ses_worker", kind: "specialist", managed: true, title: "Worker", roles: ["worker"], location: { directory: "fixture" }, joinedAt: 1 }],
    frontier: [], claims: [], revision: 3, createdAt: 1, updatedAt: Date.now() - 3_600_000, history: [], historyTruncated: false, tasks, reports: [] }
}
const LONG = mission("long", "Long migration", Array.from({ length: TASKS }, (_, index) => task(index)))
const SHORT = mission("short", "Short audit", [task(0)])

async function open(options: BrowserContextOptions = {}, holdDepth = false) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1000, height: 600 }, ...options })
  const page = await context.newPage(), errors: string[] = [], mutations: string[] = [], sessionReads: string[] = []
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.includes("/session/")) sessionReads.push(path) })
  // Native reads naming the long mission's coordinator (its messages, its children).
  const coordinatorReads: string[] = []
  page.on("request", request => { if (request.url().includes("ses_long")) coordinatorReads.push(request.url()) })
  await page.addInitScript("globalThis.__name ??= target => target")
  page.setDefaultTimeout(15_000)
  page.on("pageerror", error => errors.push(error.message))
  let depthRoute: Route | undefined
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`)
    if (holdDepth && path.endsWith("/subagent-depth")) { depthRoute = route; return }
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions([LONG, SHORT]), generatedAt: 1, discardedEvents: 0,
      activity: { generatedAt: 1, missions: [{ missionId: "long", actors: [{ sessionId: "ses_worker", state: "running" }] }, { missionId: "short", actors: [] }] } } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] } })
    return route.fulfill({ json: {} })
  })
  await page.goto(url, { timeout: 60_000 })
  await page.locator(".mission-rows button.mission-row-select").first().waitFor()
  return { page, errors, mutations, sessionReads, coordinatorReads, close: () => context.close(), releaseDepth: async () => {
    assert(depthRoute, "the actual depth HTTP request is held")
    // Exactly the default HTTP fixture reply, including its depth-read validation error.
    const route = depthRoute; depthRoute = undefined
    await route.fulfill({ json: {} })
  } }
}

const scrolls = (page: Page, selector: string) => page.locator(selector).first().evaluate(element => element.scrollHeight > element.clientHeight + 1)

test("a long mission's tasks scroll with the panel, the only scroller, under its fixed header", async () => {
  for (const viewport of [{ width: 1000, height: 600 }, { width: 1000, height: 420 }]) {
    const f = await open({ viewport })
    try {
      const detail = await selectMission(f.page, "Long migration")
      const flow = detail.locator(".mission-tree .mission-flow")
      // One continuation follows the continuous rows and loads on scrolling.
      await flow.locator(".mission-tree-more").waitFor({ state: "attached" })
      assert.equal(await flow.locator(".mission-tree-node").count(), MISSION_TASK_PAGE)
      assert.equal(await detail.locator(".mission-tree").getAttribute("aria-label"), `Tasks (${TASKS})`, "the group names its task count")
      assert.equal(await scrolls(f.page, ".mission-tree .mission-flow"), false, `no task scroller at ${viewport.height}px`)
      assert.equal(await scrolls(f.page, "#tab-body"), false, `no host scrollbar at ${viewport.height}px`)
      assert.equal(await scrolls(f.page, ".mission-control"), true, `the panel scrolls at ${viewport.height}px`)
      // The list's end (its read further) is reachable by scrolling the panel; the header stays.
      const last = flow.locator(".mission-tree-list > li").last()
      await last.scrollIntoViewIfNeeded()
      assert.equal(await f.page.locator("#tab-body").evaluate(element => element.scrollTop), 0)
      assert(await f.page.locator(".mission-control").evaluate(element => element.scrollTop) > 0)
      const [header, panel] = await Promise.all([f.page.locator(".mission-control-header").boundingBox(), f.page.locator(".mission-control").boundingBox()])
      assert(header && panel && Math.abs(header.y - panel.y) <= 1, `the header stays at the panel top at ${viewport.height}px: ${header?.y} vs ${panel?.y}`)
      // Nothing escapes the panel's clipping: every absolutely positioned descendant
      // (screen-reader labels, the dependency overlay) is contained by the scroller, so
      // no outer container or the window itself gains an overflow to scroll.
      assert.deepEqual(await f.page.locator(".mission-control").evaluate(panel => [...panel.querySelectorAll("*")]
        .filter(element => ["absolute", "fixed"].includes(getComputedStyle(element).position) && element.offsetParent
          && element.offsetParent !== panel && !panel.contains(element.offsetParent)).map(element => element.className)), [], `no descendant escapes at ${viewport.height}px`)
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.body.scrollHeight <= innerHeight + 1), true,
        `the window never overflows at ${viewport.height}px`)
      // The mission row's chevron folds the tasks with the rest of its detail.
      const chevron = f.page.locator(".mission-row:has(.mission-row-select[aria-current=true]) .session-item-expander")
      await chevron.click()
      assert.equal(await chevron.getAttribute("aria-expanded"), "false")
      assert.equal(await flow.isVisible(), false)
      assert.equal(await scrolls(f.page, "#tab-body"), false)
      await chevron.click()
      assert.equal(await chevron.getAttribute("aria-expanded"), "true")
      assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  }
})

test("rows select a Mission whose detail is the row's children; its chevron folds the detail and the filter keeps it listed", async () => {
  const f = await open()
  try {
    const row = (title: string) => f.page.locator(".mission-row").filter({ has: f.page.locator(".session-item-title", { hasText: new RegExp(`^${title}$`) }) })
    const chevron = (title: string) => row(title).locator(".session-item-expander")
    const actions = f.page.locator(".mission-picker-selection-actions .mission-action-bar")
    assert.equal(await missionDetail(f.page).count(), 0, "nothing is selected by default")
    assert.equal(await actions.count(), 0, "no selection mounts no toolbar")
    assert.equal(await f.page.locator(".mission-picker-idle-actions .mission-action-bar button:enabled").count(), 0, "the same buttons show disabled")
    // Selecting a row expands it: its detail directly follows it, its toolbar is in the header.
    await (await inlineMissionEntry(f.page, "Short audit")).click()
    assert.equal(await missionDetail(f.page).getAttribute("aria-label"), "Short audit")
    assert.equal(await chevron("Short audit").getAttribute("aria-expanded"), "true")
    assert.equal(await chevron("Long migration").getAttribute("aria-expanded"), "false")
    await actions.waitFor()
    assert.equal(await row("Short audit").evaluate(element => Boolean(element.nextElementSibling?.querySelector("section.mission-detail"))), true)
    // The selected row's chevron folds and unfolds its detail without changing the selection.
    await chevron("Short audit").click()
    assert.equal(await chevron("Short audit").getAttribute("aria-expanded"), "false")
    assert.equal(await missionDetail(f.page).isVisible(), false, "folded, the detail stays mounted but hidden")
    assert.equal(await selectedMissionTitle(f.page).innerText(), "Short audit")
    assert.equal(await actions.isVisible(), true, "the toolbar still acts on the folded selection")
    await chevron("Short audit").click()
    await missionDetail(f.page).waitFor()
    // Another mission's chevron expands its tasks, read on demand, without selecting it.
    await chevron("Long migration").click()
    assert.equal(await chevron("Long migration").getAttribute("aria-expanded"), "true")
    assert.equal(await selectedMissionTitle(f.page).innerText(), "Short audit")
    const preview = row("Long migration").locator("xpath=following-sibling::div[contains(@class, 'mission-row-children')]")
    await preview.locator('.mission-tree-node[data-task-key="t20"]').waitFor()
    // Like a selected mission, an expanded one reads its native task conversations.
    for (let attempt = 0; !f.sessionReads.some(path => path.includes("ses_long")) && attempt < 100; attempt++) await f.page.waitForTimeout(50)
    assert.ok(f.sessionReads.some(path => path.includes("ses_long")), `the expanded mission's coordinator delegations are read: ${f.sessionReads.join(", ")}`)
    assert.equal(await missionDetail(f.page).getAttribute("aria-label"), "Short audit", "the selection's detail stays where it is")
    // A task there selects its mission (and asks for the task's reader).
    await preview.locator('.mission-tree-node[data-task-key="t20"] .mission-tree-task').click()
    assert.equal(await selectedMissionTitle(f.page).innerText(), "Long migration")
    await missionDetail(f.page).and(f.page.locator('[aria-label="Long migration"]')).waitFor()
    assert.equal(await chevron("Long migration").getAttribute("aria-expanded"), "true", "selected, it shows its detail")
    // The filter narrows the other rows only.
    await f.page.locator(".mission-picker-search").fill("audit")
    assert.equal(await row("Short audit").count(), 1)
    assert.equal(await row("Long migration").count(), 1, "the selected row stays listed")
    await f.page.locator(".mission-picker-search").fill("")
    // The selection survives a remount.
    await f.page.evaluate(() => (window as any).missionHost.mount(false))
    await f.page.evaluate(() => (window as any).missionHost.mount(true))
    await missionDetail(f.page).waitFor()
    assert.equal(await selectedMissionTitle(f.page).innerText(), "Long migration")
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

for (const hide of ["none", "fold", "create"] as const) test(`an expanded mission's native task reads ${hide === "fold" ? "stop once it folds" : hide === "create" ? "stop while the creation form hides it" : "go on while it stays expanded"}`, async () => {
  const f = await open()
  try {
    // Hold the coordinator's message read: the children read only follows it.
    let held: Route | undefined
    await f.page.route(url => url.href.includes("ses_long") && url.pathname.includes("/message"), route => {
      if (!held) { held = route; return }
      return route.fulfill({ json: { data: [] } })
    })
    const chevron = f.page.locator(".mission-row").filter({ has: f.page.locator(".session-item-title", { hasText: /^Long migration$/ }) }).locator(".session-item-expander")
    await chevron.click()
    for (let attempt = 0; !held && attempt < 200; attempt++) await f.page.waitForTimeout(50)
    assert(held, "the expanded mission's coordinator read starts")
    const fold = hide !== "none"
    if (hide === "fold") {
      await chevron.click()
      assert.equal(await chevron.getAttribute("aria-expanded"), "false")
    }
    if (hide === "create") {
      await missionGeneralAction(f.page, "Create mission").click()
      await f.page.locator("form.mission-editor").waitFor()
    }
    const before = f.coordinatorReads.length
    await held.fulfill({ json: { data: [] } })
    const children = () => f.coordinatorReads.slice(before).filter(url => url.includes("parentID=ses_long"))
    for (let attempt = 0; !fold && !children().length && attempt < 100; attempt++) await f.page.waitForTimeout(50)
    if (fold) await f.page.waitForTimeout(1_000)
    assert.equal(children().length > 0, !fold, fold ? `a hidden mission reads nothing further: ${children().join(", ")}` : "an expanded mission lists its coordinator's children")
    if (hide === "create") {
      // Back from the form, the preview is still expanded and reads again.
      await f.page.locator("form.mission-editor").getByRole("button", { name: "Cancel", exact: true }).click()
      await f.page.locator(".mission-row-children .mission-tree-node").first().waitFor()
      assert.equal(await chevron.getAttribute("aria-expanded"), "true")
    }
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

/** Whether a user sees the focused control once layout settles (a scroller switch lands a
 * frame after a resize): the point at its centre reaches it. */
const focusVisible = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))).then(() => {
  const focused = document.activeElement as HTMLElement, box = focused.getBoundingClientRect()
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
  return { label: `${focused.tagName} "${focused.getAttribute("aria-label") ?? focused.textContent?.trim().slice(0, 40)}" (centre hits ${hit?.tagName ?? "nothing"})`,
    visible: Boolean(hit && focused.contains(hit)) }
}))
const openCreation = async (page: Page) => {
  await missionGeneralAction(page, "Create mission").click()
  await page.locator("form.mission-editor").getByLabel("What should the mission do?", { exact: true }).fill("Survey the panel geometry")
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('form.mission-editor button[type="submit"]')?.disabled)
  await page.getByLabel("Coordinator · Agent", { exact: true }).waitFor()
}

test("keyboard focus in the creation form is never under its footer, with the brief name prompt open, tall or short", async () => {
  for (const viewport of [{ width: 1000, height: 600 }, { width: 260, height: 300 }]) {
    const f = await open({ viewport })
    try {
      await openCreation(f.page)
      const form = f.page.locator("form.mission-editor")
      await form.getByRole("button", { name: "Save configuration", exact: true }).click()
      await form.getByRole("textbox", { name: "Configuration name", exact: true }).waitFor()
      await form.getByRole("textbox", { name: "Notes", exact: true }).focus()
      assert.equal(await form.getByRole("textbox", { name: "Notes", exact: true }).evaluate(element => element === document.activeElement), true, "Notes owns focus")
      // Every control from Notes to Create, the brief prompt's included, is seen when Tab reaches it.
      for (let step = 0; step < 20; step++) {
        const focus = await focusVisible(f.page)
        assert.equal(focus.visible, true, `${focus.label} is visible when focused at ${viewport.width}×${viewport.height}`)
        if (await form.locator('button[type="submit"]').evaluate(element => element === document.activeElement)) break
        await f.page.keyboard.press("Tab")
      }
      assert.equal(await form.locator('button[type="submit"]').evaluate(element => element === document.activeElement), true, "Tab reached Create")
      // One scroller: the form body in a tall panel, the whole panel in a short one.
      const tall = viewport.height === 600
      assert.equal(await scrolls(f.page, "form.mission-editor > .window-body"), tall, `the form body scrolls only in a tall panel (${viewport.height}px)`)
      assert.equal(await scrolls(f.page, ".mission-control"), !tall, `the panel scrolls only in a short one (${viewport.height}px)`)
      assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  }
})

test("a very short panel scrolls the whole compact creation form and every control stays reachable", async () => {
  const f = await open({ viewport: { width: 220, height: 120 } })
  try {
    await openCreation(f.page)
    const form = f.page.locator("form.mission-editor")
    for (const control of [form.getByRole("textbox", { name: "Notes", exact: true }), form.getByRole("button", { name: "Save configuration", exact: true }),
      form.getByRole("button", { name: "Cancel", exact: true }), form.locator('button[type="submit"]')]) {
      // A trial click scrolls the control into view and checks that the pointer reaches it.
      await control.click({ trial: true })
    }
    assert.equal(await scrolls(f.page, "form.mission-editor > .window-body"), false, "the body never scrolls inside the scrolling panel")
    assert.equal(await scrolls(f.page, ".mission-control"), true)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

const focusLayouts = [
  { name: "tall", viewport: { width: 1000, height: 600 }, panel: false },
  { name: "short", viewport: { width: 260, height: 300 }, panel: true },
  { name: "tiny", viewport: { width: 220, height: 120 }, panel: true },
  { name: "tall RTL/zoom", viewport: { width: 1000, height: 600 }, panel: false, rtlZoom: true },
  { name: "short RTL/zoom", viewport: { width: 260, height: 300 }, panel: true, rtlZoom: true },
]

async function assertFocusVisible(page: Page, label: string) {
  const focus = await focusVisible(page)
  if (!focus.visible) {
    const diagnostics = await page.evaluate(() => {
      const describe = (element: Element | null) => {
        if (!element) return null
        const style = getComputedStyle(element)
        return { tag: element.tagName, class: element.className, id: element.id, connected: element.isConnected,
          rect: element.getBoundingClientRect().toJSON(), scrollTop: element.scrollTop, scrollLeft: element.scrollLeft,
          scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, clientWidth: element.clientWidth,
          overflowX: style.overflowX, overflowY: style.overflowY, direction: style.direction, zoom: style.zoom }
      }
      const focused = document.activeElement!, rect = focused.getBoundingClientRect(), ancestors = []
      for (let node: Element | null = focused; node; node = node.parentElement) ancestors.push(describe(node))
      return { focused: describe(focused), ancestors, viewport: { width: innerWidth, height: innerHeight },
        documentFocused: document.hasFocus(), visibility: document.visibilityState,
        mode: document.querySelector("form.mission-editor")?.getAttribute("data-scroller"),
        owners: [".mission-control", ".mission-tree", ".mission-flow", "#tab-body", "[role=tabpanel]", "form.mission-editor > .window-body"].map(selector => ({ selector, ...describe(document.querySelector(selector)) })),
        hits: document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2).map(describe) }
    })
    const directory = process.env.CODENOMAD_FOCUS_DIAGNOSTICS || join(tmpdir(), "opencode", "c4-mission-focus-fix", "host-diagnostics")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${process.pid}-${label.replace(/[^a-z0-9]+/gi, "-")}.private.json`), JSON.stringify(diagnostics, null, 2))
  }
  assert.equal(focus.visible, true, `${focus.label} is visible in ${label}`)
}

for (const layout of focusLayouts) for (const releaseAt of ["Notes", "Scheduling"] as const) {
  test(`a held depth HTTP reply preserves creation focus: ${layout.name}, released at ${releaseAt}`, async () => {
    const f = await open({ viewport: layout.viewport }, true)
    try {
      if (layout.rtlZoom) await f.page.evaluate(() => {
        document.documentElement.dir = "rtl"
        // Zoom the consumer inside its fixed host, not the fixture's explicit 100vw/100vh shell.
        const panel = document.querySelector<HTMLElement>(".mission-control")!
        panel.style.zoom = "1.25"; panel.style.height = "80%"
      })
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/subagent-depth"))
      await openCreation(f.page)
      await requested
      const form = f.page.locator("form.mission-editor"), notes = form.getByRole("textbox", { name: "Notes", exact: true })
      const scheduling = form.getByRole("checkbox", { name: "Start on creation", exact: true })
      await form.getByRole("button", { name: "Save configuration", exact: true }).click()
      await form.getByRole("textbox", { name: "Configuration name", exact: true }).waitFor()
      await notes.focus()
      assert.equal(await notes.evaluate(element => element === document.activeElement), true, "Notes owns focus before the reply")
      if (releaseAt === "Scheduling") await f.page.keyboard.press("Tab")
      const target = releaseAt === "Notes" ? notes : scheduling
      assert.equal(await target.evaluate(element => element === document.activeElement), true, `${releaseAt} owns focus at release`)
      const before = await focusVisible(f.page)
      assert.equal(before.visible, true, `${before.label} is visible before the reply`)
      await f.releaseDepth()
      // Observe publication without locator actions that could repair scrolling or focus.
      await f.page.waitForFunction(() => Boolean(document.querySelector(".mission-depth [role='alert']")))
      assert.equal(await target.evaluate(element => element === document.activeElement), true, "the reply preserves the exact focus target")
      const after = await focusVisible(f.page)
      assert.equal(after.visible, true, `${after.label} remains visible after the reply`)
      if (releaseAt === "Notes") {
        await f.page.keyboard.press("Tab")
        assert.equal(await scheduling.evaluate(element => element === document.activeElement), true, "the temporal control reaches Scheduling after the same reply")
        const control = await focusVisible(f.page)
        assert.equal(control.visible, true, `${control.label} is visible in the temporal control`)
      }
      assert.equal(await scrolls(f.page, "form.mission-editor > .window-body"), !layout.panel)
      assert.equal(await scrolls(f.page, ".mission-control"), layout.panel)
      assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  })
}

test("task-tree keyboard focus stays reachable in the single panel scroller, tiny and RTL/zoom layouts", async () => {
  const f = await open()
  try {
    const detail = await selectMission(f.page, "Long migration")
    const target = detail.locator('.mission-tree-node[data-task-key="t20"] .mission-tree-task')
    await target.focus()
    for (const layout of focusLayouts) {
      await f.page.setViewportSize(layout.viewport)
      await f.page.evaluate(rtlZoom => {
        document.documentElement.dir = rtlZoom ? "rtl" : "ltr"
        const panel = document.querySelector<HTMLElement>(".mission-control")!
        panel.style.zoom = rtlZoom ? "1.25" : "1"; panel.style.height = rtlZoom ? "80%" : "100%"
      }, Boolean(layout.rtlZoom))
      assert.equal(await target.evaluate(element => element === document.activeElement), true, `the same task retains focus in ${layout.name}`)
      await assertFocusVisible(f.page, `task-tree ${layout.name}`)
      assert.equal(await scrolls(f.page, ".mission-tree .mission-flow"), false, `no task scroller in ${layout.name}`)
      assert.equal(await scrolls(f.page, ".mission-control"), true, `panel scroller in ${layout.name}`)
      assert.equal(await scrolls(f.page, "#tab-body"), false, `no host scroller in ${layout.name}`)
    }
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("the gear opens Settings on the Missions section; the panel has no inline preferences", async () => {
  const f = await open()
  try {
    assert.equal(await f.page.locator(".mission-control .mission-preferences").count(), 0)
    await missionGeneralAction(f.page, "Preferences").click()
    await f.page.waitForFunction(() => (window as any).missionHost.settings().open)
    assert.deepEqual(await f.page.evaluate(() => (window as any).missionHost.settings()), { open: true, section: "missions" })
    await f.page.locator("#settings-missions .mission-preferences").waitFor()
    assert.equal(await f.page.locator(".mission-control .mission-preferences").count(), 0, "preferences render in Settings, not the panel")
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
