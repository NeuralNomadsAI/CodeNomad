import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { missionPickerExpander, missionPickerField, missionPopupOption, missionDetail, missionGeneralAction, inlineMissionEntry, selectMission, selectedMissionTitle } from "./mission-actions"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [solid(), shutdown.plugin, { name: "mission-panel-host", configureServer(s) {
        s.middlewares.use("/mission-panel-host", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/mission-panel-host", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-panel-host.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    shutdown.own(server); await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-panel-host`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

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
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [LONG, SHORT], generatedAt: 1, discardedEvents: 0,
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
