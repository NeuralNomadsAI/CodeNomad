import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import type {} from "./fixtures/mission-defaults-models"

// Mission Model selects list what the conversation's model selector lists, under the same names.
let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "mission-profile-models",
    routes: [
      { path: "/mission-profile-models", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-defaults-models.tsx"></script></body></html>' },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const model = (providerID: string, id: string, name: string, extra: Record<string, unknown> = {}) => ({ providerID, id, name, status: "active",
  enabled: true, capabilities: { tools: true }, cost: [], limit: { context: 1, output: 1 }, variants: [{ id: "high" }], ...extra })
const CATALOG = [
  model("claude-code", "claude-opus-5-5[1m]", "Opus 5.5 Fast"),
  model("openai", "gpt-6.1-sol-fast", "GPT-6.1 Sol Fast"),
  model("openai", "luna-mini", "Luna Mini"),
  model("openai", "secret-preview", "Secret Preview"),
  model("opencode", "flint-40b-free", "Flint 40B", { status: "deprecated" }),
  model("opencode", "no-tools", "No Tools", { capabilities: { tools: false } }),
]
const PROVIDERS = [{ id: "claude-code", name: "Claude Code" }, { id: "openai", name: "OpenAI" }, { id: "opencode", name: "OpenCode Zen" }]
const key = (providerID: string, id: string) => JSON.stringify([providerID, id])
const OPUS = { providerID: "claude-code", id: "claude-opus-5-5[1m]" }, SECRET = { providerID: "openai", id: "secret-preview" }
const text = (page: Page, key: string) => page.evaluate(key => window.missionDefaultsModels.text(key), key)

async function setup(page: Page, settings: Record<string, unknown>, models: Record<string, unknown>) {
  const writes: unknown[] = [], reads: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: { location: { directory: "/fixture" }, capability: null, effectiveDepth: null, project: null } }))
  await page.route("**/api/storage/config/ui*", route => {
    if (route.request().method() !== "GET") writes.push(route.request().postDataJSON())
    return route.fulfill({ json: { settings: { modelVisibility: { openai: { hiddenModelIds: ["secret-preview"] } }, ...settings } } })
  })
  await page.route("**/api/storage/state/ui*", route => route.fulfill({ json: { models } }))
  await page.route("**/workspaces/fixture/instance/api/{agent,model,provider}**", route => {
    const path = new URL(route.request().url()).pathname
    reads.push(path)
    return route.fulfill({ json: { data: path.endsWith("/agent") ? [{ id: "build", mode: "primary" }, { id: "general", mode: "subagent" }]
      : path.endsWith("/provider") ? PROVIDERS : CATALOG } })
  })
  await page.goto(url)
  await page.waitForFunction(() => window.missionDefaultsModels.loaded())
  return { writes, reads, errors }
}

/** The select's value, shown text and options; a provider group is [label, option texts]. */
const listing = (page: Page, label: string) => page.getByLabel(label, { exact: true }).evaluate((select: HTMLSelectElement) => ({
  value: select.value,
  shown: select.selectedOptions[0]?.textContent,
  options: [...select.children].map(child => child instanceof HTMLOptGroupElement
    ? [child.label, [...child.children].map(option => option.textContent)] : child.textContent),
}))
/** Publishes the conversation's model catalog, as the composer's providers store does after a read. */
const publishConversationCatalog = (page: Page, models: typeof CATALOG) => page.evaluate(async ({ providers, models }) => {
  const path = "/src/stores/session-state.ts", { setProviders } = await import(path)
  setProviders(new Map([["fixture", providers.map(provider => ({ ...provider, models: models.filter(item => item.providerID === provider.id)
    .map(item => ({ id: item.id, name: item.name, providerId: item.providerID })) }))]]))
}, { providers: PROVIDERS, models })
const loadedCatalog = (page: Page, label: string) => page.getByLabel(label, { exact: true }).locator(`option[value='${key("openai", "gpt-6.1-sol-fast")}']`).waitFor({ state: "attached" })

