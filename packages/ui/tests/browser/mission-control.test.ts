import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"
import { fixtureEventStream } from "./fixture-event-stream"
import { armFixtureNavigationBudget, waitForMissionPanelRefresh } from "./mission-panel-route"
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import { clickMissionAction, inlineMissionEntry, missionEntryStatus, missionGeneralAction, missionRow, missionMenuTrigger, missionPicker, missionRows, missionToolbar,
  missionRefresh, missionToolbarAction, selectMission, selectedMissionTitle, depthInfo, depthMenu, waitForDepthInfo, waitForDepthReady } from "./mission-actions"

import { borrowFixture } from "./fixture-borrow"
import { isMissionContentRequest, listedMissions, panelMissions, routeMissionContent } from "./mission-content-fixture"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
    name: "mission-control",
    routes: [
      { path: "/mission-fixture", html: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' },
      { path: "/mission-session-fixture", html: '<html><body><div id="root" style="display:flex;height:100vh"></div><script type="module" src="/tests/browser/fixtures/mission-session.tsx"></script></body></html>' },
    ],
  })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

function mission(id: string): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "Notes",
    coordinatorSessionId: "ses_fixture", status: "active", actors: [], frontier: [], claims: [], revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false,
    tasks: [{ id: `task-${id}`, key: "task-one", title: "Inspect evidence", brief: "A detailed brief", role: "research", status: "completed", blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }],
    reports: [{ id: `report-${id}`, taskKey: "task-one", sessionId: "ses_fixture", outcome: "completed", summary: "Report opening paragraph.\n\n" + "Long report paragraph.\n\n".repeat(90), evidence: ["Source proof"], next: [], createdAt: 1 }],
  }
}
/** Local desktop windows route every Settings entry point to the single native
 * Preferences window; the embedded Settings screen exists only in browser and
 * remote windows, so tests of that screen run in a remote window. */
async function setup(page: Page, windowContext: "local" | "remote" = "local") {
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(60_000)
  page.on("pageerror", error => console.error("fixture error", error))
  await page.addInitScript(`
    Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: ${JSON.stringify(windowContext)}, electronAPI: {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(localStorage.getItem("fixture-native") ?? "null") }),
      saveClientState: async (_token, snapshot) => { localStorage.setItem("fixture-native", JSON.stringify(snapshot)); return true },
    } })
  `)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await events.route(page)
  await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: { location: { directory: "fixture" }, capability: null, effectiveDepth: null, project: null } }))
  await routeMissionContent(page, listedMissions)
}
const fixtureCall = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) => (window as any).missionFixture[method](arg), { method, arg })
/** Polls a condition on test-process state, such as what a route handler recorded. */
async function until(condition: () => boolean, timeout = 5_000) {
  for (const start = Date.now(); !condition();) {
    if (Date.now() - start > timeout) throw new Error("Condition not reached")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
/** The selected Mission's detail: a separate section below the picker. */
const selectedCard = (page: Page) => page.locator("section.mission-detail")
/** Screen-reader status ("State · time") of the selected Mission's row. */
const selectedStatus = (page: Page, state: string) => page.locator(".mission-row-select[aria-current=true] .sr-only").filter({ hasText: new RegExp(`^${state} · `) })
/** The selected Mission's contextual Play/Pause/Check control: the toolbar's first button. */
const primaryControl = (page: Page) => missionToolbar(page).locator("button").first()
const taskRow = (page: Page, key: string) => page.locator(`.mission-tree li[data-task-key="${key}"]`)
const taskButton = (page: Page, key: string) => taskRow(page, key).locator(".mission-tree-task")
const taskState = (page: Page, key: string, state: string) => page.locator(`.mission-tree li[data-task-key="${key}"][data-state="${state}"]`)
const readAll = (page: Page) => missionToolbar(page).locator(".mission-overview-toggle")
const screenshotPath = (name: string) => path.join(os.tmpdir(), "opencode", `${name}-${process.env.CODENOMAD_MISSION_CAPTURE_TAG ?? "updated"}.png`)
const fixtureText = (page: Page, key: string) => fixtureCall(page, "text", key) as Promise<string>
/** Locale-neutral explicit choice of a row by its title. */
async function pickLocalized(page: Page, title: string) {
  await (await inlineMissionEntry(page, title)).click()
  await selectedCard(page).waitFor()
}
async function localizedPreferences(page: Page, name: string) {
  const preferences = missionGeneralAction(page, name)
  await preferences.waitFor()
  return preferences
}
/** Preferences are no longer inline: the panel gear opens Settings at its Missions section
 * (in this window, as the real shell does when no native Preferences window exists). */
const settingsShell = (page: Page) => page.locator(".settings-screen-shell")
async function openMissionSettings(page: Page, label = "Preferences") {
  await missionGeneralAction(page, label).click()
  const shell = settingsShell(page)
  await shell.locator(".mission-preferences").waitFor()
  assert.equal(await shell.locator('.settings-nav-button[aria-current="page"]').innerText(), await fixtureText(page, "settings.nav.missions"))
  // Agent and model choices sit in one "Agents and models" disclosure.
  const profiles = shell.locator(".mission-profiles-disclosure > summary")
  if (!await profiles.evaluate(item => (item.parentElement as HTMLDetailsElement).open)) await profiles.click()
  return shell
}
async function closeMissionSettings(page: Page) {
  await settingsShell(page).locator(".settings-screen-close").filter({ visible: true }).first().click()
  await settingsShell(page).waitFor({ state: "detached" })
}
const settingsFits = (page: Page) => page.locator(".settings-screen-scroll").evaluate(element => element.scrollWidth <= element.clientWidth)
/** Plan changes, reports, cleanup history and identifiers are folded at the
 * bottom of the central overview reader; the panel keeps none of them. */
async function openOverviewFold(page: Page, label: string) {
  // An open task reader holds the Summary eye: it closes first.
  if (await page.locator(".mission-task-reader").count()) await readAll(page).click()
  if (await readAll(page).getAttribute("aria-pressed") !== "true") await readAll(page).click()
  const fold = page.locator(".mission-reader details.mission-report-technical").filter({ has: page.locator(":scope > summary", { hasText: new RegExp(`^${label}$`) }) })
  if (!await fold.evaluate(element => (element as HTMLDetailsElement).open)) await fold.locator(":scope > summary").click()
  return fold
}
const openResultHistory = (page: Page) => openOverviewFold(page, "Reports")
async function openTaskTechnicalDetails(page: Page) {
  await page.locator(".mission-task-reader > details").filter({ has: page.locator("summary", { hasText: "Technical details" }) }).locator("summary").click()
}

test("Missions preferences open in Settings from the panel gear, save each choice compare-and-swapped and fence hidden catalog demand without closing the reader", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  const errors: string[] = [], catalogReads: string[] = [], writes: any[] = []
  page.on("pageerror", error => errors.push(error.message))
  let owner: any = { settings: { missionProfileDefaults: [], unrelated: "keep" } }
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions([mission("preferences")]), generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/storage/config/ui*", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: owner })
      const body = route.request().postDataJSON(); writes.push(body)
      if (JSON.stringify(body.expected[0].value) !== JSON.stringify(owner.settings.missionProfileDefaults))
        return route.fulfill({ status: 409, json: { error: "Changed elsewhere" } })
      owner = { ...owner, settings: { ...owner.settings, ...body.patch.settings } }
      return route.fulfill({ json: owner })
    })
    await page.route("**/workspaces/fixture/instance/api/agent**", route => {
      catalogReads.push(route.request().url())
      return route.fulfill({ json: { data: [{ id: "build", mode: "primary" }, { id: "review", mode: "subagent" }] } })
    })
    await page.route("**/workspaces/fixture/instance/api/model**", route => {
      catalogReads.push(route.request().url())
      return route.fulfill({ json: { data: [{ providerID: "native", id: "long-context", name: "Long context", status: "active", enabled: true,
        capabilities: { tools: true }, cost: [], limit: { context: 1, output: 1 }, variants: [{ id: "high" }] }] } })
    })
    await page.route("**/workspaces/fixture/instance/api/provider**", route => route.fulfill({ json: { data: [{ id: "native", name: "Native" }] } }))
    await page.goto(url)
    await fixtureCall(page, "connectCatalog")
    await page.waitForFunction(() => (window as any).missionFixture.loaded())
    const preferences = missionGeneralAction(page, await fixtureText(page, "missions.preferences.title"))
    await preferences.waitFor()
    assert.equal(await page.locator(".mission-preferences").count(), 0, "preferences are not inline in the panel")
    assert.equal(await fixtureCall(page, "settingsOpen"), false)
    await page.waitForTimeout(100)
    assert.equal(catalogReads.length, 0)
    // Only the picker selects a Mission; the coordinator conversation selects none.
    await selectMission(page, "Objective preferences")
    await readAll(page).click()
    const reader = page.locator(".mission-reader")
    await reader.waitFor()
    await reader.evaluate(element => { (window as any).savedPreferenceReader = element })
    await openMissionSettings(page)
    const agent = page.getByLabel("Coordinator · Agent", { exact: true })
    await agent.locator('option[value="build"]').waitFor({ state: "attached" })
    await agent.selectOption("build")
    await until(() => owner.settings.missionProfileDefaults.length === 1)
    assert.deepEqual(writes[0].expected[0].value, [], "the write is compared against the value shown")
    await closeMissionSettings(page)
    const reads = catalogReads.length
    await page.evaluate(async () => {
      const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
      serverEvents.dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: { type: "server.connected", id: "hidden", created: 1, location: { directory: "fixture" }, data: {} } }])
    })
    await page.waitForTimeout(100)
    assert.equal(catalogReads.length, reads, JSON.stringify(catalogReads))
    await fixtureCall(page, "active", false)
    await fixtureCall(page, "mount", false); await fixtureCall(page, "mount", true)
    await fixtureCall(page, "active", true)
    assert.equal(await page.locator(".mission-preferences").count(), 0, "panel remounts never reopen Settings")
    await openMissionSettings(page)
    assert.equal(await agent.inputValue(), "build")
    assert.equal(await reader.evaluate(element => element === (window as any).savedPreferenceReader), true)
    assert.equal(await readAll(page).getAttribute("aria-pressed"), "true")
    await agent.focus(); await fixtureCall(page, "refresh")
    assert.equal(await agent.evaluate(element => element === document.activeElement), true)
    for (const width of [1100, 640, 390]) {
      await page.setViewportSize({ width, height: 850 })
      await page.locator(".mission-profiles-disclosure .mission-preferences-actions").scrollIntoViewIfNeeded()
      assert.equal(await settingsFits(page), true)
      await page.screenshot({ path: screenshotPath(`mission-preferences-en-${width}`) })
    }
    await page.setViewportSize({ width: 1100, height: 850 })
    assert.equal(await page.locator(".mission-preferences").getByRole("button", { name: /^(Save|Reload)$/ }).count(), 0, "no save or reload step")
    // Another window changed the defaults; this window has not heard about it yet.
    const stored = owner.settings.missionProfileDefaults
    owner = { settings: { missionProfileDefaults: [{ template: "custom", profiles: { coordinator: { agent: "other-window" } } }], unrelated: "keep" } }
    await agent.selectOption("")
    await page.getByText(await fixtureText(page, "missions.defaults.error"), { exact: true }).waitFor()
    assert.deepEqual(writes[1].expected[0].value, stored, "the rejected write was compared against what this window showed")
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="Coordinator · Agent"]')?.value === "other-window")
    assert.equal(owner.settings.missionProfileDefaults[0].profiles.coordinator.agent, "other-window")
    assert.equal(writes.length, 2, "the stored value is re-read; the rejected mutation is never replayed")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("empty Missions reaches localized preferences through the gear, without settings-card chrome", async () => {
  for (const locale of ["fr-FR", "he-IL"]) {
    const page = await browser.newPage({ locale, viewport: { width: 1000, height: 850 } })
    try {
      await setup(page, "remote")
      await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
      await page.goto(url); await fixtureCall(page, "panelWidth", "280px")
      await page.waitForFunction(() => (window as any).missionFixture.loaded())
      await page.waitForFunction(language => document.documentElement.lang === language, locale.split("-")[0])
      const label = locale === "fr-FR" ? "Préférences" : "העדפות"
      await localizedPreferences(page, label)
      assert.equal(await page.locator(".mission-preferences").count(), 0)
      assert.equal(await page.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: screenshotPath(`mission-empty-${locale}`) })
      const settings = await openMissionSettings(page, label)
      assert.equal(await settings.locator(".mission-preferences > header h4").innerText(), await fixtureText(page, "missions.defaults.title"))
      assert.equal(await settings.locator(".mission-preferences .settings-card").count(), 0, "compact Mission controls, not wide settings cards")
      assert.equal(await settingsFits(page), true)
      await page.screenshot({ path: screenshotPath(`mission-preferences-${locale}`) })
      await closeMissionSettings(page)
      await missionGeneralAction(page, await fixtureText(page, "missions.control.create")).click()
      await page.locator("form.mission-editor").waitFor()
      await page.locator("aside").evaluate(element => { element.scrollTop = 0 })
      assert.equal(await page.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: screenshotPath(`mission-create-${locale}-280`) })
    } finally { await page.close() }
  }
})

