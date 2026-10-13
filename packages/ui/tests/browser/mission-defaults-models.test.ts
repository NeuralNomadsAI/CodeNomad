import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-defaults-models"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-defaults-models", configureServer(s) { s.middlewares.use("/mission-defaults-models", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/mission-defaults-models", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-defaults-models.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-defaults-models`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const profiles = { coordinator: { agent: "root", model: { providerID: "p", id: "m", variant: "high" } }, roles: { specialist: { agent: "child" } } }
const modelID = "70d47119-e4c3-4b18-814b-3e72ff93a1b2"
const text = (page: Page, key: string) => page.evaluate(key => window.missionDefaultsModels.text(key), key)
const ensureOptions = async (page: Page) => { const summary = page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }); if (!await summary.evaluate(item => (item.parentElement as HTMLDetailsElement).open)) await summary.click() }
const openProfiles = async (page: Page) => { await ensureOptions(page); await page.locator("summary").filter({ hasText: await text(page, "missions.create.agents") }).click() }
const openModels = ensureOptions
const toggleOptions = (page: Page) => page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }).click()
const OBJECTIVE = "What should the mission do?", CREATE_ONLY = "Create"
const pickBrief = async (page: Page, id: string) => page.getByLabel(await text(page, "missions.create.brief.start"), { exact: true }).selectOption(id)
const nameBrief = async (page: Page, name: string) => {
  await page.getByRole("button", { name: await text(page, "missions.create.brief.saveAs"), exact: true }).click()
  await page.getByLabel(await text(page, "missions.models.name"), { exact: true }).fill(name)
}
const briefMenu = async (page: Page, key: string) => {
  await page.getByRole("button", { name: await text(page, "missions.create.brief.more"), exact: true }).click()
  await page.getByRole("menuitem", { name: await text(page, key), exact: true }).click()
}
const dispatchOwner = (page: Page, owner: Record<string, unknown>) => page.evaluate(async value => {
  const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
  serverEvents.dispatchBatch([{ type: "storage.configChanged", owner: "ui", value }])
}, owner)

async function setup(page: Page, initial: Record<string, unknown> = {}, delay?: Promise<void>) {
  const writes: Record<string, any>[] = [], creates: Record<string, any>[] = [], reads: string[] = [], errors: string[] = []
  let bucket: Record<string, any> = { unrelated: "keep", settings: { showThinkingBlocks: true, ...initial } }
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: { location: { directory: "/fixture" }, capability: null, effectiveDepth: null, project: null } }))
  await page.route("**/api/storage/config/ui*", async route => {
    if (route.request().method() === "GET") { if (delay) await delay; return route.fulfill({ json: bucket }) }
    const body = route.request().postDataJSON(), conditional = new URL(route.request().url()).searchParams.get("conditional")
    const patch = conditional ? body.patch : body
    if (conditional) {
      assert.equal(conditional, "missions-v1")
      for (const expected of body.expected) {
        const present = Object.prototype.hasOwnProperty.call(bucket.settings, expected.key)
        try { assert.equal(present, expected.present); if (present) assert.deepEqual(bucket.settings[expected.key], expected.value) }
        catch { return route.fulfill({ status: 409, json: { error: "Mission preferences changed" } }) }
      }
    }
    writes.push(patch)
    bucket = { ...bucket, ...patch, settings: { ...bucket.settings, ...patch.settings } }
    return route.fulfill({ json: bucket })
  })
  await page.route("**/api/workspaces/fixture/missions", route => {
    creates.push(route.request().postDataJSON())
    return route.fulfill({ status: 409, json: { code: "creation-uncertain", error: "Unknown native result" } })
  })
  await page.route("**/workspaces/fixture/instance/api/agent**", route => {
    if (!new URL(route.request().url()).search) reads.push(route.request().url())
    return route.fulfill({ json: { data: [{ id: "root", mode: "primary" }, { id: "child", mode: "subagent" }, { id: "all", mode: "all" }] } })
  })
  await page.route("**/workspaces/fixture/instance/api/model**", route => {
    if (!new URL(route.request().url()).search) reads.push(route.request().url())
    return route.fulfill({ json: { data: [{ providerID: "p", id: "m", enabled: true, capabilities: { tools: true }, variants: [{ id: "high" }] }] } })
  })
  return { writes, creates, reads, errors, bucket: () => bucket, replace: (value: Record<string, any>) => { bucket = value } }
}

