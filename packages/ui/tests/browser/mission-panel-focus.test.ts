import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page, type Route } from "playwright"
import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { missionGeneralAction, missionPickerField, selectMission } from "./mission-actions"
import { panelMissions } from "./mission-content-fixture"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "mission-panel-focus", routes: [{ path: "/focus", html: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-panel-focus.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

function mission(grown = false): MissionMap {
  const tasks: MissionTask[] = Array.from({ length: 30 }, (_, index) => ({ id: `task-${index}`, key: `t${index}`, title: `Migration step ${index + 1}`,
    brief: "Inspect the migration", role: "worker", status: "dispatching", blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1,
    ...(grown && index < 20 ? { actorSessionId: "ses_worker", admissionId: `admission-${index}` } : {}) }))
  return { version: 1, id: "focus", projectID: "project", projectCanonical: "/fixture", objective: "Focus migration", template: "custom",
    coordinatorSessionId: "ses_focus", status: "active", runState: "running", actors: [
      { sessionId: "ses_focus", kind: "coordinator", managed: true, title: "Coordinator", roles: ["coordinator"], location: { directory: "fixture" }, joinedAt: 1 },
      { sessionId: "ses_worker", kind: "specialist", managed: true, title: "Worker", roles: ["worker"], location: { directory: "fixture" }, joinedAt: 1 }],
    frontier: [], claims: [], revision: grown ? 4 : 3, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false, tasks, reports: [] }
}

async function open(consumer: "creation" | "tree", viewport = { width: 1000, height: 600 }, holdDepth = false) {
  const context = await browser.newContext({ locale: "en-US", viewport }), page = await context.newPage(), errors: string[] = []
  page.setDefaultTimeout(15_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript("globalThis.__name ??= target => target")
  let grown = false, depthRoute: Route | undefined
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (holdDepth && path.endsWith("/subagent-depth")) { depthRoute = route; return }
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions([mission(grown)]), generatedAt: 1, discardedEvents: 0,
      activity: { generatedAt: 1, missions: [{ missionId: "focus", actors: [{ sessionId: "ses_worker", state: "idle-without-report" }] }] } } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] } })
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url, { timeout: 60_000 })
    await missionPickerField(page).waitFor()
    if (consumer === "tree") await selectMission(page, "Focus migration")
    else {
      await missionGeneralAction(page, "Create mission").click()
      await page.locator("form.mission-editor").getByLabel("What should the mission do?", { exact: true }).fill("Inspect focus ownership")
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('form.mission-editor button[type="submit"]')?.disabled)
      const requested = holdDepth ? page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/subagent-depth")) : undefined
      await page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }).click()
      if (requested) await requested
      else await page.waitForFunction(() => Boolean(document.querySelector(".mission-depth [role=alert]")))
    }
    return { page, context, errors, grow: async () => { grown = true; await page.evaluate(() => (window as any).missionHost.refresh()) },
      releaseDepth: async () => { assert(depthRoute); await depthRoute.fulfill({ json: {} }); depthRoute = undefined }, close: () => context.close() }
  } catch (error) { await context.close(); throw error }
}

const region = (consumer: string) => consumer === "tree" ? ".mission-tree" : "form.mission-editor > .window-body"
const target = (page: Page, consumer: string) => page.locator(consumer === "tree" ? '.mission-tree-node[data-task-key="t20"] .mission-tree-task' : ".mission-scheduling > summary")
const frames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
const visible = (page: Page) => page.evaluate(() => {
  const focused = document.activeElement!, box = focused.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
  return Boolean(hit && focused.contains(hit))
})

// Observe real native calls; every wrapper forwards to the browser unchanged.
async function audit(page: Page) {
  await page.evaluate(() => {
    const state = (window as any).focusAudit = { writes: [] as unknown[], scheduled: [] as number[], ran: [] as number[], cancelled: [] as number[] }
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!
    Object.defineProperty(Element.prototype, "scrollTop", { ...descriptor, set(value) { state.writes.push({ element: this, value }); descriptor.set!.call(this, value) } })
    for (const method of ["scrollIntoView", "scrollTo", "scrollBy"] as const) {
      const original = Element.prototype[method]
      ;(Element.prototype as any)[method] = function (...args: unknown[]) { state.writes.push({ element: this, method }); return (original as Function).apply(this, args) }
    }
    const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window), owned = new Set<number>()
    window.requestAnimationFrame = callback => {
      if (!new Error().stack?.includes("/mission-panel-scroll.ts")) return request(callback)
      const id = request(time => { owned.delete(id); state.ran.push(time); callback(time) })
      owned.add(id); state.scheduled.push(id); return id
    }
    window.cancelAnimationFrame = id => { if (owned.delete(id)) state.cancelled.push(id); cancel(id) }
  })
}