for (const failBeforeRelease of [false, true]) test(`localized Missions preferences wait for a held French dictionary, not only config and document language${failBeforeRelease ? " · failure cleanup" : ""}`, { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ locale: "fr-FR", viewport: { width: 1000, height: 850 } })
  const requested = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const originatingError = new Error("Assertion failed before dictionary release")
  let selected = false, handlerSettled = false, closedBeforeHandler = false
  let routeFailed = false, routeFailure: unknown
  page.on("close", () => { closedBeforeHandler = !handlerSettled })
  const run = async () => {
    let failed = false, failure: unknown
    try {
      await setup(page, "remote")
      await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
      await page.route("**/messages/fr/index.ts*", async route => {
        requested.resolve()
        try {
          await release.promise
          // Give the failure path an admitted, bounded continuation to drain before closing.
          if (failBeforeRelease) await new Promise(resolve => setTimeout(resolve, 50))
          await route.continue()
        } catch (error) { routeFailed = true; routeFailure = error }
        finally { handlerSettled = true }
      })
      await page.goto(url); await fixtureCall(page, "panelWidth", "280px")
      await requested.promise
      await page.waitForFunction(() => (window as any).missionFixture.loaded() && document.documentElement.lang === "fr")
      assert.equal(await fixtureText(page, "missions.preferences.title"), "Preferences")
      if (failBeforeRelease) throw originatingError
      const ready = localizedPreferences(page, "Préférences").then(preferences => { selected = true; return preferences })
      void ready.catch(() => {}) // Page closure still handles a failed assertion before release.
      // A read-only round trip lets a missing readiness wait settle while the import remains held.
      await page.evaluate(() => document.documentElement.lang)
      assert.equal(selected, false)
      release.resolve()
      const preferences = await ready
      assert.equal(await fixtureText(page, "missions.preferences.title"), "Préférences")
      assert.equal(await page.locator(".mission-preferences").count(), 0)
      await preferences.click()
      await settingsShell(page).locator(".mission-preferences").waitFor()
      assert.equal(await settingsShell(page).locator(".mission-preferences > header h4").innerText(), await fixtureText(page, "missions.defaults.title"))
      await settingsShell(page).getByRole("button", { name: "Fermer les paramètres", exact: true }).filter({ visible: true }).first().click()
      await settingsShell(page).waitFor({ state: "detached" })
    } catch (error) { failed = true; failure = error }
    finally {
      release.resolve()
      try { await page.unrouteAll({ behavior: "wait" }); if (routeFailed) throw routeFailure }
      catch (error) { if (!failed) { failed = true; failure = error } }
      try { await page.close() }
      catch (error) { if (!failed) { failed = true; failure = error } }
    }
    if (failed) throw failure
  }
  if (failBeforeRelease) await assert.rejects(run(), error => error === originatingError)
  else await run()
  assert.equal(handlerSettled, true)
  assert.equal(routeFailed, false)
  assert.equal(closedBeforeHandler, false)
  assert.equal(page.isClosed(), true)
})

test("Delegation depth is one labelled menu, read only on demand: Inherit then 1 to 10 within the contract, each choice saved at once without native reload or global preference writes", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  const mutations: Array<{ url: string; body: any }> = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let reads = 0, depth: number | null = null, expectation = "original-file"
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", route => {
      if (route.request().method() === "GET") {
        reads++
        return route.fulfill({ json: { location: { directory: "fixture" }, capability: { minimum: 0, maximum: 4 }, effectiveDepth: depth ?? 3,
          project: { path: "fixture/opencode.jsonc", depth, expectation } } })
      }
      const body = route.request().postDataJSON(); mutations.push({ url: route.request().url(), body })
      assert.equal(body.expectation, expectation); depth = body.depth; expectation = `saved-${mutations.length}`
      return route.fulfill({ status: 204, body: "" })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await page.waitForFunction(() => (window as any).missionFixture.loaded())
    assert.equal(reads, 0)
    await openMissionSettings(page)
    const controls = page.locator(".mission-depth"), menu = controls.getByRole("combobox", { name: "Subagent depth", exact: true })
    await waitForDepthReady(page)
    // The inherited depth names Inherit; the contract's maximum bounds the choices.
    assert.deepEqual(await menu.locator("option").allInnerTexts(), ["Inherit (3)", "1", "2", "3", "4"])
    assert.equal(await menu.inputValue(), "")
    // One row: the label and its menu. Everything else is behind the one info tip.
    assert.equal(await controls.locator(".settings-info-tip").count(), 1)
    assert.equal(await controls.locator("p:not(.sr-only)").count(), 0, "no prose under the row")
    assert.equal(await controls.getByRole("button").count(), 0, "no Inherit or Save button; refreshing is only a recovery")
    assert.deepEqual(await depthInfo(page), [await fixtureText(page, "missions.depth.hint"), await fixtureText(page, "missions.depth.nesting.rule"),
      "OpenCode effective depth: 3", "Project write target: fixture/opencode.jsonc", "OpenCode configuration file: No document path"])
    for (const width of [1100, 640, 390]) {
      await page.setViewportSize({ width, height: 850 })
      await controls.scrollIntoViewIfNeeded()
      assert.equal(await settingsFits(page), true)
      // Label and menu share one line at every width.
      const [label, box] = [await controls.locator("label > span").boundingBox(), await menu.boundingBox()]
      assert.ok(label && box && label.y < box.y + box.height && box.y < label.y + label.height && label.x + label.width <= box.x + 1,
        `one line at ${width}px: ${JSON.stringify([label, box])}`)
      await page.screenshot({ path: screenshotPath(`mission-delegation-depth-${width}`) })
    }
    await page.setViewportSize({ width: 1100, height: 850 })
    await menu.selectOption("4")
    await controls.getByRole("status").filter({ hasText: "Configuration saved. OpenCode was not reloaded." }).waitFor({ state: "attached" })
    assert.deepEqual(mutations[0].body, { location: { directory: "fixture" }, depth: 4, expectation: "original-file" })
    await waitForDepthInfo(page, "OpenCode effective depth: 4")
    await waitForDepthReady(page)
    // With a project depth set, Inherit no longer knows the value it would restore.
    assert.deepEqual(await menu.locator("option").allInnerTexts(), ["Inherit", "1", "2", "3", "4"])
    await menu.selectOption("")
    await until(() => mutations.length === 2)
    assert.equal(mutations[1].body.depth, null)
    assert.equal(mutations[1].body.expectation, "saved-1")
    await waitForDepthInfo(page, "OpenCode effective depth: 3")
    assert.equal(await menu.locator("option").first().innerText(), "Inherit (3)")
    assert.ok(mutations.every(item => item.url.includes("/subagent-depth")))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a depth write acknowledged after leaving Settings is accepted and reread on return", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let reads = 0, writes = 0, depth: number | null = 1, expectation = "e1", release!: () => void, reached!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", async route => {
      if (route.request().method() === "GET") {
        reads++
        return route.fulfill({ json: { location: { directory: "fixture" }, capability: { minimum: 0 }, effectiveDepth: depth,
          project: { path: "fixture/opencode.jsonc", depth, expectation } } })
      }
      writes++; reached(); await hold
      depth = route.request().postDataJSON().depth; expectation = "e2"
      return route.fulfill({ status: 204, body: "" })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await openMissionSettings(page)
    const menu = depthMenu(page)
    await waitForDepthInfo(page, "OpenCode effective depth: 1")
    await waitForDepthReady(page)
    await menu.selectOption("2"); await started
    await closeMissionSettings(page)
    release()
    await until(() => depth === 2)
    await openMissionSettings(page)
    await waitForDepthInfo(page, "OpenCode effective depth: 2")
    assert.equal(await page.getByText("Save not confirmed. Your choice is kept; refresh before another change. No automatic retry.", { exact: true }).count(), 0)
    await waitForDepthReady(page)
    assert.equal(writes, 1); assert.equal(reads, 2, "the acknowledged write is reread once the section is visible again")
  } finally { release(); await page.close() }
})

test("Inherit repairs an existing empty project experimental block and the info names the effective origin separately from its write target", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let empty = true, expectation = "empty-block"
  const writes: unknown[] = []
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { location: { directory: "fixture" }, capability: { minimum: 0 },
        effectiveDepth: empty ? null : 5, origin: empty ? "fixture/opencode.jsonc" : "/global/opencode.jsonc",
        project: { path: "fixture/opencode.jsonc", depth: null, expectation, ...(empty ? { emptyExperimental: true } : {}) } } })
      writes.push(route.request().postDataJSON()); empty = false; expectation = "repaired"
      return route.fulfill({ status: 204, body: "" })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await openMissionSettings(page)
    const menu = depthMenu(page)
    await waitForDepthInfo(page, "OpenCode effective depth unknown")
    await waitForDepthInfo(page, "Project write target: fixture/opencode.jsonc")
    await waitForDepthInfo(page, "OpenCode configuration file: fixture/opencode.jsonc")
    await waitForDepthReady(page)
    // No override is set, but the empty block hides the inherited depth: the menu shows
    // OpenCode's default, and Inherit (a change) repairs it.
    assert.equal(await menu.inputValue(), "masked")
    assert.deepEqual((await menu.locator("option").allInnerTexts()).slice(0, 2), ["Inherit", "OpenCode default (?)"])
    await menu.selectOption("")
    await waitForDepthInfo(page, "OpenCode effective depth: 5")
    await waitForDepthInfo(page, "OpenCode configuration file: /global/opencode.jsonc")
    await waitForDepthInfo(page, "Project write target: fixture/opencode.jsonc")
    // Paths stay left-to-right inside right-to-left text.
    assert.match(await page.locator(".mission-depth .settings-info-tip").getAttribute("aria-label") ?? "", /: \u2066\/global\/opencode\.jsonc\u2069/)
    assert.deepEqual(writes, [{ location: { directory: "fixture" }, depth: null, expectation: "empty-block" }])
    assert.equal(await menu.inputValue(), "")
    assert.deepEqual((await menu.locator("option").allInnerTexts()).slice(0, 2), ["Inherit (5)", "1"], "repaired, the default is no longer offered")
  } finally { await page.close() }
})

