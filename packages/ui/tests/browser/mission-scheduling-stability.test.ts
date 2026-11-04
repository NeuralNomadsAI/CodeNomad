import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { fixtureEventStream } from "./fixture-event-stream"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { missionGeneralAction } from "./mission-actions"
import { borrowFixture } from "./fixture-borrow"
import { listedMissions, routeMissionContent } from "./mission-content-fixture"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "mission-control", routes: [{ path: "/mission-fixture",
    html: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

type Capability = "available" | "missing"
const capabilityBody = (value: Capability) => ({ location: { directory: "fixture" }, api: value === "available" ? { available: true } : { available: false, reason: "missing-api" },
  enabled: value === "available", origin: "/ancestor/.opencode/opencode.jsonc",
  activation: { available: false, reason: "missing-api", targets: [{ scope: "global", path: "/global/opencode.jsonc" }] } })

/** Real MissionControl and native dispatcher; each capability read waits for the test unless auto-answered. */
async function setup(page: Page) {
  page.setDefaultTimeout(15_000)
  const errors: string[] = [], reads: Array<{ route: Route; answer: (value: Capability) => Promise<void> }> = []
  let automatic: Capability | undefined = "available"
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "remote", electronAPI: {
    claimClientStateAccess: async () => true, loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }), saveClientState: async () => true } })`)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await events.route(page)
  await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: { location: { directory: "fixture" }, capability: null, effectiveDepth: null, project: null } }))
  await routeMissionContent(page, listedMissions)
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/missions/scheduled/capabilities*", async route => {
    const answer = async (value: Capability) => { await route.fulfill({ json: capabilityBody(value) }).catch(() => undefined) }
    reads.push({ route, answer })
    if (automatic) await answer(automatic)
  })
  await page.goto(url)
  await page.evaluate(() => (window as any).missionFixture.connectCatalog())
  return { errors, reads, hold: () => { automatic = undefined }, answerAutomatically: (value: Capability) => { automatic = value } }
}
const dispatch = (page: Page, event: Record<string, unknown>) => page.evaluate(async event => {
  const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
  serverEvents.dispatchBatch([event as any])
}, event)
const scheduling = (page: Page) => page.locator("form.mission-editor .mission-scheduling")
const add = (page: Page) => scheduling(page).getByRole("button", { name: "Add a criterion", exact: true })
const kind = (page: Page) => scheduling(page).getByLabel("Criterion 1 type", { exact: true })
const addDisabled = (page: Page) => add(page).isDisabled()
const updateIcon = (page: Page) => page.locator(".mission-control-header button[aria-label='Refresh mission map'] .animate-spin")
async function until(condition: () => boolean, timeout = 5_000) {
  for (const start = Date.now(); !condition();) {
    if (Date.now() - start > timeout) throw new Error("Condition not reached")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
/** Records every frame's Scheduling geometry, disabled state, status text and focus against the first frame. */
// A source string: the test transpiler would wrap named functions in a helper the page lacks.
const watchScheduling = (page: Page) => page.evaluate(`(() => {
  const root = document.querySelector("form.mission-editor .mission-scheduling"), focused = document.activeElement
  const sample = () => JSON.stringify({ rects: [...root.querySelectorAll("summary, fieldset, select, .mission-criterion, p")]
    .map(item => { const box = item.getBoundingClientRect(); return [item.tagName, Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)] }),
  disabled: [...root.querySelectorAll("fieldset, option, button")].map(item => item.disabled),
  text: root.textContent, focus: document.activeElement === focused, open: root.querySelector("select").matches(":open") })
  const first = sample(), changes = []
  let running = true
  const frame = () => { if (!running) return; const next = sample(); if (next !== first && !changes.includes(next)) changes.push(next); requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
  window.schedulingChanges = () => { running = false; return { first, changes } }
})()`)
const schedulingChanges = (page: Page) => page.evaluate(() => (window as any).schedulingChanges()) as Promise<{ first: string; changes: string[] }>

test("Scheduling keeps its display, focus and open picker through passive revalidation, which only config and connection changes cause", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const f = await setup(page)
    await missionGeneralAction(page, "Create mission").click()
    await scheduling(page).locator("summary").click()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("form.mission-editor .mission-scheduling-add")?.disabled)
    await add(page).click()
    await scheduling(page).locator(".mission-criterion").waitFor()
    await page.waitForTimeout(300)
    const baseline = f.reads.length
    // The fixture's startup plugin/config events may add one coalesced trailing read.
    assert.ok(baseline >= 1 && baseline <= 2, `opening reads capability once, plus at most one trailing read (${baseline})`)
    assert.equal(await scheduling(page).getByText(/OpenCode configuration file:|\/ancestor\/|\/global\//).count(), 0, "Scheduling shows no configuration path")
    await updateIcon(page).waitFor({ state: "detached" })

    await kind(page).click()
    assert.equal(await kind(page).evaluate(select => select.matches(":open")), true)
    await watchScheduling(page)
    // Task revisions, transcript releases and unrelated instance publications keep the same owner.
    for (let index = 0; index < 3; index++) {
      await page.evaluate(() => (window as any).missionFixture.refresh())
      await page.evaluate(async () => {
        const dataPath = "/src/stores/opencode-data.ts", { destroyOpenCodeData } = await import(dataPath)
        destroyOpenCodeData("fixture", "ses_released")
        const instancePath = "/src/stores/instances.ts", { updateInstance } = await import(instancePath)
        updateInstance("fixture", { status: "ready" })
      })
      await page.waitForTimeout(400)
    }
    assert.equal(f.reads.length, baseline, "task-only and transcript changes read no capability")

    // Config changes during a pending read coalesce into one trailing read.
    f.hold()
    await dispatch(page, { type: "instance.event", instanceId: "fixture", event: { type: "config.updated" } })
    await until(() => f.reads.length === baseline + 1)
    await updateIcon(page).waitFor()
    await dispatch(page, { type: "instance.event", instanceId: "fixture", event: { type: "config.updated" } })
    await dispatch(page, { type: "instance.event", instanceId: "fixture", event: { type: "plugin.updated" } })
    await page.waitForTimeout(300)
    assert.equal(f.reads.length, baseline + 1, "one read at a time")
    await f.reads.at(-1)!.answer("available")
    await until(() => f.reads.length === baseline + 2)
    await f.reads.at(-1)!.answer("available")
    await updateIcon(page).waitFor({ state: "detached" })
    await page.waitForTimeout(300)
    assert.equal(f.reads.length, baseline + 2, "at most one trailing read")

    f.answerAutomatically("available")
    await dispatch(page, { type: "instance.eventStatus", instanceId: "fixture", status: "connected" })
    await until(() => f.reads.length === baseline + 3)
    await updateIcon(page).waitFor({ state: "detached" })
    await page.waitForTimeout(200)

    const { first, changes } = await schedulingChanges(page)
    assert.deepEqual(changes, [], `no reflow, disabled flash, text, focus or picker change from ${first}`)
    assert.equal(await scheduling(page).getByText("Checking scheduling availability…").count(), 0)
    await page.keyboard.press("Escape")
    assert.equal(await kind(page).inputValue(), "daily")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("a new client resets Scheduling to its first read, and a late response of a previous owner never publishes", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const f = await setup(page)
    await missionGeneralAction(page, "Create mission").click()
    await scheduling(page).locator("summary").click()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("form.mission-editor .mission-scheduling-add")?.disabled)
    f.hold()
    const setClient = (original: boolean) => page.evaluate(async original => {
      const path = "/src/stores/instances.ts", { instances, updateInstance } = await import(path)
      const store = window as any
      store.originalClient ??= instances().get("fixture")?.client
      updateInstance("fixture", { client: original ? store.originalClient : {} })
    }, original)
    const before = f.reads.length
    await setClient(false)
    await until(() => f.reads.length === before + 1)
    assert.equal(await addDisabled(page), true, "another client starts from its own first read")
    await updateIcon(page).waitFor()
    await setClient(true)
    await until(() => f.reads.length === before + 2)
    await f.reads[before].answer("available")
    await page.waitForTimeout(300)
    assert.equal(await addDisabled(page), true, "the previous owner's late answer is ignored")
    await f.reads[before + 1].answer("missing")
    await scheduling(page).getByText("Scheduling is unavailable on this connection.", { exact: false }).waitFor()
    assert.equal(await addDisabled(page), true)
    await updateIcon(page).waitFor({ state: "detached" })
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("the scheduling i opens the real Settings on the Keep OpenCode running row and the native hint targets the same anchor", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const f = await setup(page)
    await missionGeneralAction(page, "Create mission").click()
    await scheduling(page).locator("summary").click()
    await scheduling(page).getByRole("button", { name: /Schedules only run while OpenCode is running\.$/ }).click()
    await page.locator(".settings-info-link-content").getByRole("button", { name: "Keep OpenCode running", exact: true }).click()
    const row = page.locator('.settings-screen-shell [data-settings-row="service-supervision"]')
    await row.waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-settings-row") === "service-supervision")
    await page.waitForTimeout(300)
    assert.equal(await row.evaluate(element => element === document.activeElement), true, "the dialog never takes focus back")
    // A native Preferences window adopts a fresh hint for its active section only, once.
    const adopt = (hint: object | null, section: string) => page.evaluate(async ({ hint, section }) => {
      const path = "/src/stores/settings-screen.ts", store = await import(path)
      ;(document.activeElement as HTMLElement | null)?.blur()
      if (hint) localStorage.setItem(store.SETTINGS_ROW_HINT_KEY, JSON.stringify(hint))
      store.adoptSettingsRowHint(section)
      await new Promise(resolve => requestAnimationFrame(resolve))
      return { focused: document.activeElement?.getAttribute("data-settings-row") ?? null, left: localStorage.getItem(store.SETTINGS_ROW_HINT_KEY) }
    }, { hint, section })
    const stale = await adopt({ section: "opencode", row: "service-supervision", at: Date.now() - 60_000 }, "opencode")
    assert.equal(stale.focused, null, "a stale hint never moves focus"); assert.notEqual(stale.left, null)
    assert.equal((await adopt({ section: "missions", row: "service-supervision", at: Date.now() }, "opencode")).focused, null, "another section's hint is ignored")
    assert.deepEqual(await adopt({ section: "opencode", row: "service-supervision", at: Date.now() }, "opencode"), { focused: "service-supervision", left: null })
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
