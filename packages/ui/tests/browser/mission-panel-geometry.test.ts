import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright"
import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { compactMissionMap } from "../../../server/src/missions/mission-compact-map"
import { missionTaskOrder } from "../../../server/src/missions/mission-task-order"
import { panelMissions, routeMissionTasks } from "./mission-content-fixture"

// Real MissionControl with the full stylesheet: single-scroller policy on short
// layouts, measured dependency rail endpoints and native picker key semantics.
let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-panel-geometry",
      routes: [
        { path: "/mission-geometry", html: "<html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-control.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url; events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

const task = (key: string, blockedBy: string[] = [], status: MissionTask["status"] = "queued"): MissionTask => ({ id: `task-${key}`, key, title: `Task ${key}`,
  brief: `Brief ${key}`, role: "worker", status, blockedBy, outstandingExecution: false, createdAt: 1, updatedAt: 1 })
const mission = (id: string, tasks: MissionTask[] = []): MissionMap => ({ version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`,
  template: "custom", coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [], frontier: [], claims: [], revision: 3, createdAt: 1,
  updatedAt: 1, history: [], historyTruncated: false, tasks, reports: [] } as MissionMap)
const chain = Array.from({ length: 40 }, (_, index) => task(`c${index}`, index ? [`c${index - 1}`] : [], index < 3 ? "completed" : "queued"))
const long = [mission("long", chain), ...Array.from({ length: 11 }, (_, index) => mission(`other${index}`))]
// Fan-out/fan-in with an unrelated task: only declared edges are drawn.
const fan = [mission("fan", [task("read", [], "completed"), task("bench", ["read"]), task("schema", ["read"]), task("lone"), task("cleanup", ["bench", "schema"])]),
  ...Array.from({ length: 11 }, (_, index) => mission(`other${index}`))]

async function open(context: BrowserContextOptions, missions: MissionMap[], selected: string, view: { listExpanded?: boolean; rtl?: boolean; frame?: string } = {}) {
  const page = await (await browser.newContext({ locale: "en-US", ...context })).newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  // tsx keeps function names with a helper that page.evaluate callbacks cannot see.
  await page.addInitScript(`Object.assign(window,{__name:f=>f,__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/missions/scheduled")) return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(missions), generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: "project",
      projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] }) })
    return route.fulfill({ json: {} })
  })
  await events.route(page)
  await page.goto(url)
  await page.evaluate(async ({ selected, view }) => {
    if (view.rtl) document.documentElement.dir = "rtl"
    if (view.frame) document.querySelector<HTMLElement>("aside")!.style.cssText += view.frame
    ;(window as any).missionFixture.connectCatalog()
    const instances = "/src/stores/instances.ts", state = "/src/stores/mission-view-state.ts"
    ;(await import(instances)).updateInstance("fixture", { metadata: { project: { id: "project" } } })
    ;(await import(state)).updateMissionProjectView("fixture", { selected, listExpanded: view.listExpanded || undefined })
  }, { selected, view })
  await page.locator(".mission-tree-node").first().waitFor()
  await settle(page)
  return { page, errors }
}
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

/** Every vertical scroll container in the panel (the aside host included). */
const scrollers = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("aside, aside *")].filter(element => {
  const overflow = getComputedStyle(element).overflowY
  return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight + 1
}).map(element => element.className || element.tagName))

/** Both ends of the panel stay reachable through its single scroller. */
async function reachable(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".mission-control")!, box = () => panel.getBoundingClientRect()
    const inside = (element: Element) => { const rect = element.getBoundingClientRect(), bounds = box(); return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 }
    panel.scrollTop = 0
    const top = inside(document.querySelector(".mission-picker-field")!) && inside(document.querySelector('.mission-picker-actions button')!)
    panel.scrollTop = panel.scrollHeight
    const bottom = inside([...document.querySelectorAll(".mission-tree-node")].at(-1)!)
    panel.scrollTop = 0
    return { top, bottom }
  })
}