test("creation waits for loaded defaults, summarizes exact choices and never fetches closed profile controls", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let release!: () => void
  const delay = new Promise<void>(resolve => { release = resolve })
  const fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles }] }, delay)
  try {
    await page.goto(url)
    await ensureOptions(page)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Loaded defaults")
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    assert.equal(fixture.reads.length, 0)
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.getByLabel(await text(page, "missions.defaults.summary")).filter({ hasText: "p/m / high" }).waitFor()
    await page.waitForTimeout(100)
    assert.equal(fixture.reads.length, 0, "summary is preference-only")
    await page.getByLabel("Playbook", { exact: true }).selectOption("wayfinder")
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.deepEqual(fixture.creates[0].profiles, { coordinator: profiles.coordinator,
      roles: Object.fromEntries(["cartographer", "research", "prototype", "grilling", "decision"].map(role => [role, profiles.roles.specialist])) })
    assert.equal(fixture.creates[0].directory, undefined)
    assert.equal(fixture.creates.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("explicit override survives playbook changes; closed and inactive controls do not refresh catalogs", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    await openProfiles(page)
    const agent = page.getByLabel("Coordinator · Agent", { exact: true })
    await agent.locator('option[value="root"]').waitFor({ state: "attached" }); await agent.selectOption("root")
    await page.getByLabel("Playbook", { exact: true }).selectOption("debug")
    assert.equal(await agent.inputValue(), "root", "template change retains an explicit override")
    await openProfiles(page)
    await page.evaluate(() => window.missionDefaultsModels.active(false))
    const before = fixture.reads.length
    await page.evaluate(async () => {
      const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
      serverEvents.dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: { type: "config.updated", id: "changed", created: 1, location: { directory: "/fixture" }, data: {} } }])
    })
    await page.waitForTimeout(150)
    assert.equal(fixture.reads.length, before)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("saved models store briefs only and manual use creates fresh authority requests; uncertain identity survives remount/default changes", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const model = { version: 1, id: modelID, name: "My reusable brief", objective: "Original objective", notes: "Shared notes", template: "custom", profiles }
  const fixture = await setup(page, { missionModels: [model] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    await openModels(page)
    await pickBrief(page, modelID)
    assert.equal(await page.getByLabel(OBJECTIVE, { exact: true }).inputValue(), model.objective)
    assert.equal(fixture.creates.length, 0, "loading a brief is not a launch")
    await nameBrief(page, "Second reusable brief")
    await toggleOptions(page); await toggleOptions(page)
    assert.equal(await page.getByLabel(await text(page, "missions.models.name"), { exact: true }).inputValue(), "Second reusable brief", "collapsing Options never discards the brief name draft")
    await page.getByRole("button", { name: await text(page, "missions.models.save"), exact: true }).click()
    await page.waitForFunction(() => window.missionDefaultsModels.preferences().missionModels.length === 2)
    assert.equal(fixture.writes.length, 1)
    const saved = fixture.writes[0].settings.missionModels[1]
    assert.deepEqual(Object.keys(saved).sort(), ["version", "id", "name", "objective", "notes", "template", "profiles"].sort())
    assert.notEqual(saved.id, model.id)
    assert.equal(fixture.bucket().unrelated, "keep"); assert.equal(fixture.bucket().settings.showThinkingBlocks, true)
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await page.getByRole("alert").waitFor()
    const submitted = fixture.creates[0]
    assert.deepEqual(submitted.profiles, profiles)
    assert.equal(submitted.coordinatorSessionID, undefined)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(async () => { await window.missionDefaultsModels.update({ missionProfileDefaults: [], missionModels: [] }); window.missionDefaultsModels.view("create") })
    await ensureOptions(page)
    await page.getByText(await text(page, "missions.models.current").then(value => value.replace("{name}", model.name)), { exact: true }).waitFor()
    assert.equal(await page.getByLabel(OBJECTIVE, { exact: true }).inputValue(), model.objective)
    await page.getByLabel(await text(page, "missions.defaults.summary")).filter({ hasText: "p/m / high" }).waitFor()
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    assert.equal(fixture.creates.length, 1, "no retry with new defaults")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("global preference drafts survive tab remount; explicit reload confirms discard and pending writes stay locked", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    assert.equal(await page.evaluate(() => window.missionDefaultsModels.discard()), true)
    await page.getByRole("button", { name: await text(page, "missions.defaults.reset"), exact: true }).click()
    await page.evaluate(() => window.missionDefaultsModels.view("closed"))
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await page.getByText(await text(page, "missions.preferences.unsaved"), { exact: true }).waitFor()
    const discarded = page.getByRole("button", { name: await text(page, "missions.defaults.reload"), exact: true }).click()
    await page.getByRole("dialog").waitFor()
    await page.getByRole("button", { name: await text(page, "settings.configFiles.confirmDiscard.cancelLabel"), exact: true }).click()
    await discarded
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), false)
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    await page.route("**/api/storage/config/ui*", async route => { await hold; return route.fulfill({ json: { settings: { missionProfileDefaults: [] } } }) })
    await page.getByRole("button", { name: "Save", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: await text(page, "missions.defaults.reload"), exact: true }).isDisabled(), true)
    release()
    await page.getByText(await text(page, "missions.preferences.unsaved"), { exact: true }).waitFor({ state: "hidden" })
    await page.evaluate(() => window.missionDefaultsModels.view("closed"))
    assert.equal(await page.evaluate(() => window.missionDefaultsModels.discard()), true, "unmounted guard cannot trap navigation")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("failed UI-owner reads stay fenced despite general readiness and server/state updates, then explicit reload recovers", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  let fail = true
  await page.route("**/api/storage/config/ui*", route => fail
    ? route.fulfill({ status: 503, json: { error: "UI owner unavailable" } })
    : route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles }] } } }))
  try {
    await page.goto(url)
    await ensureOptions(page)
    await page.waitForFunction(() => window.missionDefaultsModels.generalLoaded())
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Failed-load fence")
    assert.equal(await page.evaluate(() => window.missionDefaultsModels.loaded()), false)
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    await page.evaluate(async () => {
      const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
      serverEvents.dispatchBatch([{ type: "storage.configChanged", owner: "server", value: {} }, { type: "storage.stateChanged", owner: "ui", value: {} }])
    })
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    fail = false
    await page.getByRole("button", { name: await text(page, "missions.defaults.reload"), exact: true }).click()
    await page.getByLabel(await text(page, "missions.defaults.summary")).filter({ hasText: "p/m / high" }).waitFor()
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), false)
    assert.equal(fixture.creates.length, 0); assert.equal(fixture.reads.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("Use saved defaults explicitly resnapshots after Settings edits while a creation draft otherwise remains frozen", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles }] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    fixture.replace({ settings: { missionProfileDefaults: [{ template: "custom", profiles: { coordinator: { agent: "all" } } }] } })
    await page.getByLabel(await text(page, "missions.defaults.summary")).filter({ hasText: "p/m / high" }).waitFor()
    await openProfiles(page)
    await page.getByRole("button", { name: await text(page, "missions.defaults.use"), exact: true }).click()
    await page.getByLabel("Coordinator · Agent", { exact: true }).filter({ has: page.locator('option[value="all"]') }).waitFor()
    await page.waitForFunction(() => window.missionDefaultsModels.preferences().missionProfileDefaults[0]?.profiles.coordinator?.agent === "all")
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).inputValue(), "all")
    assert.equal(await page.getByLabel(await text(page, "missions.defaults.summary")).textContent().then(value => value?.includes("p/m")), false)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("invalid documents cannot masquerade as empty; explicit repair uses raw conditional expectations", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page, { missionModels: { corrupt: true }, missionProfileDefaults: [{ template: "unknown" }] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Invalid defaults fence")
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).isDisabled(), true)
    assert.equal(fixture.writes.length, 0)
    await page.getByRole("button", { name: await text(page, "missions.defaults.reset"), exact: true }).click()
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>('select[aria-label="Coordinator · Agent"]')?.disabled)
    await page.getByRole("button", { name: await text(page, "missions.models.reset"), exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: await text(page, "missions.models.reset"), exact: true }).click()
    await page.getByText(await text(page, "missions.models.invalid"), { exact: true }).waitFor({ state: "hidden" })
    assert.deepEqual(fixture.bucket().settings.missionProfileDefaults, [])
    assert.deepEqual(fixture.bucket().settings.missionModels, [])
    assert.equal(fixture.writes.length, 2)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("stale model saves and deletes fail closed without resurrecting another window's removal", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const model = { version: 1, id: modelID, name: "Deleted elsewhere", objective: "A task", notes: "", template: "custom" }
  const fixture = await setup(page, { missionModels: [model] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    await openModels(page)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Another brief")
    await nameBrief(page, "New model")
    fixture.replace({ settings: { missionModels: [] } })
    await page.getByRole("button", { name: await text(page, "missions.models.save"), exact: true }).click()
    await page.getByRole("alert").filter({ hasText: await text(page, "missions.models.error") }).waitFor()
    assert.deepEqual(fixture.bucket().settings.missionModels, [])
    assert.equal(await page.evaluate(() => window.missionDefaultsModels.loaded()), false)
    // Restore from an explicit authoritative read before exercising a separate
    // stale delete. The failed save never authorizes another mutation itself.
    fixture.replace({ settings: { missionModels: [model] } })
    await page.getByRole("button", { name: await text(page, "missions.models.reload"), exact: true }).click()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await pickBrief(page, modelID)
    fixture.replace({ settings: { missionModels: [] } })
    await briefMenu(page, "missions.models.remove")
    await page.getByRole("dialog").getByRole("button", { name: await text(page, "missions.models.remove"), exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(fixture.writes.length, 0)
    assert.deepEqual(fixture.bucket().settings.missionModels, [])
    assert.equal(fixture.creates.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("explicit defaults reload locks every profile-affecting control until its fenced result settles", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page, { missionModels: [{ version: 1, id: modelID, name: "Locked brief", objective: "A task", notes: "", template: "custom" }] })
  let release!: () => void, started!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { started = resolve })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    await openModels(page); await openProfiles(page)
    await page.getByLabel("Coordinator · Agent", { exact: true }).locator('option[value="root"]').waitFor({ state: "attached" })
    await page.route("**/api/storage/config/ui*", async route => { started(); await hold; return route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles }] } } }) })
    await page.getByRole("button", { name: await text(page, "missions.defaults.use"), exact: true }).click()
    await reached
    assert.equal(await page.getByLabel("Playbook", { exact: true }).isDisabled(), true)
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).isDisabled(), true)
    assert.equal(await page.getByLabel(await text(page, "missions.create.brief.start"), { exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: await text(page, "missions.create.brief.saveAs"), exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    release()
    await page.getByLabel(await text(page, "missions.defaults.summary")).filter({ hasText: "p/m / high" }).waitFor()
    assert.equal(await page.getByLabel("Playbook", { exact: true }).inputValue(), "custom")
    assert.equal(fixture.creates.length, 0); assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("late completion of other initial owner loads cannot republish the older UI document after an event", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/storage/config/server", async route => { await hold; return route.fulfill({ json: {} }) })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(async profiles => {
      const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
      serverEvents.dispatchBatch([{ type: "storage.configChanged", owner: "ui", value: { settings: { missionProfileDefaults: [{ template: "all", profiles }, { template: "custom", profiles }] } } }])
    }, profiles)
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.generalLoaded())
    assert.deepEqual(await page.evaluate(() => window.missionDefaultsModels.preferences().missionProfileDefaults), [{ template: "all", profiles }, { template: "custom", profiles }])
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("a saved brief manually creates independent fresh requests and explicit removal preserves executions", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const model = { version: 1, id: modelID, name: "Repeatable brief", objective: "Repeatable task", notes: "", template: "custom" }
  const fixture = await setup(page, { missionModels: [model], missionProfileDefaults: [{ template: "custom", profiles }] })
  await page.route("**/api/workspaces/fixture/missions", route => {
    fixture.creates.push(route.request().postDataJSON())
    return route.fulfill({ json: { mission: { id: `mission_${fixture.creates.length}` } } })
  })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    for (let launch = 0; launch < 2; launch++) {
      if (launch) await page.evaluate(() => window.missionDefaultsModels.view("create"))
      await openModels(page)
      await pickBrief(page, modelID)
      assert.equal(fixture.creates.length, launch, "loading a brief never launches automatically")
      await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
      await page.locator("form.mission-editor").waitFor({ state: "detached" })
    }
    assert.notEqual(fixture.creates[0].requestId, fixture.creates[1].requestId)
    assert.deepEqual(fixture.creates[0].profiles, profiles, "a brief without requested profiles uses current defaults")
    assert.deepEqual(fixture.creates[1].profiles, profiles)
    assert.equal(fixture.creates[0].missionID, undefined)
    assert.equal(fixture.creates[1].coordinatorSessionID, undefined)
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await page.getByLabel(await text(page, "missions.models.select"), { exact: true }).selectOption(modelID)
    await page.getByRole("button", { name: await text(page, "missions.models.remove"), exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(fixture.writes.length, 0)
    await page.getByRole("button", { name: await text(page, "missions.models.remove"), exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: await text(page, "missions.models.remove"), exact: true }).click()
    await page.waitForFunction(() => window.missionDefaultsModels.preferences().missionModels.length === 0)
    assert.deepEqual(fixture.writes, [{ settings: { missionModels: [] } }])
    assert.equal(fixture.creates.length, 2, "removing the model never deletes or recreates missions")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("scenario native defaults remain explicit while the inherit choice restores the global baseline", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles }] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await page.locator('.mission-preferences-scope select').selectOption("wayfinder")
    const mode = page.locator(".mission-default-inheritance select").first()
    assert.equal(await mode.inputValue(), "inherit")
    await mode.selectOption("native")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.waitForFunction(() => window.missionDefaultsModels.preferences().missionProfileDefaults.some(item => item.template === "wayfinder"))
    assert.deepEqual(fixture.bucket().settings.missionProfileDefaults.find((item: { template: string }) => item.template === "wayfinder").profiles.coordinator, {})
    await mode.selectOption("inherit")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.waitForFunction(() => window.missionDefaultsModels.preferences().missionProfileDefaults.find(item => item.template === "wayfinder")?.profiles.coordinator === undefined)
    await page.getByLabel(await text(page, "missions.defaults.summary")).filter({ hasText: "p/m / high" }).waitFor()
    assert.equal(fixture.writes.length, 2)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("earlier unrelated SSE during Save B is reconciled from owner authority before a fresh editor freezes profile B", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles }] })
  let release!: () => void, started!: () => void, reads = 0
  const hold = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { started = resolve })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    const agent = page.getByLabel("Coordinator · Agent", { exact: true })
    await agent.locator('option[value="all"]').waitFor({ state: "attached" }); await agent.selectOption("all")
    await page.route("**/api/storage/config/ui*", async route => {
      if (route.request().method() === "GET") { reads++; return route.fallback() }
      const body = route.request().postDataJSON()
      fixture.writes.push(body.patch)
      const initial = fixture.bucket()
      fixture.replace({ ...initial, settings: { ...initial.settings, unrelated: "earlier-window-field", ...body.patch.settings } })
      started(); await hold
      return route.fulfill({ json: fixture.bucket() })
    })
    await page.getByRole("button", { name: "Save", exact: true }).click(); await reached
    await dispatchOwner(page, { settings: { missionProfileDefaults: [{ template: "custom", profiles }], unrelated: "earlier-window-field" } })
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded() && window.missionDefaultsModels.preferences().missionProfileDefaults[0]?.profiles.coordinator?.agent === "all")
    assert.equal(reads, 1); assert.equal(fixture.writes.length, 1)
    await page.evaluate(() => window.missionDefaultsModels.view("create"))
    await ensureOptions(page)
    const summary = page.getByLabel(await text(page, "missions.defaults.summary"))
    await summary.filter({ hasText: "all" }).waitFor()
    assert.equal((await summary.textContent())?.includes("root"), false)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Freeze accepted B")
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(fixture.creates[0].profiles.coordinator.agent, "all")
    assert.equal(fixture.bucket().settings.unrelated, "earlier-window-field")
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("an acknowledged library write with continuously invalidated reads gates creation until explicit stable reload, without replay", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  let invalidate = true, reads = 0
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    await openModels(page)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Saved but owner unreadable")
    await nameBrief(page, "Accepted once")
    await page.route("**/api/storage/config/ui*", async route => {
      if (route.request().method() === "GET") {
        reads++
        if (invalidate) await dispatchOwner(page, { settings: { missionModels: [] } })
        return route.fulfill({ json: fixture.bucket() })
      }
      const body = route.request().postDataJSON()
      fixture.writes.push(body.patch)
      fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, ...body.patch.settings } })
      await dispatchOwner(page, { settings: { missionModels: [] } })
      return route.fulfill({ json: fixture.bucket() })
    })
    await page.getByRole("button", { name: await text(page, "missions.models.save"), exact: true }).click()
    await page.getByText(await text(page, "missions.defaults.reconciliationPending"), { exact: true }).waitFor()
    assert.equal(reads, 3); assert.equal(fixture.writes.length, 1)
    assert.equal(await page.evaluate(() => window.missionDefaultsModels.loaded()), false)
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    assert.equal(await page.getByLabel(await text(page, "missions.models.name"), { exact: true }).count(), 0, "acknowledged save is not offered as a duplicate retry")
    invalidate = false
    await page.getByRole("button", { name: await text(page, "missions.models.reload"), exact: true }).click()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    assert.equal(fixture.writes.length, 1); assert.equal(reads, 4)
    assert.equal(await page.evaluate(() => window.missionDefaultsModels.preferences().missionModels.length), 1)
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), false)
    assert.equal(fixture.creates.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("Creation and Settings summaries group requested tuples once and collapse all native defaults without catalog reads", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    const label = await text(page, "missions.defaults.summary"), native = await text(page, "missions.simple.profilesNative")
    assert.equal(await page.getByLabel(label).textContent(), native)
    await page.getByLabel("Playbook", { exact: true }).selectOption("debug")
    assert.equal(await page.getByLabel(label).textContent(), native)
    assert.equal(fixture.reads.length, 0)
    await page.evaluate(async () => {
      await window.missionDefaultsModels.update({ missionProfileDefaults: [{ template: "custom", profiles: {
        coordinator: { agent: "root" }, roles: { specialist: { agent: "child", model: { providerID: "p", id: "m", variant: "high" } } },
      } }] })
      window.missionDefaultsModels.view("settings")
    })
    await page.locator('.mission-preferences-scope select').selectOption("debug")
    const settingsSummary = (await page.getByLabel(label).textContent())!
    assert.equal(settingsSummary.match(/p\/m \/ high/g)?.length, 1)
    assert.equal(settingsSummary.match(/\bchild\b/g)?.length, 1)
    await page.evaluate(() => window.missionDefaultsModels.view("create"))
    await ensureOptions(page)
    await page.getByLabel("Playbook", { exact: true }).selectOption("debug")
    const creationSummary = (await page.getByLabel(label).textContent())!
    assert.equal(creationSummary, settingsSummary)
    assert.equal(creationSummary.match(/p\/m \/ high/g)?.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("initial mission readiness waits for a stable owner barrier when an earlier SSE invalidates the first authoritative response", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  const earlier = { settings: { missionProfileDefaults: [{ template: "custom", profiles: { coordinator: { agent: "root" } } }], unrelated: "earlier" } }
  const authoritative = { settings: { missionProfileDefaults: [{ template: "custom", profiles: { coordinator: { agent: "all" } } }], unrelated: "earlier" } }
  let releaseFirst!: () => void, releaseStable!: () => void, firstStarted!: () => void, stableStarted!: () => void, reads = 0
  const firstHold = new Promise<void>(resolve => { releaseFirst = resolve }), stableHold = new Promise<void>(resolve => { releaseStable = resolve })
  const firstReached = new Promise<void>(resolve => { firstStarted = resolve }), stableReached = new Promise<void>(resolve => { stableStarted = resolve })
  await page.route("**/api/storage/config/ui*", async route => {
    assert.equal(route.request().method(), "GET")
    if (++reads === 1) { firstStarted(); await firstHold }
    else { stableStarted(); await stableHold }
    return route.fulfill({ json: authoritative })
  })
  try {
    await page.goto(url); await firstReached
    await ensureOptions(page)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Initial stable profile B")
    await dispatchOwner(page, earlier)
    assert.equal(await page.evaluate(() => window.missionDefaultsModels.loaded()), false)
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    releaseFirst(); await stableReached
    assert.equal(await page.evaluate(() => window.missionDefaultsModels.loaded()), false, "an invalidated successful response is not initial readiness")
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    releaseStable()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.getByLabel(await text(page, "missions.defaults.summary")).filter({ hasText: "all" }).waitFor()
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(fixture.creates[0].profiles.coordinator.agent, "all")
    assert.equal(reads, 2); assert.equal(fixture.reads.length, 0)
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await page.evaluate(() => window.missionDefaultsModels.view("create"))
    assert.equal(reads, 2, "mounting another view does not re-run global initial loading")
    assert.deepEqual(fixture.errors, [])
  } finally { releaseFirst(); releaseStable(); await page.close() }
})

test("new independent Missions freeze task policy and expose only primary/all task agents without changing the coordinator or replaying uncertainty", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles: { coordinator: { agent: "root" } }, taskMode: "independent" }] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    const mode = page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true })
    assert.equal(await mode.inputValue(), "independent")
    assert.equal(fixture.reads.length, 0)
    await openProfiles(page)
    await page.locator("form.mission-editor").getByText("Optional task presets", { exact: true }).click()
    const task = page.getByLabel("Default task · Agent", { exact: true })
    await task.locator('option[value="root"]').waitFor({ state: "attached" })
    assert.equal(await task.locator('option[value="child"]').count(), 0)
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).locator('option[value="child"]').count(), 0)
    await task.selectOption("root")
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Independent policy snapshot")
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(fixture.creates[0].taskMode, "independent")
    assert.equal(fixture.creates[0].profiles.roles.specialist.agent, "root")
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(async () => { await window.missionDefaultsModels.update({ missionProfileDefaults: [{ template: "custom", profiles: {}, taskMode: "native" }] }); window.missionDefaultsModels.view("create") })
    await ensureOptions(page)
    assert.equal(await mode.inputValue(), "independent")
    assert.equal(await mode.isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    assert.equal(fixture.creates.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("playbook task policy can inherit again without resetting profiles or other preferences", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page, { missionProfileDefaults: [
    { template: "custom", profiles: {}, taskMode: "independent" },
    { template: "wayfinder", profiles: { coordinator: { agent: "root" } }, taskMode: "native" },
  ] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    const scope = page.locator(".mission-preferences-scope select")
    await scope.selectOption("wayfinder")
    const mode = page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true })
    assert.equal(await mode.inputValue(), "native")
    await mode.selectOption("inherit")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByText(await text(page, "missions.preferences.unsaved"), { exact: true }).waitFor({ state: "hidden" })
    assert.deepEqual(fixture.writes[0].settings.missionProfileDefaults, [
      { template: "all", profiles: {}, taskMode: "independent" },
      { template: "wayfinder", profiles: { coordinator: { agent: "root" } } },
    ])
    await scope.selectOption("all"); await mode.selectOption("native")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByText(await text(page, "missions.preferences.unsaved"), { exact: true }).waitFor({ state: "hidden" })
    await scope.selectOption("wayfinder")
    assert.equal(await mode.inputValue(), "inherit")
    await page.evaluate(() => window.missionDefaultsModels.view("create"))
    await ensureOptions(page)
    await page.getByLabel(await text(page, "missions.control.template"), { exact: true }).selectOption("wayfinder")
    assert.equal(await mode.inputValue(), "native")
    assert.equal(await mode.locator('option[value="inherit"]').count(), 0, "creation freezes an explicit policy")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("reset then a Flexible-only exception save keeps other Mission types unchanged after reload", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles: {}, taskMode: "independent" }] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    const mode = page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true })
    assert.equal(await mode.inputValue(), "independent", "an old global Flexible record still reads as global")
    await page.getByRole("button", { name: await text(page, "missions.defaults.reset"), exact: true }).click()
    await page.locator(".mission-preferences-scope select").selectOption("custom")
    await mode.selectOption("independent")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByText(await text(page, "missions.preferences.unsaved"), { exact: true }).waitFor({ state: "hidden" })
    assert.deepEqual(fixture.writes.at(-1)!.settings.missionProfileDefaults, [
      { template: "all", profiles: {} }, { template: "custom", profiles: {}, taskMode: "independent" },
    ])
    await page.reload(); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("create"))
    await ensureOptions(page)
    const template = page.getByLabel(await text(page, "missions.control.template"), { exact: true })
    assert.equal(await mode.inputValue(), "independent", "Flexible keeps its exception")
    for (const other of ["debug", "wayfinder"]) {
      await template.selectOption(other)
      assert.equal(await mode.inputValue(), "native", `${other} is unchanged by a Flexible exception`)
    }
    assert.equal(fixture.creates.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("native task defaults and independent preference edits keep global CAS drafts across remount without mutating existing Missions", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    assert.equal(await page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true }).inputValue(), "native")
    await openProfiles(page)
    await page.locator("form.mission-editor").getByText("Optional task presets", { exact: true }).click()
    const task = page.getByLabel("Default task · Agent", { exact: true })
    await task.locator('option[value="child"]').waitFor({ state: "attached" })
    assert.equal(await task.locator('option[value="root"]').count(), 0)
    await task.selectOption("child")
    await page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true }).selectOption("independent")
    assert.equal(await task.inputValue(), "child", "switching policy preserves an explicitly requested, now unavailable selection")
    assert.match(await task.locator('option[value="child"]').innerText(), /Unavailable/)
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    const mode = page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true })
    await mode.selectOption("independent")
    await page.evaluate(() => window.missionDefaultsModels.view("closed")); await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    assert.equal(await mode.inputValue(), "independent")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByText(await text(page, "missions.preferences.unsaved"), { exact: true }).waitFor({ state: "hidden" })
    assert.deepEqual(fixture.writes, [{ settings: { missionProfileDefaults: [{ template: "all", profiles: {}, taskMode: "independent" }] } }])
    assert.equal(fixture.creates.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})
