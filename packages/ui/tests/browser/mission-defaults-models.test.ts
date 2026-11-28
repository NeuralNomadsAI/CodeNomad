import assert from "node:assert/strict"
import { openMissionProfiles } from "./mission-actions"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import type {} from "./fixtures/mission-defaults-models"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
    name: "mission-defaults-models",
    routes: [
      { path: "/mission-defaults-models", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-defaults-models.tsx"></script></body></html>' },
    ],
  })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

const profiles = { coordinator: { agent: "root", model: { providerID: "p", id: "m", variant: "high" } }, roles: { specialist: { agent: "child" } } }
/** A native catalog entry; its display name is "Model <ID>". */
const nativeModel = (id: string, variants: { id: string }[] = []) => ({ providerID: "p", id, name: `Model ${id.toUpperCase()}`, status: "active",
  enabled: true, capabilities: { tools: true }, cost: [], limit: { context: 1, output: 1 }, variants })
const modelID = "70d47119-e4c3-4b18-814b-3e72ff93a1b2"
const text = (page: Page, key: string) => page.evaluate(key => window.missionDefaultsModels.text(key), key)
// An unknown creation result keeps its request held: the footer offers only reading the original back.
const uncertainCreation = async (page: Page) => page.getByRole("button", { name: await text(page, "missions.control.refresh"), exact: true }).waitFor()
const ensureOptions = async (page: Page) => {
  await page.getByLabel("Playbook", { exact: true }).waitFor()
  await page.getByLabel(await text(page, "missions.create.brief.start"), { exact: true }).waitFor()
  assert.equal(await page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }).count(), 0)
}
const openProfiles = async (page: Page) => {
  await openMissionProfiles(page)
  await page.getByLabel("Coordinator · Agent", { exact: true }).waitFor()
}
const openModels = ensureOptions
/** Settings folds every agent/model choice under one "Agents and models" disclosure. */
const openSettingsProfiles = openMissionProfiles
const OBJECTIVE = "Objective", CREATE_ONLY = "Create"
const pickBrief = async (page: Page, id: string) => page.getByLabel(await text(page, "missions.create.brief.start"), { exact: true }).selectOption(id)
const nameBrief = async (page: Page, name: string) => {
  await page.getByRole("button", { name: await text(page, "missions.create.brief.saveAs"), exact: true }).click()
  assert.equal(await page.getByLabel(await text(page, "missions.models.name"), { exact: true }).inputValue(),
    await page.getByLabel("Title", { exact: true }).inputValue(), "saving starts from the Mission title")
  await page.getByLabel(await text(page, "missions.models.name"), { exact: true }).fill(name)
}
const briefMenu = async (page: Page, key: string) => {
  await page.getByRole("button", { name: await text(page, "missions.create.brief.more"), exact: true }).click()
  await page.getByRole("menuitem", { name: await text(page, key), exact: true }).click()
}
/** Settings save each choice at once: wait until the nth write reached the server and its reply is applied. */
async function waitForWrites(page: Page, fixture: { writes: unknown[] }, count: number) {
  for (let attempt = 0; fixture.writes.length < count; attempt++) {
    if (attempt > 500) throw new Error(`Expected ${count} writes, saw ${fixture.writes.length}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await page.waitForFunction(() => window.missionDefaultsModels.loaded())
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
  await events.route(page)
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
    return route.fulfill({ json: { data: [nativeModel("m", [{ id: "high" }])] } })
  })
  await page.route("**/workspaces/fixture/instance/api/provider**", route => {
    if (!new URL(route.request().url()).search) reads.push(route.request().url())
    return route.fulfill({ json: { data: [{ id: "p", name: "Provider P" }] } })
  })
  return { writes, creates, reads, errors, bucket: () => bucket, replace: (value: Record<string, any>) => { bucket = value } }
}

test("configuration progress names save, confirmation, removal and read separately", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  let release = () => {}, gate = Promise.resolve()
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Progress")
    await nameBrief(page, "Progress")
    await page.route("**/api/storage/config/ui*", async route => { await gate; return route.fallback() })
    gate = new Promise<void>(resolve => { release = resolve })
    await page.getByRole("button", { name: await text(page, "missions.models.save"), exact: true }).click()
    await page.getByRole("status").filter({ hasText: /^Saving configuration…$/ }).waitFor()
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.preferences().missionModels.length === 1)
    await pickBrief(page, fixture.bucket().settings.missionModels[0].id)
    await briefMenu(page, "missions.models.remove")
    assert.equal(await page.locator(".mission-brief-picker [role=status]").count(), 0, "confirmation has not started a write")
    gate = new Promise<void>(resolve => { release = resolve })
    await page.getByRole("dialog").getByRole("button", { name: await text(page, "missions.models.remove"), exact: true }).click()
    await page.getByRole("status").filter({ hasText: /^Removing configuration…$/ }).waitFor()
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.preferences().missionModels.length === 0)
    gate = new Promise<void>(resolve => { release = resolve })
    await briefMenu(page, "missions.models.reload")
    await page.getByRole("status").filter({ hasText: /^Reloading configurations…$/ }).waitFor()
    release()
    await page.getByRole("status").filter({ hasText: /^Reloading configurations…$/ }).waitFor({ state: "detached" })
    assert.equal(fixture.writes.length, 2)
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("saving a configuration under the same name requires confirmation and keeps its ID", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const model = { version: 1, id: modelID, name: "Release brief", objective: "Original objective", notes: "", template: "custom" }
  const fixture = await setup(page, { missionModels: [model] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await pickBrief(page, modelID)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Updated objective")
    await nameBrief(page, ` ${model.name} `)
    const field = page.getByLabel(await text(page, "missions.models.name"), { exact: true })
    const dialog = page.getByRole("dialog")
    const confirm = dialog.getByRole("button", { name: "Replace", exact: true })
    await field.press("Enter")
    await confirm.waitFor({ timeout: 4000 })
    assert.equal(fixture.writes.length, 0)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await field.and(page.locator(":focus")).waitFor()
    assert.equal(await field.inputValue(), ` ${model.name} `)
    assert.equal(fixture.writes.length, 0)
    await field.press("Enter")
    await dialog.getByRole("button", { name: "Cancel", exact: true }).and(page.locator(":focus")).waitFor()
    await page.keyboard.press("Tab")
    await confirm.and(page.locator(":focus")).waitFor()
    await page.keyboard.press("Enter")
    await field.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: await text(page, "missions.create.brief.saveAs"), exact: true }).and(page.locator(":focus")).waitFor()
    assert.equal(fixture.writes.length, 1)
    assert.deepEqual(fixture.bucket().settings.missionModels, [{ ...model, objective: "Updated objective" }])
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Third objective")
    await nameBrief(page, model.name)
    await field.press("Enter")
    await confirm.click()
    await field.waitFor({ state: "hidden" })
    assert.equal(fixture.writes.length, 2)
    assert.deepEqual(fixture.bucket().settings.missionModels, [{ ...model, objective: "Third objective" }])
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("renaming or deleting a loaded duplicate-name configuration conflicts instead of overwriting its namesake", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const otherID = "00000000-0000-4000-8000-000000000002"
  const first = { version: 1, id: modelID, name: "Release brief", objective: "Objective A", notes: "", template: "custom" }
  const second = { version: 1, id: otherID, name: "Release brief", objective: "Objective B", notes: "", template: "custom" }
  const fixture = await setup(page, { missionModels: [first, second] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await pickBrief(page, first.id)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Edited A")
    await nameBrief(page, first.name)
    const field = page.getByLabel("Configuration name", { exact: true })
    const renamed = { ...first, name: "Release brief archived" }
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionModels: [renamed, second] } })
    await dispatchOwner(page, fixture.bucket())
    await field.press("Enter")
    await page.getByRole("alert").filter({ hasText: "Reload saved configurations, then try again." }).waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await field.inputValue(), first.name)
    assert.deepEqual(fixture.bucket().settings.missionModels, [renamed, second])
    assert.equal(fixture.writes.length, 0)
    // Deleting the loaded entry leaves only its namesake; saving still conflicts instead of selecting the other ID.
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionModels: [second] } })
    await dispatchOwner(page, fixture.bucket())
    await page.getByRole("button", { name: "Reload saved configurations", exact: true }).click()
    await page.getByRole("alert").waitFor({ state: "detached" })
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="Configuration name"]')?.disabled)
    await field.press("Enter")
    await page.getByRole("alert").filter({ hasText: "Reload saved configurations, then try again." }).waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.deepEqual(fixture.bucket().settings.missionModels, [second])
    assert.equal(fixture.writes.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("editing a loaded configuration elsewhere before opening Save reports a conflict instead of losing those changes", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const model = { version: 1, id: modelID, name: "Release brief", objective: "Original objective", notes: "Original notes", template: "custom" }
  const fixture = await setup(page, { missionModels: [model] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await pickBrief(page, modelID)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Local objective")
    const changed = { ...model, notes: "Notes edited elsewhere" }
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionModels: [changed] } })
    await dispatchOwner(page, fixture.bucket())
    await nameBrief(page, model.name)
    const field = page.getByLabel("Configuration name", { exact: true })
    await field.press("Enter")
    await page.getByRole("alert").filter({ hasText: "Reload saved configurations, then try again." }).waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await field.inputValue(), model.name)
    assert.deepEqual(fixture.bucket().settings.missionModels, [changed])
    assert.equal(fixture.writes.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("saving a fresh draft binds repeat saves to its saved baseline and conflicts on concurrent notes edits", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page)
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Fresh objective v1")
    await page.getByLabel("Notes", { exact: true }).fill("Initial notes")
    await nameBrief(page, "My draft")
    const field = page.getByLabel("Configuration name", { exact: true })
    await field.press("Enter")
    await field.waitFor({ state: "hidden" })
    assert.equal(fixture.writes.length, 1)
    const saved = fixture.bucket().settings.missionModels[0]
    assert.equal(saved.name, "My draft")
    // Same-baseline repeat save from the still-open draft replaces the same ID after confirmation.
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Fresh objective v2")
    await page.getByRole("button", { name: "Save configuration", exact: true }).click()
    await field.fill("My draft")
    await field.press("Enter")
    await page.getByRole("dialog").getByRole("button", { name: "Replace", exact: true }).click()
    await field.waitFor({ state: "hidden" })
    assert.equal(fixture.writes.length, 2)
    const updated = fixture.bucket().settings.missionModels[0]
    assert.equal(updated.id, saved.id)
    assert.equal(updated.objective, "Fresh objective v2")
    // Concurrent notes edit elsewhere before the next save must conflict instead of overwriting newer notes.
    const remote = { ...updated, notes: "Notes edited elsewhere" }
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionModels: [remote] } })
    await dispatchOwner(page, fixture.bucket())
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Fresh objective v3")
    await page.getByRole("button", { name: "Save configuration", exact: true }).click()
    await field.fill("My draft")
    await field.press("Enter")
    await page.getByRole("alert").filter({ hasText: "Reload saved configurations, then try again." }).waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await field.inputValue(), "My draft")
    assert.deepEqual(fixture.bucket().settings.missionModels, [remote])
    assert.equal(fixture.writes.length, 2)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("saving a copy from a loaded configuration binds repeat saves to the copy baseline without losing concurrent notes", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const original = { version: 1, id: modelID, name: "Release brief", objective: "Objective A", notes: "Notes A", template: "custom" }
  const fixture = await setup(page, { missionModels: [original] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await pickBrief(page, original.id)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Copy objective v1")
    await nameBrief(page, "My draft")
    const field = page.getByLabel("Configuration name", { exact: true })
    await field.press("Enter")
    await field.waitFor({ state: "hidden" })
    assert.equal(fixture.writes.length, 1)
    assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), original.name)
    const copy = fixture.bucket().settings.missionModels.find((item: { name: string }) => item.name === "My draft")
    assert.ok(copy && copy.id !== original.id)
    // Same-baseline repeat save updates the copy while keeping its ID and leaving the original intact.
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Copy objective v2")
    await page.getByRole("button", { name: "Save configuration", exact: true }).click()
    await field.fill("My draft")
    await field.press("Enter")
    await page.getByRole("dialog").getByRole("button", { name: "Replace", exact: true }).click()
    await field.waitFor({ state: "hidden" })
    assert.equal(fixture.writes.length, 2)
    const copyV2 = fixture.bucket().settings.missionModels.find((item: { id: string }) => item.id === copy.id)
    assert.equal(copyV2.objective, "Copy objective v2")
    assert.deepEqual(fixture.bucket().settings.missionModels.find((item: { id: string }) => item.id === original.id), original)
    // Concurrent notes edit on the copy elsewhere before saving again must report a conflict.
    const remoteCopy = { ...copyV2, notes: "Copy notes edited elsewhere" }
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionModels: [original, remoteCopy] } })
    await dispatchOwner(page, fixture.bucket())
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Copy objective v3")
    await page.getByRole("button", { name: "Save configuration", exact: true }).click()
    await field.fill("My draft")
    await field.press("Enter")
    await page.getByRole("alert").filter({ hasText: "Reload saved configurations, then try again." }).waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await field.inputValue(), "My draft")
    assert.deepEqual(fixture.bucket().settings.missionModels, [original, remoteCopy])
    assert.equal(fixture.writes.length, 2)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("a held save that completes while the editor is hidden retains its baseline for the same draft without retargeting another draft", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page)
  let release = () => {}, reached = () => {}
  let hold = new Promise<void>(resolve => { release = resolve })
  let started = new Promise<void>(resolve => { reached = resolve })
  let holdWrite = false
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.route("**/api/storage/config/ui*", async route => {
      if (holdWrite && route.request().method() !== "GET") { reached(); await hold }
      return route.fallback()
    })
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Hidden save v1")
    await page.getByLabel("Notes", { exact: true }).fill("Initial notes")
    await nameBrief(page, "My draft")
    const field = page.getByLabel("Configuration name", { exact: true })
    holdWrite = true
    await field.press("Enter")
    await started
    // Switch away (editor stays mounted while hidden), then let the in-flight save succeed.
    await page.evaluate(() => window.missionDefaultsModels.active(false))
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded() && window.missionDefaultsModels.preferences().missionModels.length === 1)
    assert.equal(fixture.writes.length, 1)
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest(".mission-brief-save"))), false, "completing while hidden does not steal focus")
    const saved = fixture.bucket().settings.missionModels[0]
    const remote = { ...saved, notes: "Remote notes while hidden" }
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionModels: [remote] } })
    await dispatchOwner(page, fixture.bucket())
    // Return to the same mounted draft: editing only objective and saving under the same name must conflict.
    await page.evaluate(() => window.missionDefaultsModels.active(true))
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Hidden save v2")
    await page.getByRole("button", { name: "Save configuration", exact: true }).click()
    await field.fill("My draft")
    await field.press("Enter")
    await page.getByRole("alert").filter({ hasText: "Reload saved configurations, then try again." }).waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.deepEqual(fixture.bucket().settings.missionModels, [remote])
    assert.equal(fixture.writes.length, 1)
    // A late save completion from a replaced/closed draft must never bind a new draft to its baseline.
    hold = new Promise<void>(resolve => { release = resolve })
    started = new Promise<void>(resolve => { reached = resolve })
    await field.fill("Other draft")
    await field.press("Enter")
    await started
    await page.evaluate(() => { window.missionDefaultsModels.view("closed"); window.missionDefaultsModels.view("create") })
    holdWrite = false
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded() && window.missionDefaultsModels.preferences().missionModels.length === 2)
    const other = fixture.bucket().settings.missionModels.find((item: { name: string }) => item.name === "Other draft")
    const remoteOther = { ...other, notes: "Edited elsewhere" }
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionModels: [remote, remoteOther] } })
    await dispatchOwner(page, fixture.bucket())
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Brand new draft")
    await nameBrief(page, "Other draft")
    await field.press("Enter")
    await page.getByRole("dialog").getByRole("button", { name: "Replace", exact: true }).waitFor()
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(fixture.writes.length, 2)
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("a full library with duplicate names replaces only the loaded configuration", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const name = "A configuration whose name is longer than the sixty-character Mission title"
  const models = Array.from({ length: 20 }, (_, index) => ({
    version: 1, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: index < 2 ? name : `Configuration ${index}`, objective: `Objective ${index}`, notes: "", template: "custom",
  }))
  const fixture = await setup(page, { missionModels: models })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("A draft")
    await nameBrief(page, name)
    const save = page.locator(".mission-brief-save").getByRole("button", { name: "Save configuration", exact: true })
    assert.equal(await save.isDisabled(), true)
    await page.getByText("Load the configuration you want to replace or use a different name.", { exact: true }).waitFor()
    const field = page.getByLabel("Configuration name", { exact: true })
    await field.press("Escape")
    await pickBrief(page, models[1].id)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Updated objective")
    await page.getByRole("button", { name: "Save configuration", exact: true }).click()
    assert.equal(await field.inputValue(), name)
    await field.press("Enter")
    await page.getByRole("dialog").getByRole("button", { name: "Replace", exact: true }).click()
    await field.waitFor({ state: "hidden" })
    const stored = fixture.bucket().settings.missionModels
    assert.equal(stored.length, 20)
    assert.deepEqual(stored.find(item => item.id === models[0].id), models[0])
    assert.deepEqual(stored.find(item => item.id === models[1].id), { ...models[1], objective: "Updated objective" })
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("confirming replacement does not overwrite a concurrent edit", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const model = { version: 1, id: modelID, name: "Release brief", objective: "Original objective", notes: "", template: "custom" }
  const fixture = await setup(page, { missionModels: [model] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await pickBrief(page, modelID)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Local draft")
    await nameBrief(page, model.name)
    const field = page.getByLabel("Configuration name", { exact: true })
    await field.press("Enter")
    const replace = page.getByRole("dialog").getByRole("button", { name: "Replace", exact: true })
    await replace.waitFor()
    const changed = { ...model, objective: "Other window" }
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionModels: [changed] } })
    await dispatchOwner(page, fixture.bucket())
    await replace.click()
    await page.getByRole("alert").filter({ hasText: "Reload saved configurations, then try again." }).waitFor()
    assert.equal(await field.inputValue(), model.name)
    assert.deepEqual(fixture.bucket().settings.missionModels, [changed])
    assert.equal(fixture.writes.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("creation waits for loaded defaults and exposes exact requested choices", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let release!: () => void
  const delay = new Promise<void>(resolve => { release = resolve })
  const fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles }] }, delay)
  try {
    await page.goto(url)
    await ensureOptions(page)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Loaded defaults")
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await openProfiles(page)
    await page.getByLabel("Coordinator · Model", { exact: true }).locator("option:checked").filter({ hasText: "Model M" }).waitFor({ state: "attached" })
    assert.equal(await page.getByLabel("Coordinator · Thinking", { exact: true }).inputValue(), "high")
    await page.getByLabel("Playbook", { exact: true }).selectOption("wayfinder")
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await uncertainCreation(page)
    assert.deepEqual(fixture.creates[0].profiles, { coordinator: profiles.coordinator,
      roles: Object.fromEntries(["cartographer", "research", "prototype", "grilling", "decision"].map(role => [role, profiles.roles.specialist])) })
    assert.equal(fixture.creates[0].directory, undefined)
    assert.equal(fixture.creates.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("explicit override survives playbook changes; inactive controls do not refresh catalogs", async () => {
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
    assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), model.name)
    assert.equal(await page.getByLabel("Notes", { exact: true }).inputValue(), model.notes)
    assert.equal(await page.getByLabel("Playbook", { exact: true }).inputValue(), model.template)
    const picker = page.getByLabel(await text(page, "missions.create.brief.start"), { exact: true })
    assert.equal(await picker.evaluate(select => {
      const first = select.closest("form")!.querySelector("input, textarea, select")
      return first === select
    }), true, "the configuration picker is the first form field")
    assert.equal(fixture.creates.length, 0, "loading a brief is not a launch")
    await page.getByRole("checkbox", { name: "Start automatically", exact: true }).check()
    await nameBrief(page, "Second reusable brief")
    await page.getByLabel("Notes", { exact: true }).focus()
    assert.equal(await page.getByLabel(await text(page, "missions.models.name"), { exact: true }).inputValue(), "Second reusable brief", "editing another field keeps the configuration name draft")
    await page.getByRole("button", { name: await text(page, "missions.models.save"), exact: true }).click()
    await page.waitForFunction(() => window.missionDefaultsModels.preferences().missionModels.length === 2)
    assert.equal(fixture.writes.length, 1)
    const saved = fixture.writes[0].settings.missionModels[1]
    assert.deepEqual(Object.keys(saved).sort(), ["version", "id", "name", "objective", "notes", "template", "profiles"].sort())
    assert.notEqual(saved.id, model.id)
    assert.equal(fixture.bucket().unrelated, "keep"); assert.equal(fixture.bucket().settings.showThinkingBlocks, true)
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await uncertainCreation(page)
    const submitted = fixture.creates[0]
    assert.deepEqual(submitted.profiles, profiles)
    assert.equal(submitted.coordinatorSessionID, undefined)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(async () => { await window.missionDefaultsModels.update({ missionProfileDefaults: [], missionModels: [] }); window.missionDefaultsModels.view("create") })
    await ensureOptions(page)
    assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), model.name)
    assert.equal(await page.getByLabel(OBJECTIVE, { exact: true }).inputValue(), model.objective)
    assert.equal(await page.getByLabel("Coordinator · Model", { exact: true }).inputValue(), JSON.stringify(["p", "m"]))
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    assert.equal(fixture.creates.length, 1, "no retry with new defaults")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("configuration names preserve punctuation and suffixes, shorten only at the title bound and leave manual titles intact", async () => {
  const punctuation = "Release: Windows and Linux", suffix = "Audit. Follow-up; release notes!"
  const long = "Release: Windows and Linux release validation for desktop and remote clients"
  const emoji = "🚀".repeat(29)
  const cases = [
    { name: punctuation, expected: punctuation }, { name: suffix, expected: suffix },
    { name: "Release:\n Windows\tand Linux", expected: punctuation },
    { name: long, expected: long.slice(0, 60).trimEnd() },
    { name: `${emoji}X🚀Remaining`, expected: `${emoji}X` },
  ]
  const models = cases.map((item, index) => ({ version: 1, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: item.name, objective: "A different objective. Keep its instructions separate.", notes: "Verbatim notes", template: "custom" }))
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page, { missionModels: models })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    const title = page.getByLabel("Title", { exact: true })
    for (const [index, item] of cases.entries()) {
      await pickBrief(page, models[index].id)
      assert.equal(await title.inputValue(), item.expected)
      assert.ok((await title.inputValue()).length <= 60)
      assert.equal(await page.getByLabel("Notes", { exact: true }).inputValue(), "Verbatim notes")
    }
    await title.fill("Custom: Final title — Windows.")
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Changed objective: another sentence.")
    await dispatchOwner(page, fixture.bucket())
    assert.equal(await title.inputValue(), "Custom: Final title — Windows.")
    assert.deepEqual(fixture.writes, []); assert.deepEqual(fixture.creates, []); assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("each preference choice saves at once; edits made during a write keep focus, queue behind it and survive remount", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 0, "no separate save step")
    const mode = page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true })
    await page.route("**/api/storage/config/ui*", async route => { if (route.request().method() !== "GET") await hold; return route.fallback() })
    await mode.focus(); await mode.selectOption("independent")
    assert.equal(await mode.evaluate(element => element === document.activeElement), true, "a running write never disables the focused field")
    await page.locator(".mission-preferences-scope select").selectOption("debug")
    await mode.selectOption("native")
    await page.evaluate(() => window.missionDefaultsModels.view("closed"))
    assert.equal(await page.evaluate(() => window.missionDefaultsModels.discard()), true, "no unsaved draft can trap navigation")
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    assert.equal(await mode.inputValue(), "native", "queued edits show at once, across remount")
    assert.equal(fixture.writes.length, 0)
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded() && window.missionDefaultsModels.preferences().missionProfileDefaults.length === 2)
    assert.deepEqual(fixture.writes.map(write => write.settings.missionProfileDefaults), [
      [{ template: "all", profiles: {}, taskMode: "independent" }],
      [{ template: "all", profiles: {}, taskMode: "independent" }, { template: "debug", profiles: {}, taskMode: "native" }],
    ], "each edit applies to the value stored at its turn")
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("a rejected choice is not resent: an edit made from it is refused, an independent one still applies to the stored values", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    const mode = page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true }), scope = page.locator(".mission-preferences-scope select")
    await page.route("**/api/storage/config/ui*", async route => { if (route.request().method() !== "GET") await hold; return route.fallback() })
    await mode.selectOption("independent")
    await mode.selectOption("native")
    await scope.selectOption("debug")
    await mode.selectOption("native")
    // Another window changes the document before the held write reaches the server.
    const other = { template: "wayfinder", profiles: {}, taskMode: "independent" }
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionProfileDefaults: [other] } })
    release()
    await waitForWrites(page, fixture, 1)
    await page.getByRole("alert").filter({ hasText: await text(page, "missions.defaults.error") }).waitFor()
    assert.deepEqual(fixture.writes.map(write => write.settings.missionProfileDefaults), [[other, { template: "debug", profiles: {}, taskMode: "native" }]],
      "the rejected global choice and the one made from it are never sent; the Debugging choice applies on top of the other window's")
    assert.equal(await mode.inputValue(), "native")
    await scope.selectOption("all")
    assert.equal(await mode.inputValue(), "native", "the global value is the stored one")
    await scope.selectOption("wayfinder")
    assert.equal(await mode.inputValue(), "independent")
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

for (const outcome of ["accepted", "replaced", "invalid", "unreadable"] as const) test(`a lost defaults write response reconciles ${outcome} owner state without replay`, async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  let writes = 0, reads = 0
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await page.route("**/api/storage/config/ui*", route => {
      if (route.request().method() === "GET") {
        reads++
        return outcome === "unreadable" ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: fixture.bucket() })
      }
      writes++
      const submitted = route.request().postDataJSON().patch.settings.missionProfileDefaults
      fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionProfileDefaults:
        outcome === "replaced" ? [{ template: "all", profiles: {}, taskMode: "native" }]
          : outcome === "invalid" ? [{ template: "broken" }] : submitted } })
      return route.fulfill({ status: 503, json: { error: "Write response lost" } })
    })
    const mode = page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true })
    await mode.selectOption("independent")
    if (outcome === "unreadable") {
      await page.getByRole("button", { name: await text(page, "missions.defaults.reload"), exact: true }).waitFor()
    } else {
      await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    }
    const alert = page.getByRole("alert").filter({ hasText: await text(page, "missions.defaults.error") })
    if (outcome === "accepted") {
      await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>(".mission-preferences-scope select")?.disabled)
      assert.equal(await alert.count(), 0, "the saved choice clears the false failure")
      assert.equal(await mode.inputValue(), "independent")
    } else {
      await alert.waitFor()
      if (outcome === "replaced") assert.equal(await mode.inputValue(), "native", "the other client's current choice wins")
    }
    assert.equal(writes, 1, "recovery never repeats a write")
    assert.equal(reads, outcome === "unreadable" ? 3 : 1)
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
    await openProfiles(page)
    await page.getByLabel("Coordinator · Model", { exact: true }).locator("option:checked").filter({ hasText: "Model M" }).waitFor({ state: "attached" })
    assert.equal(await page.getByLabel("Coordinator · Model", { exact: true }).inputValue(), JSON.stringify(["p", "m"]))
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), false)
    assert.equal(fixture.creates.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("Preferences edits preserve the creation draft and profiles have no reset or Preferences commands", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles }] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    assert.equal(await page.getByLabel("Coordinator · Model", { exact: true }).inputValue(), JSON.stringify(["p", "m"]))
    await openProfiles(page)
    await page.evaluate(() => window.missionDefaultsModels.update({ missionProfileDefaults: [{ template: "all", profiles: { coordinator: { agent: "all" } } }] }))
    await page.waitForFunction(() => window.missionDefaultsModels.preferences().missionProfileDefaults[0]?.profiles.coordinator?.agent === "all")
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).inputValue(), "root")
    assert.equal(await page.getByLabel("Coordinator · Model", { exact: true }).inputValue(), JSON.stringify(["p", "m"]))
    assert.equal(await page.locator(".mission-create-option button").count(), 0)
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
    await page.getByRole("dialog").getByRole("button", { name: await text(page, "missions.control.cancel"), exact: true }).click()
    assert.equal(fixture.writes.length, 0, "repairing asks first")
    await page.getByRole("button", { name: await text(page, "missions.defaults.reset"), exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: await text(page, "missions.defaults.reset"), exact: true }).click()
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

test("failed defaults recovery locks every profile-affecting control until its fenced result settles", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page, { missionModels: [{ version: 1, id: modelID, name: "Locked brief", objective: "A task", notes: "", template: "custom" }] })
  let release!: () => void, started!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { started = resolve })
  await page.route("**/api/storage/config/ui*", route => route.fulfill({ status: 503, json: {} }))
  try {
    await page.goto(url); await page.getByRole("button", { name: await text(page, "missions.defaults.reload"), exact: true }).waitFor()
    await ensureOptions(page)
    await openModels(page); await openProfiles(page)
    await page.route("**/api/storage/config/ui*", async route => { started(); await hold; return route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles }] } } }) })
    await page.getByRole("button", { name: await text(page, "missions.defaults.reload"), exact: true }).click()
    await reached
    assert.equal(await page.getByLabel("Playbook", { exact: true }).isDisabled(), true)
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).isDisabled(), true)
    assert.equal(await page.getByLabel(await text(page, "missions.create.brief.start"), { exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: await text(page, "missions.create.brief.saveAs"), exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    release()
    await page.getByLabel("Coordinator · Model", { exact: true }).locator("option:checked").filter({ hasText: "Model M" }).waitFor({ state: "attached" })
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

test("a mission type's rows show the inherited global values, customize from them and keep native default distinct from inherit", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles }] })
  const wayfinder = () => window.missionDefaultsModels.preferences().missionProfileDefaults.find(item => item.template === "wayfinder")?.profiles
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await page.locator('.mission-preferences-scope select').selectOption("wayfinder")
    await openSettingsProfiles(page)
    assert.equal(await page.locator(".mission-default-inheritance").count(), 0, "one row per role, no second selector level")
    const row = page.locator(".mission-profile-row").filter({ has: page.getByLabel("Coordinator · Agent", { exact: true }) })
    const agent = row.getByLabel("Coordinator · Agent", { exact: true }), model = row.getByLabel("Coordinator · Model", { exact: true })
    await agent.locator('option[value="root"]').waitFor({ state: "attached" })
    assert.equal(await agent.inputValue(), "root", "an inherited role shows the global value it really uses")
    assert.equal(await model.inputValue(), JSON.stringify(["p", "m"]))
    assert.equal(await row.locator(".mission-profile-origin").innerText(), await text(page, "missions.defaults.fromGlobal"))
    assert.equal(await page.getByLabel("Cartographer · Agent", { exact: true }).inputValue(), "child", "task roles inherit the global Tasks profile")
    await agent.selectOption("all")
    await waitForWrites(page, fixture, 1)
    assert.deepEqual(fixture.writes[0].settings.missionProfileDefaults.find((item: { template: string }) => item.template === "wayfinder").profiles,
      { coordinator: { agent: "all", model: { providerID: "p", id: "m", variant: "high" } } }, "changing the agent keeps the global model")
    assert.equal(await row.locator(".mission-profile-origin").count(), 0)
    await agent.selectOption(""); await waitForWrites(page, fixture, 2)
    await model.selectOption(""); await waitForWrites(page, fixture, 3)
    assert.deepEqual(await page.evaluate(wayfinder), { coordinator: {} }, "an all-native choice stays an explicit override, not inherit")
    assert.equal(await agent.inputValue(), "")
    const revert = row.getByRole("button", { name: await page.evaluate(() => window.missionDefaultsModels.text("missions.defaults.revert").replace("{role}", "Coordinator")), exact: true })
    await revert.click(); await waitForWrites(page, fixture, 4)
    assert.equal(await page.evaluate(wayfinder), undefined, "reverting inherits the global values again")
    assert.equal(await agent.inputValue(), "root")
    assert.equal(await agent.evaluate(element => element === document.activeElement), true, "focus stays in the row after its revert button leaves")
    await page.getByLabel(await text(page, "missions.defaults.summary")).filter({ hasText: "Model M / high" }).waitFor()
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("queued agent/model edits touch only their role and are refused when that stored role changed since they were made", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await page.locator(".mission-preferences-scope select").selectOption("debug")
    await openSettingsProfiles(page)
    const implementer = page.getByLabel("Implementer · Agent", { exact: true }), validator = page.getByLabel("Fresh validator · Agent", { exact: true })
    await implementer.locator('option[value="child"]').waitFor({ state: "attached" })
    await page.route("**/api/storage/config/ui*", async route => { if (route.request().method() !== "GET") await hold; return route.fallback() })
    await implementer.selectOption("child")
    await implementer.selectOption("all")
    await validator.selectOption("child")
    // Another window customizes the validator before the held write reaches the server.
    const other = { template: "debug", profiles: { roles: { validator: { agent: "all" } } } }
    fixture.replace({ ...fixture.bucket(), settings: { ...fixture.bucket().settings, missionProfileDefaults: [other] } })
    release()
    await page.getByRole("alert").filter({ hasText: await text(page, "missions.defaults.error") }).waitFor()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded()
      && document.querySelector<HTMLSelectElement>('select[aria-label="Fresh validator · Agent"]')?.value === "all")
    assert.equal(await implementer.inputValue(), "", "the rejected choice and the one made from it are gone")
    assert.equal(fixture.writes.length, 0, "no queued edit overwrites the other window's change or resends the rejected one")
    assert.deepEqual(fixture.bucket().settings.missionProfileDefaults, [other])
    await implementer.selectOption("child")
    await waitForWrites(page, fixture, 1)
    assert.deepEqual(fixture.writes[0].settings.missionProfileDefaults,
      [{ template: "debug", profiles: { roles: { validator: { agent: "all" }, implementer: { agent: "child" } } } }], "an edit of one role keeps the others")
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("Mission scope stays directly available without a duplicate explanation", async () => {
  const page = await browser.newPage({ locale: "en-US", hasTouch: true })
  try {
    await setup(page)
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    assert.equal(await page.locator(".mission-preferences-scope .settings-info-tip").count(), 0)
    assert.equal(await page.getByLabel(await text(page, "missions.defaults.scope"), { exact: true }).isEnabled(), true)
    await page.locator(".mission-preferences > header .settings-info-tip").focus()
    await page.locator(".section-info-tooltip").filter({ hasText: await text(page, "missions.defaults.hint") }).waitFor()
  } finally { await page.close() }
})

test("Reset inside Agents and models clears only the shown scope's agents and models, after confirmation", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page, { missionProfileDefaults: [{ template: "all", profiles, taskMode: "independent" }, { template: "debug", profiles: { coordinator: { agent: "root" } } }] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await openSettingsProfiles(page)
    const reset = page.locator(".mission-profiles-disclosure").getByRole("button", { name: await text(page, "missions.defaults.resetProfiles"), exact: true })
    await reset.click()
    await page.getByRole("dialog").getByRole("button", { name: await text(page, "missions.control.cancel"), exact: true }).click()
    assert.equal(fixture.writes.length, 0)
    await reset.click()
    await page.getByRole("dialog").getByRole("button", { name: await text(page, "missions.preferences.reset"), exact: true }).click()
    await waitForWrites(page, fixture, 1)
    assert.deepEqual(fixture.writes[0].settings.missionProfileDefaults, [
      { template: "debug", profiles: { coordinator: { agent: "root" } } }, { template: "all", profiles: {}, taskMode: "independent" },
    ], "the task-session policy and other Mission types are kept")
    assert.equal(await reset.isDisabled(), true, "nothing left to reset")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("earlier unrelated SSE during write B is reconciled from owner authority before a fresh editor freezes profile B", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles }] })
  let release!: () => void, started!: () => void, reads = 0
  const hold = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { started = resolve })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await openSettingsProfiles(page)
    const agent = page.getByLabel("Coordinator · Agent", { exact: true })
    await agent.locator('option[value="all"]').waitFor({ state: "attached" })
    await page.route("**/api/storage/config/ui*", async route => {
      if (route.request().method() === "GET") { reads++; return route.fallback() }
      const body = route.request().postDataJSON()
      fixture.writes.push(body.patch)
      const initial = fixture.bucket()
      fixture.replace({ ...initial, settings: { ...initial.settings, unrelated: "earlier-window-field", ...body.patch.settings } })
      started(); await hold
      return route.fulfill({ json: fixture.bucket() })
    })
    await agent.selectOption("all"); await reached
    await dispatchOwner(page, { settings: { missionProfileDefaults: [{ template: "custom", profiles }], unrelated: "earlier-window-field" } })
    release()
    await page.waitForFunction(() => window.missionDefaultsModels.loaded() && window.missionDefaultsModels.preferences().missionProfileDefaults[0]?.profiles.coordinator?.agent === "all")
    assert.equal(reads, 1); assert.equal(fixture.writes.length, 1)
    await page.evaluate(() => window.missionDefaultsModels.view("create"))
    await ensureOptions(page)
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).inputValue(), "all")
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Freeze accepted B")
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await uncertainCreation(page)
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

test("Creation exposes native choices and matches Settings' inherited requested profiles", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    const label = await text(page, "missions.defaults.summary")
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).inputValue(), "")
    await page.getByLabel("Playbook", { exact: true }).selectOption("debug")
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).inputValue(), "")
    await page.evaluate(async () => {
      await window.missionDefaultsModels.update({ missionProfileDefaults: [{ template: "custom", profiles: {
        coordinator: { agent: "root" }, roles: { specialist: { agent: "child", model: { providerID: "p", id: "m", variant: "high" } } },
      } }] })
      window.missionDefaultsModels.view("settings")
    })
    await page.locator('.mission-preferences-scope select').selectOption("debug")
    // Settings reads the catalog for its selectors; the summary then names the model.
    await page.getByLabel(label).filter({ hasText: "Model M / high" }).waitFor()
    const settingsSummary = (await page.getByLabel(label).textContent())!
    assert.equal(settingsSummary.match(/Model M \/ high/g)?.length, 1)
    assert.equal(settingsSummary.match(/\bchild\b/g)?.length, 1)
    await page.evaluate(() => window.missionDefaultsModels.view("create"))
    await ensureOptions(page)
    await page.getByLabel("Playbook", { exact: true }).selectOption("debug")
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).inputValue(), "root")
    assert.equal(await page.getByLabel("Implementer · Agent", { exact: true }).inputValue(), "child")
    assert.equal(await page.getByLabel("Implementer · Model", { exact: true }).inputValue(), JSON.stringify(["p", "m"]))
    assert.equal(await page.getByLabel("Implementer · Thinking", { exact: true }).inputValue(), "high")
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
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).inputValue(), "all")
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await uncertainCreation(page)
    assert.equal(fixture.creates[0].profiles.coordinator.agent, "all")
    assert.equal(reads, 2)
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
    await openProfiles(page)
    const task = page.getByLabel("Tasks · Agent", { exact: true })
    await task.locator('option[value="root"]').waitFor({ state: "attached" })
    assert.equal(await task.locator('option[value="child"]').count(), 0)
    assert.equal(await page.getByLabel("Coordinator · Agent", { exact: true }).locator('option[value="child"]').count(), 0)
    await task.selectOption("root")
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Independent policy snapshot")
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await uncertainCreation(page)
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
    await waitForWrites(page, fixture, 1)
    assert.deepEqual(fixture.writes[0].settings.missionProfileDefaults, [
      { template: "all", profiles: {}, taskMode: "independent" },
      { template: "wayfinder", profiles: { coordinator: { agent: "root" } } },
    ])
    await scope.selectOption("all"); await mode.selectOption("native")
    await waitForWrites(page, fixture, 2)
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

test("a Flexible-only exception keeps other Mission types unchanged after reload", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page, { missionProfileDefaults: [{ template: "custom", profiles: {}, taskMode: "independent" }] })
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    const mode = page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true })
    assert.equal(await mode.inputValue(), "independent", "an old global Flexible record still reads as global")
    await mode.selectOption("native")
    await waitForWrites(page, fixture, 1)
    await page.locator(".mission-preferences-scope select").selectOption("custom")
    await mode.selectOption("independent")
    await waitForWrites(page, fixture, 2)
    assert.deepEqual(fixture.writes.at(-1)!.settings.missionProfileDefaults, [
      { template: "all", profiles: {}, taskMode: "native" }, { template: "custom", profiles: {}, taskMode: "independent" },
    ])
    await page.reload(); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await page.evaluate(() => window.missionDefaultsModels.view("create"))
    await ensureOptions(page)
    const template = page.getByLabel(await text(page, "missions.control.template"), { exact: true })
    assert.equal(await mode.inputValue(), "independent", "Flexible keeps its exception")
    for (const other of ["debug", "wayfinder", "delivery", "compare"]) {
      await template.selectOption(other)
      assert.equal(await mode.inputValue(), "native", `${other} is unchanged by a Flexible exception`)
    }
    assert.equal(fixture.creates.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("native task defaults and an independent preference edit save once, compare-and-swapped, without mutating existing Missions", async () => {
  const page = await browser.newPage({ locale: "en-US" }), fixture = await setup(page)
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels.loaded())
    await ensureOptions(page)
    assert.equal(await page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true }).inputValue(), "native")
    await openProfiles(page)
    const task = page.getByLabel("Tasks · Agent", { exact: true })
    await task.locator('option[value="child"]').waitFor({ state: "attached" })
    assert.equal(await task.locator('option[value="root"]').count(), 0)
    await task.selectOption("child")
    await page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true }).selectOption("independent")
    assert.equal(await task.inputValue(), "child", "switching policy preserves an explicitly requested, now unavailable selection")
    assert.match(await task.locator('option[value="child"]').innerText(), /Unavailable/)
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    const mode = page.getByLabel(await text(page, "missions.taskMode.label"), { exact: true })
    await mode.selectOption("independent")
    await waitForWrites(page, fixture, 1)
    await page.evaluate(() => window.missionDefaultsModels.view("closed")); await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    assert.equal(await mode.inputValue(), "independent")
    assert.deepEqual(fixture.writes, [{ settings: { missionProfileDefaults: [{ template: "all", profiles: {}, taskMode: "independent" }] } }])
    assert.equal(fixture.creates.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("Compare groups model selectors, refuses identical models beside the group and keeps judge explanations out of the form", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const fixture = await setup(page, { missionProfileDefaults: [{ template: "all", profiles }] })
  await page.route("**/api/workspaces/fixture/missions", route => {
    fixture.creates.push(route.request().postDataJSON())
    return route.fulfill({ json: { mission: { id: "prepared-comparison", template: "compare", runState: "prepared" } } })
  })
  await page.route("**/workspaces/fixture/instance/api/model**", route => route.fulfill({ json: { data: ["m", "n", "j"].map(id =>
    nativeModel(id, id === "m" ? [{ id: "high" }] : [])) } }))
  try {
    await page.goto(url); await page.waitForFunction(() => window.missionDefaultsModels?.loaded())
    await ensureOptions(page)
    const template = page.getByLabel("Playbook", { exact: true })
    await template.selectOption("compare")
    await openProfiles(page)
    const first = page.getByLabel("Model A · Model", { exact: true }), second = page.getByLabel("Model B · Model", { exact: true })
    await first.locator('option[value=\'["p","m"]\']').waitFor({ state: "attached" })
    assert.equal(await first.evaluate(node => Boolean(node.closest("details"))), true)
    await first.selectOption(JSON.stringify(["p", "m"])); await second.selectOption(JSON.stringify(["p", "m"]))
    await page.getByRole("alert").filter({ hasText: "A and B must use different models" }).waitFor()
    assert.equal(await page.getByRole("status").filter({ hasText: "The judge uses the same model" }).count(), 0)
    assert.equal(await page.locator(".mission-create-option").getByRole("alert").count(), 1)
    await page.getByLabel(OBJECTIVE, { exact: true }).fill("Compare two models")
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isDisabled(), true)
    await second.selectOption(JSON.stringify(["p", "n"]))
    assert.equal(await page.getByRole("button", { name: CREATE_ONLY, exact: true }).isEnabled(), true)
    await ensureOptions(page); await openProfiles(page)
    await page.getByLabel("Coordinator · Model", { exact: true }).selectOption(JSON.stringify(["p", "n"]))
    assert.equal(await page.getByLabel("Blind judge · Model", { exact: true }).inputValue(), JSON.stringify(["p", "n"]))
    assert.equal(await page.getByLabel("Blind judge · Model", { exact: true }).locator("option:checked").innerText(), "Model N")
    await page.getByLabel("Coordinator · Model", { exact: true }).selectOption(JSON.stringify(["p", "j"]))
    assert.equal(await page.getByRole("status").filter({ hasText: "The judge uses the same model" }).count(), 0)
    assert.equal(await page.getByLabel("Blind judge · Model", { exact: true }).locator("option:checked").innerText(), "Model J")
    await page.getByLabel("Coordinator · Model", { exact: true }).selectOption(JSON.stringify(["p", "n"]))
    await page.getByLabel("Blind judge · Model", { exact: true }).selectOption(JSON.stringify(["p", "j"]))
    await page.getByLabel("Coordinator · Model", { exact: true }).selectOption(JSON.stringify(["p", "m"]))
    assert.equal(await page.getByLabel("Blind judge · Model", { exact: true }).inputValue(), JSON.stringify(["p", "j"]))
    assert.equal(await page.getByRole("status").filter({ hasText: "The judge uses the same model" }).count(), 0)
    await page.getByRole("button", { name: CREATE_ONLY, exact: true }).click()
    await page.locator("form.mission-editor").waitFor({ state: "detached" })
    assert.equal(fixture.creates[0].template, "compare")
    assert.deepEqual(fixture.creates[0].profiles.roles.comparator, { model: { providerID: "p", id: "j" } })
    assert.equal(fixture.creates[0].profiles.roles["model-b"].model.id, "n")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})
