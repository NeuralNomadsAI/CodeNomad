import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import type {} from "./fixtures/mission-editor-lifetime"
import { captureMissionView } from "./mission-view-capture"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { panelMissions } from "./mission-content-fixture"
import { pausedMissionScheduleReceipt } from "./mission-scheduled-fixture"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-create-submit",
      routes: [
        { path: "/create-submit", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-editor-lifetime.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

const OBJECTIVE = "Objective"
const profiles = { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m" } },
  roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } } }
const emptyRecurrence = () => recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] })
function created(body: Record<string, unknown>): MissionMap {
  return { version: 1, id: "msn_created", projectID: "project", projectCanonical: "/fixture", title: body.title as string, objective: body.objective as string,
    template: "custom", status: "active", runState: "prepared", coordinatorSessionId: "ses_coordinator", revision: 1, createdAt: 1, updatedAt: 1,
    history: [], historyTruncated: false, frontier: [], claims: [], actors: [], tasks: [], reports: [] }
}

async function setup(page: Page) {
  const errors: string[] = [], creates: Array<Record<string, unknown>> = [], controls: string[] = []
  let list: MissionMap[] = []
  let scheduled: Awaited<ReturnType<typeof pausedMissionScheduleReceipt>> | undefined
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await events.route(page)
  await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: {
    location: { directory: "/fixture" }, capability: null, effectiveDepth: null, project: null } }))
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles }] } } }))
  await page.route("**/api/workspaces/fixture/missions**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith("/control")) { controls.push(path); return route.abort() }
    if (path.endsWith("/capabilities")) return route.fulfill({ json: { location: { directory: "/fixture" }, api: { available: true }, enabled: true } })
    if (request.method() === "GET" && path.endsWith("/msn_created/schedule") && scheduled) return route.fulfill({ json: scheduled })
    if (request.method() === "GET" && path.endsWith("/missions/scheduled")) return route.fulfill({ json: {
      version: 1, projectID: "project", schedules: scheduled ? [scheduled.document] : [] } })
    if (request.method() === "GET") return route.fulfill({ json: path.endsWith("/missions/recurrence") ? emptyRecurrence()
      : { available: true, projectID: "project", missions: panelMissions(list), generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/scheduled")) {
      creates.push(request.postDataJSON())
      scheduled = await pausedMissionScheduleReceipt(request.postDataJSON())
      return route.fulfill({ json: scheduled })
    }
    if (path.endsWith("/missions")) {
      const body = request.postDataJSON(); creates.push(body)
      list = [created(body)]
      return route.fulfill({ json: { mission: list[0] } })
    }
    return route.fulfill({ json: {} })
  })
  return { errors, creates, controls, get scheduled() { return scheduled } }
}

const submitReady = (page: Page) => page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)

async function assertSingleCreate(form: ReturnType<Page["locator"]>) {
  const submits = form.locator('button[type="submit"]')
  assert.equal(await submits.count(), 1, "creation offers one submit button")
  assert.equal(await submits.innerText(), "Create")
  assert.equal(await form.getByRole("checkbox", { name: "Start automatically", exact: true }).isChecked(), false, "creation stays paused by default")
  await form.getByRole("button", { name: "Create", exact: true }).click()
  await form.waitFor({ state: "detached" })
}

