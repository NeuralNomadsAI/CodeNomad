import assert from "node:assert/strict"
import { openMissionProfiles } from "./mission-actions"
import { selectMissionSource } from "./mission-actions"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { installSourceScrollDelivery } from "./source-scroll-delivery"
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
const objective = "Objective"
async function createDocument() {
  const values = new Map<string, MissionJsonValue>()
  const store = new NativeMissionDocumentStore({ get: async key => values.get(key), compareAndSet: async (key, value) => { values.set(key, value) } }, "project", "/fixture")
  return store.create("msn_fixture", { title: "Stored title", objective: "Stored instructions", notes: "Stored notes", template: "custom", profiles,
    taskMode: "native", watchedConversationIDs: [], roots: [{ mode: "directory-only", directory: "/fixture" }], profileID: "profile", executionHost: "local",
    launch: { when: [{ kind: "cron", expression: "0 05 09 1,15 * *", zone: "Europe/Paris" }] } }, Date.now(), () => true)
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
  await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: {
    location: { directory: "/fixture" }, capability: null, effectiveDepth: null, project: null } }))
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
const scheduling = (page: Page) => form(page).locator("section.mission-scheduling")
const addCriterion = (page: Page) => form(page).getByRole("button", { name: "Add a criterion", exact: true }).click()
const ready = (page: Page) => page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
async function capture(page: Page, name: string) {
  const directory = process.env.CODENOMAD_MISSION_CAPTURE_DIR
  if (directory) { await mkdir(directory, { recursive: true }); await page.screenshot({ path: path.join(directory, name), fullPage: true }) }
}

