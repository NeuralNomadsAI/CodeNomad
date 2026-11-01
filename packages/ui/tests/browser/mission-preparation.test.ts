import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { preparationFixture, scheduledPreparation, followedPreparationFixture } from "../../../server/src/missions/mission-preparation-test-fixture"
import { ownerFixture } from "../../../server/src/opencode/missions/native-schedule-owner-test-fixture"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import type {} from "./fixtures/mission-editor-scheduling"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "mission-editor-scheduling", routes: [{ path: "/editor",
    html: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-scheduling.tsx"></script></body></html>' }] })
  url = fixture.url; events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined }); armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })
async function setup(page: Page, lose = false, calendar?: Awaited<ReturnType<typeof ownerFixture>>) {
  const directory = calendar?.directory ?? "/fixture"
  const f = await followedPreparationFixture(directory), writes: Record<string, any>[] = [], errors: string[] = []
  if (calendar) await f.control.configurePreparation({ ...f.request, requestID: "seed_profiles", configuration: { ...scheduledPreparation(f), launch: f.original.configuration.launch } }, f.native, () => true)
  const owner = calendar?.makeOwner(f.store)
  page.on("pageerror", error => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await events.route(page)
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { locale: "en" } } }))
  await page.route("**/workspaces/fixture/instance/api/agent**", route => route.fulfill({ json: { data: [{ id: "coordinator", mode: "all" }] } }))
  await page.route("**/workspaces/fixture/instance/api/model**", route => route.fulfill({ json: { data: [
    { providerID: "p", id: "m", name: "Model M", status: "active", cost: [], limit: { context: 1, output: 1 },
      enabled: true, capabilities: { tools: true }, variants: [{ id: "precise" }] }] } }))
  await page.route("**/workspaces/fixture/instance/api/provider**", route => route.fulfill({ json: { data: [{ id: "p", name: "Provider P" }] } }))
  await page.route("**/api/workspaces/fixture/missions**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (pathname.endsWith("/capabilities")) return route.fulfill({ json: { location: { directory },
      api: { available: !!calendar }, enabled: !!calendar, activation: { available: false, reason: "missing-api", targets: [] } } })
    if (request.method() !== "GET") {
      const body = request.postDataJSON(); writes.push(body)
      if (pathname.endsWith("/control")) {
        const result = await f.control.lifecycle({ ...body, missionID: f.mission.id, requestID: body.requestId })
        return route.fulfill({ json: result })
      }
      try {
        if (body.action === "play" && owner) {
          calendar!.advance(5000)
          await owner.control({ ...body, missionID: f.mission.id })
        } else {
          const doc = await f.control.configurePreparation({ ...body, missionID: f.mission.id,
            configuration: { ...body.configuration, roots: f.original.configuration.roots, profileID: calendar ? "profile" : null, executionHost: calendar ? "host" : null } }, f.native, () => true)
          // This browser fixture has an already-enabled native setting. Its ready
          // receipt stands in for the separate settings-executor qualification.
          if (doc.dormantJournal && calendar && !doc.scheduleActivation) await f.store.change(doc.id, doc.revision, () => true,
            value => { value.scheduleActivation = { requestID: "fixture_activation", expectedRevision: doc.revision, authority: "0".repeat(64),
              state: "ready", targets: [], effectiveOrigin: directory } })
        }
      }
      catch { return route.fulfill({ status: 503, json: missionScheduleView(await f.read()) }) }
      if (lose) return route.abort("connectionreset")
    }
    if (pathname.endsWith("/schedule")) return route.fulfill({ json: missionScheduleView(await f.read()) })
    const snapshot = await f.control.snapshot()
    return route.fulfill({ json: { available: true, ...snapshot, mission: snapshot.missions[0], cleanups: [] } })
  })
  await page.goto(url)
  await page.evaluate(directory => window.schedulingEditor.directory(directory), directory)
  await page.evaluate(mission => window.schedulingEditor.prepared(mission), (await f.control.snapshot()).missions[0])
  await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
  return { ...f, writes, errors, owner }
}
async function edit(page: Page) {
  const form = page.locator("form.mission-editor")
  assert.equal(await form.getByLabel("Title", { exact: true }).isDisabled(), false)
  await form.getByLabel("Title", { exact: true }).fill("Browser edited preparation")
  await form.locator("summary").filter({ hasText: /^Options$/ }).click()
  assert.equal(await form.getByLabel("Playbook", { exact: true }).isDisabled(), false)
  await form.getByLabel("Playbook", { exact: true }).selectOption("delivery")
  await form.locator(".mission-delegation select").selectOption("independent")
  await form.locator("summary").filter({ hasText: /^Agents and models$/ }).click()
  const agent = form.getByLabel("Coordinator · Agent", { exact: true })
  await agent.locator('option[value="coordinator"]').waitFor({ state: "attached" }); await agent.selectOption("coordinator")
  await form.getByLabel("Coordinator · Model", { exact: true }).selectOption(JSON.stringify(["p", "m"]))
  await form.getByLabel("Coordinator · Thinking", { exact: true }).selectOption("precise")
  await form.locator(".mission-scheduling > summary").click()
  assert.equal(await form.getByLabel("Frequency", { exact: true }).isDisabled(), false)
  assert.equal(await form.getByLabel("Frequency", { exact: true }).locator('option[value="every"]').evaluate(option => (option as HTMLOptionElement).disabled), true,
    await form.locator(".mission-scheduling").innerText())
  assert.doesNotMatch(await form.locator(".mission-scheduling").innerText(), /journal-owned launch/)
  return form
}
test("real owner: prepared fields unlock without schedule capability; edit then real Play uses the new coordinator profile", async () => {
  const page = await browser.newPage({ viewport: { width: 620, height: 1100 } }), f = await setup(page)
  try {
    const form = await edit(page)
    const capture = process.env.CODENOMAD_MISSION_CAPTURE_DIR
    if (capture) { await mkdir(capture, { recursive: true }); await page.screenshot({ path: path.join(capture, "editor-preparation-unlocked.png"), fullPage: true }) }
    await form.getByRole("button", { name: "Save", exact: true }).click(); await form.waitFor({ state: "detached" })
    assert.equal(f.writes.length, 1); assert.equal(f.admissions.length, 0)
    const saved = (await f.control.snapshot()).missions[0]
    assert.equal(saved.title, "Browser edited preparation"); assert.equal(saved.template, "delivery"); assert.equal(saved.taskMode, "independent")
    assert.deepEqual(saved.profiles?.coordinator, { agent: "coordinator", model: { providerID: "p", id: "m", variant: "precise" } })
    await Promise.all([page.waitForResponse(response => response.url().endsWith("/control") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Start mission", exact: true }).click()])
    assert.equal(f.admissions.length, 1); assert.equal(f.admissions[0].sessionID, saved.coordinatorSessionId)
    assert.deepEqual(f.admissions[0].profile.model, saved.profiles?.coordinator?.model)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
test("real owner: lost edit response keeps its request and reconciles through a read, without another root or Play", async () => {
  const page = await browser.newPage(), f = await setup(page, true)
  try {
    const form = await edit(page)
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").filter({ hasText: /unconfirmed/ }).waitFor()
    const held = await page.evaluate(() => window.schedulingEditor.held())
    assert.equal(JSON.parse(held!.payload).requestID, f.writes[0].requestID)
    await form.getByRole("button", { name: "Refresh saved request", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.equal(f.writes.length, 1); assert.equal(f.sessions.size, 2); assert.equal(f.admissions.length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("real owner: positive partial preparation enables only an explicit original retry; refresh and remount never resend", async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    f.fail("native-after")
    const form = await edit(page)
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").filter({ hasText: /unconfirmed/ }).waitFor()
    const retry = form.locator(".window-footer").getByRole("button", { name: "Try again", exact: true })
    assert.equal(await retry.count(), 0)
    await form.getByRole("button", { name: "Refresh saved request", exact: true }).click()
    await retry.waitFor()
    assert.equal(f.writes.length, 1); assert.equal(f.admissions.length, 0)
    await page.evaluate(() => window.schedulingEditor.mount(false)); await page.evaluate(() => window.schedulingEditor.mount(true))
    assert.equal(await retry.count(), 0)
    await form.getByRole("button", { name: "Refresh saved request", exact: true }).click()
    await retry.click()
    await form.waitFor({ state: "detached" })
    assert.equal(f.writes.length, 2)
    assert.deepEqual(f.writes[1], { ...f.writes[0], retry: true })
    assert.equal(f.sessions.size, 2); assert.equal(f.admissions.length, 0)
    assert.equal((await f.read()).preparation!.pending, false)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

async function convert(page: Page, frequency: "every" | "immediate") {
  const form = page.locator("form.mission-editor")
  await form.locator(".mission-scheduling > summary").click()
  await form.getByLabel("Frequency", { exact: true }).selectOption(frequency)
  assert.equal(await form.getByLabel("Frequency", { exact: true }).isDisabled(), false)
  if (frequency === "every") await form.getByLabel("Duration", { exact: true }).fill("15")
  return form
}

test("real owners: immediate → recurring → explicit Play arms the converted interval and keeps Mission identity", async t => {
  const calendar = await ownerFixture(t), page = await browser.newPage({ viewport: { width: 620, height: 1100 } }), f = await setup(page, false, calendar)
  try {
    const form = await convert(page, "every")
    const capture = process.env.CODENOMAD_MISSION_CAPTURE_DIR
    if (capture) { await mkdir(capture, { recursive: true }); await page.screenshot({ path: path.join(capture, "editor-convert-recurring.png"), fullPage: true }) }
    await form.getByRole("button", { name: "Save", exact: true }).click(); await form.waitFor({ state: "detached" })
    assert.equal((await f.read()).id, f.mission.id)
    assert.equal((await f.read()).firstPlayedAt, null); assert.equal(calendar.calls.length, 0)
    assert.equal(f.admissions.length, 0); assert.equal(f.writes.length, 1)
    await Promise.all([page.waitForResponse(response => response.url().endsWith("/schedule") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Start", exact: true }).click()])
    const played = await f.read()
    assert.equal(played.id, f.mission.id); assert.equal(played.calendarOwner!.operation.pending, false)
    assert.deepEqual(played.configuration.launch.timing, { kind: "every", intervalMs: 900000 })
    assert.equal(played.calendars.length, 2); assert.equal(played.launchedCount, 0)
    assert.equal((await f.control.list()).missions.length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("real owners: recurring → immediate → explicit Play uses the restored journal without a native calendar", async t => {
  const calendar = await ownerFixture(t), page = await browser.newPage(), f = await setup(page, false, calendar)
  try {
    let form = await convert(page, "every")
    await form.getByRole("button", { name: "Save", exact: true }).click(); await form.waitFor({ state: "detached" })
    await page.evaluate(id => window.schedulingEditor.schedule(id), f.mission.id)
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
    form = await convert(page, "immediate")
    await form.getByRole("button", { name: "Save", exact: true }).click(); await form.waitFor({ state: "detached" })
    const before = await f.read()
    assert.equal(before.dormantJournal, null); assert.equal(before.firstPlayedAt, null)
    assert.equal(calendar.calls.length, 0)
    await Promise.all([page.waitForResponse(response => response.url().endsWith("/control") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Start mission", exact: true }).click()])
    assert.equal(f.admissions.length, 1); assert.equal(f.admissions[0].sessionID, before.oneTime!.coordinatorSessionID)
    assert.equal((await f.read()).launchedCount, 1); assert.equal(calendar.calls.length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("real conversion: lost HTTP ACK retains its exact request; receipt refresh never repeats conversion or Play", async t => {
  const calendar = await ownerFixture(t), page = await browser.newPage(), f = await setup(page, true, calendar)
  try {
    const form = await convert(page, "every")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").filter({ hasText: /unconfirmed/ }).waitFor()
    const hold = await page.evaluate(() => window.schedulingEditor.held())
    assert.equal(JSON.parse(hold!.payload).requestID, f.writes[0].requestID)
    await form.getByRole("button", { name: "Refresh saved request", exact: true }).click(); await form.waitFor({ state: "detached" })
    assert.equal(f.writes.length, 1); assert.equal(calendar.calls.length, 0); assert.equal(f.admissions.length, 0)
    assert.equal((await f.read()).dormantJournal?.deleted, false)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("real conversion conflict preserves its unsent draft and reloads only by explicit choice", async t => {
  const calendar = await ownerFixture(t), page = await browser.newPage(), f = await setup(page, false, calendar)
  try {
    const form = await convert(page, "every"), mission = (await f.control.snapshot()).missions[0]
    await f.control.update({ missionID: mission.id, requestID: "concurrent_text", expectedRevision: mission.revision, objective: "Concurrent authoritative text" })
    await form.getByRole("button", { name: "Save", exact: true }).click()
    const reload = form.getByRole("button", { name: "Reload current configuration", exact: true }); await reload.waitFor()
    assert.equal(await form.getByLabel("Frequency", { exact: true }).inputValue(), "every")
    assert.equal(f.writes.length, 0); assert.equal((await f.read()).dormantJournal, null)
    await reload.click()
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
    assert.equal(await form.getByLabel("What should the mission do?", { exact: true }).inputValue(), "Concurrent authoritative text")
    assert.equal(calendar.calls.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("scheduled followed context survives return to immediate and is frozen only at explicit Play", async t => {
  const calendar = await ownerFixture(t), page = await browser.newPage(), f = await setup(page, false, calendar)
  try {
    const before = await f.read()
    await f.control.configurePreparation({ ...f.request, requestID: "seed_followed", expectedRevision: before.revision,
      configuration: { ...scheduledPreparation(f), watchedConversationIDs: ["ses_followed"] } }, f.native, () => true)
    await page.evaluate(id => window.schedulingEditor.schedule(id), f.mission.id)
    const form = page.locator("form.mission-editor")
    await form.getByLabel("Title", { exact: true }).waitFor()
    await page.waitForFunction(() => !!document.querySelector('form.mission-editor .mission-scheduling'))
    await convert(page, "immediate")
    await form.getByRole("status").filter({ hasText: /read and frozen at Play/ }).waitFor()
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), false)
    await form.getByRole("button", { name: "Save", exact: true }).click(); await form.waitFor({ state: "detached" })
    assert.equal((await f.read()).dormantJournal, null); assert.deepEqual((await f.read()).configuration.watchedConversationIDs, ["ses_followed"])
    assert.equal(f.writes.length, 1); assert.equal(calendar.calls.length, 0); assert.equal(f.admissions.length, 0)
    f.messages[0].text = "Latest context at the explicit browser Play"
    await Promise.all([page.waitForResponse(response => response.url().endsWith("/control") && response.request().method() === "POST"),
      page.getByRole("button", { name: "Start mission", exact: true }).click()])
    assert.equal(f.admissions.length, 1)
    assert.match(f.admissions[0].text, /Latest context at the explicit browser Play/)
    assert.equal(f.admissions[0].text, (await f.read()).oneTime!.firstPlay!.inputText)
    assert.equal((await f.read()).launchedCount, 1); assert.equal(calendar.calls.length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