test("the depth editor states the nesting rule and whether General subagents can nest, per OpenCode's resolved rules", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  // Each saved value selects the native state the next read reports.
  const states: Record<string, { effectiveDepth: number; depth: number | null; nesting: unknown; nestingSkipped?: boolean }> = {
    initial: { effectiveDepth: 1, depth: null, nesting: { effect: "deny", hidden: true } },
    "3": { effectiveDepth: 3, depth: 3, nesting: { effect: "allow" } },
    "2": { effectiveDepth: 2, depth: 2, nesting: { effect: "ask" } },
    "4": { effectiveDepth: 4, depth: 4, nesting: { effect: "deny", hidden: true } },
    null: { effectiveDepth: 5, depth: null, nesting: { effect: "deny", hidden: true } },
    // General may not launch General; the tool stays, so other agents follow their own rules.
    "6": { effectiveDepth: 6, depth: 6, nesting: { effect: "deny" } },
    // The project's legacy General block could not take the rule: only the depth was saved.
    "7": { effectiveDepth: 7, depth: 7, nesting: { effect: "deny", hidden: true }, nestingSkipped: true },
    // The rule is written with a depth of 1 too, but OpenCode's depth limit still stops nesting.
    "1": { effectiveDepth: 1, depth: 1, nesting: { effect: "allow" } },
  }
  let state = states.initial
  const writes: unknown[] = []
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { location: { directory: "fixture" }, capability: { minimum: 0 },
        effectiveDepth: state.effectiveDepth, nesting: state.nesting,
        project: { path: "fixture/opencode.jsonc", depth: state.depth, expectation: `e${state.depth}`,
          ...(state.nestingSkipped ? { nestingSkipped: true } : {}) } } })
      writes.push(route.request().postDataJSON())
      state = states[String(route.request().postDataJSON().depth)]
      return route.fulfill({ status: 204, body: "" })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await openMissionSettings(page)
    const controls = page.locator(".mission-depth"), menu = depthMenu(page)
    // The info's nesting line follows the effective depth's line.
    const note = async () => { const lines = await depthInfo(page); return lines[lines.findIndex(line => line.startsWith("OpenCode effective depth")) + 1] }
    const save = async (value: string, effective: number) => {
      await waitForDepthReady(page)
      await menu.selectOption(value)
      await waitForDepthInfo(page, `OpenCode effective depth: ${effective}`)
    }
    await waitForDepthInfo(page, "OpenCode effective depth: 1")
    assert.ok((await depthInfo(page)).includes("Setting a project depth also lets subagents launch their own subagents in this project, up to that depth; at 1, OpenCode's own limit still stops nesting. This project rule takes precedence over General's restrictions from other config files."))
    assert.equal(await note(), "At this depth, OpenCode's own depth limit stops nesting.")
    await save("3", 3)
    assert.equal(await note(), "General subagents can launch their own subagents here, so they nest up to this depth.")
    await save("2", 2)
    assert.equal(await note(), "General subagents ask before launching other General subagents here.")
    await save("4", 4)
    assert.equal(await note(), "General subagents cannot launch subagents here, so they do not nest.")
    await save("6", 6)
    assert.equal(await note(), "General subagents cannot launch other General subagents here; launching other agents depends on their permissions.")
    assert.equal(await controls.getByText("Only the depth was saved: this project's legacy General `permission` is a single value or already uses both `task` and `subagent`, so CodeNomad did not add the nesting rule. Allow subagents for General in that file yourself.", { exact: true }).count(), 0, "the rule was written")
    await save("7", 7)
    assert.equal(await controls.getByRole("alert").filter({ hasText: "Only the depth was saved" }).innerText(), "Only the depth was saved: this project's legacy General `permission` is a single value or already uses both `task` and `subagent`, so CodeNomad did not add the nesting rule. Allow subagents for General in that file yourself.")
    await save("", 5)
    assert.equal(await note(), "General subagents cannot launch subagents here, so they do not nest.")
    await save("1", 1)
    assert.equal(await note(), "At this depth, OpenCode's own depth limit stops nesting.",
      "General may launch subagents, but a depth of 1 still stops nesting")
    assert.deepEqual(writes.map(write => (write as { depth: number | null }).depth), [3, 2, 4, 6, 7, null, 1], "only depth writes")
    assert.equal(await controls.getByText("Only the depth was saved: this project's legacy General `permission` is a single value or already uses both `task` and `subagent`, so CodeNomad did not add the nesting rule. Allow subagents for General in that file yourself.", { exact: true }).count(), 0, "no warning without the depth-only save")
  } finally { await page.close() }
})

test("the mission editor's Scheduling never displays an OpenCode configuration path", async () => {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let origin: string | null = "/ancestor/.opencode/opencode.jsonc"
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/missions/scheduled/capabilities*", route => route.fulfill({ json: { location: { directory: "fixture" },
      api: { available: true }, enabled: false, origin, activation: { available: true,
        targets: [{ scope: "global", path: "/global/opencode.jsonc" }, { scope: "project", path: "fixture/opencode.jsonc" }] } } }))
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    for (const path of [origin, "fixture/opencode.jsonc", null]) {
      origin = path
      await missionGeneralAction(page, "Create mission").click()
      const editor = page.locator("form.mission-editor"), scheduling = editor.locator(".mission-scheduling")
      await scheduling.locator("summary").click()
      await page.waitForFunction(() => !document.querySelector<HTMLOptionElement>('form.mission-editor .mission-scheduling option[value="daily"]')?.disabled)
      assert.equal(await scheduling.getByText(/OpenCode configuration file:|No document path|opencode\.jsonc/).count(), 0)
      assert.equal(await scheduling.locator("code").count(), 0)
      await editor.getByRole("button", { name: "Cancel", exact: true }).click()
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a depth read only locks the menu; only a write announces Saving", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const read = Promise.withResolvers<void>(), write = Promise.withResolvers<void>(), reading = Promise.withResolvers<void>(), writing = Promise.withResolvers<void>()
  let depth = 2
  const writes: number[] = []
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", async route => {
      if (route.request().method() === "GET") {
        reading.resolve(); await read.promise
        return route.fulfill({ json: { location: { directory: "fixture" }, capability: { minimum: 0 }, effectiveDepth: depth,
          project: { path: "fixture/opencode.jsonc", depth, expectation: `e${depth}` } } })
      }
      writing.resolve(); await write.promise
      depth = route.request().postDataJSON().depth; writes.push(depth)
      return route.fulfill({ status: 204, body: "" })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await missionGeneralAction(page, "Create mission").click()
    await page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }).click()
    const form = page.locator("form.mission-editor"), controls = form.locator(".mission-depth"), menu = depthMenu(form)
    const locked = () => menu.evaluate(element => element.getAttribute("aria-disabled") === "true")
    await reading.promise
    assert.equal(await locked(), true, "a read locks the menu")
    assert.equal(await controls.getByRole("status").count(), 0, "and announces no save")
    read.resolve()
    await waitForDepthInfo(form, "OpenCode effective depth: 2")
    await waitForDepthReady(form)
    await menu.selectOption("3")
    await writing.promise
    await controls.getByRole("status").filter({ hasText: "Saving…" }).waitFor({ state: "attached" })
    assert.equal(await locked(), true, "a write locks the menu too")
    assert.equal(await menu.evaluate(element => (element as HTMLSelectElement).disabled), false, "and keeps it focusable")
    // Choices made during the write (a native closed select's arrow keys fire one change
    // per step) are kept, shown, and the latest is written once the first write's read has
    // settled; the intermediate one is never written.
    await menu.focus()
    for (const value of ["4", "5"]) await menu.evaluate((element, value) => {
      (element as HTMLSelectElement).value = value; element.dispatchEvent(new Event("change", { bubbles: true }))
    }, value)
    assert.equal(await menu.inputValue(), "5")
    assert.deepEqual(writes, [], "the first write is still held, and nothing else is sent")
    write.resolve()
    await waitForDepthInfo(form, "OpenCode effective depth: 5")
    assert.deepEqual(writes, [3, 5])
    assert.equal(await menu.inputValue(), "5")
    assert.equal(await menu.evaluate(element => element === document.activeElement), true, "focus stays on the menu")
    await page.waitForFunction(() => !document.querySelector(".mission-depth [role=status]")?.textContent?.includes("Saving…"))
  } finally { read.resolve(); write.resolve(); await page.close() }
})

test("choosing a depth in the creation form, then Enter on its menu, saves the depth without creating the mission", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let depth = 2, expectation = "e1"
  const writes: Array<{ path: string; body: unknown }> = []
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/missions**", route => {
      if (route.request().method() === "GET" || route.request().url().endsWith("/panel-page")) return route.fallback()
      writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
      return route.fulfill({ status: 503, json: { code: "creation-unavailable" } })
    })
    await page.route("**/api/workspaces/fixture/subagent-depth*", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { location: { directory: "fixture" }, capability: { minimum: 0 },
        effectiveDepth: depth, project: { path: "fixture/opencode.jsonc", depth, expectation } } })
      writes.push({ path: "depth", body: route.request().postDataJSON() }); depth = 3; expectation = "e2"
      return route.fulfill({ status: 204, body: "" })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await missionGeneralAction(page, "Create mission").click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel("What should the mission do?", { exact: true }).fill("Do not create until I press Create")
    await form.locator("summary").filter({ hasText: /^Options$/ }).click()
    // The footer's Save as brief is a bookmark icon named by its tooltip.
    const brief = form.locator(".window-footer").getByRole("button", { name: "Save as brief", exact: true })
    assert.deepEqual([await brief.innerText(), await brief.getAttribute("title"), await brief.locator("svg").count()], ["", "Save as brief", 1])
    // The depth is a row of the Delegation group, under Task sessions.
    const delegation = form.getByRole("group", { name: "Delegation", exact: true }), menu = depthMenu(delegation)
    await waitForDepthReady(form)
    assert.equal(await menu.inputValue(), "2")
    await menu.selectOption("3")
    await waitForDepthInfo(form, "OpenCode effective depth: 3")
    await menu.press("Enter")
    assert.deepEqual(writes, [{ path: "depth", body: { location: { directory: "fixture" }, depth: 3, expectation: "e1" } }], "no mission write")
    assert.equal(await form.getByLabel("What should the mission do?", { exact: true }).inputValue(), "Do not create until I press Create")
  } finally { await page.close() }
})

test("visible clean depth revalidates after config and connection changes while hidden, dirty and uncertain states stay fenced", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let reads = 0, depth = 1, expectation = "original", writes = 0
  const invalidate = (reconnect = false) => page.evaluate(async reconnect => {
    const eventPath = "/src/lib/server-events.ts", { serverEvents } = await import(eventPath)
    if (reconnect) {
      const instancePath = "/src/stores/instances.ts", { updateInstance } = await import(instancePath)
      updateInstance("fixture", { client: {} as any })
    }
    serverEvents.dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: {
      type: reconnect ? "server.connected" : "config.updated", id: "depth-invalidation", created: 1, location: { directory: "fixture" }, data: {},
    } } as any])
  }, reconnect)
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", route => {
      if (route.request().method() === "GET") {
        reads++
        return route.fulfill({ json: { location: { directory: "fixture" }, capability: { minimum: 0 }, effectiveDepth: depth,
          project: { path: "fixture/opencode.jsonc", depth, expectation } } })
      }
      writes++; assert.equal(route.request().postDataJSON().expectation, "changed")
      return route.fulfill({ status: 503, json: { error: "Acknowledgement unknown" } })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    const menu = depthMenu(page)
    await openMissionSettings(page); await waitForDepthInfo(page, "OpenCode effective depth: 1")
    depth = 4; expectation = "changed"
    await invalidate(); await waitForDepthInfo(page, "OpenCode effective depth: 4")
    assert.equal(reads, 2)
    depth = 3; await invalidate(true); await waitForDepthInfo(page, "OpenCode effective depth: 3")
    assert.equal(reads, 3)
    await waitForDepthReady(page)
    await menu.selectOption("2")
    await page.getByText("Save not confirmed. Your choice is kept; refresh before another change. No automatic retry.", { exact: true }).waitFor()
    depth = 5; await invalidate(true); await invalidate(); await page.waitForTimeout(150)
    assert.equal(await menu.inputValue(), "2", "the unconfirmed choice is kept")
    assert.equal(reads, 3, "its file expectation is not rebased"); assert.equal(writes, 1, "unknown admission is not retried or silently refreshed")
    await closeMissionSettings(page); await invalidate(true); await page.waitForTimeout(150)
    assert.equal(reads, 3, "hidden preference demand stays closed")
  } finally { await page.close() }
})