for (const variant of [{ name: "desktop LTR", context: {} }, { name: "touch RTL", context: { hasTouch: true, isMobile: true }, rtl: true }]) {
  test(`${variant.name}: 300px with the expanded picker scrolls the whole panel once; nothing is clipped`, async () => {
    const { page, errors } = await open({ ...variant.context, viewport: { width: 900, height: 300 } }, long, "long", { listExpanded: true, rtl: variant.rtl })
    try {
      assert.equal(await page.locator(".mission-picker-inline .mission-picker-options > li").count(), 12)
      assert.equal(await page.locator(".mission-tree-node").count(), 40)
      assert.equal(await page.locator(".mission-tree").getAttribute("data-scroller"), "panel")
      const found = await scrollers(page)
      // The picker's own bounded list is a separate compact list by design.
      assert.deepEqual(found.filter(name => !String(name).includes("mission-picker-options")), ["mission-control"], `single task scroller, found ${found}`)
      assert.equal(await page.locator(".mission-flow").evaluate(element => getComputedStyle(element).overflowY), "visible")
      assert.deepEqual(await reachable(page), { top: true, bottom: true })
      assert.deepEqual(errors, [])
    } finally { await page.context().close() }
  })

  test(`${variant.name}: 600px keeps the header fixed and the task flow as sole scroller, filling to the bottom; collapse adds no chrome`, async () => {
    const { page, errors } = await open({ ...variant.context, viewport: { width: 900, height: 600 } }, long, "long", { rtl: variant.rtl })
    try {
      assert.equal(await page.locator(".mission-tree").getAttribute("data-scroller"), null)
      assert.deepEqual(await scrollers(page), ["mission-flow mission-flow-linked"])
      // Down to the window bottom, inside the existing panel/detail/group paddings.
      const gaps = await page.evaluate(() => {
        const contentBottom = (selector: string) => { const element = document.querySelector(selector)!
          return element.getBoundingClientRect().bottom - parseFloat(getComputedStyle(element).paddingBottom) }
        return [contentBottom(".mission-control") - document.querySelector(".mission-detail")!.getBoundingClientRect().bottom,
          contentBottom(".mission-detail") - document.querySelector(".mission-tree")!.getBoundingClientRect().bottom,
          contentBottom(".mission-tree") - document.querySelector(".mission-flow")!.getBoundingClientRect().bottom]
      })
      assert.ok(gaps.every(gap => Math.abs(gap) <= 1), `tasks fill to the bottom: ${gaps}`)

      // At 600px the expanded picker still leaves the minimum task room; at 520px it does not:
      // the panel takes over, and collapsing restores the inner flow.
      await page.locator(".mission-picker-expander").click()
      await settle(page)
      assert.equal(await page.locator(".mission-tree").getAttribute("data-scroller"), null)
      assert.deepEqual((await scrollers(page)).filter(name => !String(name).includes("mission-picker-options")), ["mission-flow mission-flow-linked"])
      await page.locator(".mission-picker-expander").click()
      await page.setViewportSize({ width: 900, height: 520 })
      await page.locator(".mission-picker-expander").click()
      await page.waitForFunction(() => document.querySelector(".mission-tree")?.getAttribute("data-scroller") === "panel")
      await settle(page)
      assert.deepEqual((await scrollers(page)).filter(name => !String(name).includes("mission-picker-options")), ["mission-control"])
      assert.deepEqual(await reachable(page), { top: true, bottom: true })
      await page.locator(".mission-picker-expander").click()
      await page.waitForFunction(() => !document.querySelector(".mission-tree")?.hasAttribute("data-scroller"))
      await settle(page)
      assert.deepEqual(await scrollers(page), ["mission-flow mission-flow-linked"])

      await page.locator(".mission-tree h3 button").click()
      await settle(page)
      assert.deepEqual(await scrollers(page), [], "collapsed tasks need no scroller")
      assert.equal(await page.locator(".mission-tree").getAttribute("data-scroller"), null)
      assert.deepEqual(errors, [])
    } finally { await page.context().close() }
  })
}

/** Each declared edge starts and ends on its tasks' status icons (inline-start
 * side, vertical center), checked in client space through the SVG's own CTM. */