for (const consumer of ["creation", "tree"] as const) {
  test(`${consumer}: visible, external, hidden, inactive, disconnected and unfocused views never scroll`, async () => {
    for (const condition of ["visible", "outside", "host", "hidden", "opacity", "inert", "aria-hidden", "inactive", "disconnected", "window-unfocused"]) {
      const f = await open(consumer)
      let other: Page | undefined
      try {
        const focus = condition === "visible" ? f.page.locator(consumer === "tree" ? ".mission-tree-task" : "form.mission-editor textarea").first() : target(f.page, consumer)
        await focus.focus(); await frames(f.page)
        if (condition === "outside") await f.page.locator("#outside").focus()
        if (condition === "host") await f.page.locator(".mission-control").evaluate(panel => { (panel as HTMLElement).tabIndex = -1; (panel as HTMLElement).focus() })
        if (condition === "window-unfocused") {
          // Playwright enables Chromium focus emulation on every page. Restore native focus first.
          const cdp = await f.context.newCDPSession(f.page)
          await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false })
          other = await f.context.newPage(); await other.bringToFront()
          assert.equal(await f.page.evaluate(() => document.hasFocus()), false, "the native document is genuinely unfocused")
        }
        await audit(f.page)
        await f.page.evaluate(({ condition, selector }) => {
          const panel = document.querySelector<HTMLElement>(".mission-control")!, node = document.querySelector<HTMLElement>(selector)!
          if (condition === "hidden") panel.style.visibility = "hidden"
          if (condition === "opacity") panel.style.opacity = "0"
          if (condition === "inert") panel.inert = true
          if (condition === "aria-hidden") panel.setAttribute("aria-hidden", "true")
          if (condition === "inactive") (window as any).missionHost.activate(false)
          if (condition === "disconnected") node.remove()
          // Real consumer observation, while its active focus/lifetime guards decide ownership.
          node.append(document.createElement("span"))
        }, { condition, selector: region(consumer) })
        if (condition !== "visible") await f.page.setViewportSize({ width: 1000, height: 420 })
        await frames(other ?? f.page)
        assert.equal(await f.page.evaluate(() => (window as any).focusAudit.writes.length), 0, `${condition} view leaves every scroll owner alone`)
        assert.deepEqual(f.errors, [])
      } finally { await other?.close(); await f.close() }
    }
  })

  test(`${consumer}: queued callbacks retire with their view and mutation bursts coalesce`, async () => {
    const f = await open(consumer)
    try {
      await target(f.page, consumer).focus(); await frames(f.page); await audit(f.page)
      await f.page.evaluate(async selector => {
        const node = document.querySelector(selector)!
        for (let index = 0; index < 24; index++) node.append(document.createElement("span"))
        await Promise.resolve()
        const state = (window as any).focusAudit
        state.queuedBeforeDispose = state.scheduled.length
        ;(window as any).missionHost.mount(false)
      }, region(consumer))
      await frames(f.page)
      const disposed = await f.page.evaluate(() => {
        const state = (window as any).focusAudit
        return { queued: state.queuedBeforeDispose, cancelled: state.cancelled.length, ran: state.ran.length, writes: state.writes.length }
      })
      assert.equal(disposed.queued, 1, "one callback owns the entire mutation burst")
      assert.equal(disposed.cancelled, 1, "disposing the old view cancels its queued callback")
      assert.equal(disposed.ran, 0); assert.equal(disposed.writes, 0)
      await f.page.evaluate(() => (window as any).missionHost.mount(true))
      await frames(f.page)
      assert.equal(await f.page.evaluate(() => (window as any).focusAudit.writes.length), 0, "the replacement view never revives the old focus target")
      await target(f.page, consumer).focus(); await frames(f.page)
      await f.page.evaluate(selector => {
        const state = (window as any).focusAudit
        state.scheduled.length = 0; state.ran.length = 0; state.writes.length = 0
        const node = document.querySelector(selector)!
        for (let index = 0; index < 24; index++) node.append(document.createElement("span"))
      }, region(consumer))
      await frames(f.page)
      const burst = await f.page.evaluate(() => ({ scheduled: (window as any).focusAudit.scheduled.length, ran: (window as any).focusAudit.ran as number[] }))
      assert(burst.scheduled > 0 && burst.scheduled <= burst.ran.length + 1, "a live mutation burst keeps at most one pending callback")
      assert.equal(new Set(burst.ran).size, burst.ran.length, "at most one consumer callback runs in each animation frame")
      assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  })
}

