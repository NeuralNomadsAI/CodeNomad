import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"
import { NativeMissionDocumentStore } from "../../../server/src/missions/mission-document-store"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import type { MissionDocument } from "../../../server/src/missions/mission-document"
import type { MissionJsonValue, MissionMap } from "../../../server/src/missions/model"
import { missionDocumentChanges } from "../../../server/src/missions/mission-document-state"
import { missionContentFixture, panelMissions } from "./mission-content-fixture"
import type {} from "./fixtures/mission-editor-scheduling"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "mission-editor-scheduling", routes: [{ path: "/editor",
    html: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;min-height:100%;background:var(--surface-canvas)}</style></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-scheduling.tsx"></script></body></html>' }] })
  url = fixture.url; events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })
const profiles = { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m", variant: "precise" } },
  roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m", variant: "fast" } } } }
const objective = "What should the mission do?"
async function createDocument() {
  const values = new Map<string, MissionJsonValue>()
  const store = new NativeMissionDocumentStore({ get: async key => values.get(key), compareAndSet: async (key, value) => { values.set(key, value) } }, "project", "/fixture")
  return store.create("msn_fixture", { title: "Stored title", objective: "Stored instructions", notes: "Stored notes", template: "custom", profiles,
    taskMode: "native", watchedConversationIDs: [], roots: [{ mode: "directory-only", directory: "/fixture" }], profileID: "profile", executionHost: "local",
    launch: { timing: { kind: "cron", expression: "0 05 09 1,15 * *", zone: "Europe/Paris" }, condition: null,
      ends: { at: null, afterMs: null, maxLaunches: 10 } } }, Date.now(), () => true)
}
async function setup(page: Page, available = true, locale = "en", theme = "dark", taskCount = 0) {
  page.setDefaultTimeout(15_000)
  const errors: string[] = [], posts: Array<Record<string, any>> = [], reads: URL[] = []
  let doc = await createDocument(), lose = false, proof = true, contentProof = true, original: Record<string, any> | undefined
  let journal: MissionMap = { version: 1, id: "msn_fixture", projectID: "project", projectCanonical: "/fixture",
    title: "Stored title", objective: "Stored instructions", notes: "Stored notes", template: "custom", status: "active", runState: "prepared",
    coordinatorSessionId: "ses_coordinator", revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false,
    frontier: [], claims: [], actors: [], tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `tsk_${index}`, key: `work-${index}`, title: `Work ${index}`, brief: `Brief ${index}`, role: "specialist", status: "ready",
      blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 })), reports: [] }
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await events.route(page)
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: {
    missionProfileDefaults: [{ template: "custom", profiles }], locale } } }))
  await page.route("**/api/storage/state/ui", route => route.fulfill({ json: { theme, colorScheme: theme === "light" ? "porcelain" : "mist" } }))
  await page.route("**/api/workspaces/fixture/missions**", async route => {
    const request = route.request(), link = new URL(request.url()), pathname = link.pathname
    if (request.method() === "PATCH") {
      const body = request.postDataJSON(); posts.push(body)
      journal = { ...journal, objective: body.objective, notes: body.notes, revision: journal.revision + 1, history: [{
        source: "user", requestID: body.requestId, revision: body.expectedRevision + 1, objective: { before: journal.objective, after: body.objective },
        notes: { before: journal.notes, after: body.notes }, addedTaskKeys: [], retiredTasks: [], dependencyUpdates: [], createdAt: Date.now() }] }
      return lose ? route.abort("connectionreset") : route.fulfill({ json: { mission: journal } })
    }
    if (request.method() !== "GET") {
      const body = request.postDataJSON(); posts.push(body); original = body
      if (pathname.endsWith("/scheduled")) {
        doc = { ...doc, configuration: { ...doc.configuration, ...body.configuration }, revision: 0, state: "paused", firstPlayedAt: null, calendars: [] }
      } else doc = { ...doc, configuration: { ...doc.configuration, ...body.configuration }, revision: doc.revision + 1 }
      if (lose) return route.abort("connectionreset")
      return route.fulfill({ json: receipt(body) })
    }
    reads.push(link)
    const content = missionContentFixture(request.url(), request.method(), contentProof ? [journal] : [])
    if (content) return route.fulfill({ json: content })
    if (pathname.endsWith("/capabilities")) return route.fulfill({ json: { location: { directory: "/fixture" },
      api: available ? { available: true } : { available: false, reason: "missing-api" }, enabled: available,
      origin: null, activation: { available: false, reason: "missing-api", targets: [] } } })
    if (pathname.endsWith("/scheduled")) return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
    if (pathname.endsWith("/msn_fixture")) {
      const [mission] = panelMissions([proof ? journal : { ...journal, history: [] }])
      return route.fulfill({ json: { available: true, projectID: "project", mission, cleanups: [] } })
    }
    if (pathname.endsWith("/schedule") || pathname.includes("/requests/")) {
      const requestID = link.searchParams.get("requestID") ?? (pathname.includes("/requests/") ? pathname.split("/").at(-1) : undefined)
      return route.fulfill({ json: requestID && original && proof ? receipt(original) : { ...missionScheduleView(doc), ...(requestID ? { pending: true } : {}) } })
    }
    return route.fulfill({ json: { available: true, projectID: "project", missions: [], cleanups: [], generatedAt: 1 } })
  })
  function receipt(input: Record<string, any>) {
    const result = missionScheduleView(doc)
    return { ...result, pending: false, document: { ...result.document, control: { requestID: input.requestID,
      action: input.action, expectedRevision: input.expectedRevision, pending: false } } }
  }
  await page.goto(url)
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
  return { errors, posts, reads, get doc() { return doc }, set doc(value: MissionDocument) { doc = value },
    set lose(value: boolean) { lose = value }, set proof(value: boolean) { proof = value },
    set contentProof(value: boolean) { contentProof = value } }
}
const form = (page: Page) => page.locator("form.mission-editor")
const scheduling = (page: Page) => form(page).locator(".mission-scheduling > summary")
const options = (page: Page) => form(page).locator("summary").filter({ hasText: /^Options$/ })
const ready = (page: Page) => page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
async function capture(page: Page, name: string) {
  const directory = process.env.CODENOMAD_MISSION_CAPTURE_DIR
  if (directory) { await mkdir(directory, { recursive: true }); await page.screenshot({ path: path.join(directory, name), fullPage: true }) }
}