async function railEnds(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>(".mission-graph")!, matrix = svg.getScreenCTM()!
    const rtl = getComputedStyle(svg).direction === "rtl"
    const anchor = (key: string) => document.querySelector(`.mission-tree-node[data-task-key="${key}"] [data-graph-anchor]`)!.getBoundingClientRect()
    const client = (x: number, y: number) => { const point = svg.createSVGPoint(); point.x = x; point.y = y; return point.matrixTransform(matrix) }
    return [...svg.querySelectorAll<SVGPathElement>("path[data-from]")].map(path => {
      const [, x1, y1, , y2, x2] = path.getAttribute("d")!.match(/^M ([\d.]+) ([\d.]+) H ([\d.]+) V ([\d.]+) H ([\d.]+)$/)!.map(Number)
      const ends = [[path.dataset.from!, client(x1, y1)], [path.dataset.to!, client(x2, y2)]] as const
      return { edge: `${path.dataset.from}>${path.dataset.to}`, gaps: ends.map(([key, point]) => {
        const box = anchor(key)
        return [Math.abs(point.x - (rtl ? box.right : box.left)), Math.abs(point.y - (box.top + box.height / 2))]
      }).flat() }
    })
  })
}

for (const variant of [
  { name: "LTR", context: {} },
  { name: "RTL", context: {}, rtl: true },
  { name: "RTL at fractional device and CSS scale", context: { deviceScaleFactor: 1.25 }, rtl: true, frame: "transform: scale(0.85); transform-origin: 100% 0;" },
  { name: "LTR under CSS zoom", context: { deviceScaleFactor: 1.5 }, frame: "zoom: 1.25;" },
]) {
  test(`${variant.name}: dependency rails meet the measured status icons, declared edges only, also after scrolling`, async () => {
    const { page, errors } = await open({ ...variant.context, viewport: { width: 900, height: 220 } }, fan, "fan", { rtl: variant.rtl, frame: variant.frame })
    try {
      const edges = await railEnds(page)
      assert.deepEqual(edges.map(edge => edge.edge).sort(), ["bench>cleanup", "read>bench", "read>schema", "schema>cleanup"])
      for (const edge of edges) assert.ok(edge.gaps.every(gap => gap <= 0.75), `${edge.edge} meets its icons: ${edge.gaps}`)
      // Scrolling whichever container owns the tasks keeps the overlay on the rows.
      await page.evaluate(() => {
        const flow = document.querySelector<HTMLElement>(".mission-flow")!, panel = document.querySelector<HTMLElement>(".mission-control")!
        ;(flow.scrollHeight > flow.clientHeight + 1 ? flow : panel).scrollTop = 60
      })
      await settle(page)
      for (const edge of await railEnds(page)) assert.ok(edge.gaps.every(gap => gap <= 0.75), `after scroll ${edge.edge}: ${edge.gaps}`)
      // Full-width rollover and the row button stay interactive beneath the rail.
      const row = page.locator('.mission-tree-node[data-task-key="cleanup"]')
      await row.scrollIntoViewIfNeeded()
      const box = (await row.boundingBox())!
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".mission-tree-node")?.getAttribute("data-task-key"), { x: box.x + box.width / 2, y: box.y + box.height / 2 })
      assert.equal(hit, "cleanup")
      assert.equal(await page.locator(".mission-graph path").first().evaluate(path => getComputedStyle(path).strokeWidth), "1px")
      assert.deepEqual(errors, [])
    } finally { await page.context().close() }
  })
}