test("Settings model selects show the conversation selector's named, filtered list and keep saved choices outside it", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const fixture = await setup(page, { missionProfileDefaults: [
      { template: "all", profiles: { coordinator: { agent: "build", model: { ...OPUS, variant: "high" } }, roles: { specialist: { model: { providerID: "gone", id: "retired-model" } } } } },
      { template: "debug", profiles: { coordinator: { model: { providerID: "opencode", id: "no-tools" } } } },
    ] }, { favorites: [], favoritesOnly: false })
    const native = await text(page, "missions.control.execution.nativeDefault"), unavailable = await text(page, "missions.control.profiles.unavailable")
    await page.evaluate(() => window.missionDefaultsModels.view("settings"))
    await page.locator(".mission-profiles-disclosure > summary").click()
    await loadedCatalog(page, "Coordinator · Model")
    const groups = [["Claude Code", ["Opus 5.5 Fast"]], ["OpenAI", ["GPT-6.1 Sol Fast", "Luna Mini"]]]
    assert.deepEqual(await listing(page, "Coordinator · Model"), { value: key(OPUS.providerID, OPUS.id), shown: "Opus 5.5 Fast", options: [native, ...groups] },
      "hidden, deprecated and tool-less models are left out; the rest are named and grouped by provider")
    assert.deepEqual(await listing(page, "Tasks · Model"), { value: key("gone", "retired-model"), shown: `gone/retired-model · ${unavailable}`,
      options: [native, `gone/retired-model · ${unavailable}`, ...groups] }, "a saved model missing from the catalog stays selected")
    await page.getByLabel(await text(page, "missions.defaults.summary")).filter({ hasText: "Coordinator: build / Opus 5.5 Fast / high" }).waitFor()
    await page.locator(".mission-preferences-scope select").selectOption("debug")
    assert.equal((await listing(page, "Coordinator · Model")).shown, `No Tools · ${unavailable}`, "a known model the mission cannot use keeps its name")
    assert.deepEqual(fixture.writes, [], "showing saved choices never rewrites them")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("the editor and Compare follow favorites-only, keep hidden or non-favorite saved choices and summarize with names", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const fixture = await setup(page, { missionProfileDefaults: [
      { template: "all", profiles: { coordinator: { agent: "build", model: { ...OPUS, variant: "high" } }, roles: { specialist: { model: SECRET } } } },
    ] }, { favorites: [{ providerId: "openai", modelId: "gpt-6.1-sol-fast" }], favoritesOnly: true })
    const native = await text(page, "missions.control.execution.nativeDefault"), summary = await text(page, "missions.defaults.summary")
    await page.evaluate(async () => {
      const path = "/src/stores/preferences.tsx", { uiState } = await import(path)
      for (let attempt = 0; !uiState().models.favoritesOnly; attempt++) {
        if (attempt > 500) throw new Error("The favorites-only mode never loaded")
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    })
    await page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }).click()
    await page.getByLabel(summary).filter({ hasText: "build / claude-code/claude-opus-5-5[1m] / high" }).waitFor()
    // The conversation catalog names models without a Missions catalog read.
    await publishConversationCatalog(page, CATALOG)
    await page.getByLabel(summary).filter({ hasText: "Coordinator: build / Opus 5.5 Fast / high · Tasks: Secret Preview" }).waitFor()
    assert.deepEqual(fixture.reads, [])

    await page.locator("form.mission-editor summary").filter({ hasText: /^Agents and models$/ }).click()
    await loadedCatalog(page, "Coordinator · Model")
    assert.deepEqual(await listing(page, "Coordinator · Model"), { value: key(OPUS.providerID, OPUS.id), shown: "Opus 5.5 Fast",
      options: [native, ["Claude Code", ["Opus 5.5 Fast"]], ["OpenAI", ["GPT-6.1 Sol Fast"]]] }, "favorites only, plus the saved non-favorite")
    assert.deepEqual(await listing(page, "Tasks · Model"), { value: key(SECRET.providerID, SECRET.id), shown: "Secret Preview",
      options: [native, ["OpenAI", ["GPT-6.1 Sol Fast", "Secret Preview"]]] }, "a saved hidden model stays selected under its name")

    // A conversation catalog refreshed after that Missions read renames the model: the summary
    // follows the fresher catalog without a read of its own.
    const reads = fixture.reads.length
    await publishConversationCatalog(page, CATALOG.map(item => item.id === OPUS.id ? { ...item, name: "Opus 5.5 Turbo" } : item))
    await page.getByLabel(summary).filter({ hasText: "Coordinator: build / Opus 5.5 Turbo / high" }).waitFor()
    assert.equal(fixture.reads.length, reads)

    await page.getByLabel("Playbook", { exact: true }).selectOption("compare")
    await loadedCatalog(page, "Model A · Model")
    assert.deepEqual(await listing(page, "Model A · Model"), { value: key(SECRET.providerID, SECRET.id), shown: "Secret Preview",
      options: [native, ["OpenAI", ["GPT-6.1 Sol Fast", "Secret Preview"]]] }, "Model A inherits the Tasks choice and the same list")
    await page.getByLabel("Model B · Model", { exact: true }).selectOption(key("openai", "gpt-6.1-sol-fast"))
    assert.equal((await listing(page, "Model B · Model")).shown, "GPT-6.1 Sol Fast")
    assert.deepEqual(fixture.writes, [])
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})