test("config invalidation fences an admitted stale depth response and keeps the menu locked through its trailing refresh", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let reads = 0, depth = 1, release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  const invalidate = () => page.evaluate(async () => {
    const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
    serverEvents.dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: { type: "config.updated" } } as any])
  })
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", async route => {
      assert.equal(route.request().method(), "GET")
      const snapshot = { location: { directory: "fixture" }, capability: { minimum: 0 }, effectiveDepth: depth,
        project: { path: "fixture/opencode.jsonc", depth, expectation: `depth-${depth}` } }
      if (++reads === 2) { reached(); await held }
      return route.fulfill({ json: snapshot })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await openMissionSettings(page)
    await waitForDepthInfo(page, "OpenCode effective depth: 1")
    await page.evaluate(() => {
      const bad: string[] = []; (window as any).staleDepthPublications = bad
      new MutationObserver(() => {
        const info = document.querySelector(".mission-depth .settings-info-tip")?.getAttribute("aria-label")?.split("\n") ?? []
        if (info.includes("OpenCode effective depth: 2")) bad.push("stale snapshot published")
        const menu = document.querySelector<HTMLSelectElement>(".mission-depth select")
        if (info.includes("OpenCode effective depth: 1") && menu && !menu.hasAttribute("aria-disabled")) bad.push("old snapshot unlocked")
      }).observe(document.querySelector(".mission-depth")!, { subtree: true, childList: true, characterData: true, attributes: true })
    })
    const locked = () => depthMenu(page).evaluate(menu => menu.getAttribute("aria-disabled") === "true")
    depth = 2; await invalidate(); await started
    assert.equal(await locked(), true)
    depth = 4; await invalidate(); release()
    await waitForDepthInfo(page, "OpenCode effective depth: 4")
    await waitForDepthReady(page)
    assert.equal(reads, 3)
    assert.deepEqual(await page.evaluate(() => (window as any).staleDepthPublications), [])
  } finally { release(); await page.close() }
})

for (const foreign of [false, true]) test(`a depth chosen during a held refresh is written after it ${foreign ? "only if no other writer changed the depth" : "against its fresh expectation"}`, async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let reads = 0, depth = 2, expectation = "e-2", release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  const writes: unknown[] = []
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", async route => {
      if (route.request().method() !== "GET") {
        writes.push(route.request().postDataJSON()); depth = route.request().postDataJSON().depth; expectation = `e-${depth}`
        return route.fulfill({ status: 204, body: "" })
      }
      if (++reads === 2) { reached(); await held }
      return route.fulfill({ json: { location: { directory: "fixture" }, capability: { minimum: 0 }, effectiveDepth: depth,
        project: { path: "fixture/opencode.jsonc", depth, expectation } } })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await openMissionSettings(page)
    const menu = depthMenu(page)
    await waitForDepthInfo(page, "OpenCode effective depth: 2")
    await page.evaluate(async () => {
      const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
      serverEvents.dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: { type: "config.updated" } } as any])
    })
    await started
    await menu.evaluate(element => { (element as HTMLSelectElement).value = "5"; element.dispatchEvent(new Event("change", { bubbles: true })) })
    assert.equal(await menu.inputValue(), "5", "the choice is shown while the refresh is held")
    if (foreign) { depth = 7; expectation = "e-foreign" }
    release()
    if (foreign) {
      await waitForDepthInfo(page, "OpenCode effective depth: 7")
      await waitForDepthReady(page)
      await page.waitForTimeout(150)
      assert.deepEqual(writes, [], "another writer's depth wins over the queued choice")
      assert.equal(await menu.inputValue(), "7")
    } else {
      await waitForDepthInfo(page, "OpenCode effective depth: 5")
      assert.deepEqual(writes, [{ location: { directory: "fixture" }, depth: 5, expectation: "e-2" }])
    }
  } finally { release(); await page.close() }
})

test("depth uncertainty stays at its original Location through pending navigation and remount, with no replay until explicit refresh", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let writes = 0, reads = 0, release!: () => void, reached!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  try {
    await setup(page, "remote")
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", async route => {
      if (route.request().method() === "GET") {
        reads++; const directory = new URL(route.request().url()).searchParams.get("directory")!
        return route.fulfill({ json: { location: { directory }, capability: { minimum: 0 }, effectiveDepth: null,
          project: { path: `${directory}/opencode.jsonc`, depth: directory === "fixture" ? 1 : 9, expectation: directory } } })
      }
      writes++; reached(); await hold
      return route.fulfill({ status: 503, json: { error: "Acknowledgement unknown" } })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await openMissionSettings(page)
    const menu = depthMenu(page), refresh = page.getByRole("button", { name: "Refresh project depth", exact: true })
    await waitForDepthInfo(page, "Project write target: fixture/opencode.jsonc")
    await waitForDepthInfo(page, "OpenCode configuration file: No document path")
    await waitForDepthReady(page)
    await menu.selectOption("2"); await started
    assert.equal(await refresh.count(), 0, "no refresh while the save is still pending")
    // The open Settings section follows the project's Location while the save is still pending.
    await fixtureCall(page, "directory", "other")
    await waitForDepthInfo(page, "Project write target: other/opencode.jsonc")
    await waitForDepthInfo(page, "OpenCode configuration file: No document path")
    assert.equal(await menu.inputValue(), "9", "the new Location cannot inherit the old pending choice")
    release()
    await fixtureCall(page, "directory", "fixture")
    await page.getByText("Save not confirmed. Your choice is kept; refresh before another change. No automatic retry.", { exact: true }).waitFor()
    await closeMissionSettings(page)
    await fixtureCall(page, "mount", false); await fixtureCall(page, "mount", true)
    await openMissionSettings(page)
    assert.equal(await menu.inputValue(), "2")
    assert.equal(await menu.isDisabled(), true, "an unconfirmed save locks the menu until an explicit refresh")
    await menu.evaluate(element => { (element as HTMLSelectElement).value = "4"; element.dispatchEvent(new Event("change", { bubbles: true })) })
    assert.equal(await menu.inputValue(), "2", "a forced change is refused")
    assert.equal(writes, 1)
    assert.equal(reads, 2)
    await refresh.click()
    assert.equal(await page.getByRole("button", { name: "Refresh project depth", exact: true, includeHidden: true }).isDisabled(), true)
    await page.getByRole("dialog").getByRole("button", { name: "Discard changes", exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".mission-depth select")?.value === "1")
    assert.equal(writes, 1)
    assert.equal(reads, 3)
  } finally { release(); await page.close() }
})

for (const close of [false, true]) test(`an open task reader's native task reads ${close ? "stop when it closes" : "go on while it stays open"}`, async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    const value = mission("reader-demand")
    value.coordinatorSessionId = "ses_reader_root"
    value.tasks[0].status = "dispatching"
    await page.route("**/api/workspaces/fixture/missions**", route => {
      if (isMissionContentRequest(route.request().url())) return route.fallback()
      return route.fulfill({ json: { available: true, missions: panelMissions([value]), generatedAt: value.revision, discardedEvents: 0 } })
    })
    // Hold the coordinator's message read: the children read only follows it.
    let held: Route | undefined
    const children: string[] = []
    page.on("request", request => { if (request.url().includes("parentID=ses_reader_root")) children.push(request.url()) })
    await page.route(target => target.href.includes("ses_reader_root") && target.pathname.includes("/message"), route => {
      if (!held) { held = route; return }
      return route.fulfill({ json: { data: [] } })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await selectMission(page, "Objective reader-demand")
    await until(() => Boolean(held), 15_000)
    await taskButton(page, "task-one").click()
    await page.locator(".mission-reader").getByRole("heading", { name: "Inspect evidence", level: 2 }).waitFor()
    // The hidden panel's tree releases its demand; the open reader is the last owner.
    await fixtureCall(page, "active", false)
    if (close) {
      await page.getByRole("button", { name: "Back to chat", exact: true }).click()
      await page.locator(".mission-reader").waitFor({ state: "detached" })
    }
    await held!.fulfill({ json: { data: [] } })
    if (close) await page.waitForTimeout(1_000)
    else await until(() => children.length > 0).catch(() => undefined)
    assert.equal(children.length > 0, !close, close ? `a closed reader reads nothing further: ${children.join(", ")}` : "an open reader lists the coordinator's children")
  } finally { await page.close() }
})

test("reader toggles highlight the exact visible content and toggle it off without navigation or writes", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    const value = mission("toggle"), writes: string[] = []
    value.history = [{ revision: 1, source: "user", reason: "Scope clarified", createdAt: 1, addedTaskKeys: [], retiredTasks: [], dependencyUpdates: [] }]
    await page.route("**/api/workspaces/fixture/missions**", route => {
      if (isMissionContentRequest(route.request().url())) return route.fallback()
      if (route.request().method() !== "GET") writes.push(route.request().method())
      return route.fulfill({ json: { available: true, missions: panelMissions([value]), generatedAt: value.revision, discardedEvents: 0 } })
    })
    await page.goto(url)
    await selectMission(page, "Objective toggle")
    const overview = readAll(page)
    const task = taskButton(page, "task-one")
    await overview.click()
    assert.equal(await overview.getAttribute("aria-pressed"), "true")
    await overview.click()
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await fixtureCall(page, "panelWidth", "280px")
    await task.click()
    assert.equal(await task.getAttribute("aria-pressed"), "true")
    assert.equal(await overview.getAttribute("aria-pressed"), "true", "the eye shows the task's open reader")
    await fixtureCall(page, "refresh")
    await fixtureCall(page, "mount", false); await fixtureCall(page, "mount", true)
    assert.equal(await task.getAttribute("aria-pressed"), "true")
    await task.click()
    assert.equal(await task.getAttribute("aria-pressed"), "false")
    assert.equal(await page.locator(".mission-reader").count(), 0)
    // Reports and plan changes are reached from the overview reader, never from the panel.
    assert.equal(await page.locator(".mission-control").getByRole("button", { name: /^(Reports|Plan changes|More)$/ }).count(), 0)
    await (await openResultHistory(page)).getByRole("button", { name: "Inspect evidence", exact: true }).click()
    await page.locator(".mission-reader").getByRole("heading", { name: "Inspect evidence", level: 2 }).waitFor()
    assert.equal(await overview.getAttribute("aria-pressed"), "false", "only the exact reader target is highlighted")
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    await (await openOverviewFold(page, "Plan changes")).getByRole("button", { name: "Scope clarified", exact: true }).click()
    await page.locator(".mission-reader").getByRole("heading", { name: "Plan changes", level: 2 }).waitFor()
    assert.equal(await overview.getAttribute("aria-pressed"), "false")
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    assert.equal(await page.locator(".mission-reader").count(), 0)
    assert.deepEqual(writes, [])
  } finally { await page.close() }
})

test("finished missions omit dead controls and duplicate report/cleanup sections without losing receipts", async () => {
  const page = await browser.newPage({ locale: "fr-FR", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    const value = { ...mission("minimal"), status: "completed" as const, summary: "Une livraison vérifiée avec ses preuves." }
    const cleanups = [{ deletionID: "deleted", missionID: "old", requestID: "cleanup", expectedRevision: 1, deleteManagedSessions: true,
      objective: "Ancienne mission", removed: 1, retained: 1, pending: 0, reasons: ["children"], createdAt: 1 }]
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions([value]), cleanups, generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    assert.equal(await page.locator(".mission-control").locator("form, textarea, .mission-index-primary").count(), 0)
    await pickLocalized(page, "Objective minimal")
    await selectedCard(page).locator(".mission-tree").waitFor()
    assert.equal(await selectedCard(page).getByText(value.summary, { exact: true }).count(), 0, "the result is read centrally")
    assert.equal(await page.locator(".mission-control .mission-cleanup").count(), 0, "settled cleanup history stays out of the panel")
    await readAll(page).click()
    const reader = page.locator(".mission-reader")
    await reader.getByText(value.summary, { exact: true }).waitFor()
    const folds = () => reader.locator("details.mission-report-technical > summary").allTextContents()
    assert.deepEqual(await folds(), ["Rapports", "Détails techniques"], "no empty plan history")
    const cleanup = reader.getByRole("button", { name: "Historique du nettoyage des conversations", exact: true })
    await cleanup.click()
    assert.equal(await page.locator(".mission-cleanup .mission-disclosure-trigger").count(), 1)
    await reader.getByText("Ancienne mission", { exact: true }).waitFor()
    await reader.getByText("Conservées car elles ont des conversations enfants.", { exact: true }).waitFor()
    await cleanup.click()
    for (const width of [440, 280, 390]) {
      await fixtureCall(page, "panelWidth", `${width}px`)
      if (width === 390) await page.setViewportSize({ width, height: 850 })
      await page.locator("aside").evaluate(element => { element.scrollTop = 0 })
      assert.equal(await page.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: screenshotPath(`mission-minimal-fr-${width}`) })
    }
  } finally { await page.close() }
})