test("a map of 500 tasks and 40 actors shows a page of rows, reads further on request to every row and declared rail, and stays responsive", async () => {
  // Groups of ten chained tasks: 450 declared edges.
  const tasks = Array.from({ length: 500 }, (_, index) => ({ ...task(`t${index}`, index % 10 ? [`t${index - 1}`] : [], index % 7 ? "queued" : "completed"),
    actorSessionId: `ses_actor_${index % 40}` }))
  const actors = Array.from({ length: 40 }, (_, index) => ({ sessionId: `ses_actor_${index}`, kind: index ? "specialist" : "coordinator", managed: index > 0,
    title: `Actor ${index}`, roles: ["worker"], location: { directory: "/fixture" }, joinedAt: 1 }))
  const large = [{ ...mission("large", tasks), actors } as MissionMap]
  const { page, errors } = await open({ viewport: { width: 900, height: 700 } }, large, "large")
  try {
    const requests: string[] = []
    await routeMissionTasks(page, () => large, requests)
    const rows = () => page.locator(".mission-tree-node").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.taskKey))
    // The map's page: its window of the display order and its pinned rows, the rest gaps.
    assert.deepEqual(await rows(), compactMissionMap(large[0]).tasks.map(task => task.key))
    assert.equal(await page.locator(".mission-tree > h3 .mission-disclosure-trigger small").innerText(), "500")
    // Each deliberate read takes the first gap's page, in the order the map named.
    for (let read = 0; await page.locator(".mission-tree-gap").count(); read++) {
      assert.ok(read < 10, "at most one read a page")
      const before = (await rows()).length
      await page.locator(".mission-tree-gap button").first().click()
      await page.waitForFunction(count => document.querySelectorAll(".mission-tree-node").length > count, before)
    }
    assert.ok(requests.every(query => query.includes(`order=${compactMissionMap(large[0]).taskPage!.order}`)), requests.join(" "))
    assert.deepEqual(await rows(), missionTaskOrder(tasks).map(task => task.key))
    await page.waitForFunction(() => document.querySelectorAll(".mission-graph path[data-from]").length === 450)
    assert.equal(await page.locator(".mission-graph path.mission-graph-omitted").count(), 0, "every edge's both ends are shown")
    // Toggling one task's reader re-renders the tree in place without rebuilding it.
    const elapsed = await page.evaluate(async () => {
      const row = document.querySelector<HTMLButtonElement>('.mission-tree-node[data-task-key="t499"] .mission-tree-task')!
      const start = performance.now()
      row.click()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return { ms: performance.now() - start, pressed: row.getAttribute("aria-pressed") }
    })
    assert.equal(elapsed.pressed, "true")
    assert.ok(elapsed.ms < 1_000, `one row toggle took ${elapsed.ms} ms`)
    const edge = (await railEnds(page)).find(item => item.edge === "t1>t2")!
    assert.ok(edge.gaps.every(gap => gap <= 0.75), `t1>t2 meets its icons: ${edge.gaps}`)
    assert.deepEqual(errors, [])
  } finally { await page.context().close() }
})

test("picker keys: Space opens once, composing Enter keeps the popup, arrows/Home/End/Enter/Escape and outside dismissal", async () => {
  const { page, errors } = await open({ viewport: { width: 900, height: 600 } }, long, "long")
  try {
    const field = page.locator(".mission-picker-field")
    const expanded = () => field.getAttribute("aria-expanded")
    const selected = () => field.locator("bdi").innerText()
    await field.focus()
    await page.keyboard.press("Space")
    assert.equal(await expanded(), "true", "Space opens the closed combobox")
    await settle(page)
    assert.equal(await expanded(), "true", "the native keyup click does not toggle it closed")

    // The popup list overflows, so typing moves focus into its search.
    await page.keyboard.type("Objective other")
    const search = page.locator(".mission-picker-popup .mission-picker-search")
    assert.equal(await search.evaluate(element => element === document.activeElement), true)
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await search.evaluate((element, init) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })), init)
      await search.evaluate((element, init) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init })), init)
      await search.evaluate((element, init) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true, ...init })), init)
      assert.equal(await expanded(), "true", `composition keys (${JSON.stringify(init)}) stay with the text`)
      assert.equal(await selected(), "Objective long")
    }
    const active = () => page.locator(".mission-picker-popup .mission-picker-option-active bdi").innerText()
    assert.equal(await active(), "Objective other0", "composition arrows did not move the active option")
    await page.keyboard.press("End")
    assert.equal(await active(), "Objective other10")
    await page.keyboard.press("Home")
    await page.keyboard.press("ArrowDown")
    assert.equal(await active(), "Objective other1")
    await page.keyboard.press("Enter")
    assert.equal(await expanded(), "false")
    assert.equal(await selected(), "Objective other1")
    assert.equal(await field.evaluate(element => element === document.activeElement), true, "focus returns to the field")

    // Enter opens through the native button click exactly once; Space selects the active option.
    await page.keyboard.press("Enter")
    assert.equal(await expanded(), "true")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Space")
    assert.equal(await expanded(), "false")
    assert.equal(await selected(), "Objective other0")

    await page.keyboard.press("ArrowDown")
    assert.equal(await expanded(), "true")
    await page.keyboard.press("Escape")
    assert.equal(await expanded(), "false")
    assert.equal(await field.evaluate(element => element === document.activeElement), true)
    await page.keyboard.press("ArrowDown")
    await page.mouse.click(20, 20)
    assert.equal(await expanded(), "false", "outside pointer dismissal")
    assert.equal(await selected(), "Objective other0")
    assert.deepEqual(errors, [])
  } finally { await page.context().close() }
})