test("shared Create stores a paused multi-time policy with exact profiles and sends no Play", async () => {
  const page = await browser.newPage({ timezoneId: "Europe/Paris", viewport: { width: 620, height: 1100 } }), f = await setup(page)
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Review project changes")
    await ready(page)
    assert.equal(await form(page).locator(".mission-scheduling").getAttribute("open"), null)
    assert.match(await scheduling(page).innerText(), /Once, immediately.*Without a condition/)
    await scheduling(page).click()
    await form(page).getByLabel("Frequency", { exact: true }).selectOption("multi")
    await form(page).getByRole("button", { name: "Add a time", exact: true }).click()
    await form(page).getByLabel("Time 1", { exact: true }).fill("09:15")
    await form(page).getByLabel("Time 2", { exact: true }).fill("17:45")
    await form(page).getByLabel("Maximum launched passages", { exact: true }).fill("3")
    assert.equal(await form(page).locator(".mission-scheduling-preview li").count(), 3)
    await capture(page, "editor-create-en-dark.png")
    await form(page).getByRole("button", { name: "Create", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.equal(f.posts.length, 1)
    assert.equal(f.posts[0].action, "create"); assert.equal(f.posts[0].expectedRevision, 0)
    assert.deepEqual(f.posts[0].configuration.profiles, profiles)
    assert.deepEqual(f.posts[0].configuration.launch.timing, { kind: "multi", calendars: [
      { expression: "15 9 * * *", zone: "Europe/Paris" }, { expression: "45 17 * * *", zone: "Europe/Paris" }] })
    assert.equal(f.doc.state, "paused"); assert.equal(f.doc.firstPlayedAt, null); assert.deepEqual(f.doc.calendars, [])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("shared Edit loads all preparation fields and preserves the exact stored policy across remount and quota edits", async () => {
  const page = await browser.newPage(), f = await setup(page), timing = f.doc.configuration.launch.timing
  try {
    await page.evaluate(() => window.schedulingEditor.edit()); await ready(page)
    assert.equal(await form(page).getByLabel("Title", { exact: true }).inputValue(), "Stored title")
    await scheduling(page).click()
    assert.equal(await form(page).getByLabel("Frequency", { exact: true }).inputValue(), "cron")
    await form(page).getByLabel("Maximum launched passages", { exact: true }).fill("12")
    await page.evaluate(() => window.schedulingEditor.mount(false))
    await page.evaluate(() => window.schedulingEditor.mount(true)); await ready(page)
    await scheduling(page).click()
    assert.equal(await form(page).getByLabel("Maximum launched passages", { exact: true }).inputValue(), "12")
    await options(page).click()
    assert.equal(await form(page).getByLabel("Playbook", { exact: true }).isDisabled(), false)
    await form(page).getByLabel("Notes", { exact: true }).fill("Future instructions only")
    await form(page).getByLabel("Title", { exact: true }).fill("Updated title")
    await capture(page, "editor-edit-en-dark.png")
    await form(page).getByRole("button", { name: "Save", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0].action, "configure")
    assert.deepEqual(f.posts[0].configuration.launch.timing, timing)
    assert.equal(f.posts[0].configuration.launch.ends.maxLaunches, 12)
    assert.equal(f.posts[0].configuration.notes, "Future instructions only")
    assert.deepEqual(f.posts[0].configuration.profiles, profiles); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("revision conflict keeps the old draft for explicit comparison and never resends it", async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    await page.evaluate(() => window.schedulingEditor.edit()); await ready(page)
    await form(page).getByLabel(objective, { exact: true }).fill("My unsent draft")
    f.doc = { ...f.doc, revision: 1, configuration: { ...f.doc.configuration, objective: "New authoritative instructions" } }
    await form(page).getByRole("button", { name: "Save", exact: true }).click()
    await form(page).getByRole("button", { name: "Reload current configuration", exact: true }).waitFor()
    assert.equal(await form(page).getByLabel(objective, { exact: true }).inputValue(), "My unsent draft")
    assert.equal(await form(page).getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(f.posts.length, 0)
    await form(page).getByRole("button", { name: "Reload current configuration", exact: true }).click(); await ready(page)
    assert.equal(await form(page).getByLabel(objective, { exact: true }).inputValue(), "New authoritative instructions")
    await form(page).locator("summary").filter({ hasText: /^Previous draft for comparison$/ }).click()
    assert.match(await form(page).getByLabel("Previous draft for comparison", { exact: true }).inputValue(), /My unsent draft/)
    await capture(page, "editor-conflict-en-dark.png")
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const kind of ["create", "edit"] as const) test(`${kind} lost ACK keeps its immutable identity across close/remount; Refresh reads only its exact receipt`, async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    await page.evaluate(kind => window.schedulingEditor[kind](), kind)
    if (kind === "create") {
      await form(page).getByLabel(objective, { exact: true }).fill("Original creation")
      await scheduling(page).click(); await form(page).getByLabel("Frequency", { exact: true }).selectOption("daily")
    }
    await ready(page); f.lose = true
    await form(page).locator('button[type="submit"]').click()
    await form(page).getByRole("alert").filter({ hasText: /unconfirmed/ }).waitFor()
    const held = await page.evaluate(() => window.schedulingEditor.held())
    assert.equal(JSON.parse(held!.payload).requestID, f.posts[0].requestID)
    await form(page).getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(kind => window.schedulingEditor[kind](), kind)
    await page.evaluate(() => window.schedulingEditor.mount(false))
    await page.evaluate(() => window.schedulingEditor.mount(true))
    assert.equal(await form(page).getByLabel(objective, { exact: true }).isDisabled(), true)
    await form(page).evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    assert.equal(f.posts.length, 1)
    f.proof = false
    await form(page).getByRole("button", { name: "Refresh saved request", exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.schedulingEditor.held()), held)
    f.proof = true
    await form(page).getByRole("button", { name: "Refresh saved request", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.equal(f.posts.length, 1)
    assert.ok(f.reads.some(read => read.searchParams.get("requestID") === f.posts[0].requestID || read.pathname.endsWith(`/requests/${f.posts[0].requestID}`)))
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("H9 locks structural fields during a passage, with reasons, while keeping its instructions and notes editable", async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    missionDocumentChanges.play(f.doc, "play_fixture", Date.now(), [])
    f.doc.synchronization = null
    missionDocumentChanges.reserve(f.doc, { kind: "manual", requestID: "manual_fixture" }, Date.now(), [])
    await page.evaluate(() => window.schedulingEditor.edit()); await ready(page)
    await form(page).getByRole("status").filter({ hasText: /passage is in progress/ }).first().waitFor()
    assert.equal(await form(page).getByLabel("Title", { exact: true }).isDisabled(), true)
    assert.equal(await form(page).getByLabel(objective, { exact: true }).isDisabled(), false)
    await options(page).click()
    assert.equal(await form(page).getByLabel("Playbook", { exact: true }).isDisabled(), true)
    await form(page).getByLabel("Notes", { exact: true }).fill("Editable guidance")
    await capture(page, "editor-h9-en-dark.png")
    await form(page).getByRole("button", { name: "Save", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.equal(f.posts[0].configuration.notes, "Editable guidance")
    assert.equal(f.doc.pending!.configuration.notes, "Stored notes", "the admitted/prepared passage keeps its frozen instructions")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const taskCount of [0, 75]) test(`a journal edit with ${taskCount} tasks and a lost ACK keeps the original request until its exact history receipt is read`, async () => {
  const page = await browser.newPage(), f = await setup(page, true, "en", "dark", taskCount)
  try {
    await page.evaluate(() => window.schedulingEditor.journal()); await ready(page)
    await form(page).getByLabel(objective, { exact: true }).fill("Original journal edit")
    f.lose = true
    await form(page).getByRole("button", { name: "Save", exact: true }).click()
    await form(page).getByRole("alert").filter({ hasText: /change is unconfirmed/ }).waitFor()
    const held = await page.evaluate(() => window.schedulingEditor.held())
    assert.equal(JSON.parse(held!.payload).requestID, f.posts[0].requestId)
    await form(page).getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(() => window.schedulingEditor.journal())
    assert.equal(await form(page).getByLabel(objective, { exact: true }).inputValue(), "Original journal edit")
    assert.equal(await form(page).getByLabel(objective, { exact: true }).isDisabled(), true)
    f.proof = false
    const missingHistory = page.waitForResponse(response => response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/workspaces/fixture/missions/msn_fixture")
    await form(page).getByRole("button", { name: "Refresh saved request", exact: true }).click()
    await missingHistory
    assert.deepEqual(await page.evaluate(() => window.schedulingEditor.held()), held)
    f.proof = true
    f.contentProof = false
    const missingContent = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/content")
      && new URL(response.url()).searchParams.get("field") === "objective")
    await form(page).getByRole("button", { name: "Refresh saved request", exact: true }).click()
    await missingContent
    assert.deepEqual(await page.evaluate(() => window.schedulingEditor.held()), held, "a descriptor without its exact content keeps the hold")
    f.contentProof = true
    const exactReceipt = page.waitForResponse(response => response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/workspaces/fixture/missions/msn_fixture")
    await form(page).getByRole("button", { name: "Refresh saved request", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    const { mission } = await (await exactReceipt).json()
    assert.equal(mission.history[0].requestID, f.posts[0].requestId)
    assert.equal(mission.taskPage.total, taskCount)
    assert.equal(mission.tasks.length, Math.min(taskCount, 50))
    assert.equal("objective" in mission.history[0], false)
    assert.equal(f.posts.length, 1); assert.deepEqual(f.errors, [])
    assert.ok(f.reads.some(read => read.pathname.endsWith("/content") && read.searchParams.get("kind") === "change"))
    assert.equal(f.reads.some(read => read.pathname.endsWith("/tasks")), false, "receipt reconciliation never loads missing task rows")
  } finally { await page.close() }
})

test("journal conflict reload prefills from descriptor-pinned content when the display map has no text", async () => {
  const page = await browser.newPage(), f = await setup(page)
  await page.route("**/api/workspaces/fixture/missions/msn_fixture", route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 409, json: { code: "revision-conflict" } }) : route.fallback())
  try {
    await page.evaluate(() => window.schedulingEditor.journal()); await ready(page)
    await form(page).getByLabel(objective, { exact: true }).fill("Keep this draft for comparison")
    await form(page).getByRole("button", { name: "Save", exact: true }).click()
    await form(page).getByRole("button", { name: "Reload current configuration", exact: true }).click()
    await ready(page)
    assert.equal(await form(page).getByLabel(objective, { exact: true }).inputValue(), "Stored instructions")
    await form(page).locator("summary").filter({ hasText: /^Previous draft for comparison$/ }).click()
    assert.match(await form(page).getByLabel("Previous draft for comparison", { exact: true }).inputValue(), /Keep this draft for comparison/)
    assert.ok(f.reads.some(read => read.pathname.endsWith("/content") && read.searchParams.get("field") === "objective"))
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("an ever-created task locks the template after retirement; incomplete native observation locks structural editing", async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    f.doc.everCreatedTask = true
    await page.evaluate(() => window.schedulingEditor.edit()); await ready(page); await options(page).click()
    assert.equal(await form(page).getByLabel("Playbook", { exact: true }).isDisabled(), true)
    assert.equal(await form(page).getByLabel("Title", { exact: true }).isDisabled(), false)
    assert.match(await form(page).innerText(), /including after tasks finish or are retired/)
    await form(page).getByRole("button", { name: "Cancel", exact: true }).click()
    f.doc.firstPlayedAt = Date.now(); f.doc.state = "running"
    f.doc.calendars.push({ role: "principal", slot: 0, timeGeneration: 1, sessionID: "ses_cn_schedule_fixture",
      scheduleID: "sch_fixture", highWater: 0, pendingWake: null, wakePreparing: null })
    await page.evaluate(() => window.schedulingEditor.edit())
    await form(page).getByRole("status").filter({ hasText: /Reconcile the original request/ }).first().waitFor()
    assert.equal(await form(page).getByLabel("Title", { exact: true }).isDisabled(), true)
    assert.equal(await form(page).getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("missing capability keeps immediate creation available and disables scheduled choices", async () => {
  const page = await browser.newPage(), f = await setup(page, false)
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Immediate remains available")
    await ready(page); await scheduling(page).click()
    assert.equal(await form(page).getByLabel("Frequency", { exact: true }).locator('option[value="daily"]').evaluate(option => (option as HTMLOptionElement).disabled), true)
    assert.equal(await form(page).getByLabel("Frequency", { exact: true }).locator('option[value="immediate"]').evaluate(option => (option as HTMLOptionElement).disabled), false)
    assert.match(await form(page).locator(".mission-scheduling").innerText(), /immediate, unconditional Mission remains available/)
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const kind of ["create", "edit"] as const) test(`${kind} rejects impossible cron and a calendar with no eligible slot, including after first Play`, async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    if (kind === "edit") { f.doc.firstPlayedAt = Date.now(); f.doc.state = "running" }
    await page.evaluate(kind => window.schedulingEditor[kind](), kind)
    if (kind === "create") await form(page).getByLabel(objective, { exact: true }).fill("Valid instructions")
    await ready(page); await scheduling(page).click()
    await form(page).getByLabel("Frequency", { exact: true }).selectOption("cron")
    await form(page).getByLabel("Cron expression", { exact: true }).fill("0 0 31 2 *")
    await form(page).getByRole("alert").waitFor()
    assert.equal(await form(page).locator('button[type="submit"]').isDisabled(), true)
    await form(page).getByLabel("Cron expression", { exact: true }).fill("0 9 * * *")
    await ready(page)
    await form(page).getByLabel("Last allowed slot", { exact: true }).fill("2020-01-01T00:00")
    await form(page).getByRole("alert").waitFor()
    assert.equal(await form(page).locator('button[type="submit"]').isDisabled(), true)
    await form(page).evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("the real editor selects all five explicit project sources, pages on demand and avoids rereading sources while typing", async () => {
  const page = await browser.newPage(), f = await setup(page)
  let schedulePages = 0
  await page.route("**/api/workspaces/fixture/missions/scheduled?*", route => {
    schedulePages++
    const more = new URL(route.request().url()).searchParams.get("after")
    return route.fulfill({ json: { version: 1, projectID: "project", ...(more ? {} : { next: "msn_after" }),
      schedules: more ? [{ ...missionScheduleView(f.doc).document, id: "msn_schedule", kind: "schedule" },
        { ...missionScheduleView(f.doc).document, id: "msn_once", kind: "one-time" }] : [] } })
  })
  await page.route("**/api/workspaces/fixture/worktrees", route => route.fulfill({ json: { worktrees: [{ branch: "dev" }] } }))
  await page.route("**/api/workspaces/fixture/git-branches?*", route => route.fulfill({ json: { branches: ["refs/heads/dev", "refs/heads/not-checked-out"] } }))
  await page.route("**/workspaces/fixture/instance/api/session**", route => route.fulfill({ json: {
    data: [{ id: "ses_reference", title: "Reference conversation" }], cursor: {} } }))
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Check explicit sources")
    await ready(page); await scheduling(page).click()
    const condition = form(page).getByLabel("Condition", { exact: true }), source = form(page).getByLabel("Source in this project", { exact: true })
    for (const [kind, id] of [["schedule-success", "msn_schedule"], ["mission-completed", "msn_once"],
      ["branch-commits", "refs/heads/not-checked-out"], ["conversation-message", "ses_reference"]]) {
      await condition.selectOption(kind)
      if (kind === "schedule-success" || kind === "mission-completed") {
        await form(page).getByRole("button", { name: "Load more sources", exact: true }).click()
      }
      await source.locator(`option[value="${id}"]`).waitFor({ state: "attached" })
      await source.selectOption(id); await ready(page)
    }
    assert.equal(schedulePages, 4, "each schedule source reads one page plus one explicit continuation")
    await condition.selectOption("files-changed")
    await form(page).getByLabel("Relative file paths (one per line)", { exact: true }).fill("src/input.ts")
    await ready(page)
    await form(page).getByLabel("Title", { exact: true }).fill("Typing does not refresh sources")
    await page.waitForTimeout(150)
    assert.equal(schedulePages, 4); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("late initial Edit reads cannot overwrite a newer Create draft after unmount", async () => {
  const page = await browser.newPage(), f = await setup(page)
  let release!: () => void, started!: () => void
  const pending = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { started = resolve })
  await page.route("**/api/workspaces/fixture/missions/msn_fixture/schedule*", async route => {
    started(); await pending
    try { await route.fulfill({ json: missionScheduleView(f.doc) }) } catch { /* disposed reader */ }
  })
  try {
    await page.evaluate(() => window.schedulingEditor.edit()); await reached
    assert.equal(await form(page).getByLabel("Title", { exact: true }).isDisabled(), true)
    await form(page).getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("New unsent draft")
    release(); await ready(page)
    assert.equal(await form(page).getByLabel(objective, { exact: true }).inputValue(), "New unsent draft")
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { release(); await page.close() }
})

test("remounting during the first document read still decodes the stored policy; unsupported roots stay read-only", async () => {
  const page = await browser.newPage(), f = await setup(page)
  let release!: () => void, started!: () => void
  const pending = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { started = resolve })
  await page.route("**/api/workspaces/fixture/missions/msn_fixture/schedule*", async route => {
    started(); await pending
    try { await route.fulfill({ json: missionScheduleView(f.doc) }) } catch { /* cancelled initial read */ }
  })
  try {
    await page.evaluate(() => window.schedulingEditor.edit()); await reached
    await page.evaluate(() => window.schedulingEditor.mount(false))
    await page.evaluate(() => window.schedulingEditor.mount(true))
    release(); await ready(page)
    await scheduling(page).click()
    assert.equal(await form(page).getByLabel("Frequency", { exact: true }).inputValue(), "cron")
    assert.equal(await form(page).getByLabel("Title", { exact: true }).inputValue(), "Stored title")
    await form(page).getByRole("button", { name: "Cancel", exact: true }).click()
    f.doc.configuration.roots.push({ mode: "directory-only", directory: "/another-root" })
    await page.evaluate(() => window.schedulingEditor.edit())
    await form(page).getByRole("status").filter({ hasText: /stored execution roots differ/ }).first().waitFor()
    assert.equal(await form(page).getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { release(); await page.close() }
})

for (const locale of ["fr", "he"]) test(`shared editor fits at 320px in ${locale} with native controls, scheduling and conditional preview`, async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 1000 }, timezoneId: "Europe/Paris" })
  const f = await setup(page, true, locale, "light")
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).locator("textarea").first().fill(locale === "fr" ? "Vérifier les sources du projet" : "בדיקת מקורות הפרויקט")
    await ready(page); await scheduling(page).click()
    await form(page).locator(".mission-scheduling select").first().selectOption("multi")
    await form(page).locator(".mission-scheduling button").first().click()
    await form(page).locator('input[type="time"]').nth(0).fill("09:15")
    await form(page).locator('input[type="time"]').nth(1).fill("17:45")
    await form(page).locator(".mission-scheduling select").nth(1).selectOption("files-changed")
    await form(page).locator(".mission-scheduling textarea").fill("src/input.ts")
    await ready(page)
    assert.equal(await form(page).locator(".mission-scheduling-preview li").count(), 5)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.evaluate(() => document.documentElement.dir), locale === "he" ? "rtl" : "ltr")
    await capture(page, `editor-create-${locale}-light.png`)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