test("mission journey exposes honest progress, real human requests and result-first readers without losing evidence", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 900 } })
  const errors: string[] = [], mutations: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await setup(page)
    const value: MissionMap = { ...mission("journey"), objective: "Ship reliable desktop navigation", tasks: [], reports: [], runState: "prepared" }
    let activity: Array<{ sessionId: string; state: "running" | "idle-without-report" }> = []
    await page.route("**/api/workspaces/fixture/missions**", route => {
      if (isMissionContentRequest(route.request().url())) return route.fallback()
      if (route.request().method() !== "GET") mutations.push(route.request().method())
      return route.fulfill({ json: { available: true, missions: panelMissions([value]), generatedAt: value.revision, discardedEvents: 0,
        activity: { generatedAt: value.revision, missions: [{ missionId: value.id, actors: activity }] } } })
    })
    const refresh = async () => {
      value.revision++
      const response = waitForMissionPanelRefresh(page)
      await fixtureCall(page, "refresh")
      await response
      await page.waitForFunction(revision => (window as any).missionFixture.snapshot().missions[0]?.revision === revision
        && (window as any).missionFixture.snapshot().status === "ready", value.revision)
    }
    const card = selectedCard(page), checklist = card.locator(".mission-tree")
    const capture = async (name: string, width: number, panelWidth: string, mobile = false) => {
      const target = mobile ? await browser.newPage({ locale: "en-US", viewport: { width, height: 844 }, isMobile: true, hasTouch: true }) : page
      try {
        if (mobile) {
          await setup(target)
          await target.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions([value]), generatedAt: value.revision, discardedEvents: 0,
            activity: { generatedAt: value.revision, missions: [{ missionId: value.id, actors: activity }] } } }))
          await target.goto(url)
          await selectMission(target, value.objective)
          await selectedCard(target).locator(".mission-tree").waitFor()
          if (name.includes("human-request")) {
            await fixtureCall(target, "seedActor")
            await fixtureCall(target, "event", { type: "form.created", data: { form: { id: "form-mobile", sessionID: "ses_background", title: "Choose a supported build route", fields: [{ type: "text", name: "route", label: "Build route" }] } } })
            await taskState(target, "inspect", "input").waitFor()
          }
        } else await target.setViewportSize({ width, height: 900 })
        await fixtureCall(target, "panelWidth", panelWidth)
        await target.locator("aside").evaluate(element => { element.scrollTop = 0 })
        assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        assert.equal(await target.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
        await target.screenshot({ path: screenshotPath(`mission-journey-${name}`) })
      } finally { if (mobile) await target.close() }
    }
    await page.goto(url)
    await selectMission(page, value.objective)
    await selectedStatus(page, "Prepared").waitFor({ state: "attached" })
    await checklist.getByText("Ready to start. Start the mission to build its plan.", { exact: true }).waitFor()
    assert.equal(await card.locator("form, textarea, .mission-disclosure:not(.mission-tree)").count(), 0, "no coordinator field or secondary disclosure besides the task tree")
    assert.equal(await missionToolbarAction(page, "Start mission").isEnabled(), true)
    await capture("before-wide", 1280, "440px")

    value.runState = "running"
    const task = mission("journey").tasks[0]
    value.tasks = [
      { ...task, id: "inspect", key: "inspect", title: "Inspect current navigation", status: "queued", actorSessionId: "ses_background", admissionId: "admission-inspect" },
      { ...task, id: "verify", key: "verify", title: "Verify desktop navigation", status: "blocked", blockedBy: ["inspect"] },
    ]
    value.actors = [{ sessionId: "ses_background", title: "Navigation investigator", kind: "specialist", managed: false, roles: ["research"], location: { directory: "fixture" }, joinedAt: 1 }]
    await fixtureCall(page, "seedActor")
    await refresh()
    await taskState(page, "inspect", "assigned").waitFor()
    assert.equal(await taskRow(page, "inspect").locator(".sr-only").textContent(), "Assigned", "admission is not evidence of running work")
    assert.equal(await taskRow(page, "verify").getAttribute("data-state"), "waiting")
    assert.equal(await card.getByText(/tasks done|%/).count(), 0, "declared task counts are not shown as progress")
    activity = [{ sessionId: "ses_background", state: "running" }]
    await refresh()
    await taskState(page, "inspect", "active").waitFor()
    await capture("during-wide", 1280, "440px")

    const evidence = ["Read-only SDK inventory: no full Xcode.", "```text\nSDK_PATH=/Applications/CommandLineTools\n```\n\n" + "Preserved evidence paragraph.\n\n".repeat(45) + "Final evidence sentinel: unchanged."]
    const blocked = { id: "report-obstacle", taskKey: "inspect", sessionId: "ses_background", outcome: "blocked" as const,
      summary: "The macOS build is blocked because full Xcode is unavailable.", evidence, next: ["Install Xcode or use the verified Windows path."], createdAt: 20 }
    value.tasks[0] = { ...value.tasks[0], status: "needs-input", report: blocked }
    value.reports = [blocked]
    activity = [{ sessionId: "ses_background", state: "idle-without-report" }]
    await refresh()
    await taskState(page, "inspect", "blocked").waitFor()
    assert.equal(await page.locator(".mission-control").getByText(blocked.summary, { exact: true }).filter({ visible: true }).count(), 0,
      "source prose belongs in the central reader, not duplicated in the tree")
    assert.equal(await missionRow(page, value.objective).locator(".session-item-expander").getAttribute("data-child-activity"), null, "a reported blockage is not a human request")
    await capture("technical-blocked-narrow", 1100, "280px")
    await capture("technical-blocked-mobile", 390, "390px", true)
    await page.setViewportSize({ width: 1280, height: 900 })
    await fixtureCall(page, "panelWidth", "440px")
    await taskButton(page, "inspect").click()
    const reader = page.locator(".mission-task-reader")
    await reader.getByText(blocked.summary, { exact: true }).waitFor()
    await reader.locator(".markdown-body p").filter({ hasText: blocked.summary }).waitFor()
    await reader.locator(".markdown-body pre code").filter({ hasText: "SDK_PATH=/Applications/CommandLineTools" }).waitFor()
    assert.equal(await reader.locator("details[open]").count(), 0, "result and evidence are immediately available; technical internals remain collapsed")
    const text = await reader.innerText()
    assert.ok(text.indexOf(blocked.summary) < text.indexOf("Task brief"))
    await page.screenshot({ path: screenshotPath("mission-journey-result-reader") })
    await reader.getByText("Final evidence sentinel: unchanged.", { exact: false }).waitFor()
    await page.locator(".mission-reader .window-body").evaluate(element => { element.scrollTop = element.scrollHeight })
    assert.ok(await page.locator(".mission-reader .window-body").evaluate(element => element.scrollTop) > 0)
    await page.screenshot({ path: screenshotPath("mission-journey-full-evidence") })
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    await taskButton(page, "verify").click()
    await page.locator(".mission-reader").getByText("No result recorded for this task yet.", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").getByRole("button", { name: /^Open / }).count(), 0, "an unbound task must not route to a generic coordinator")
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()

    await fixtureCall(page, "event", { type: "form.created", data: { form: { id: "form-journey", sessionID: "ses_background", title: "Choose a supported build route", fields: [{ type: "text", name: "route", label: "Build route" }] } } })
    // The asking task turns red and opens its question; the chevron carries it, the flag stays the mission's own.
    const row = missionRow(page, value.objective)
    await taskState(page, "inspect", "input").waitFor()
    assert.equal(await taskButton(page, "inspect").getAttribute("aria-description"), "Opens its question")
    assert.equal(await row.locator(".session-item-expander").getAttribute("data-child-activity"), "permission")
    assert.equal(await row.locator('.mission-row-flag[data-mark="permission"]').count(), 0, "a task's question is never the mission's flag")
    assert.equal(await card.locator(".mission-needs, .mission-attention-list").count(), 0, "questions live on their rows")
    await capture("human-request-mobile", 390, "390px", true)
    await fixtureCall(page, "event", { type: "permission.asked", data: { id: "permission-journey", sessionID: "ses_background", action: "shell", resources: ["npm run verify"] } })
    await fixtureCall(page, "event", { type: "form.created", data: { form: { id: "unrelated-form", sessionID: "ses_unrelated", title: "Unrelated request", fields: [] } } })
    await fixtureCall(page, "event", { type: "form.replied", data: { id: "form-journey", sessionID: "ses_background", answers: { route: "Windows" } } })
    await taskState(page, "inspect", "input").waitFor()
    assert.equal(await row.locator('.mission-row-flag[data-mark="permission"]').count(), 0, "an unrelated request belongs to no mission")
    await fixtureCall(page, "event", { type: "permission.replied", data: { requestID: "permission-journey", sessionID: "ses_background", response: "once" } })
    await taskState(page, "inspect", "blocked").waitFor()
    assert.equal(await row.locator(".session-item-expander").getAttribute("data-child-activity"), null)
    assert.equal(await page.locator(".mission-control").getByText(blocked.summary, { exact: true }).filter({ visible: true }).count(), 0)

    const old = { ...blocked, id: "old-report", taskKey: "retired", summary: "Obsolete failure from the cancelled build.", createdAt: 100 }
    const inspectResult = { ...blocked, id: "inspect-done", outcome: "completed" as const, summary: "Windows navigation is verified.", createdAt: 30 }
    const verifyResult = { ...inspectResult, id: "verify-done", taskKey: "verify", summary: "Independent desktop review passed.", createdAt: 40 }
    value.tasks = [
      { ...value.tasks[0], status: "completed", report: inspectResult },
      { ...value.tasks[1], status: "completed", report: verifyResult },
      { ...task, id: "retired", key: "retired", title: "Cancelled macOS build", status: "withdrawn", replacedByTaskKey: "verify", report: old },
    ]
    value.reports = [blocked, inspectResult, verifyResult, old]
    await refresh()
    await taskState(page, "verify", "done").waitFor()
    assert.equal(await taskRow(page, "retired").getAttribute("data-state"), "retired", "retired work stays visible in the dependency tree")
    assert.equal(await card.locator("p").count(), 0, "no awaiting-final or result prose in the panel")
    assert.equal(await card.getByText(old.summary, { exact: false }).filter({ visible: true }).count(), 0)
    const reports = await openResultHistory(page)
    await reports.locator("li").filter({ hasText: "Verify desktop navigation" }).getByText(/Complete/).waitFor()
    await reports.locator("li").filter({ hasText: "Cancelled macOS build" }).getByText(/Previous attempt/).waitFor()
    assert.equal(await reports.locator("li").count(), 4)
    const previous = reports.locator("li").filter({ hasText: "Inspect current navigation" }).filter({ hasText: /Previous attempt/ })
    await previous.getByRole("button").click()
    await page.locator(".mission-reader").getByText("Final evidence sentinel: unchanged.", { exact: false }).waitFor()
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    value.status = "completed"
    value.summary = "Desktop navigation shipped with an independent review and preserved evidence."
    await refresh()
    await selectedStatus(page, "Completed").waitFor({ state: "attached" })
    assert.equal(await card.getByText(value.summary, { exact: true }).count(), 0, "the result is read centrally")
    await readAll(page).click()
    await page.locator(".mission-reader").getByText(value.summary, { exact: true }).waitFor()
    await readAll(page).click()
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await capture("completed-wide", 1280, "440px")
    await capture("completed-mobile", 390, "390px", true)
    assert.deepEqual(blocked.evidence, evidence)
    assert.deepEqual(mutations, [])
    assert.deepEqual(errors, [])
  } catch (error) { console.error(await page.locator("body").innerText(), await fixtureCall(page, "snapshot")); throw error }
  finally { await page.close() }
})