for (const viewport of [{ width: 1000, height: 600 }, { width: 260, height: 300 }]) {
  test(`task HTTP refresh grows nested recovery rows without changing its scroll policy at ${viewport.width}×${viewport.height}`, async () => {
    const f = await open("tree", viewport)
    try {
      const task = target(f.page, "tree"), identity = await task.elementHandle()
      await task.focus(); await frames(f.page)
      assert.equal(await visible(f.page), true)
      const before = await f.page.locator(".mission-tree").getAttribute("data-scroller")
      const size = await f.page.locator(".mission-tree-list").evaluate(element => element.getBoundingClientRect().height)
      await audit(f.page)
      await f.grow()
      await f.page.waitForFunction(() => document.querySelectorAll(".mission-tree-recovery").length === 20)
      await frames(f.page)
      assert.equal(await identity!.evaluate(element => element === document.activeElement), true, "HTTP publication retains the exact DOM focus target")
      assert.equal(await f.page.locator(".mission-tree").getAttribute("data-scroller"), before, "the existing vertical owner is unchanged")
      assert(await f.page.locator(".mission-tree-list").evaluate(element => element.getBoundingClientRect().height) > size, "real recovery controls grew the nested list")
      assert.equal(await visible(f.page), true, "the same task stays hit-testable after nested HTTP growth")
      assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  })
}

test("an oversized focused creation textarea moves only the nearer vertical edge and preserves horizontal position", async () => {
  const f = await open("creation")
  try {
    const notes = f.page.locator("form.mission-editor").getByRole("textbox", { name: "Notes", exact: true })
    await notes.focus(); await frames(f.page)
    for (const direction of ["below", "above", "spanning"] as const) {
      const expected = await notes.evaluate((field, direction) => {
        const owner = field.closest(".window-body")!, height = owner.clientHeight
        ;(field as HTMLElement).style.height = `${height * 2}px`
        // Establish each oversized starting geometry; no repair gesture follows.
        const box = field.getBoundingClientRect(), port = owner.getBoundingClientRect()
        owner.scrollTop += box.top - port.top - (direction === "below" ? height / 2 : direction === "above" ? -height * 1.5 : -height / 2)
        const start = field.getBoundingClientRect(), edge = owner.getBoundingClientRect(), above = start.top - edge.top, below = start.bottom - edge.bottom
        const result = { top: owner.scrollTop, left: owner.scrollLeft, delta: above < 0 && below > 0 ? 0 : above < 0 ? Math.max(above, below) : Math.min(above, below) }
        field.parentElement!.append(document.createElement("span"))
        return result
      }, direction)
      assert(direction === "spanning" ? expected.delta === 0 : direction === "below" ? expected.delta > 0 : expected.delta < 0, "the starting geometry exercises the named edge")
      await frames(f.page)
      const actual = await notes.evaluate(field => ({ top: field.closest(".window-body")!.scrollTop, left: field.closest(".window-body")!.scrollLeft, focused: field === document.activeElement }))
      assert.equal(actual.focused, true)
      assert(Math.abs(actual.top - expected.top - expected.delta) <= 1, `${direction}: the nearer edge determines the minimal scroll`)
      assert.equal(actual.left, expected.left)
    }
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("a depth reply preserves horizontal owners and the original native Create pointer target", async () => {
  const f = await open("creation", { width: 1000, height: 600 }, true)
  try {
    await f.page.evaluate(() => {
      document.querySelector<HTMLElement>("#root > div")!.style.width = "calc(100vw + 200px)"
      window.scrollTo(200, 0) // Initial non-zero horizontal owner, before the focus/HTTP transition.
    })
    const form = f.page.locator("form.mission-editor")
    await form.getByRole("button", { name: "Save as brief", exact: true }).click()
    await form.getByRole("textbox", { name: "Brief name", exact: true }).waitFor()
    await target(f.page, "creation").focus(); await frames(f.page)
    const position = await f.page.evaluate(() => ({ x: scrollX, owners: Array.from(document.querySelectorAll(".mission-control, #tab-body, form.mission-editor > .window-body"), element => element.scrollLeft) }))
    assert(position.x > 0, "the outer horizontal owner starts away from its origin")
    const create = form.locator('button[type="submit"]'), box = await create.boundingBox()
    assert(box)
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await create.evaluate(button => button.addEventListener("click", event => {
      event.preventDefault()
      ;(window as any).nativeCreateClick = event.isTrusted && event.currentTarget === button
    }, { once: true }))
    await f.page.mouse.move(point.x, point.y)
    await f.releaseDepth()
    await f.page.waitForFunction(() => Boolean(document.querySelector(".mission-depth [role=alert]")))
    await frames(f.page)
    assert.deepEqual(await f.page.evaluate(() => ({ x: scrollX, owners: Array.from(document.querySelectorAll(".mission-control, #tab-body, form.mission-editor > .window-body"), element => element.scrollLeft) })), position)
    assert.equal(await create.evaluate((button, point) => button.contains(document.elementFromPoint(point.x, point.y)), point), true, "Create remains at the exact pre-reply pointer coordinates")
    await f.page.mouse.click(point.x, point.y)
    assert.equal(await f.page.evaluate(() => (window as any).nativeCreateClick), true, "a trusted native click reaches the original Create target")
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
