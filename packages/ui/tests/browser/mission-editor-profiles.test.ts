import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type {} from "./fixtures/mission-editor-lifetime"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { observeHeaderFixture } from "./header-fixture-diagnostics"

let browser: Browser, url: string
const OBJECTIVE = "What should the mission do?", CREATE_ONLY = "Create"
const openOptions = (page: Page) => page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }).click()
async function connect(page: Page) {
  // Module scripts with top-level await do not hold the document load event.
  // addInstance runs after client-state restoration and would overwrite an early connection.
  await page.waitForFunction(() => !!window.missionEditorLifetime)
  await page.evaluate(async () => {
    const instancesPath = "/src/stores/instances.ts", clientPath = "/src/stores/opencode-client.ts"
    const [{ updateInstance }, { getRootClient }] = await Promise.all([import(instancesPath), import(clientPath)])
    updateInstance("fixture", { client: getRootClient("fixture") })
  })
}
const openAgents = async (page: Page) => {
  const agents = page.locator("form.mission-editor summary").filter({ hasText: /^Agents and models$/ })
  const options = page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ })
  if (!await options.evaluate(summary => (summary.parentElement as HTMLDetailsElement).open)) await openOptions(page)
  await agents.click()
}
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-editor-profiles",
      routes: [
        { path: "/editor-profiles", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-editor-lifetime.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})

test("inactivation cancels visible catalog demand and late responses cannot populate the fenced editor", async () => {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = []
  let release!: () => void, started!: () => void, finished!: () => void, reads = 0, completions = 0
  const hold = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { started = resolve })
  const settled = new Promise<void>(resolve => { finished = resolve })
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/workspaces/fixture/missions**", route => new URL(route.request().url()).pathname.endsWith("/missions/scheduled")
    ? route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } }) : route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/missions/recurrence")
    ? recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] }) : {
    available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0,
  } }))
  await page.route("**/workspaces/fixture/instance/api/{agent,model}**", async route => {
    const request = new URL(route.request().url())
    // Other native UI consumers revalidate their explicitly selected directory
    // on config events. Count only this editor's native-default catalog reads.
    if (request.search || !/\/api\/(agent|model)$/.test(request.pathname)) {
      await route.fulfill({ json: { data: [] } }); return
    }
    if (++reads === 2) started()
    await hold
    try { await route.fulfill({ json: { data: route.request().url().includes("/agent") ? [{ id: "late-root", mode: "primary" }] : [] } }) }
    catch { /* The owned editor cancels its request on inactivation. */ }
    if (++completions === 2) finished()
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).count(), 0)
    await openAgents(page)
    await page.evaluate(async () => {
      const instancesPath = "/src/stores/instances.ts", clientPath = "/src/stores/opencode-client.ts"
      const [{ updateInstance }, { getRootClient }] = await Promise.all([import(instancesPath), import(clientPath)])
      updateInstance("fixture", { client: getRootClient("fixture") })
    })
    await reached
    await page.evaluate(() => window.missionEditorLifetime.activate(false))
    release(); await settled
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).locator('option[value="late-root"]').count(), 0)
    await page.evaluate(async () => {
      const eventsPath = "/src/lib/server-events.ts", { serverEvents } = await import(eventsPath)
      serverEvents.dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: {
        type: "config.updated", id: "hidden-config", created: 1, location: { directory: "/fixture" }, data: {},
      } }])
    })
    // A bounded quiet period covers the control's coalesced trailing-read delay.
    await page.waitForTimeout(150)
    assert.equal(reads, 2, "hidden invalidations do not schedule trailing catalog reads")
    assert.deepEqual(errors, [])
  } finally { release(); await page.close() }
})
after(async () => { await browser?.close(); })