test("current report readers honor task-owned results instead of stale history copies", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    const value = mission("authoritative-report")
    // Compact transport identities agree; the complete body still comes from the task's own result.
    const prefix = "Shared compact excerpt. ".repeat(12)
    const stale = { ...value.reports[0], summary: prefix + "Superseded historical copy.", evidence: ["Obsolete evidence."] }
    const current = { ...stale, summary: prefix + "Authoritative current task result.", evidence: ["Current source proof: exact bytes retained."], next: ["Proceed to independent review."] }
    value.tasks[0].report = current
    value.reports = [stale]
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions([value]), generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await selectMission(page, value.objective)
    await (await openResultHistory(page)).getByRole("button", { name: "Inspect evidence", exact: true }).click()
    await page.locator(".mission-reader").getByText(current.summary, { exact: true }).waitFor()
    await page.locator(".mission-reader").getByText(current.evidence[0], { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").getByText(stale.summary, { exact: true }).count(), 0)
  } finally { await page.close() }
})

test("paginated evidence copies its entire unchanged source without touching the system clipboard", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    await page.addInitScript(`Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async text => { window.fixtureCopiedEvidence = text } } })`)
    const value = mission("long-evidence")
    const source = "```text\nSDK inventory: first-page proof.\n" + "Unchanged raw evidence 😀\n".repeat(850) + "Final source sentinel: exact.\n```"
    value.reports[0].summary = "The full inventory is available below."
    value.reports[0].evidence = [source]
    value.tasks[0].report = value.reports[0]
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions([value]), generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await selectMission(page, value.objective)
    await (await openResultHistory(page)).getByRole("button", { name: "Inspect evidence", exact: true }).click()
    const evidence = page.locator(".mission-reader article").filter({ has: page.getByRole("heading", { name: "Evidence", exact: true }) })
    await evidence.getByText("SDK inventory: first-page proof.", { exact: false }).waitFor()
    await evidence.locator(".markdown-body pre code").filter({ hasText: "SDK inventory: first-page proof." }).waitFor()
    await evidence.locator(".window-toolbar").getByRole("button", { name: "Copy", exact: true }).click()
    await page.waitForFunction(source => (window as any).fixtureCopiedEvidence === source, source)
    const pager = evidence.getByRole("spinbutton")
    const pages = Number(await pager.getAttribute("max"))
    assert.ok(pages > 1)
    await pager.fill(String(pages))
    await evidence.getByText("Final source sentinel: exact.", { exact: false }).waitFor()
    await evidence.locator(".markdown-body p, .markdown-body pre").first().waitFor()
    await page.locator(".mission-reader .window-body").evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.screenshot({ path: screenshotPath("mission-evidence-last-page") })
    assert.equal(await evidence.locator(".markdown-body pre code").filter({ hasText: "Final source sentinel: exact." }).count(), 1,
      "paging must preserve fenced evidence as literal code rather than reinterpreting a fragment")
    assert.equal(await page.evaluate(() => (window as any).fixtureCopiedEvidence), source)
  } finally { await page.close() }
})

test("one Play control starts and resumes; partial Pause survives remount and Stop stays terminal", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    let current: MissionMap = { ...mission("lifecycle"), runState: "prepared" }
    const calls: any[] = []
    let failPause = true
    let failMap = false
    await page.route("**/api/workspaces/fixture/missions**", async route => {
      if (isMissionContentRequest(route.request().url())) return route.fallback()
      if (route.request().method() === "GET") return failMap
        ? route.fulfill({ status: 503, json: { error: "Map unavailable" } })
        : route.fulfill({ json: { available: true, missions: panelMissions([current]), generatedAt: 1, discardedEvents: 0 } })
      const input = route.request().postDataJSON()
      calls.push(input)
      current = { ...current, revision: current.revision + 1,
        runState: input.action === "start" ? "running" : input.action === "pause" ? "paused" : "stopped",
        status: input.action === "stop" ? "stopped" : "active",
        control: { id: "evt_control", missionID: current.id, requestID: input.requestId, expectedRevision: input.expectedRevision, action: input.action,
          ...(input.graceful ? { graceful: true } : {}), targets: [{ sessionID: "ses_fixture", location: { directory: "/fixture" } }], pending: [] },
      }
      if (input.action === "pause" && failPause) {
        failPause = false
        current.control!.pending = ["ses_fixture"]
        return route.fulfill({ status: 503, json: { code: "control-pending" } })
      }
      return route.fulfill({ json: { mission: current } })
    })
    await page.goto(url)
    await selectMission(page, current.objective)
    const play = primaryControl(page), stop = missionToolbarAction(page, "Stop mission permanently")
    await play.waitFor()
    assert.equal(await play.getAttribute("aria-label"), "Start mission")
    await play.click()
    await missionToolbarAction(page, "Pause mission").waitFor()
    await page.waitForFunction(() => !(document.querySelector('.mission-action-bar [aria-label="Pause mission"]') as HTMLButtonElement)?.disabled)
    await missionToolbarAction(page, "Pause mission").click()
    await page.getByRole("alert").getByText("Action not yet confirmed. Check status before retrying.").waitFor()
    await fixtureCall(page, "mount", false)
    await fixtureCall(page, "mount", true)
    assert.equal(await play.getAttribute("aria-label"), "Check control status", "an unresolved request offers a status check, never a second Pause")
    // The explicit panel refresh reconciles first, then resends the unconfirmed control with its original identity.
    assert.equal(await missionRefresh(page).getAttribute("aria-label"), "Refresh and resend the unconfirmed action")
    failMap = true
    const failedRead = waitForMissionPanelRefresh(page)
    await missionRefresh(page).click()
    await failedRead
    await page.waitForFunction(() => !(document.querySelector('.mission-picker-actions > button:last-child') as HTMLButtonElement)?.disabled)
    assert.equal(calls.length, 2, "a failed map read never authorizes a one-time resend")
    failMap = false
    await missionRefresh(page).click()
    await page.waitForFunction(() => { const button = document.querySelector<HTMLButtonElement>('.mission-action-bar [aria-label="Resume mission"]'); return Boolean(button && !button.disabled) })
    assert.equal(calls[1].requestId, calls[2].requestId)
    assert.equal(calls[1].expectedRevision, calls[2].expectedRevision)
    assert.equal(await play.getAttribute("aria-label"), "Resume mission")
    assert.equal(await missionRefresh(page).getAttribute("aria-label"), "Refresh mission map")
    assert.equal(await page.getByRole("button", { name: "Start mission", exact: true }).count(), 0)
    await play.evaluate(el => { (window as any).savedPlayControl = el })
    await play.click()
    await page.waitForFunction(() => !(document.querySelector('.mission-action-bar [aria-label="Pause mission"]') as HTMLButtonElement)?.disabled)
    assert.equal(await play.evaluate(el => el === (window as any).savedPlayControl), true)
    await stop.click()
    await page.getByRole("dialog").waitFor()
    assert.equal(calls.length, 4, "Stop first asks for confirmation")
    await page.getByRole("dialog").getByRole("button", { name: "Stop mission permanently", exact: true }).click()
    await selectedMissionTitle(page).filter({ hasText: "Objective lifecycle" }).waitFor()
    await selectedStatus(page, "Stopped").waitFor({ state: "attached" })
    // Inapplicable controls stay in place, disabled: no Play/Pause and no Stop for a terminal Mission.
    assert.equal(await play.isDisabled(), true)
    assert.equal(await stop.isDisabled(), true, "terminal Missions cannot be stopped again")
    await fixtureCall(page, "mount", false)
    await fixtureCall(page, "mount", true)
    assert.equal(await play.isDisabled(), true)
    assert.equal(await stop.isDisabled(), true)
    assert.equal(await missionMenuTrigger(page).count(), 1, "secondary actions live in the selection's overflow menu")
    await page.screenshot({ path: screenshotPath("mission-lifecycle-stopped") })
    assert.deepEqual(calls.map(call => call.action), ["start", "pause", "pause", "start", "stop"])
  } finally { await page.close() }
})

test("mission selection, focus and reader survive native invalidations, remount and restoration", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    await setup(page)
    let revision = 1
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions([mission("one"), { ...mission("two"), revision }]), generatedAt: revision, discardedEvents: 0 } }))
    await page.goto(url)
    assert.equal(await selectedCard(page).count(), 0, "two candidate Missions: nothing is selected or detailed by default")
    await selectMission(page, "Objective two")
    await (await openResultHistory(page)).getByRole("button", { name: "Inspect evidence", exact: true }).click()
    await page.locator(".mission-reader .markdown-body p").first().waitFor()
    await page.screenshot({ path: screenshotPath("mission-reader-browser") })
    await page.locator(".mission-reader .window-body").evaluate(el => { el.scrollTop = 600 })
    const task = taskButton(page, "task-one")
    await task.focus()
    revision++
    await fixtureCall(page, "refresh")
    await waitForMissionPanelRefresh(page)
    assert.equal(await task.evaluate(el => el === document.activeElement), true, "refreshed tree keeps its rows and focus")
    assert.ok(await page.locator(".mission-reader .window-body").evaluate(el => el.scrollTop) > 0)
    await fixtureCall(page, "mount", false)
    await fixtureCall(page, "mount", true)
    assert.ok(await page.locator(".mission-reader .window-body").evaluate(el => el.scrollTop) > 0)
    await fixtureCall(page, "flush")
    await page.reload()
    await page.locator(".mission-reader").waitFor()
    await selectedCard(page).waitFor()
    assert.equal(await selectedMissionTitle(page).innerText(), "Objective two")
    assert.equal(await (await inlineMissionEntry(page, "Objective two")).getAttribute("aria-current"), "true")
    assert.equal(await (await inlineMissionEntry(page, "Objective one")).getAttribute("aria-current"), null)
    await page.getByRole("button", { name: "Back to chat" }).click()
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await page.screenshot({ path: screenshotPath("mission-control-browser"), fullPage: true })
  } catch (error) { console.error(await page.locator("body").innerText()); throw error } finally { await page.close() }
})

test("edits keep drafts and original revision during refresh, and creation retries reuse request identity", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await setup(page)
    let revision = 1, failCreate = true, failDelete = true
    const creates: any[] = [], updates: any[] = [], deletions: any[] = []
    let list = [mission("one")]
    let cleanups: any[] = []
    await page.route("**/api/workspaces/fixture/missions**", async route => {
      if (isMissionContentRequest(route.request().url())) return route.fallback()
      const request = route.request(), body = request.postDataJSON()
      if (request.method() === "POST") {
        creates.push(body)
        // A reviewed pre-dispatch refusal proves no effect, so the same request may
        // be retried; unproven failures are held instead (isDefinitiveCreationRejection).
        if (failCreate) return route.fulfill({ status: 503, json: { code: "creation-capacity" } })
        const created = { ...mission("created"), objective: body.objective }; list.push(created)
        return route.fulfill({ json: { mission: created } })
      }
      if (request.method() === "PATCH") { updates.push(body); return route.fulfill({ status: 409, body: "Changed" }) }
      if (request.method() === "DELETE") {
        deletions.push(body); list = list.filter(m => m.id !== "created")
        cleanups = [{ missionID: "created", deletionID: "evt_fixture_delete", requestID: body.requestId, expectedRevision: body.expectedRevision,
          deleteManagedSessions: body.deleteManagedSessions, objective: "New mission objective", removed: 0, retained: 0, pending: failDelete ? 1 : 0, reasons: [], createdAt: 1 }]
        if (failDelete) { failDelete = false; return route.fulfill({ status: 503, body: "Cleanup pending" }) }
        return route.fulfill({ json: { deleted: true } })
      }
      return route.fulfill({ json: { available: true, missions: panelMissions(list.map(m => ({ ...m, revision }))), cleanups, generatedAt: revision, discardedEvents: 0 } })
    })
    await page.goto(url)
    await clickMissionAction(page, "Edit selected mission", "Objective one")
    await page.locator("form.mission-editor textarea").first().fill("My edited objective")
    revision++
    await fixtureCall(page, "refresh")
    await waitForMissionPanelRefresh(page)
    assert.equal(await page.locator("form.mission-editor textarea").first().inputValue(), "My edited objective")
    await page.locator("form.mission-editor button[type=submit]").first().click()
    await page.getByRole("alert").waitFor()
    assert.equal(updates[0].expectedRevision, 1)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await missionGeneralAction(page, "Create mission").click()
    await page.locator("form.mission-editor textarea").first().fill("New mission objective")
    await page.locator("form.mission-editor button[type=submit]").first().click()
    await page.getByRole("alert").waitFor()
    failCreate = false
    await page.locator("form.mission-editor button[type=submit]").first().click()
    await selectedMissionTitle(page).filter({ hasText: "New mission objective" }).waitFor()
    assert.equal(creates.length, 2)
    assert.equal(creates[0].requestId, creates[1].requestId)
    await clickMissionAction(page, "Delete selected mission…", "New mission objective")
    await page.getByText("Delete this mission? The coordinator and reused conversations will be kept.").waitFor()
    const cleanup = page.getByRole("checkbox", { name: "Also delete specialist conversations created for this mission" })
    assert.equal(await cleanup.isChecked(), false)
    await cleanup.check()
    await page.locator("form").getByRole("button", { name: "Delete mission", exact: true }).click()
    await page.getByRole("alert").getByText("Deletion could not be completed. Retry to finish the remaining cleanup.").waitFor()
    assert.equal(await cleanup.isDisabled(), true)
    await fixtureCall(page, "refresh")
    await page.locator("form").getByRole("button", { name: "Try again", exact: true }).click()
    await page.locator("form.mission-editor").waitFor({ state: "detached" })
    // Only the picker selects: deleting the selected Mission never falls back to
    // another one, even the current conversation's coordinator Mission.
    await selectedMissionTitle(page).waitFor({ state: "detached" })
    assert.equal(await selectedCard(page).count(), 0)
    await (await inlineMissionEntry(page, "Objective one")).waitFor()
    assert.equal(deletions.length, 2)
    assert.equal(deletions[0].deleteManagedSessions, true)
    assert.equal(deletions[0].requestId, deletions[1].requestId)
  } catch (error) { console.error(await page.locator("body").innerText()); throw error } finally { await page.close() }
})

