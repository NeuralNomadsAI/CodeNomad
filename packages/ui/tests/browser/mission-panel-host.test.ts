import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright"
import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { missionPickerExpander, missionPickerField, missionPopupOption, missionDetail, missionGeneralAction, inlineMissionEntry, selectMission, selectedMissionTitle } from "./mission-actions"
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

async function open(options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1000, height: 600 }, ...options })
  const page = await context.newPage(), errors: string[] = [], mutations: string[] = []
  page.setDefaultTimeout(15_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`)
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions([LONG, SHORT]), generatedAt: 1, discardedEvents: 0,
      activity: { generatedAt: 1, missions: [{ missionId: "long", actors: [{ sessionId: "ses_worker", state: "running" }] }, { missionId: "short", actors: [] }] } } })
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] } })
    return route.fulfill({ json: {} })
  })
  await page.goto(url, { timeout: 60_000 })
  await missionPickerField(page).waitFor()
  return { page, errors, mutations, close: () => context.close() }
}

const scrolls = (page: Page, selector: string) => page.locator(selector).first().evaluate(element => element.scrollHeight > element.clientHeight + 1)

test("a long mission's task group fills the panel to the window bottom with a single task scroller", async () => {
  for (const viewport of [{ width: 1000, height: 600 }, { width: 1000, height: 420 }]) {
    const f = await open({ viewport })
    try {
      const detail = await selectMission(f.page, "Long migration")
      const flow = detail.locator(".mission-tree .mission-flow")
      await flow.locator(".mission-tree-node").nth(TASKS - 1).waitFor({ state: "attached" })
      assert.equal(await detail.locator(".mission-tree .mission-disclosure-trigger small").innerText(), String(TASKS), "the group shows its task count")
      assert.equal(await scrolls(f.page, ".mission-tree .mission-flow"), true, `the task list scrolls at ${viewport.height}px`)
      assert.equal(await scrolls(f.page, "#tab-body"), false, `no host scrollbar at ${viewport.height}px`)
      assert.equal(await scrolls(f.page, ".mission-control"), false, `no second panel scrollbar at ${viewport.height}px`)
      const [flowBox, detailBox, bodyBox] = await Promise.all([flow.boundingBox(), detail.boundingBox(), f.page.locator("#tab-body").boundingBox()])
      const padding = await f.page.locator(".mission-control").evaluate(element => parseFloat(getComputedStyle(element).paddingBottom))
      assert(flowBox && detailBox && bodyBox, "measured")
      assert(Math.abs(detailBox.y + detailBox.height - (bodyBox.y + bodyBox.height - padding)) <= 2, `the detail reaches the panel bottom at ${viewport.height}px`)
      // Only the detail/tree paddings separate the list from the window bottom.
      const gap = detailBox.y + detailBox.height - (flowBox.y + flowBox.height)
      assert(gap >= 0 && gap <= 16, `the task list fills the remaining height at ${viewport.height}px (gap ${gap})`)
      assert(flowBox.height >= 100, `the task list keeps a usable height at ${viewport.height}px`)
      // The last task is reachable by scrolling the task list only.
      const last = flow.locator(".mission-tree-node").nth(TASKS - 1)
      await last.scrollIntoViewIfNeeded()
      assert.equal(await f.page.locator("#tab-body").evaluate(element => element.scrollTop), 0)
      assert(await flow.evaluate(element => element.scrollTop) > 0)
      // Collapsing keeps the header and count; expanding restores the filled list.
      const trigger = detail.locator(".mission-tree .mission-disclosure-trigger")
      await trigger.click()
      assert.equal(await trigger.getAttribute("aria-expanded"), "false")
      assert.equal(await flow.isVisible(), false)
      assert.equal(await scrolls(f.page, "#tab-body"), false)
      await trigger.click()
      assert.equal(await trigger.getAttribute("aria-expanded"), "true")
      assert.equal(await scrolls(f.page, ".mission-tree .mission-flow"), true)
      assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  }
})

test("the task conversation arrow appears on desktop hover and stays visible on touch", async () => {
  for (const touch of [false, true]) {
    const f = await open(touch ? { hasTouch: true, isMobile: true, viewport: { width: 1000, height: 700 } } : {})
    try {
      const detail = await selectMission(f.page, "Long migration")
      const node = detail.locator('.mission-tree-node[data-task-key="t20"]'), arrow = node.locator(".mission-tree-open")
      await arrow.waitFor({ state: "attached" })
      const opacity = () => arrow.evaluate(element => Number(getComputedStyle(element).opacity))
      if (touch) assert(await opacity() > 0, "touch shows the arrow without hover")
      else {
        await f.page.locator("#chat").hover()
        assert.equal(await opacity(), 0, "desktop hides the arrow until rollover")
        await node.hover()
        await f.page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.mission-tree-node[data-task-key="t20"] .mission-tree-open')!).opacity) > 0)
      }
      assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  }
})

test("the mission name opens a transient popup closed by selection, Escape and outside interaction", async () => {
  const f = await open()
  try {
    const field = missionPickerField(f.page), popup = f.page.locator(".mission-picker-popup")
    assert.equal(await missionDetail(f.page).count(), 0, "nothing is selected by default")
    await field.click()
    assert.equal(await field.getAttribute("aria-expanded"), "true")
    await missionPopupOption(f.page, "Short audit").click()
    await popup.waitFor({ state: "detached" })
    assert.equal(await field.getAttribute("aria-expanded"), "false")
    assert.equal(await selectedMissionTitle(f.page).innerText(), "Short audit")
    assert.equal(await missionDetail(f.page).getAttribute("aria-label"), "Short audit")
    assert.equal(await field.evaluate(element => element === document.activeElement), true, "selection returns focus to the field")
    // Outside pointer interaction dismisses without changing the selection.
    await field.click()
    await popup.waitFor()
    await f.page.locator("#chat").click()
    await popup.waitFor({ state: "detached" })
    assert.equal(await selectedMissionTitle(f.page).innerText(), "Short audit")
    // Keyboard: arrows open, Escape dismisses and keeps focus on the field.
    await field.focus()
    await f.page.keyboard.press("ArrowDown")
    await popup.waitFor()
    await f.page.keyboard.press("Escape")
    await popup.waitFor({ state: "detached" })
    assert.equal(await field.evaluate(element => element === document.activeElement), true)
    assert.equal(await f.page.locator(".mission-picker-inline").count(), 0, "the popup never opens the persistent list")
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("the chevron's inline list persists across selection and remount", async () => {
  const f = await open()
  try {
    const expander = missionPickerExpander(f.page), inline = f.page.locator(".mission-picker-inline")
    assert.equal(await expander.getAttribute("aria-expanded"), "false")
    await (await inlineMissionEntry(f.page, "Long migration")).click()
    assert.equal(await expander.getAttribute("aria-expanded"), "true")
    await missionDetail(f.page).waitFor()
    assert.equal(await inline.isVisible(), true, "selecting from the inline list keeps it open")
    assert.equal(await (await inlineMissionEntry(f.page, "Long migration")).getAttribute("aria-current"), "true")
    await f.page.locator("#chat").click()
    assert.equal(await inline.isVisible(), true, "outside interaction does not dismiss the persistent list")
    await f.page.evaluate(() => (window as any).missionHost.mount(false))
    await f.page.evaluate(() => (window as any).missionHost.mount(true))
    await inline.waitFor()
    assert.equal(await missionPickerExpander(f.page).getAttribute("aria-expanded"), "true", "expansion survives remount")
    assert.equal(await selectedMissionTitle(f.page).innerText(), "Long migration")
    await missionPickerExpander(f.page).click()
    await inline.waitFor({ state: "detached" })
    await f.page.evaluate(() => (window as any).missionHost.mount(false))
    await f.page.evaluate(() => (window as any).missionHost.mount(true))
    await missionPickerField(f.page).waitFor()
    assert.equal(await missionPickerExpander(f.page).getAttribute("aria-expanded"), "false", "collapse survives remount")
    assert.equal(await inline.count(), 0)
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
  await page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }).click()
  await page.locator("form.mission-editor details.mission-create-options[open]").waitFor()
}

test("keyboard focus in the creation form is never under its footer, with the brief name prompt open, tall or short", async () => {
  for (const viewport of [{ width: 1000, height: 600 }, { width: 260, height: 300 }]) {
    const f = await open({ viewport })
    try {
      await openCreation(f.page)
      const form = f.page.locator("form.mission-editor")
      await form.getByRole("button", { name: "Save as brief", exact: true }).click()
      await form.getByRole("textbox", { name: "Brief name", exact: true }).waitFor()
      await form.locator("summary").filter({ hasText: /^Agents and models$/ }).focus()
      await f.page.keyboard.press("Tab")
      assert.equal(await form.getByRole("textbox", { name: "Notes", exact: true }).evaluate(element => element === document.activeElement), true, "Tab reached Notes")
      // Every control from Notes to Create, the brief prompt's included, is seen when Tab reaches it.
      for (let step = 0; step < 8; step++) {
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

test("a very short panel scrolls the whole creation form: Options opens and every control stays reachable", async () => {
  const f = await open({ viewport: { width: 220, height: 120 } })
  try {
    await openCreation(f.page)
    const form = f.page.locator("form.mission-editor")
    for (const control of [form.getByRole("textbox", { name: "Notes", exact: true }), form.getByRole("button", { name: "Save as brief", exact: true }),
      form.getByRole("button", { name: "Cancel", exact: true }), form.locator('button[type="submit"]')]) {
      // A trial click scrolls the control into view and checks that the pointer reaches it.
      await control.click({ trial: true })
    }
    assert.equal(await scrolls(f.page, "form.mission-editor > .window-body"), false, "the body never scrolls inside the scrolling panel")
    assert.equal(await scrolls(f.page, ".mission-control"), true)
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