test("shared Create stores a paused two-time policy with exact profiles and sends no Play", async () => {
  const page = await browser.newPage({ timezoneId: "Europe/Paris", viewport: { width: 620, height: 1100 } }), f = await setup(page)
  try {
    await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: {
      location: { directory: "/fixture" }, capability: { minimum: 0, maximum: 10 }, effectiveDepth: 3,
      project: { path: "/fixture/opencode.jsonc", depth: null, expectation: "fixture-depth" } } }))
    await page.route("**/workspaces/fixture/instance/api/{agent,model,provider}**", route => {
      const pathname = new URL(route.request().url()).pathname
      return route.fulfill({ json: { data: pathname.endsWith("/agent") ? [{ id: "coordinator", mode: "primary" }, { id: "specialist", mode: "subagent" }]
        : pathname.endsWith("/provider") ? [{ id: "p", name: "Fixture provider" }]
          : [{ providerID: "p", id: "m", name: "Project model", status: "active", enabled: true,
            capabilities: { tools: true }, cost: [], limit: { context: 1, output: 1 }, variants: [{ id: "precise" }, { id: "fast" }] }] } })
    })
    await page.waitForFunction(() => !!window.schedulingEditor)
    await page.evaluate(async () => {
      const instancesPath = "/src/stores/instances.ts", clientPath = "/src/stores/opencode-client.ts"
      const [{ updateInstance }, { getRootClient }] = await Promise.all([import(instancesPath), import(clientPath)])
      updateInstance("fixture", { client: getRootClient("fixture") })
    })
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Review project changes")
    await ready(page)
    assert.equal(await scheduling(page).locator("summary").count(), 0)
    assert.equal(await form(page).getByLabel("Criterion 1 type", { exact: true }).inputValue(), "now")
    const autostart = form(page).getByRole("checkbox", { name: "Start automatically", exact: true })
    assert.equal(await autostart.isChecked(), false)
    assert.equal(await scheduling(page).getByRole("checkbox").count(), 0, "autostart is outside Scheduling")
    await openMissionProfiles(page)
    await form(page).getByLabel("Coordinator · Model", { exact: true }).locator("option:checked").filter({ hasText: "Project model" }).waitFor({ state: "attached" })
    await form(page).getByLabel("Subagent depth", { exact: true }).locator('option[value="10"]').waitFor({ state: "attached" })
    await capture(page, "editor-compact-default.png")
    await form(page).getByLabel("Criterion 1 type", { exact: true }).selectOption("daily")
    await form(page).getByLabel("Criterion 1 time", { exact: true }).fill("09:15")
    await addCriterion(page)
    await form(page).getByLabel("Criterion 2 time", { exact: true }).fill("17:45")
    assert.equal(await scheduling(page).getByRole("group", { name: /^Criterion \d+$/ }).count(), 2)
    await capture(page, "editor-create-en-dark.png")
    await form(page).getByRole("button", { name: "Create", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.equal(f.posts.length, 1)
    assert.equal(f.posts[0].action, "create"); assert.equal(f.posts[0].expectedRevision, 0)
    assert.deepEqual(f.posts[0].configuration.profiles, profiles)
    assert.deepEqual(f.posts[0].configuration.launch, { when: [{ kind: "cron", expression: "15 9 * * *", zone: "Europe/Paris" },
      { kind: "cron", expression: "45 17 * * *", zone: "Europe/Paris" }] })
    assert.equal(f.doc.state, "paused"); assert.equal(f.doc.firstPlayedAt, null); assert.deepEqual(f.doc.calendars, [])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("source selection belongs to its criterion, loads in its popup and leaves no global conversation or paging controls", async () => {
  const page = await browser.newPage({ viewport: { width: 620, height: 1000 } }), f = await setup(page)
  const nativeReads: URL[] = []
  await page.route("**/workspaces/fixture/instance/api/session**", route => {
    const request = new URL(route.request().url()); nativeReads.push(request)
    return route.fulfill({ json: { data: request.searchParams.get("search") === "Later" || request.searchParams.has("cursor") ? [{ id: "ses_later", title: "Later conversation" }]
      : Array.from({ length: 200 }, (_, index) => ({ id: `ses_${index}`, title: `Conversation ${index}` })),
      cursor: request.searchParams.get("search") === "Later" || request.searchParams.has("cursor") ? {} : { next: "next_conversations" } } })
  })
  let sourcePages = 0
  await page.route("**/api/workspaces/fixture/missions/scheduled?*", route => {
    sourcePages++
    const after = new URL(route.request().url()).searchParams.get("after")
    return route.fulfill({ json: { version: 1, projectID: "project", ...(after ? {} : { next: "source_page_2" }),
      schedules: after ? [{ ...missionScheduleView(f.doc).document, id: "msn_source", kind: "one-time" }] : [] } })
  })
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("React to the selected source")
    await ready(page)
    const kind = form(page).getByLabel("Criterion 1 type", { exact: true })
    for (const value of ["daily", "hours", "weekly", "monthly", "cron"]) {
      await kind.selectOption(value)
      assert.equal(await form(page).locator(".mission-conversation-picker").count(), 0)
      assert.equal(await form(page).getByRole("button", { name: "Criterion 1 source", exact: true }).count(), 0)
    }
    await kind.selectOption("mission-completed")
    const source = form(page).getByRole("button", { name: "Criterion 1 source", exact: true })
    assert.equal(await source.evaluate(element => Boolean(element.closest('[role="group"][aria-label="Criterion 1"]'))), true)
    assert.equal(await form(page).getByRole("alert").count(), 0, "an empty new source is not a premature global error")
    assert.equal(await form(page).locator('button[type="submit"]').isDisabled(), true)
    assert.equal(await form(page).getByRole("button", { name: "Load more sources", exact: true }).count(), 0)
    await selectMissionSource(page, 1, "msn_source")
    await ready(page)
    assert.equal(sourcePages, 2, "the open picker follows its empty filtered page, not a global button")
    await kind.selectOption("conversation-message")
    assert.equal(await source.getAttribute("data-source-id"), "", "changing kind clears the previous criterion's source")
    await source.click()
    await page.getByRole("listbox").getByRole("option").first().waitFor()
    assert.ok(await page.getByRole("listbox").getByRole("option").count() < 40, "only the popup viewport is mounted")
    const before = nativeReads.length
    await page.evaluate(async () => {
      const { destroyOpenCodeData } = await import("/src/stores/opencode-data.ts")
      for (let index = 0; index < 5; index++) destroyOpenCodeData("fixture", `unrelated-${index}`)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(nativeReads.length, before, "unrelated transcript retirement never clears or reloads the choices")
    await page.getByRole("combobox", { name: "Search sources", exact: true }).fill("Later")
    await page.getByRole("option", { name: "Later conversation", exact: true }).click()
    assert.ok(nativeReads.some(request => request.searchParams.get("search") === "Later"), "conversation search stays native and project-scoped")
    assert.equal(nativeReads.some(request => request.searchParams.has("cursor")), false, "search never scans every conversation page")
    assert.equal(await source.getAttribute("data-source-id"), "ses_later")
    await kind.selectOption("daily")
    assert.equal(await source.count(), 0)
    assert.equal(await page.getByRole("listbox").count(), 0, "changing criterion disposes its popup and search state")
    assert.equal(await form(page).locator(".mission-conversation-picker").count(), 0)
    await kind.selectOption("conversation-message")
    assert.equal(await source.getAttribute("data-source-id"), "")
    await selectMissionSource(page, 1, "ses_1")
    await ready(page)
    await capture(page, "conversation-source-in-criterion.png")
    await form(page).getByRole("button", { name: "Create", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.deepEqual(f.posts[0].configuration.launch, { when: [{ kind: "conversation-message", conversationID: "ses_1" }] })
    assert.deepEqual(f.posts[0].configuration.watchedConversationIDs, [], "new-message context comes from the criterion, not an unrelated global source")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("conversation continuation and search failures retry their exact read inside the owning popup", async () => {
  const page = await browser.newPage(), f = await setup(page), reads: URL[] = []
  let pageFailed = true, searchFailed = true
  await page.route("**/workspaces/fixture/instance/api/session**", route => {
    const request = new URL(route.request().url()); reads.push(request)
    if (request.searchParams.has("cursor")) return pageFailed
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { data: [{ id: "ses_tail", title: "Last conversation" }], cursor: {} } })
    if (request.searchParams.get("search") === "Recover") return searchFailed
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { data: [{ id: "ses_recovered", title: "Recovered conversation" }], cursor: {} } })
    return route.fulfill({ json: { data: Array.from({ length: 200 }, (_, index) => ({ id: `ses_${index}`, title: `Conversation ${index}` })), cursor: { next: "opaque_tail" } } })
  })
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Recover only the source read")
    await ready(page)
    await form(page).getByLabel("Criterion 1 type", { exact: true }).selectOption("conversation-message")
    const source = form(page).getByRole("button", { name: "Criterion 1 source", exact: true })
    await source.click()
    await page.getByRole("listbox").getByRole("option").first().waitFor()
    await page.getByRole("listbox").evaluate(element => { element.scrollTop = element.scrollHeight })
    const popup = page.locator(".mission-source-popover"), retry = popup.getByRole("button", { name: "Try again", exact: true })
    await retry.waitFor()
    assert.equal(await popup.getByRole("alert").evaluate(element => {
      const shown = getComputedStyle(element).color
      element.style.color = "var(--status-error-fg)"
      const expected = getComputedStyle(element).color
      element.style.removeProperty("color")
      return shown === expected
    }), true, "the portalled read error uses the shared error ink in dark mode")
    assert.equal(await form(page).getByRole("alert").count(), 0, "read failure belongs to the popup")
    assert.ok(await page.getByRole("listbox").getByRole("option").count() > 0, "the loaded page survives a continuation failure")
    await capture(page, "source-continuation-failed.png")
    pageFailed = false
    await retry.click()
    await page.getByRole("option", { name: "Last conversation", exact: true }).click()
    assert.equal(await source.getAttribute("data-source-id"), "ses_tail")
    const continuations = reads.filter(request => request.searchParams.has("cursor"))
    assert.equal(continuations.length, 2)
    for (const request of continuations) assert.deepEqual([...request.searchParams], [["cursor", "opaque_tail"]])
    await source.click()
    await page.getByRole("combobox", { name: "Search sources", exact: true }).fill("Recover")
    await retry.waitFor()
    assert.match(await source.innerText(), /Last conversation/, "the chosen source stays named through search failure")
    await capture(page, "source-search-failed.png")
    searchFailed = false
    const search = page.getByRole("combobox", { name: "Search sources", exact: true })
    await search.press("Tab")
    assert.equal(await retry.evaluate(element => element === document.activeElement), true, "Retry is reachable without closing the popup")
    await retry.press("Shift+Tab")
    assert.equal(await search.evaluate(element => element === document.activeElement), true)
    await search.press("Tab"); await retry.press("Enter")
    await page.getByRole("option", { name: "Recovered conversation", exact: true }).click()
    assert.equal(reads.filter(request => request.searchParams.get("search") === "Recover").length, 2)
    await ready(page)
    await form(page).getByRole("button", { name: "Create", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.deepEqual(f.posts[0].configuration.launch, { when: [{ kind: "conversation-message", conversationID: "ses_recovered" }] })
    assert.deepEqual(f.errors, [])
  } catch (error) {
    console.error("Source recovery failure", reads.map(value => value.search), await page.locator(".mission-source-popover").innerText().catch(String),
      await page.locator(".mission-source-popover input").inputValue().catch(String), f.errors)
    throw error
  } finally { await page.close() }
})

test("two conversation criteria keep independent selections across native searches, card moves and remount", async () => {
  const page = await browser.newPage(), f = await setup(page)
  const sessions = [{ id: "ses_alpha", title: "Alpha saved source" }, { id: "ses_beta", title: "Beta saved source" }]
  await page.route("**/workspaces/fixture/instance/api/session**", route => {
    const request = new URL(route.request().url()), id = request.pathname.split("/").at(-1)
    const saved = sessions.find(row => row.id === id)
    return route.fulfill({ json: saved ? { data: { ...saved, projectID: "project", location: { directory: "/fixture" } } }
      : { data: sessions.filter(row => row.title.startsWith(request.searchParams.get("search") || "not on first page")), cursor: {} } })
  })
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Watch two independent conversations")
    await ready(page)
    const choose = async (number: number, query: string) => {
      await form(page).getByLabel(`Criterion ${number} type`, { exact: true }).selectOption("conversation-message")
      await form(page).getByRole("button", { name: `Criterion ${number} source`, exact: true }).click()
      await page.getByRole("combobox", { name: "Search sources", exact: true }).fill(query)
      await page.getByRole("option", { name: `${query} saved source`, exact: true }).click()
    }
    await choose(1, "Alpha")
    await addCriterion(page); await choose(2, "Beta"); await ready(page)
    const source = (number: number) => form(page).getByRole("button", { name: `Criterion ${number} source`, exact: true })
    assert.match(await source(1).innerText(), /Alpha saved source/)
    assert.match(await source(2).innerText(), /Beta saved source/)
    await source(1).click()
    await page.getByRole("combobox", { name: "Search sources", exact: true }).fill("Missing")
    await page.getByRole("status").filter({ hasText: "No results found" }).waitFor()
    assert.match(await source(2).innerText(), /Beta saved source/)
    await capture(page, "source-search-empty-two-criteria.png")
    await page.keyboard.press("Escape")
    await form(page).getByRole("button", { name: "Move criterion 2", exact: true }).focus()
    await page.keyboard.press("Alt+ArrowUp")
    await page.evaluate(() => window.schedulingEditor.mount(false))
    await page.evaluate(() => window.schedulingEditor.mount(true)); await ready(page)
    assert.equal(await source(1).getAttribute("data-source-id"), "ses_beta")
    assert.match(await source(1).innerText(), /Beta saved source/)
    assert.equal(await source(2).getAttribute("data-source-id"), "ses_alpha")
    assert.match(await source(2).innerText(), /Alpha saved source/)
    await form(page).getByRole("button", { name: "Create", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.deepEqual(f.posts[0].configuration.launch, { when: sessions.toReversed().map(row => ({ kind: "conversation-message", conversationID: row.id })) })
    assert.deepEqual(f.errors, [])
  } catch (error) {
    console.error("Two source failure", await page.locator(".mission-source-popover").innerText().catch(String),
      await page.locator(".mission-source-popover input").inputValue().catch(String), f.errors)
    throw error
  } finally { await page.close() }
})

test("late source replies stay fenced after a type change or inactive editor, which closes its popup", async () => {
  const page = await browser.newPage(), f = await setup(page)
  let release!: () => void, started!: () => void
  const pending = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { started = resolve })
  await page.route("**/workspaces/fixture/instance/api/session**", async route => {
    if (new URL(route.request().url()).searchParams.get("search") === "Late") { started(); await pending }
    try { await route.fulfill({ json: { data: [{ id: "ses_late", title: "Late conversation" }], cursor: {} } }) } catch { /* cancelled native search */ }
  })
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Keep the current criterion")
    await ready(page)
    const kind = form(page).getByLabel("Criterion 1 type", { exact: true })
    const source = form(page).getByRole("button", { name: "Criterion 1 source", exact: true })
    await kind.selectOption("conversation-message"); await source.click()
    await page.getByRole("combobox", { name: "Search sources", exact: true }).fill("Late"); await reached
    await page.evaluate(() => window.schedulingEditor.activate(false))
    await page.getByRole("listbox").waitFor({ state: "detached" })
    release()
    assert.equal(await source.isDisabled(), true)
    await page.evaluate(() => window.schedulingEditor.activate(true))
    await kind.selectOption("files-changed")
    await form(page).getByLabel("Criterion 1 file paths", { exact: true }).fill("src/kept.ts")
    await ready(page)
    assert.equal(await source.count(), 0)
    assert.equal(await page.locator(".mission-source-popover").count(), 0)
    await form(page).getByRole("button", { name: "Create", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.deepEqual(f.posts[0].configuration.launch, { when: [{ kind: "files-changed", paths: ["src/kept.ts"] }] })
    assert.deepEqual(f.errors, [])
  } finally { release(); await page.close() }
})

for (const [locale, width] of [["en", 620], ["fr", 320], ["he", 320]] as const) test(`the source popup fits ${locale} at ${width}px with long conversation names`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 1000 } }), f = await setup(page, true, locale, locale === "en" ? "dark" : "light")
  const title = locale === "fr" ? "Conversation de référence avec un titre très long pour vérifier le sélecteur dans un panneau étroit"
    : locale === "he" ? "שיחת מקור עם כותרת ארוכה במיוחד לבדיקת הבחירה בחלון צר ובכיוון מימין לשמאל" : "Reference conversation with a deliberately long title for the source selector"
  await page.route("**/workspaces/fixture/instance/api/session**", route => route.fulfill({ json: { data: [{ id: "ses_long", title }], cursor: {} } }))
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).locator("textarea").first().fill(title); await ready(page)
    await form(page).locator(".mission-criterion select").first().selectOption("conversation-message")
    const source = form(page).locator(".mission-source-select button")
    await source.click()
    await page.getByRole("listbox").getByRole("option").first().waitFor()
    const box = (await page.locator(".mission-source-popover").boundingBox())!
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1 && box.y >= -1 && box.y + box.height <= 1001, JSON.stringify(box))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await capture(page, `source-popup-${locale}-${width}.png`)
    await page.getByRole("option", { name: title, exact: true }).click(); await ready(page)
    assert.equal(await source.getAttribute("title"), title)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await capture(page, `source-selected-${locale}-${width}.png`)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("a stored off-page conversation resolves directly, rejects foreign metadata and retries only in its own picker", async () => {
  const page = await browser.newPage(), f = await setup(page)
  f.doc = { ...f.doc, configuration: { ...f.doc.configuration,
    launch: { when: [{ kind: "conversation-message", conversationID: "ses_far" }] } } }
  let pointReads = 0, foreign = true
  await page.route("**/workspaces/fixture/instance/api/session**", route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/ses_far")) {
      pointReads++
      return route.fulfill({ json: { data: { id: "ses_far", title: foreign ? "Foreign secret title" : "Saved conversation",
        projectID: foreign ? "other-project" : "project", location: { directory: "/fixture" } } } })
    }
    return route.fulfill({ json: { data: [{ id: "ses_first", title: "First conversation" }], cursor: { next: "later" } } })
  })
  try {
    await page.evaluate(() => window.schedulingEditor.edit())
    const source = form(page).getByRole("button", { name: "Criterion 1 source", exact: true })
    await source.filter({ hasText: "Unavailable source" }).waitFor()
    assert.equal(await form(page).getByText("Foreign secret title", { exact: true }).count(), 0)
    assert.equal(await form(page).locator('button[type="submit"]').isDisabled(), true)
    foreign = false
    await source.click()
    await page.locator(".mission-source-popover").getByRole("button", { name: "Try again", exact: true }).click()
    await source.filter({ hasText: "Saved conversation" }).waitFor()
    await ready(page)
    assert.equal(pointReads, 2, "resolve the selected ID rather than traversing every source page")
    await page.keyboard.press("Escape")
    await source.click()
    await page.getByRole("listbox").getByRole("option", { name: "Saved conversation", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await form(page).getByLabel("Notes", { exact: true }).fill("Keep the exact stored event")
    await form(page).getByRole("button", { name: "Save", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.deepEqual(f.posts[0].configuration.launch, f.doc.configuration.launch)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("a saved Mission source outside the first page resolves through its workspace-bound point read", async () => {
  const page = await browser.newPage(), f = await setup(page)
  f.doc = { ...f.doc, configuration: { ...f.doc.configuration,
    launch: { when: [{ kind: "mission-completed", missionID: "msn_far" }] } } }
  let points = 0, pages = 0
  await page.route("**/api/workspaces/fixture/missions/scheduled?*", route => {
    pages++
    return route.fulfill({ json: { version: 1, projectID: "project", schedules: [], next: "still_unread" } })
  })
  await page.route("**/api/workspaces/fixture/missions/msn_far/schedule*", route => {
    points++
    const result = missionScheduleView(f.doc)
    return route.fulfill({ json: { ...result, document: { ...result.document, id: "msn_far", kind: "one-time",
      configuration: { ...result.document!.configuration, title: "Saved Mission source" } } } })
  })
  try {
    await page.evaluate(() => window.schedulingEditor.edit()); await ready(page)
    assert.match(await form(page).getByRole("button", { name: "Criterion 1 source", exact: true }).innerText(), /Saved Mission source/)
    assert.equal(points, 1); assert.equal(pages, 1, "editing does not traverse unrelated source pages")
    assert.equal(await form(page).getByRole("alert").count(), 0)
    assert.deepEqual(f.posts, []); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("hovering visible source rows never scrolls them away and pointer clicks choose the pointed conversation", async () => {
  const page = await browser.newPage(), f = await setup(page)
  await page.route("**/workspaces/fixture/instance/api/session**", route => route.fulfill({ json: {
    data: Array.from({ length: 200 }, (_, index) => ({ id: `ses_${index}`, title: `Conversation ${index}` })), cursor: {} } }))
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Choose the conversation under the pointer")
    await ready(page)
    await form(page).getByLabel("Criterion 1 type", { exact: true }).selectOption("conversation-message")
    const source = form(page).getByRole("button", { name: "Criterion 1 source", exact: true })
    await source.click()
    const list = page.getByRole("listbox")
    await list.getByRole("option").first().waitFor()
    for (let pass = 0; pass < 2; pass++) {
      const before = await list.evaluate(element => element.scrollTop)
      const targets = await list.getByRole("option").evaluateAll(options => {
        const port = options[0].closest('[role="listbox"]')!.getBoundingClientRect()
        return options.flatMap(option => {
          const box = option.getBoundingClientRect()
          return box.top >= port.top && box.bottom <= port.bottom
            ? [{ id: option.getAttribute("data-source-id"), x: box.x + box.width / 2, y: box.y + box.height / 2 }] : []
        })
      })
      assert.ok(targets.length >= 3)
      const port = (await list.boundingBox())!
      await page.mouse.move(port.x + port.width / 2, port.y + port.height + 12, { steps: 5 })
      for (const target of targets) {
        await page.mouse.move(target.x, target.y, { steps: 80 })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert.equal(await list.evaluate(element => element.scrollTop), before, "pointer focus leaves visible rows in place")
      }
      if (pass === 0) { await page.mouse.wheel(0, 900); await page.waitForFunction(() => document.querySelector('[role="listbox"]')!.scrollTop > 500); continue }
      const target = targets[Math.floor(targets.length / 2)]
      await page.mouse.move(target.x, target.y, { steps: 5 })
      await page.mouse.down(); await page.mouse.up()
      assert.equal(await source.getAttribute("data-source-id"), target.id)
    }
    assert.equal(f.posts.length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("conversation search ignores accented case without dropping uppercase-accent titles", async () => {
  const page = await browser.newPage(), f = await setup(page)
  const sessions = ["Écouter les résultats", "écouter les résultats", "ÉCOUTER LES RÉSULTATS", "Vérifier les résultats", "VÉRIFIER LES RÉSULTATS", "Keyboard", "İstanbul"]
    .map((title, index) => ({ id: `ses_case_${index}`, title }))
  const asciiLower = (text: string) => text.replace(/[A-Z]/g, letter => letter.toLowerCase())
  await page.route("**/workspaces/fixture/instance/api/session**", route => {
    const search = new URL(route.request().url()).searchParams.get("search") ?? ""
    return route.fulfill({ json: { data: sessions.filter(row => asciiLower(row.title).includes(asciiLower(search))), cursor: {} } })
  })
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Find accented conversation titles regardless of case")
    await ready(page)
    await form(page).getByLabel("Criterion 1 type", { exact: true }).selectOption("conversation-message")
    const source = form(page).getByRole("button", { name: "Criterion 1 source", exact: true })
    await source.click()
    await page.getByRole("listbox").getByRole("option").first().waitFor()
    const search = page.getByRole("combobox", { name: "Search sources", exact: true })
    for (const [query, candidate, count] of [["écouter", "couter", 3], ["ÉCOUTER", "COUTER", 3], ["éCoUtEr", "CoUtEr", 3],
      ["keyboard", "eyboard", 1], ["KEYBOARD", "EYBOARD", 1], ["i", null, 3], ["i\u0307", null, 1],
      ["VÉRIFIER", "RIFIER", 2], ["vérifier", "rifier", 2]] as const) {
      const read = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/session")
        && new URL(response.url()).searchParams.get("search") === candidate)
      await search.fill(query); await read
      await page.waitForFunction(count => document.querySelectorAll('.mission-source-popover [role="option"]').length === count, count)
      const titles = await page.getByRole("listbox").getByRole("option").allTextContents()
      assert.ok(titles.every(title => title.toLowerCase().includes(query.toLowerCase())), JSON.stringify({ query, titles }))
      assert.equal(await search.inputValue(), query)
    }
    await page.getByRole("option", { name: "VÉRIFIER LES RÉSULTATS", exact: true }).click()
    assert.equal(await source.getAttribute("data-source-id"), "ses_case_4")
    assert.deepEqual(f.posts, []); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const firstMatch of [false, true]) test(`filtered search pages require explicit continuation even with a retained match (${firstMatch})`, async () => {
  const page = await browser.newPage(), f = await setup(page), reads: URL[] = []
  await page.route("**/workspaces/fixture/instance/api/session**", route => {
    const request = new URL(route.request().url()); reads.push(request)
    const cursor = request.searchParams.get("cursor")
    const rows = cursor === "page_4" ? [{ id: "ses_greek", title: "Δοκιμή δεύτερη" }]
      : Array.from({ length: 200 }, (_, index) => ({ id: `ses_${cursor ?? "first"}_${index}`, title: `Conversation ${index}` }))
    if (!cursor && firstMatch) rows[199] = { id: "ses_greek_first", title: "Δοκιμή πρώτη" }
    return route.fulfill({ json: { data: rows, cursor: cursor === "page_4" ? {}
      : { next: !cursor ? "page_2" : cursor === "page_2" ? "page_3" : "page_4" } } })
  })
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Keep Unicode search reads bounded")
    await ready(page)
    await form(page).getByLabel("Criterion 1 type", { exact: true }).selectOption("conversation-message")
    const source = form(page).getByRole("button", { name: "Criterion 1 source", exact: true })
    await source.click()
    await page.getByRole("listbox").getByRole("option").first().waitFor()
    const read = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/session"))
    const search = page.getByRole("combobox", { name: "Search sources", exact: true })
    await search.fill("ΔΟΚΙΜΉ"); await read
    const more = page.locator(".mission-source-popover").getByRole("button", { name: "Load more sources", exact: true })
    await more.waitFor()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(reads.length, 2, "a short filtered page never automatically drains the catalogue")
    assert.ok(reads.every(request => !request.searchParams.has("search")), "case-sensitive native filtering cannot omit the requested Greek title")
    await search.press("Tab")
    assert.equal(await more.evaluate(element => element === document.activeElement), true)
    for (const cursor of ["page_2", "page_3", "page_4"]) {
      const read = page.waitForResponse(response => new URL(response.url()).searchParams.get("cursor") === cursor)
      await more.press("Enter"); await read
      await page.waitForFunction(() => document.querySelector('.mission-source-popover [role="listbox"]')?.getAttribute("aria-busy") !== "true")
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(reads.length, Number(cursor.slice(-1)) + 1, "nonmatching pages keep the earlier match without automatically continuing")
      if (cursor !== "page_4") { await search.press("Tab"); assert.equal(await more.evaluate(element => element === document.activeElement), true) }
    }
    await page.getByRole("option", { name: "Δοκιμή δεύτερη", exact: true }).click()
    assert.equal(await source.getAttribute("data-source-id"), "ses_greek")
    assert.equal(reads.length, 5)
    assert.deepEqual(reads.slice(2).map(request => request.searchParams.get("cursor")), ["page_2", "page_3", "page_4"])
    assert.deepEqual(f.posts, []); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const held of [false, true]) test(`source keyboard navigation scrolls the real popup and selecting with Enter never submits the form (held scroll: ${held})`, async t => {
  const page = await browser.newPage(), consoleErrors: string[] = [], failed: string[] = [], posts: string[] = []
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()) })
  page.on("requestfailed", request => failed.push(`${request.url()}: ${request.failure()?.errorText}`))
  page.on("request", request => { if (request.method() === "POST") posts.push(request.url()) })
  if (held) await installSourceScrollDelivery(page)
  const f = await setup(page)
  let nativeReads = 0
  await page.route("**/workspaces/fixture/instance/api/session**", route => {
    nativeReads++
    return route.fulfill({ json: {
      data: Array.from({ length: 200 }, (_, index) => ({ id: `ses_${index}`, title: `Conversation ${index}` })), cursor: {} } })
  })
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Handle new messages")
    await ready(page)
    await form(page).getByLabel("Criterion 1 type", { exact: true }).selectOption("conversation-message")
    await form(page).getByRole("button", { name: "Criterion 1 source", exact: true }).click()
    await page.getByRole("listbox").getByRole("option").first().waitFor()
    const search = page.getByRole("combobox", { name: "Search sources", exact: true })
    await search.focus()
    const beforeReads = nativeReads
    await form(page).evaluate(element => {
      Object.assign(window, { sourceSubmitCount: 0 })
      element.addEventListener("submit", () => { (window as any).sourceSubmitCount++ })
    })
    assert.deepEqual(f.errors, [])
    if (held) await page.evaluate(() => window.sourceScrollDelivery.arm())
    for (let index = 0; index < 24; index++) await page.keyboard.press("ArrowDown")
    if (held) {
      const released = await page.evaluate(() => window.sourceScrollDelivery.release())
      assert.ok(released.retained > 0); assert.equal(released.pending, 0)
    }
    let geometryError: unknown
    try { await page.waitForFunction(() => {
      const field = document.querySelector<HTMLInputElement>('.mission-source-popover input[role="combobox"]')!
      const option = document.getElementById(field.getAttribute("aria-activedescendant") ?? ""), list = document.querySelector('.mission-source-popover [role="listbox"]')!
      if (!option) return false
      const box = option.getBoundingClientRect(), port = list.getBoundingClientRect()
      return list.scrollTop > 0 && box.top >= port.top - 1 && box.bottom <= port.bottom + 1
    }) } catch (error) { geometryError = error }
    const snapshot = await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>('.mission-source-popover input[role="combobox"]')!
      const list = document.querySelector('.mission-source-popover [role="listbox"]')!
      const focused = list.querySelector<HTMLElement>('[data-highlighted]')
      const box = focused?.getBoundingClientRect(), port = list.getBoundingClientRect()
      return { aria: field.getAttribute("aria-activedescendant"), focusedKey: focused?.getAttribute("data-key"),
        actualID: focused?.id, connected: focused?.isConnected, visible: Boolean(box && box.top >= port.top - 1 && box.bottom <= port.bottom + 1),
        scrollTop: list.scrollTop, selected: list.querySelectorAll('[aria-selected="true"]').length,
        focus: document.activeElement === field, barrier: window.sourceScrollDelivery?.state() }
    })
    t.diagnostic(JSON.stringify(snapshot))
    assert.equal(snapshot.focusedKey, "ses_23"); assert.equal(snapshot.selected, 0); assert.equal(snapshot.focus, true)
    assert.equal(nativeReads, beforeReads)
    if (geometryError) {
      // Preserve the original oracle failure after observing the same single Enter.
      await page.keyboard.press("Enter")
      assert.equal(await form(page).getByRole("button", { name: "Criterion 1 source", exact: true }).getAttribute("data-source-id"), snapshot.focusedKey)
      assert.equal((await page.evaluate(() => (window as any).sourceSubmitCount)), 0)
      assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
      assert.deepEqual(posts, [])
      assert.deepEqual(consoleErrors, []); assert.deepEqual(failed, [])
      throw geometryError
    }
    assert.equal(snapshot.aria, snapshot.actualID)
    assert.deepEqual(await page.locator('.mission-source-select input[role="combobox"], .mission-source-popover input[role="combobox"]').evaluateAll(fields => fields.map(field => field.getAttribute("aria-activedescendant"))), [snapshot.actualID, snapshot.actualID])
    const id = await search.evaluate(field => document.getElementById(field.getAttribute("aria-activedescendant")!)!.getAttribute("data-source-id"))
    await page.keyboard.press("Enter")
    assert.equal(await form(page).getByRole("button", { name: "Criterion 1 source", exact: true }).getAttribute("data-source-id"), id)
    assert.equal(f.posts.length, 0)
    assert.equal((await page.evaluate(() => (window as any).sourceSubmitCount)), 0)
    assert.equal(nativeReads, beforeReads)
    assert.equal(await page.getByRole("listbox").count(), 0)
    assert.deepEqual(f.errors, [])
    assert.deepEqual(consoleErrors, []); assert.deepEqual(failed, [])
    assert.deepEqual(posts, [])
    assert.equal(await form(page).locator('.mission-source-select input').getAttribute("aria-activedescendant"), null)
  } finally { try { if (held) await page.evaluate(() => window.sourceScrollDelivery?.dispose()) } finally { await page.close() } }
})

test("source descendants follow mounted option identities across range, filter, close and criterion lifetimes", async () => {
  const page = await browser.newPage(), f = await setup(page)
  await page.route("**/workspaces/fixture/instance/api/session**", route => route.fulfill({ json: {
    data: Array.from({ length: 200 }, (_, index) => ({ id: `ses_${index}`, title: `Conversation ${index}` })), cursor: {} } }))
  const source = (number: number) => form(page).getByRole("button", { name: `Criterion ${number} source`, exact: true })
  const hidden = (number: number) => form(page).getByRole("group", { name: `Criterion ${number}`, exact: true }).locator('.mission-source-select input')
  const search = page.getByRole("combobox", { name: "Search sources", exact: true })
  const descendants = async (number: number) => {
    const id = await search.getAttribute("aria-activedescendant")
    assert.ok(id)
    assert.equal(await hidden(number).getAttribute("aria-activedescendant"), id)
    const option = page.locator(`[id="${id}"]`)
    assert.equal(await option.getAttribute("data-key"), "ses_0")
    assert.ok((await option.getAttribute("aria-labelledby"))?.startsWith(`${id}-`), "ItemLabel shares the supplied actual option ID")
    assert.equal(await source(number).getAttribute("data-source-id"), "", "focus never commits selection")
    return id
  }
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Keep source option lifetimes isolated"); await ready(page)
    await form(page).getByLabel("Criterion 1 type", { exact: true }).selectOption("conversation-message")
    await addCriterion(page)
    await form(page).getByLabel("Criterion 2 type", { exact: true }).selectOption("conversation-message")
    assert.equal(await hidden(1).getAttribute("aria-activedescendant"), null)
    assert.equal(await hidden(2).getAttribute("aria-activedescendant"), null)
    await source(1).click(); await page.getByRole("listbox").getByRole("option").first().waitFor(); await search.press("ArrowDown")
    const original = await descendants(1)
    await page.getByRole("listbox").evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.locator(`[id="${original}"]`).waitFor({ state: "detached" })
    assert.equal(await search.getAttribute("aria-activedescendant"), null)
    assert.equal(await hidden(1).getAttribute("aria-activedescendant"), null)
    await page.getByRole("listbox").evaluate(element => { element.scrollTop = 0 })
    await page.waitForFunction(() => !!document.querySelector('.mission-source-popover input')?.getAttribute("aria-activedescendant"))
    const remounted = await descendants(1)
    assert.notEqual(remounted, original, "the same focused key gets the remount's actual ID")
    await search.fill("Missing source")
    await page.getByRole("status").filter({ hasText: "No results found" }).waitFor()
    assert.equal(await search.getAttribute("aria-activedescendant"), null)
    assert.equal(await hidden(1).getAttribute("aria-activedescendant"), null)
    await search.fill(""); await page.getByRole("listbox").getByRole("option").first().waitFor(); await search.press("ArrowDown")
    const filtered = await descendants(1)
    assert.notEqual(filtered, remounted)
    await search.press("Escape"); await page.getByRole("listbox").waitFor({ state: "detached" })
    assert.equal(await hidden(1).getAttribute("aria-activedescendant"), null)
    await source(1).click(); await page.getByRole("listbox").getByRole("option").first().waitFor(); await search.press("ArrowDown")
    const reopened = await descendants(1)
    assert.notEqual(reopened, filtered)
    await search.press("Escape"); await source(2).click(); await page.getByRole("listbox").getByRole("option").first().waitFor(); await search.press("ArrowDown")
    const second = await descendants(2)
    assert.notEqual(second, reopened)
    assert.equal(await hidden(1).getAttribute("aria-activedescendant"), null)
    await form(page).getByLabel("Criterion 2 type", { exact: true }).selectOption("daily")
    await page.getByRole("listbox").waitFor({ state: "detached" })
    assert.equal(await page.locator(`[id="${second}"]`).count(), 0)
    await form(page).getByLabel("Criterion 2 type", { exact: true }).selectOption("conversation-message")
    await source(2).click(); await page.getByRole("listbox").getByRole("option").first().waitFor(); await search.press("ArrowDown")
    assert.notEqual(await descendants(2), second)
    await page.evaluate(() => window.schedulingEditor.activate(false))
    await page.getByRole("listbox").waitFor({ state: "detached" })
    assert.equal(await hidden(2).getAttribute("aria-activedescendant"), null)
    assert.deepEqual(f.posts, []); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("editing instructions preserves stored context IDs without offering an unrelated global conversation control", async () => {
  const page = await browser.newPage(), f = await setup(page)
  f.doc = { ...f.doc, configuration: { ...f.doc.configuration, watchedConversationIDs: ["ses_recorded"] } }
  await page.route("**/workspaces/fixture/instance/api/location**", route => route.fulfill({ json: { directory: "/fixture", project: { id: "project" } } }))
  try {
    await page.evaluate(() => window.schedulingEditor.edit()); await ready(page)
    assert.equal(await form(page).locator(".mission-conversation-picker").count(), 0)
    await form(page).getByLabel("Notes", { exact: true }).fill("Keep stored sources intact")
    await form(page).getByRole("button", { name: "Save", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.deepEqual(f.posts[0].configuration.watchedConversationIDs, ["ses_recorded"])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("shared Edit loads all preparation fields and preserves the exact stored criterion and the card order across remount", async () => {
  const page = await browser.newPage(), f = await setup(page), stored = structuredClone(f.doc.configuration.launch)
  try {
    await page.evaluate(() => window.schedulingEditor.edit()); await ready(page)
    assert.equal(await form(page).getByLabel("Title", { exact: true }).inputValue(), "Stored title")
    assert.equal(await form(page).getByLabel("Criterion 1 type", { exact: true }).inputValue(), "cron")
    await addCriterion(page)
    await form(page).getByLabel("Criterion 2 type", { exact: true }).selectOption("files-changed")
    await form(page).getByLabel("Criterion 2 file paths", { exact: true }).fill("src/a.ts")
    await form(page).getByRole("button", { name: "Move criterion 2", exact: true }).focus(); await page.keyboard.press("Alt+ArrowUp")
    await page.evaluate(() => window.schedulingEditor.mount(false))
    await page.evaluate(() => window.schedulingEditor.mount(true)); await ready(page)
    assert.equal(await form(page).getByLabel("Criterion 1 file paths", { exact: true }).inputValue(), "src/a.ts")
    assert.equal(await form(page).getByLabel("Criterion 2 type", { exact: true }).inputValue(), "cron")
    assert.equal(await form(page).getByLabel("Playbook", { exact: true }).isDisabled(), false)
    await form(page).getByLabel("Notes", { exact: true }).fill("Future instructions only")
    await form(page).getByLabel("Title", { exact: true }).fill("Updated title")
    await capture(page, "editor-edit-en-dark.png")
    await form(page).getByRole("button", { name: "Save", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0].action, "configure")
    assert.deepEqual(f.posts[0].configuration.launch, { when: [{ kind: "files-changed", paths: ["src/a.ts"] }, ...(stored as { when: unknown[] }).when] })
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
      await form(page).getByLabel("Criterion 1 type", { exact: true }).selectOption("daily")
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
    await form(page).getByRole("button", { name: "Refresh saved request", exact: true }).and(page.locator(":enabled")).waitFor()
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
    await page.evaluate(() => window.schedulingEditor.edit()); await ready(page)
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

test("missing capability keeps criterion-free creation available and disables adding criteria", async () => {
  const page = await browser.newPage(), f = await setup(page, false)
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Immediate remains available")
    await ready(page)
    assert.equal(await form(page).getByRole("button", { name: "Add a criterion", exact: true }).isDisabled(), true)
    assert.equal(await form(page).locator('button[type="submit"]').isDisabled(), false)
    assert.match(await form(page).locator(".mission-scheduling").innerText(), /Scheduling is unavailable on this connection/)
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const kind of ["create", "edit"] as const) test(`${kind} rejects impossible cron and a calendar with no eligible slot, including after first Play`, async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    if (kind === "edit") { f.doc.firstPlayedAt = Date.now(); f.doc.state = "running" }
    await page.evaluate(kind => window.schedulingEditor[kind](), kind)
    if (kind === "create") await form(page).getByLabel(objective, { exact: true }).fill("Valid instructions")
    await ready(page)
    await form(page).getByLabel("Criterion 1 type", { exact: true }).selectOption("cron")
    await form(page).getByLabel("Criterion 1 cron expression", { exact: true }).fill("0 0 31 2 *")
    await form(page).getByRole("alert").waitFor()
    assert.equal(await form(page).locator('button[type="submit"]').isDisabled(), true)
    await form(page).getByLabel("Criterion 1 cron expression", { exact: true }).fill("0 9 * * *")
    await ready(page)
    await form(page).getByLabel("Criterion 1 cron expression", { exact: true }).fill("0 9 30 2 *")
    await form(page).getByRole("alert").filter({ hasText: "This calendar has no future slot." }).waitFor()
    assert.equal(await form(page).locator('button[type="submit"]').isDisabled(), true)
    await form(page).evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("the real editor selects all five explicit project sources in their own pickers and avoids rereading sources while typing", async () => {
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
    await ready(page)
    const condition = form(page).getByLabel("Criterion 1 type", { exact: true })
    for (const [kind, id] of [["schedule-success", "msn_schedule"], ["mission-completed", "msn_once"],
      ["branch-commits", "refs/heads/not-checked-out"], ["conversation-message", "ses_reference"]]) {
      await condition.selectOption(kind)
      await selectMissionSource(page, 1, id); await ready(page)
    }
    assert.equal(schedulePages, 4, "each open schedule source picker follows its own continuation")
    await condition.selectOption("files-changed")
    await form(page).getByLabel("Criterion 1 file paths", { exact: true }).fill("src/input.ts")
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
    assert.equal(await form(page).getByLabel("Criterion 1 type", { exact: true }).inputValue(), "cron")
    assert.equal(await form(page).getByLabel("Title", { exact: true }).inputValue(), "Stored title")
    await form(page).getByRole("button", { name: "Cancel", exact: true }).click()
    f.doc.configuration.roots.push({ mode: "directory-only", directory: "/another-root" })
    await page.evaluate(() => window.schedulingEditor.edit())
    await form(page).getByRole("status").filter({ hasText: /stored execution roots differ/ }).first().waitFor()
    assert.equal(await form(page).getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { release(); await page.close() }
})

for (const locale of ["fr", "he"]) test(`shared editor fits at 320px in ${locale} with native controls, scheduling and role labels`, async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 1000 }, timezoneId: "Europe/Paris" })
  const f = await setup(page, true, locale, "light")
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).locator("textarea").first().fill(locale === "fr" ? "Vérifier les sources du projet" : "בדיקת מקורות הפרויקט")
    await ready(page)
    await form(page).locator(".mission-criterion select").first().selectOption("daily")
    await form(page).locator('input[type="time"]').nth(0).fill("09:15")
    await form(page).locator(".mission-scheduling-add").click()
    await form(page).locator(".mission-criterion select").nth(1).selectOption("files-changed")
    await form(page).locator(".mission-scheduling textarea").fill("src/input.ts")
    await ready(page)
    assert.deepEqual(await form(page).locator(".mission-criterion-connector").allInnerTexts(), [locale === "fr" ? "si" : "אם"])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.evaluate(() => document.documentElement.dir), locale === "he" ? "rtl" : "ltr")
    await capture(page, `editor-create-${locale}-light.png`)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

const branches = (page: Page) => page.route("**/api/workspaces/fixture/git-branches?*", route => route.fulfill({ json: { branches: ["refs/heads/main", "refs/heads/dev"] } }))
test("launch criteria journey: an event, a schedule, else, if, or, the approved chain and a drag", async () => {
  const page = await browser.newPage({ timezoneId: "Europe/Paris", viewport: { width: 620, height: 1400 } }), f = await setup(page)
  await branches(page)
  await page.route("**/workspaces/fixture/instance/api/session**", route => route.fulfill({ json: { data: [{ id: "ses_reference", title: "Reference conversation" }], cursor: {} } }))
  const connectors = () => form(page).locator(".mission-criterion-connector").allInnerTexts()
  const type = (number: number) => form(page).getByLabel(`Criterion ${number} type`, { exact: true })
  const choose = async (number: number, kind: string, id: string) => {
    await type(number).selectOption(kind)
    await selectMissionSource(page, number, id)
  }
  const time = (number: number, value: string) => form(page).getByLabel(`Criterion ${number} time`, { exact: true }).fill(value)
  const shot = async (name: string) => { await ready(page); await page.mouse.move(0, 0); await capture(page, name) }
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Review the latest changes on main and report risks")
    await ready(page)
    await capture(page, "00-empty-form.png")
    await type(1).selectOption("daily"); await time(1, "18:00")
    assert.deepEqual(await connectors(), [])
    await shot("02-schedule-only.png")
    await choose(1, "branch-commits", "refs/heads/main")
    assert.equal(await form(page).getByRole("button", { name: "Move criterion 1", exact: true }).isDisabled(), true)
    await shot("01-event-only.png")
    await addCriterion(page); await time(2, "18:00")
    assert.deepEqual(await connectors(), ["else"], "commits, else 18:00")
    await shot("03-commits-else-18h.png")
    // A real pointer drag of 18:00 above the commits card; the connector follows the projected order.
    const grip = (await form(page).getByRole("button", { name: "Move criterion 2", exact: true }).boundingBox())!
    const target = (await form(page).getByRole("group", { name: "Criterion 1", exact: true }).boundingBox())!
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down()
    for (let step = 1; step <= 12; step++) await page.mouse.move(grip.x + grip.width / 2, grip.y + (target.y + target.height * 0.25 - grip.y) * step / 12)
    await form(page).locator(".mission-criterion-drop").waitFor()
    assert.deepEqual(await connectors(), ["if"], "while dragging, commits already reads as the condition of 18:00")
    await capture(page, "07-dragging.png")
    await page.mouse.up()
    assert.equal(await type(1).inputValue(), "daily")
    assert.deepEqual(await connectors(), ["if"], "18:00 if commits")
    await shot("04-18h-if-commits.png")
    await form(page).getByRole("button", { name: "Remove criterion 1", exact: true }).click()
    await addCriterion(page); await type(2).selectOption("files-changed")
    await form(page).getByLabel("Criterion 2 file paths", { exact: true }).fill("package.json")
    assert.deepEqual(await connectors(), ["or"], "commits or files")
    await shot("05-two-events-or.png")
    // The approved chain: commits, else 18:00 if new messages, else 20:00.
    await type(2).selectOption("daily"); await time(2, "18:00")
    await addCriterion(page); await choose(3, "conversation-message", "ses_reference")
    await addCriterion(page); await time(4, "20:00")
    assert.deepEqual(await connectors(), ["else", "if", "else"])
    await shot("06-approved-chain.png")
    await form(page).getByRole("button", { name: "Create", exact: true }).click()
    await form(page).waitFor({ state: "detached" })
    assert.deepEqual(f.posts[0].configuration.launch, { when: [{ kind: "branch-commits", directory: "/fixture", ref: "refs/heads/main" },
      { kind: "cron", expression: "0 18 * * *", zone: "Europe/Paris" }, { kind: "conversation-message", conversationID: "ses_reference" },
      { kind: "cron", expression: "0 20 * * *", zone: "Europe/Paris" }] })
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("two schedules, then two events: both times launch only if one of the events changed (or, if, or)", async () => {
  const page = await browser.newPage({ timezoneId: "Europe/Paris", viewport: { width: 620, height: 1100 } }), f = await setup(page)
  await branches(page)
  const type = (number: number) => form(page).getByLabel(`Criterion ${number} type`, { exact: true })
  const time = (number: number, value: string) => form(page).getByLabel(`Criterion ${number} time`, { exact: true }).fill(value)
  try {
    await page.evaluate(() => window.schedulingEditor.create())
    await form(page).getByLabel(objective, { exact: true }).fill("Review the latest changes on main and report risks")
    await ready(page)
    await type(1).selectOption("daily"); await time(1, "09:00")
    await addCriterion(page); await time(2, "18:00")
    await addCriterion(page); await type(3).selectOption("branch-commits")
    await selectMissionSource(page, 3, "refs/heads/main")
    await addCriterion(page); await type(4).selectOption("files-changed")
    await form(page).getByLabel("Criterion 4 file paths", { exact: true }).fill("package.json")
    assert.deepEqual(await form(page).locator(".mission-criterion-connector").allInnerTexts(), ["or", "if", "or"])
    await ready(page); await page.mouse.move(0, 0); await capture(page, "06b-schedules-if-events.png")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const locale of ["en", "fr"]) test(`a stored legacy frequency with a condition reopens as schedule cards, then the event as a condition (${locale})`, async () => {
  const page = await browser.newPage({ timezoneId: "Europe/Paris", viewport: { width: 620, height: 1300 } }), f = await setup(page, true, locale)
  await branches(page)
  try {
    f.doc = { ...f.doc, configuration: { ...f.doc.configuration, launch: { timing: { kind: "multi", calendars: [
      { expression: "0 9 * * *", zone: "Europe/Paris" }, { expression: "0 18 * * *", zone: "Europe/Paris" }] },
      condition: { kind: "branch-commits", directory: "/fixture", ref: "refs/heads/main" }, ends: { maxLaunches: null, afterMs: null, at: null } } } }
    const stored = structuredClone(f.doc.configuration.launch)
    await page.evaluate(() => window.schedulingEditor.edit()); await ready(page)
    const section = form(page).locator(".mission-scheduling")
    assert.equal(await section.getByRole("group", { name: /^(Criterion \d+|Critère \d+)$/ }).first().isVisible(), true, "the reopened criteria are shown")
    const label = (en: string, fr: string) => form(page).getByLabel(locale === "fr" ? fr : en, { exact: true })
    assert.equal(await label("Criterion 1 type", "Type du critère 1").inputValue(), "daily")
    assert.equal(await label("Criterion 2 time", "Heure du critère 2").inputValue(), "18:00")
    assert.equal(await label("Criterion 3 source", "Source du critère 3").getAttribute("data-source-id"), "refs/heads/main")
    assert.deepEqual(await form(page).locator(".mission-criterion-connector").allInnerTexts(), locale === "fr" ? ["ou", "si"] : ["or", "if"],
      "the schedules come first and the condition after them")
    await capture(page, locale === "fr" ? "09-legacy-reopened-fr.png" : "08-legacy-reopened-en.png")
    await form(page).locator('button[type="submit"]').click()
    await form(page).waitFor({ state: "detached" })
    assert.deepEqual(f.posts[0].configuration.launch, stored, "an unchanged reopen saves the stored legacy policy unchanged")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