test("real editor sends exact coordinator/reviewer model variants and deep-held unknown creation keeps them across remount", async () => {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = []
  const observer = observeHeaderFixture(page, "missionEditorLifetime")
  await observer.install()
  const writes: Array<Record<string, unknown>> = [], catalogReads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>{await new Promise(resolve=>window.releaseProfileState=resolve);return {isPrimary:true,restoreEnabled:true,snapshot:null}},saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui**", route => {
    if (route.request().method() !== "PATCH") return route.fulfill({ json: {} })
    const body = route.request().postDataJSON()
    assert.equal(new URL(route.request().url()).searchParams.get("conditional"), "missions-v1")
    assert.deepEqual(body.expected, [{ key: "missionProfileDefaults", present: false }])
    return route.fulfill({ json: body.patch })
  })
  await page.route("**/api/workspaces/fixture/missions**", route => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({
      version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [],
    }) })
    if (route.request().method() === "GET") return route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } })
    writes.push(route.request().postDataJSON())
    return route.fulfill({ status: 409, json: { code: "creation-uncertain", error: "Unknown native result" } })
  })
  await page.route("**/workspaces/fixture/instance/api/agent**", route => {
    catalogReads.push(route.request().url())
    return route.fulfill({ json: { data: [{ id: "root-only", mode: "primary" }, { id: "child-only", mode: "subagent" }, { id: "all", mode: "all" }, { id: "hidden", mode: "all", hidden: true }] } })
  })
  await page.route("**/workspaces/fixture/instance/api/model**", route => {
    catalogReads.push(route.request().url())
    const model = { status: "active", cost: [], limit: { context: 1, output: 1 } }
    return route.fulfill({ json: { data: [
      { ...model, providerID: "p", id: "m", name: "Model M", enabled: true, capabilities: { tools: true }, variants: [{ id: "high" }, { id: "low" }] },
      { ...model, providerID: "p", id: "disabled", name: "Disabled", enabled: false, capabilities: { tools: true }, variants: [] },
    ] } })
  })
  await page.route("**/workspaces/fixture/instance/api/provider**", route => route.fulfill({ json: { data: [{ id: "p", name: "Provider P" }] } }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => typeof (window as any).releaseProfileState === "function")
    assert.equal(await page.evaluate(() => typeof window.missionEditorLifetime), "undefined", "load precedes asynchronous instance registration")
    const connecting = connect(page)
    await page.evaluate(() => (window as any).releaseProfileState())
    await connecting
    assert.equal(catalogReads.length, 0, "a closed editor has no catalog demand")
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Profile fixture")
    await openOptions(page)
    await page.getByLabel("Playbook", { exact: true }).selectOption("debug")
    assert.equal(catalogReads.length, 0, "collapsed overrides have no catalog demand")
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).count(), 0)
    await openAgents(page)
    const root = page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }), child = page.locator("form.mission-editor").getByLabel("Specification reviewer · Agent", { exact: true })
    await root.locator('option[value="root-only"]').waitFor({ state: "attached" })
    assert.equal(await root.locator('option[value="child-only"]').count(), 0)
    assert.equal(await child.locator('option[value="root-only"]').count(), 0)
    assert.equal(await child.locator('option[value="hidden"]').count(), 0)
    await root.selectOption("root-only")
    await page.locator("form.mission-editor").getByLabel("Coordinator · Model", { exact: true }).selectOption(JSON.stringify(["p", "m"]))
    await page.locator("form.mission-editor").getByLabel("Coordinator · Thinking", { exact: true }).selectOption("high")
    await child.selectOption("child-only")
    await page.getByLabel("Specification reviewer · Model", { exact: true }).selectOption(JSON.stringify(["p", "m"]))
    await page.getByLabel("Specification reviewer · Thinking", { exact: true }).selectOption("low")
    await page.getByLabel("Standards reviewer · Agent", { exact: true }).selectOption("all")
    await page.getByLabel("Fresh validator · Agent", { exact: true }).selectOption("child-only")
    assert.equal(await page.locator("form.mission-editor .mission-profiles details").count(), 0, "every Debugging role sits directly in the one Agents and models fold")
    await page.getByLabel("Implementer · Agent", { exact: true }).selectOption("all")
    const geometry = await root.evaluate(select => ({ radius: getComputedStyle(select).borderRadius,
      rowWidth: select.closest("fieldset")!.getBoundingClientRect().width, formWidth: select.closest("form")!.getBoundingClientRect().width }))
    assert.equal(geometry.radius, "0px")
    assert.ok(geometry.rowWidth <= geometry.formWidth, "compact profile row fits the narrow editor")
    assert.equal(await page.getByLabel("Specification reviewer · Model", { exact: true }).locator('option').filter({ hasText: "disabled" }).count(), 0)
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "native creation result is unconfirmed" }).waitFor()
    const expected = { coordinator: { agent: "root-only", model: { providerID: "p", id: "m", variant: "high" } },
      roles: { "review-spec": { agent: "child-only", model: { providerID: "p", id: "m", variant: "low" } },
        "review-standards": { agent: "all" }, validator: { agent: "child-only" }, implementer: { agent: "all" } } }
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].profiles, expected)
    assert.equal(writes[0].directory, undefined, "catalog and creation retain native default directory")
    assert.deepEqual((await page.evaluate(() => window.missionEditorLifetime.held()))!.profiles, expected)
    // Later preferences are mutable defaults, not the identity of this admitted
    // request. Restoring its held draft must not consult or replay them.
    // A lone legacy `custom` entry now decodes as the explicit global `all`.
    const changedDefaults = [{ template: "all", profiles: { coordinator: { agent: "all", model: { providerID: "p", id: "m", variant: "low" } }, roles: { specialist: { agent: "all" } } } }]
    assert.deepEqual(await page.evaluate(async defaults => {
      const preferencesPath = "/src/stores/preferences.tsx", { updatePreferences, preferences } = await import(preferencesPath)
      const updated = await updatePreferences({ missionProfileDefaults: defaults })
      return { updated, defaults: preferences().missionProfileDefaults }
    }, changedDefaults), { updated: true, defaults: changedDefaults })
    assert.deepEqual((await page.evaluate(() => window.missionEditorLifetime.held()))!.profiles, expected)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await openAgents(page)
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Thinking", { exact: true }).inputValue(), "high")
    assert.equal(await page.getByLabel("Specification reviewer · Thinking", { exact: true }).inputValue(), "low")
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).inputValue(), "root-only")
    assert.equal(await page.getByLabel("Specification reviewer · Agent", { exact: true }).inputValue(), "child-only")
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    await page.getByRole("button", { name: "Refresh mission map", exact: true }).last().click()
    assert.equal(writes.length, 1)
    assert.equal(catalogReads.length, 2, "uncertain draft does not refresh or replace its original profile")
    assert.deepEqual(errors, [])
  } catch (error) {
    await observer.diagnose(message => console.error(message)).catch(() => undefined)
    throw error
  } finally { observer.detach(); await page.close() }
})