test("a saved report remains visibly pending until native notification admission is acknowledged", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await setup(page)
    const value = mission("outbox")
    value.reports[0].notificationStatus = "pending"
    value.tasks[0].report = value.reports[0]
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: {
      available: true, missions: panelMissions([value]), generatedAt: value.revision, discardedEvents: 0,
    } }))
    await page.goto(url)
    await selectMission(page, value.objective)
    const reports = await openResultHistory(page)
    const pending = page.locator(".mission-reader").getByRole("status").filter({ hasText: "Coordinator notification pending" })
    await pending.waitFor()
    assert.equal(await page.locator(".mission-control").getByText(/notification pending/).count(), 0, "the note belongs to the overview reader")
    await reports.locator("li").getByText(/Complete/).waitFor()
    value.reports[0].notificationStatus = "admitted"
    value.revision++
    await fixtureCall(page, "refresh")
    await pending.waitFor({ state: "detached" })
    await reports.locator("li").getByText(/Complete/).waitFor()
  } finally { await page.close() }
})

test("dependency navigation reveals the linked task and revised plans retain readable old and new context", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 800 } })
  try {
    await setup(page)
    const value = mission("plan")
    value.tasks.push({ ...value.tasks[0], id: "task-next", key: "task-next", title: "Check the implementation", status: "blocked", blockedBy: ["task-one"] })
    value.history = [{ revision: 12, actorSessionId: "ses_fixture", reason: "The investigation changed the scope.", createdAt: 100,
      objective: { before: "Old objective", after: "Revised objective" }, addedTaskKeys: ["task-next"], retiredTasks: [],
      dependencyUpdates: [{ taskKey: "task-next", before: [], after: ["task-one"] }] },
      { revision: 13, source: "user", createdAt: 101, notes: { before: "Old notes", after: "Human clarification" }, addedTaskKeys: [], retiredTasks: [], dependencyUpdates: [] }]
    value.historyTruncated = true
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions([value]), generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await selectMission(page, value.objective)
    await taskButton(page, "task-next").click()
    await page.getByRole("button", { name: "Depends on Inspect evidence", exact: true }).click()
    await page.locator('.mission-task-reader[data-task-id="task-plan"]').waitFor()
    assert.equal(await taskRow(page, "task-one").locator(".mission-disclosure-trigger").count(), 0)
    await page.locator(".mission-reader").getByRole("heading", { name: "Inspect evidence", exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Back to chat")
    assert.equal(await page.getByRole("button", { name: "Back to chat", exact: true }).evaluate(el => el === document.activeElement), true)
    assert.equal(await page.locator(".mission-reader").getByRole("button", { name: /^(Blocks|Unblocks)/ }).count(), 0, "a completed task omits its trivial Unblocks pointer")
    const history = await openOverviewFold(page, "Plan changes")
    await history.getByText("Showing the latest 2 changes.").waitFor()
    await history.getByText(/· Coordinator$/).waitFor()
    await history.getByText(/· You$/).waitFor()
    await history.locator("li").first().getByRole("button").click()
    await page.locator(".mission-reader").getByText("Human clarification", { exact: true }).waitFor()
    await page.locator(".mission-reader").getByText("Old notes", { exact: true }).waitFor()
    await (await openOverviewFold(page, "Plan changes")).locator("li").last().getByRole("button").click()
    await page.locator(".mission-reader").getByText("Old objective", { exact: true }).waitFor()
    await page.locator(".mission-reader").getByText("Revised objective", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Back to chat", exact: true }).press("Escape")
    assert.equal(await page.locator(".mission-reader").count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  } finally { await page.close() }
})

test("background native questions settle and requested execution remains distinct from the current session", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 800, height: 850 } })
  try {
    await setup(page)
    const value = mission("attention")
    value.actors = [{ sessionId: "ses_background", title: "Background assistant", kind: "specialist", managed: false, roles: ["research"], location: { directory: "fixture" }, joinedAt: 1 }]
    value.tasks[0] = { ...value.tasks[0], actorSessionId: "ses_background", execution: { agent: "build", model: { providerID: "requested", id: "chosen", variant: "high" } } }
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions([value]), generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await selectMission(page, value.objective)
    await taskButton(page, "task-one").click()
    await openTaskTechnicalDetails(page)
    await fixtureCall(page, "seedActor")
    await page.locator(".mission-execution-cell", { hasText: "requested/chosen" }).waitFor()
    await page.locator(".mission-execution-cell", { hasText: "native/observed" }).waitFor()
    await page.locator('.mission-execution-cell[data-state="unknown"]', { hasText: "Unknown" }).waitFor()
    await fixtureCall(page, "event", { type: "form.created", data: { form: { id: "form-background", sessionID: "ses_background", title: "Choose the scope", fields: [{ type: "text", name: "scope", label: "Scope" }] } } })
    // Its only task is done: no live task row carries the actor's question, so the flag does.
    const flag = missionRow(page, value.objective).locator('.mission-row-flag[data-mark="permission"]')
    await flag.waitFor()
    assert.match(await missionEntryStatus(page, value.objective), /Awaiting your input/)
    await fixtureCall(page, "event", { type: "form.replied", data: { id: "form-background", sessionID: "ses_background", answers: {} } })
    await flag.waitFor({ state: "detached" })
    // The coordinator's conversation is the mission's toolbar once the task's reader closes.
    await page.getByRole("button", { name: "Back to chat" }).click()
    await clickMissionAction(page, "Open conversation")
    await page.getByRole("alert").getByText("Unable to reload session").waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await taskButton(page, "task-one").click()
    await openTaskTechnicalDetails(page)
    await page.locator(".mission-execution").scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath("mission-execution-browser"), fullPage: true })
  } finally { await page.close() }
})

test("the real session retains its transcript nodes and draft while a long mission report scrolls independently", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1000, height: 800 } })
  try {
    await setup(page)
    await page.route("**/api/workspaces/browser-instance/missions", route => route.fulfill({ json: { available: true, missions: panelMissions([mission("reader")]), generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/browser-instance/files/preview?*", route => route.fulfill({ json: { contents: "# Workspace reader\n\nFile preview content", encoding: "utf-8" } }))
    await page.goto(url.replace("/mission-fixture", "/mission-session-fixture"))
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.seedHistory())
    const transcript = page.locator(".mission-transcript-content")
    await transcript.getByText("History 59", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.locator(".mission-reader").waitFor()
    await page.evaluate(() => (window as any).fixture.readFile())
    await page.locator(".workspace-file-view").getByText("File preview content", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.locator(".mission-reader").waitFor()
    assert.equal(await page.locator(".workspace-file-view").count(), 0)
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    await transcript.evaluate(el => { (window as any).savedTranscript = el.firstElementChild })
    const composer = page.locator("textarea:visible").first()
    await composer.fill("Keep this draft while reading")
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.locator(".mission-reader").getByText("Report opening paragraph.", { exact: true }).waitFor()
    assert.equal(await transcript.getAttribute("inert"), "")
    assert.equal(await composer.inputValue(), "Keep this draft while reading")
    assert.equal(await transcript.evaluate(el => el.firstElementChild === (window as any).savedTranscript), true)
    await page.locator(".mission-reader .window-body").evaluate(el => { el.scrollTop = 900 })
    assert.ok(await page.locator(".mission-reader .window-body").evaluate(el => el.scrollTop) > 0)
    await page.screenshot({ path: screenshotPath("mission-session-reader-browser") })
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    assert.equal(await transcript.evaluate(el => el.firstElementChild === (window as any).savedTranscript), true)
    assert.equal(await composer.inputValue(), "Keep this draft while reading")
    await transcript.getByText("History 59", { exact: true }).waitFor()
  } finally { await page.close() }
})

test("compact mission rows retain a completed branching plan, direct readers and measured dependency edges", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    const value = mission("compact")
    value.objective = "Ship the Mission Centre"
    value.status = "completed"
    value.notes = "Full mission context belongs in the reader."
    const task = value.tasks[0]
    value.tasks = [
      { ...task, id: "publish", key: "publish", title: "Publish the changes", blockedBy: ["review", "verify"] },
      { ...task, id: "review", key: "review", title: "Independent review", blockedBy: ["implement"] },
      { ...task, id: "verify", key: "verify", title: "Browser verification", blockedBy: ["implement"] },
      { ...task, id: "implement", key: "implement", title: "Implement the interface", blockedBy: ["research", "design"] },
      { ...task, id: "research", key: "research", title: "Explore existing patterns", blockedBy: [] },
      { ...task, id: "design", key: "design", title: "Design the mission view", blockedBy: [] },
    ]
    value.reports[0].taskKey = "review"
    let missions = [value, { ...mission("other"), objective: "Validate desktop packaging", status: "completed" }]
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions(missions), generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await selectMission(page, "Ship the Mission Centre")
    assert.deepEqual(await page.locator(".mission-tree li").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.taskKey)), ["research", "design", "implement", "review", "verify", "publish"])
    // The tree is the dependency graph: its edges are drawn with the single task view, not behind a disclosure.
    await page.locator('.mission-graph path[data-from="review"][data-to="publish"]').waitFor()
    assert.equal(await page.locator(".mission-graph path[data-from]").count(), 6)
    assert.equal(await page.locator(".mission-checklist, .mission-route-task, .mission-detail .mission-disclosure:not(.mission-tree)").count(), 0, "no duplicate task list")
    const lastTask = await page.locator(".mission-tree li").last().boundingBox()
    assert.ok(lastTask && lastTask.y + lastTask.height < 800, "the complete plan fits at a normal panel height")
    await inlineMissionEntry(page, "Ship the Mission Centre")
    const indexRows = await missionRows(page).locator("button.mission-row-select").evaluateAll(rows => rows.map(row => row.getBoundingClientRect().toJSON()))
    assert.equal(indexRows.length, 2)
    assert.ok(indexRows[1].top >= indexRows[0].bottom)
    assert.equal(await page.locator(".mission-control-metrics").count(), 0)
    // Creation is a labelled icon in the general toolbar (accessible name and tooltip).
    const create = missionGeneralAction(page, "Create mission")
    assert.equal(await create.getAttribute("title"), "Create mission")
    await page.screenshot({ path: screenshotPath("mission-compact-overview") })
    await (await openResultHistory(page)).getByRole("button", { name: "Independent review", exact: true }).click()
    await page.locator(".mission-reader").getByText("Source proof", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Back to chat" }).click()
    await readAll(page).click()
    await page.locator(".mission-reader").getByText(value.notes, { exact: true }).waitFor()
    await page.getByRole("button", { name: "Back to chat" }).click()
    const edge = page.locator('.mission-graph path[data-from="review"][data-to="publish"]')
    const compactPath = await edge.getAttribute("d")
    await taskButton(page, "review").click()
    await page.locator(".mission-reader").getByRole("heading", { name: "Independent review", exact: true }).waitFor()
    assert.equal(await edge.getAttribute("d"), compactPath, "reading no longer expands task rows or changes graph geometry")
    // The task's open reader takes the header toolbar; Summary hands it back to the mission.
    assert.equal(await taskRow(page, "review").locator("button").count(), 1, "task rows carry no per-row controls")
    await missionToolbar(page).getByRole("button", { name: "Open the task's conversation", exact: true }).waitFor()
    assert.equal(await missionToolbar(page).locator(".mission-overview-toggle").getAttribute("aria-pressed"), "true")
    assert.equal(await missionToolbar(page).locator(".action-overflow-trigger").isDisabled(), true, "the mission's menu actions do not apply to a task")
    assert.equal(await missionToolbar(page).getByRole("button", { name: "Delete selected mission…", exact: true }).isDisabled(), true)
    await missionToolbar(page).locator(".mission-overview-toggle").click()
    await missionToolbar(page).getByRole("button", { name: "Open conversation", exact: true }).waitFor()
    assert.equal(await taskButton(page, "review").getAttribute("aria-pressed"), "false")
    await taskButton(page, "review").click()
    await page.locator(".mission-reader").getByRole("heading", { name: "Independent review", exact: true }).waitFor()
    await page.getByRole("button", { name: "Back to chat" }).click()
    await missionToolbar(page).getByRole("button", { name: "Open conversation", exact: true }).waitFor()
    await page.evaluate(() => { document.querySelector<HTMLElement>(".mission-control")!.style.zoom = "1.25" })
    // At fractional zoom an edge still ends on its dependent's status icon.
    await page.waitForFunction(() => {
      const edge = document.querySelector<SVGPathElement>('.mission-graph path[data-from="review"][data-to="publish"]')!
      const end = edge.getPointAtLength(edge.getTotalLength())
      const svg = edge.ownerSVGElement!, point = svg.createSVGPoint()
      point.x = end.x; point.y = end.y
      const screen = point.matrixTransform(svg.getScreenCTM()!)
      const mark = document.querySelector('[data-task-key="publish"] .mission-tree-mark')!.getBoundingClientRect()
      return Math.abs(screen.y - (mark.top + mark.height / 2)) < 1
    })
    await page.evaluate(() => { document.querySelector<HTMLElement>(".mission-control")!.style.zoom = "1" })
    await page.setViewportSize({ width: 320, height: 850 })
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.locator("aside").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.screenshot({ path: screenshotPath("mission-compact-rtl") })
    missions = [{ ...value, revision: 2, tasks: value.tasks.filter(task => task.key !== "publish") }]
    await fixtureCall(page, "refresh")
    await page.locator('.mission-tree [data-task-key="publish"]').waitFor({ state: "detached" })
    assert.equal(await page.locator(".mission-graph path[data-to=publish]").count(), 0)
  } finally { await page.close() }
})