test("Create creates one paused one-time mission and never sends a lifecycle control", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Audit dependencies. Report outdated packages with their risk.")
    assert.equal(await form.getByLabel("Title", { exact: true }).inputValue(), "Audit dependencies")
    await submitReady(page)
    await captureMissionView(page, "create-default")
    assert.equal(await form.locator("summary").filter({ hasText: /^Options$/ }).count(), 0)
    await assertSingleCreate(form)
    await page.waitForTimeout(300)
    assert.equal(fixture.creates.length, 1)
    assert.equal(fixture.creates[0]!.title, "Audit dependencies")
    assert.deepEqual(fixture.controls, [], "Play stays a separate explicit action")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

// Later page routes win: answer one-time creation POSTs, fall back for everything else.
async function answerCreates(page: Page, answer: (route: import("playwright").Route, attempt: number) => Promise<void> | void) {
  const attempts: Array<Record<string, unknown>> = []
  await page.route("**/api/workspaces/fixture/missions", route => {
    if (route.request().method() !== "POST") return route.fallback()
    attempts.push(route.request().postDataJSON())
    return answer(route, attempts.length)
  })
  return attempts
}
const UNCONFIRMED = "native creation result is unconfirmed"

test("an opted-in one-time Create retains its draft choice across remount and sends one Start after the direct ACK", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page), controls: Record<string, any>[] = []
  await page.route("**/api/workspaces/fixture/missions/msn_created/control", route => {
    assert.equal(route.request().method(), "POST")
    const input = route.request().postDataJSON(); controls.push(input)
    return route.fulfill({ json: { mission: { ...created(fixture.creates[0]), runState: "running", revision: 2,
      control: { requestID: input.requestId, action: "start", expectedRevision: input.expectedRevision, pending: [] } } } })
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor"), autostart = form.getByRole("checkbox", { name: "Start automatically", exact: true })
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Start this confirmed preparation")
    assert.equal(await autostart.isChecked(), false)
    await autostart.check()
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    assert.equal(await autostart.isChecked(), true, "an unsent draft retains the user's choice")
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.equal(fixture.creates.length, 1)
    assert.equal(controls.length, 1)
    assert.equal(controls[0].action, "start")
    assert.equal(controls[0].expectedRevision, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

for (const loss of ["lost fetch", "undecodable acknowledgement"] as const) {
  test(`${loss} holds the exact original creation across edit, close/remount and project changes without a second create`, async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
    const fixture = await setup(page)
    const attempts = await answerCreates(page, route => loss === "lost fetch" ? route.abort("connectionreset")
      : route.fulfill({ status: 200, contentType: "application/json", body: '{"mission":{"id":' }))
    try {
      await page.goto(url)
      await page.getByRole("button", { name: "Create mission", exact: true }).click()
      const form = page.locator("form.mission-editor"), objective = form.getByLabel(OBJECTIVE, { exact: true })
      await objective.fill("Original lost create")
      await submitReady(page)
      await form.getByRole("checkbox", { name: "Start automatically", exact: true }).check()
      await form.getByRole("button", { name: "Create", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: UNCONFIRMED }).waitFor()
      assert.equal(await objective.isDisabled(), true, "the unknown contract cannot be edited into a new request")
      assert.equal(await form.locator('button[type="submit"]').isDisabled(), true)
      const original = await page.evaluate(() => window.missionEditorLifetime.held())
      assert.equal(original!.requestId, attempts[0].requestId)
      await form.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.evaluate(() => window.missionEditorLifetime.project("other-project"))
      await page.evaluate(() => window.missionEditorLifetime.project("project"))
      await page.evaluate(() => window.missionEditorLifetime.mount(false))
      await page.evaluate(() => window.missionEditorLifetime.mount(true))
      await page.getByRole("button", { name: "Create mission", exact: true }).click()
      assert.equal(await objective.inputValue(), "Original lost create")
      assert.equal(await form.getByRole("checkbox", { name: "Start automatically", exact: true }).isChecked(), true)
      assert.equal(await form.getByRole("checkbox", { name: "Start automatically", exact: true }).isDisabled(), true)
      assert.equal(await objective.isDisabled(), true)
      assert.equal(await form.locator('button[type="submit"]').isDisabled(), true)
      await form.evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
      await page.waitForTimeout(200)
      assert.equal(attempts.length, 1, "no automatic or manual replay under any identity")
      assert.deepEqual(await page.evaluate(() => window.missionEditorLifetime.held()), original)
      assert.deepEqual(fixture.controls, [], "an unknown create never starts execution")
      assert.deepEqual(fixture.errors, [])
    } finally { await page.close() }
  })
}

test("a newer editor cannot submit while a creation reply is pending and keeps its draft after the original succeeds", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  let release!: () => void
  const reply = new Promise<void>(resolve => { release = resolve })
  const attempts = await answerCreates(page, async route => {
    if (attempts.length === 1) await reply
    return route.fallback()
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor"), objective = form.getByLabel(OBJECTIVE, { exact: true })
    await objective.fill("First pending create")
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await page.waitForFunction(() => document.querySelector('form.mission-editor button[type="submit"]')?.textContent !== "Create")
    await form.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await objective.fill("Newer draft")
    await submitReady(page)
    await form.locator('button[type="submit"]').click()
    await page.waitForTimeout(200)
    assert.equal(attempts.length, 1, "the pending original fences a second logical creation")
    assert.equal(await objective.inputValue(), "Newer draft", "a pending hold does not overwrite the newer draft")
    assert.equal(await form.locator('button[type="submit"]').isDisabled(), true)
    release()
    await submitReady(page)
    assert.equal(await objective.inputValue(), "Newer draft")
    assert.equal(await page.evaluate(() => window.missionEditorLifetime.held()), undefined)
    assert.equal(fixture.creates.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

// An agent can submit within a second of the panel mounting, before the panel's first list read
// reports the project: that report is the project the creation was made in, not another view.
test("a creation submitted before the panel's first list read lands still closes the editor and selects the mission", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  const firstRead = Promise.withResolvers<void>(), posted = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>()
  let reads = 0
  await page.route("**/api/workspaces/fixture/missions", async route => {
    if (route.request().method() === "GET" && reads++ === 0) await firstRead.promise
    else if (route.request().method() === "POST") { posted.resolve(); await reply.promise }
    return route.fallback()
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Created before the first list read")
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await posted.promise
    firstRead.resolve()
    await page.waitForFunction(() => window.missionEditorLifetime.state("fixture").projectID === "project")
    reply.resolve()
    await form.waitFor({ state: "detached" })
    await page.waitForFunction(() => window.missionEditorLifetime.selectedHistory().at(-1) === "msn_created")
    assert.equal(fixture.creates.length, 1)
    assert.deepEqual(fixture.controls, [])
    assert.deepEqual(fixture.errors, [])
  } finally { firstRead.resolve(); reply.resolve(); await page.close() }
})

// The instance's metadata still names the creation's project while the first list read reports
// another one: that first report is another view, so the creation's completion cannot close it.
test("a first list read reporting another project than the instance's fences a creation still in flight", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  const firstRead = Promise.withResolvers<void>(), posted = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>()
  const completionRead = Promise.withResolvers<void>()
  let reads = 0
  await page.route("**/api/workspaces/fixture/missions", async route => {
    if (route.request().method() === "POST") { posted.resolve(); await reply.promise; return route.fallback() }
    if (route.request().method() !== "GET") return route.fallback()
    if (reads++ === 0) await firstRead.promise
    else completionRead.resolve()
    return route.fulfill({ json: { available: true, projectID: "other-project", missions: [], generatedAt: 1, discardedEvents: 0 } })
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Created in the instance's project")
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await posted.promise
    firstRead.resolve()
    await page.waitForFunction(() => window.missionEditorLifetime.state("fixture").status === "error")
    assert.equal(await page.evaluate(() => window.missionEditorLifetime.state("fixture").projectID), undefined, "a foreign directory response is refused, never adopted")
    await page.evaluate(() => window.missionEditorLifetime.project("other-project"))
    reply.resolve()
    // Either outcome of the completion reads the list again: decide only after that read.
    await completionRead.promise
    assert.equal(await page.evaluate(() => Boolean(document.querySelector("form.mission-editor"))), true,
      "a refused foreign-project response cannot close the creation view")
    assert.equal((await page.evaluate(() => window.missionEditorLifetime.selectedHistory())).includes("msn_created"), false)
    assert.equal(fixture.creates.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { firstRead.resolve(); reply.resolve(); await page.close() }
})

test("a definitive creation rejection releases the request, keeps the draft editable and admits a corrected creation", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  const attempts = await answerCreates(page, (route, attempt) => attempt === 1
    ? route.fulfill({ status: 400, json: { error: "Invalid mission creation request" } }) : route.fallback())
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor"), objective = form.getByLabel(OBJECTIVE, { exact: true })
    await objective.fill("Rejected create")
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.doesNotMatch(await page.getByRole("alert").innerText(), new RegExp(UNCONFIRMED))
    assert.equal(await page.evaluate(() => window.missionEditorLifetime.held()), undefined)
    assert.equal(await objective.isDisabled(), false)
    await objective.fill("Corrected create")
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.equal(attempts.length, 2)
    assert.notEqual(attempts[1].requestId, attempts[0].requestId, "a changed payload is a new logical request")
    assert.equal(fixture.creates.length, 1)
    assert.deepEqual(fixture.controls, [])
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("clearing the daily time and removing the criterion creates a one-time mission without flipping back to Daily", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("One-time after clearing the schedule")
    await form.getByLabel("Criterion 1 type", { exact: true }).selectOption("daily")
    await form.getByLabel("Criterion 1 time", { exact: true }).fill("")
    await form.getByRole("button", { name: "Remove criterion 1", exact: true }).click()
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await form.waitFor({ state: "detached", timeout: 3_000 }).catch(() => undefined)
    assert.equal(await form.count(), 0, "native validation must not block Once for an inactive daily time")
    assert.equal(fixture.creates.length, 1)
    assert.equal(fixture.creates[0]!.clock, undefined, "the one-time route received the creation, not a schedule")
    assert.equal(fixture.creates[0]!.objective, "One-time after clearing the schedule")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("daily Create stores a paused schedule and never sends Play", async () => {
  const page = await browser.newPage({ locale: "en-US", timezoneId: "Europe/Paris", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    // First wait after navigation: allow for a cold page boot late in a long serial run.
    await page.getByRole("button", { name: "Create mission", exact: true }).click({ timeout: 60_000 })
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Review yesterday's merged changes and summarize risks.")
    await form.getByLabel("Criterion 1 type", { exact: true }).selectOption("daily")
    await form.getByLabel("Criterion 1 time", { exact: true }).fill("07:30")
    assert.equal(await form.getByLabel("Saved time zone (IANA)", { exact: true }).count(), 0, "the system zone is the hidden default")
    await submitReady(page)
    await captureMissionView(page, "create-recurring")
    await assertSingleCreate(form)
    await page.waitForTimeout(300)
    assert.equal(fixture.creates.length, 1)
    const configuration = fixture.creates[0]!.configuration as Record<string, any>
    assert.equal(configuration.title, "Review yesterday's merged changes and summarize risks")
    assert.deepEqual(configuration.launch, { when: [{ kind: "cron", expression: "30 7 * * *", zone: "Europe/Paris" }] })
    assert.deepEqual(fixture.controls, [], "Play stays a separate explicit action")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

for (const lost of [false, true]) test(`opted-in schedule creation sends one Play; ${lost ? "a lost control ACK retains its exact hold across remount" : "a direct control ACK is accepted"}`, async () => {
  const page = await browser.newPage({ locale: "en-US", timezoneId: "Europe/Paris" }), fixture = await setup(page)
  const controls: Record<string, any>[] = []
  await page.route("**/api/workspaces/fixture/missions/msn_created/schedule", route => {
    if (route.request().method() !== "POST") return route.fallback()
    const input = route.request().postDataJSON(); controls.push(input)
    return lost ? route.abort("connectionreset") : route.fulfill({ json: { ...fixture.scheduled, pending: false,
      document: { ...fixture.scheduled!.document, revision: 1, control: { requestID: input.requestID,
        expectedRevision: input.expectedRevision, action: "play", pending: false } } } })
  })
  const holds = () => page.evaluate(async () => {
    const path = "/src/stores/mission-schedules.ts", { unifiedScheduleHolds } = await import(path)
    return [...unifiedScheduleHolds.values()].map(hold => ({ phase: hold.phase, action: hold.action,
      requestID: hold.requestID, expectedRevision: hold.expectedRevision }))
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Arm this confirmed schedule")
    await form.getByLabel("Criterion 1 type", { exact: true }).selectOption("daily")
    await form.getByRole("checkbox", { name: "Start automatically", exact: true }).check()
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.equal(fixture.creates.length, 1)
    assert.equal(controls.length, 1)
    assert.equal(controls[0].action, "play")
    assert.equal(controls[0].expectedRevision, 0)
    if (lost) {
      const held = await holds()
      assert.deepEqual(held, [{ phase: "control", action: "play", requestID: controls[0].requestID, expectedRevision: 0 }])
      await page.evaluate(() => window.missionEditorLifetime.mount(false))
      await page.evaluate(() => window.missionEditorLifetime.mount(true))
      assert.deepEqual(await holds(), held)
      assert.equal(controls.length, 1, "remount never replays the unknown Play")
    }
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})