test("creation waits for owned defaults and sends their exact snapshot without opening catalog controls", async () => {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = [], writes: Array<Record<string, unknown>> = [], catalogs: string[] = []
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const profiles = { coordinator: { agent: "saved-root", model: { providerID: "p", id: "saved-model", variant: "high" } }, roles: { specialist: { agent: "saved-child", model: { providerID: "p", id: "child-model", variant: "low" } } } }
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui", async route => {
    await hold
    return route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles }] } } })
  })
  await page.route("**/api/workspaces/fixture/missions**", route => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname.endsWith("/missions/scheduled"))
      return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({
      version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [],
    }) })
    if (route.request().method() !== "GET") {
      writes.push(route.request().postDataJSON())
      return route.fulfill({ status: 409, json: { code: "creation-uncertain", error: "Unknown result" } })
    }
    return route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1 } })
  })
  await page.route("**/workspaces/fixture/instance/api/{agent,model}**", route => { catalogs.push(route.request().url()); return route.fulfill({ json: { data: [] } }) })
  try {
    await page.goto(url)
    await connect(page)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Saved default snapshot")
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    await openOptions(page)
    assert.equal(await page.getByLabel("Playbook", { exact: true }).isDisabled(), true)
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).count(), 0)
    await page.locator("form.mission-editor").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    assert.deepEqual(writes, [] as typeof writes, "pending defaults fence direct form admission, not just the Save button")
    release()
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).waitFor()
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
    assert.match(await page.locator("form.mission-editor").innerText(), /saved-root/)
    assert.match(await page.locator("form.mission-editor").innerText(), /saved-child/)
    assert.equal(await page.locator("form.mission-editor summary").filter({ hasText: /^Agents and models$/ }).evaluate(summary => (summary.parentElement as HTMLDetailsElement).open), false)
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).count(), 0)
    assert.deepEqual(catalogs, [])
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "native creation result is unconfirmed" }).waitFor()
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].profiles, profiles)
    assert.equal(writes[0].directory, undefined)
    assert.deepEqual(catalogs, []); assert.deepEqual(errors, [])
  } finally { release(); await page.close() }
})