test("top-level mission rows expose short one-line titles, semantic states, readers and the correct coordinator", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    const missions = (["active", "completed", "failed"] as const).map((status, i) => ({ ...mission(`row-${i}`), status,
      objective: `Mission ${i}: improve the desktop navigation and keep the whole project easy to understand`,
      notes: `Full context for mission ${i}`, coordinatorSessionId: `ses_coordinator_${i}` }))
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: panelMissions(missions), generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    // Rows carry the whole first sentence; CSS ellipsis shortens it at the row edge and the full context stays in the reader.
    const titleOf = (index: number) => missions[index].objective
    const rows: Locator[] = []
    for (const index of missions.keys()) rows.push(await inlineMissionEntry(page, titleOf(index)))
    for (const row of rows) {
      await row.waitFor()
      assert.equal(await row.locator(".neutral-badge").count(), 0, "one-time rows carry no mode badge")
    }
    assert.equal(await page.locator(".mission-control-header h2, .mission-control-overview").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Missions", exact: true }).count(), 0)
    assert.equal(await page.locator(".mission-control > .mission-disclosure").count(), 0, "no bottom disclosures")
    assert.equal(await selectedCard(page).count(), 0, "no detail until a Mission is selected")
    assert.equal(await selectedMissionTitle(page).count(), 0)
    // Each entry is one line: a status mark and the title; the state · time stays in the tooltip and screen-reader text.
    const parts = await rows[0].evaluate(el => [...el.children].map(child => child.getAttribute("class")!.split(" ")[0]))
    assert.deepEqual(parts, ["lucide", "session-item-title", "sr-only"])
    assert.match(await rows[0].locator(".sr-only").textContent() ?? "", /^In progress · /)
    assert.match(await rows[0].getAttribute("title") ?? "", new RegExp(`^${titleOf(0).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — In progress · `))
    const title = await rows[0].locator(".session-item-title").evaluate(el => ({ overflow: getComputedStyle(el).textOverflow, wrap: getComputedStyle(el).whiteSpace }))
    assert.deepEqual(title, { overflow: "ellipsis", wrap: "nowrap" })
    assert.equal(await rows[0].locator(".session-item-title").evaluate(el => el.scrollWidth > el.clientWidth), true, "the long title is visually shortened")
    const heights = await Promise.all(rows.map(row => row.evaluate(el => el.getBoundingClientRect().height)))
    const titleHeight = await rows[0].locator(".session-item-title").evaluate(el => el.getBoundingClientRect().height)
    assert.ok(heights.every(height => height < titleHeight * 2), "single-line rows")
    const marks = await Promise.all(rows.map(row => row.locator(".mission-row-flag").getAttribute("data-mark")))
    assert.deepEqual(marks, ["idle", "idle", "interrupted"], "only the resumable failure needs attention; history already present reads as seen")
    const colors = await missionRows(page).locator(".mission-row-flag").evaluateAll(items => items.map(el => getComputedStyle(el).color))
    assert.equal(new Set(colors).size, 2, "idle rows share the neutral mark")
    await rows[1].click()
    await selectedCard(page).waitFor()
    // The detail is the selected row's children: right after it in the tree, before the next row.
    assert.equal(await page.locator(".mission-control").evaluate(panel => {
      const selected = panel.querySelector(".mission-row:has(.mission-row-select[aria-current=true])")!, detail = panel.querySelector("section.mission-detail")!
      return selected.parentElement!.contains(detail) && Boolean(selected.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING)
    }), true)
    assert.equal(await selectedCard(page).locator("form, textarea, .mission-disclosure:not(.mission-tree), .mission-result").count(), 0)
    assert.equal(await rows[1].getAttribute("aria-current"), "true")
    // Measured while the pointer still rests on the selected row: hover overlays, never replaces, the highlight.
    const highlight = await page.evaluate(() => { const probe = document.createElement("div"); probe.style.background = "var(--list-item-highlight-bg)"; document.body.append(probe)
      const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color })
    // Rows animate their background; compare settled values, with and without the pointer over the row.
    const rowBase = rows[1].locator("xpath=ancestor::div[contains(@class, 'session-item-base')]")
    const settledBackground = async () => {
      await rowBase.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)))
      return rowBase.evaluate(el => getComputedStyle(el).backgroundColor)
    }
    await page.mouse.move(0, 0)
    assert.equal(await settledBackground(), highlight, "selection uses the shared list highlight, never the input-field surface")
    await rows[1].hover()
    await page.waitForFunction(() => Boolean(document.querySelector(".mission-row-select[aria-current=true]:hover")))
    assert.equal(await settledBackground(), highlight, "rollover overlays the selected highlight instead of replacing it")
    await readAll(page).click()
    await page.locator(".mission-reader").getByText("Full context for mission 1", { exact: true }).waitFor()
    assert.equal(await rows[1].getAttribute("aria-current"), "true")
    await fixtureCall(page, "seedCoordinators", missions.map(mission => mission.coordinatorSessionId))
    await rows[2].click()
    assert.equal(await rows[2].getAttribute("aria-current"), "true")
    await clickMissionAction(page, "Open conversation")
    await page.waitForFunction(() => (window as any).missionFixture.selectedSession() === "ses_coordinator_2")
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await page.screenshot({ path: screenshotPath("mission-top-level-rows") })
  } finally { await page.close() }
})

test("native activity stays separate from the plan and refreshes only while a Missions panel or reader owns demand", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 850 } })
  try {
    await setup(page)
    const value = mission("activity")
    value.tasks = []
    value.reports = []
    value.actors = (["running", "background", "idle", "unknown"] as const).map((name, index) => ({
      sessionId: `ses_${name}`, title: index === 2 ? "Previous investigation title" : `${name} actor`, kind: "specialist" as const,
      managed: true, roles: ["implementer"], location: { directory: "/fixture" }, joinedAt: index + 1,
    }))
    value.tasks = value.actors.map((actor, index) => ({
      id: `task-${index}`, key: `task-${index}`, title: index === 2 ? "Verify current native state" : `Current ${index}`,
      brief: "Brief", role: "implementer", status: "queued" as const, blockedBy: [], actorSessionId: actor.sessionId,
      admissionId: `admission-${index}`, outstandingExecution: false, createdAt: 1, updatedAt: 1,
    }))
    let requests = 0
    const response = () => ({ available: true, missions: panelMissions([value]), generatedAt: requests, discardedEvents: 0,
      activity: { generatedAt: requests, missions: [{ missionId: value.id, actors: [
        { sessionId: "ses_running", state: "running" },
        { sessionId: "ses_background", state: "background" },
        { sessionId: "ses_idle", state: "idle-without-report" },
        { sessionId: "ses_unknown", state: "unknown" },
      ] }] } })
    await page.route("**/api/workspaces/fixture/missions", route => { requests += 1; return route.fulfill({ json: response() }) })
    await page.goto(url)
    await selectMission(page, value.objective)
    // Observed native activity colours the tree's status icons; the declared plan stays the same rows.
    const states = () => page.locator(".mission-tree li").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.state))
    await taskState(page, "task-0", "active").waitFor()
    assert.deepEqual(await states(), ["active", "active", "assigned", "assigned"], "only observed running/background work is active")
    await taskRow(page, "task-2").getByText("Verify current native state", { exact: true }).waitFor()
    await taskButton(page, "task-2").click()
    await openTaskTechnicalDetails(page)
    assert.equal(await page.getByText("Assignment admitted", { exact: true }).count() > 0, true)

    const beforeToken = requests
    const refreshed = waitForMissionPanelRefresh(page)
    await fixtureCall(page, "refresh")
    await refreshed
    assert.ok(requests > beforeToken)
    assert.deepEqual(await states(), ["active", "active", "assigned", "assigned"])

    await fixtureCall(page, "mount", false)
    const readerOwned = requests
    const readerRefresh = waitForMissionPanelRefresh(page)
    await fixtureCall(page, "refresh")
    await readerRefresh
    assert.ok(requests > readerOwned, "the still-open central reader owns read-only refresh demand")
    await page.locator(".mission-reader").getByRole("button", { name: "Back to chat", exact: true }).click()
    await page.locator(".mission-reader").waitFor({ state: "detached" })
    const hidden = requests
    await fixtureCall(page, "refresh")
    await page.waitForTimeout(100)
    assert.equal(requests, hidden)
    const visibleRefresh = waitForMissionPanelRefresh(page)
    await fixtureCall(page, "mount", true)
    await visibleRefresh
    await taskState(page, "task-0", "active").waitFor()
    await page.screenshot({ path: screenshotPath("mission-native-activity") })
  } finally { await page.close() }
})