test("recurring creation shares the draft, prefills its title and picks named conversations without budgets", async () => {
   const page = await browser.newPage({ locale: "en-US", timezoneId: "America/New_York", viewport: { width: 700, height: 1100 } })
  const errors: string[] = [], searches: URL[] = [], writes: Array<Record<string, unknown>> = []
  const profiles = { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m" } },
    roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } } }
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: {
    missionProfileDefaults: [{ template: "custom", profiles, taskMode: "independent" }],
  } } }))
  await page.route("**/api/workspaces/fixture/missions**", route => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname.endsWith("/missions/scheduled"))
      return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
    if (new URL(route.request().url()).pathname.endsWith("/capabilities")) return route.fulfill({ json: {
      location: { directory: "/fixture" }, api: { available: true }, enabled: true } })
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON())
      return route.fulfill({ status: 503, json: { error: "Recurrence creation unavailable or uncertain" } })
    }
    if (new URL(route.request().url()).pathname.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({
      version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [],
    }) })
    return route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1 } })
  })
  await page.route("**/workspaces/fixture/instance/api/location**", route => route.fulfill({ json: {
    directory: "/fixture", project: { id: "project" },
  } }))
  await page.route("**/workspaces/fixture/instance/api/session**", route => {
    const request = new URL(route.request().url()); searches.push(request)
    return route.fulfill({ json: { data: [{ id: "ses_reference", title: "Daily reference conversation" }], cursor: {} } })
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    assert.equal(await form.locator("details").first().locator(":scope > summary").innerText(), "Options")
    assert.equal(await form.locator(":scope > header").count(), 0, "the panel's Create button heads the form")
    assert.equal(await page.locator(".mission-picker-control").isVisible(), false, "the creation form replaces the current-mission line")
    assert.equal(await form.getByRole("button", { name: /start/i }).count(), 0, "creation never offers a start action; Play stays separate")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Daily review\nReview the latest work and report changes.")
    await form.locator(".mission-scheduling > summary").click()
    await form.getByLabel("Frequency", { exact: true }).selectOption("daily")
    await openOptions(page)
    const zone = form.getByLabel("Saved time zone (IANA)", { exact: true })
    assert.equal(await zone.inputValue(), "America/New_York", "the system zone stays the default")
    // Suggestions come from the runtime's own IANA list, when it has one.
    const suggestions = await zone.evaluate(input => [...((input as HTMLInputElement).list?.options ?? [])].map(option => option.value))
    assert.ok(suggestions.includes("Europe/Paris") && suggestions.includes("America/New_York"), "native time-zone suggestions")
    await zone.fill("Not/A_Time_Zone")
    assert.equal(await zone.getAttribute("aria-invalid"), "true")
    await form.getByRole("alert").filter({ hasText: "Enter a valid IANA time zone" }).waitFor()
    assert.equal(await form.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    await zone.fill("America/New_York")
    assert.equal(await zone.getAttribute("aria-invalid"), "false")
    const title = form.getByLabel("Title", { exact: true })
    assert.equal(await title.getAttribute("maxlength"), "60")
    assert.equal(await title.inputValue(), "Daily review")
    assert.equal(await form.locator("textarea").first().inputValue(), "Daily review\nReview the latest work and report changes.")
    assert.equal(await form.locator('input[type="number"]').count(), await form.locator('.mission-depth input[type="number"]').count() + 2,
      "scheduling exposes an optional duration end and shared launch quota")
    assert.doesNotMatch(await form.innerText(), /Publications|Native calls|Effect budget/)
    assert.equal(await form.getByLabel("Coordinator · Agent", { exact: true }).count(), 0)
    const overrides = form.locator("summary").filter({ hasText: /^Agents and models$/ })
    assert.equal(await overrides.evaluate(summary => (summary.parentElement as HTMLDetailsElement).open), false)
    await form.locator("textarea").first().fill("Updated daily review\nKeep the reference conversation in context.")
    assert.equal(await title.inputValue(), "Updated daily review")
    await title.fill("My daily schedule")
    await form.getByLabel("Frequency", { exact: true }).selectOption("immediate")
    assert.equal(await form.getByLabel(OBJECTIVE, { exact: true }).inputValue(), "Updated daily review\nKeep the reference conversation in context.")
    await form.getByLabel("Frequency", { exact: true }).selectOption("daily")
    assert.equal(await title.inputValue(), "My daily schedule")
    await form.locator(".mission-conversation-picker summary").click()
    await form.getByLabel("Search sessions", { exact: true }).fill("Daily")
    await form.getByLabel("Daily reference conversation", { exact: true }).check()
    assert.ok(searches.some(request => request.searchParams.get("search") === "Daily"))
    assert.ok(searches.every(request => request.searchParams.get("project") === "project"))
    assert.doesNotMatch(await form.innerText(), /ses_reference/)
    await form.locator(".mission-conversation-picker summary").click()
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
    const captureDirectory = process.env.CODENOMAD_MISSION_CAPTURE_DIR
    if (captureDirectory) {
      await mkdir(captureDirectory, { recursive: true })
      await page.screenshot({ path: path.join(captureDirectory, "creation-recurring.png"), fullPage: true })
    }
    await form.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await form.getByRole("alert").filter({ hasText: /unconfirmed/ }).waitFor()
    assert.equal(writes.length, 1)
    const configuration = writes[0].configuration as Record<string, unknown>
    assert.equal(configuration.title, "My daily schedule")
    assert.equal(configuration.objective, "Updated daily review\nKeep the reference conversation in context.")
    assert.deepEqual(configuration.watchedConversationIDs, ["ses_reference"])
    assert.deepEqual(configuration.profiles, profiles)
    assert.equal(configuration.taskMode, "independent")
    assert.equal("budgets" in writes[0], false)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the Playbook selector describes the selected playbook directly under it and follows the selection", async () => {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/workspaces/fixture/missions**", route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/missions/recurrence")
    ? recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] })
    : { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } }))
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await openOptions(page)
    const playbook = page.locator("form.mission-editor").getByLabel("Playbook", { exact: true })
    // The real accessible description: the select's aria-describedby target, rendered under it.
    const described = () => playbook.evaluate(select => {
      const target = document.getElementById(select.getAttribute("aria-describedby") ?? "")
      if (!target) return undefined
      const control = select.getBoundingClientRect(), text = target.getBoundingClientRect(), form = select.closest("form")!.getBoundingClientRect()
      return { text: target.textContent, below: text.top >= control.bottom && text.top - control.bottom <= 12, visible: text.height > 0,
        fits: text.left >= form.left && text.right <= form.right && target.scrollWidth <= target.clientWidth }
    })
    assert.equal(await playbook.inputValue(), "custom")
    assert.deepEqual(await described(), { text: "The coordinator chooses a dependency-aware plan for the objective.", below: true, visible: true, fits: true })
    await playbook.selectOption("wayfinder")
    assert.deepEqual(await described(), { text: "Maps uncertainties and works through bounded decisions with human questions.", below: true, visible: true, fits: true })
    const captureDirectory = process.env.CODENOMAD_MISSION_CAPTURE_DIR
    if (captureDirectory) {
      await mkdir(captureDirectory, { recursive: true })
      await page.locator("form.mission-editor .mission-create-options").screenshot({ path: path.join(captureDirectory, "creation-playbook-description.png") })
    }
    await playbook.selectOption("compare")
    assert.match((await described())!.text ?? "", /^Runs the same task with identical briefs on Model A and Model B/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
