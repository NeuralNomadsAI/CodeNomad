import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { clickMissionAction } from "./mission-actions"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  const shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-fixture", configureServer(s) {
      s.middlewares.use("/mission-session-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-session-fixture", '<html><body><div id="root" style="display:flex;height:100vh"></div><script type="module" src="/tests/browser/fixtures/mission-session.tsx"></script></body></html>'))
      })
      s.middlewares.use("/mission-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-fixture", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

function mission(id: string): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "Notes",
    coordinatorSessionId: "ses_fixture", status: "active", actors: [], frontier: [], claims: [], revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false,
    tasks: [{ id: `task-${id}`, key: "task-one", title: "Inspect evidence", brief: "A detailed brief", role: "research", status: "completed", blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }],
    reports: [{ id: `report-${id}`, taskKey: "task-one", sessionId: "ses_fixture", outcome: "completed", summary: "Report opening paragraph.\n\n" + "Long report paragraph.\n\n".repeat(90), evidence: ["Source proof"], next: [], createdAt: 1 }],
  }
}
async function setup(page: Page) {
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(60_000)
  page.on("pageerror", error => console.error("fixture error", error))
  await page.addInitScript(`
    Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(localStorage.getItem("fixture-native") ?? "null") }),
      saveClientState: async (_token, snapshot) => { localStorage.setItem("fixture-native", JSON.stringify(snapshot)); return true },
    } })
  `)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: { location: { directory: "fixture" }, capability: null, effectiveDepth: null, project: null } }))
}
const fixtureCall = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) => (window as any).missionFixture[method](arg), { method, arg })
const missionRows = (page: Page) => page.locator(".mission-control-index > .mission-index-entry")
const selectedCard = (page: Page) => page.locator(".mission-index-entry-selected > .mission-card")
const taskRow = (page: Page, key: string) => page.locator(`.mission-checklist li[data-task-key="${key}"]`)
const taskButton = (page: Page, key: string) => taskRow(page, key).locator(".mission-checklist-task")
const readAll = (page: Page) => selectedCard(page).getByRole("button", { name: "Read all", exact: true })
const routeRow = (page: Page, key: string) => page.locator(`.mission-route-task[data-task-key="${key}"] > .mission-list-item`)
const screenshotPath = (name: string) => path.join(os.tmpdir(), "opencode", `${name}-${process.env.CODENOMAD_MISSION_CAPTURE_TAG ?? "updated"}.png`)
const fixtureText = (page: Page, key: string) => fixtureCall(page, "text", key) as Promise<string>
async function localizedPreferences(page: Page, name: string) {
  const preferences = page.getByRole("button", { name, exact: true })
  await preferences.waitFor()
  return preferences
}
/** Secondary sections (Reports, Conversations, Plan changes, cleanup, dependencies) live in the card's single More. */
async function openMore(page: Page) {
  const more = selectedCard(page).locator(".mission-more > h3 > .mission-disclosure-trigger")
  if (await more.getAttribute("aria-expanded") !== "true") await more.click()
}
async function openResultHistory(page: Page) {
  await openMore(page)
  const history = page.getByRole("button", { name: "Reports", exact: true })
  if (await history.getAttribute("aria-expanded") !== "true") await history.click()
}
async function openTaskTechnicalDetails(page: Page) {
  await page.locator(".mission-task-reader > details").filter({ has: page.locator("summary", { hasText: "Technical details" }) }).locator("summary").click()
}

test("Missions preferences stay in the panel, retain dirty CAS drafts and fence hidden catalog demand without closing the reader", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  const errors: string[] = [], catalogReads: string[] = [], writes: any[] = []
  page.on("pageerror", error => errors.push(error.message))
  let owner: any = { settings: { missionProfileDefaults: [], unrelated: "keep" } }
  try {
    await setup(page)
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [mission("preferences")], generatedAt: 1, discardedEvents: 0 } }))
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
      return route.fulfill({ json: { data: [{ providerID: "native", id: "long-context", enabled: true, capabilities: { tools: true }, variants: [{ id: "high" }] }] } })
    })
    await page.goto(url)
    await fixtureCall(page, "connectCatalog")
    await page.waitForFunction(() => (window as any).missionFixture.loaded())
    const preferences = page.getByRole("button", { name: await fixtureText(page, "missions.preferences.title"), exact: true })
    assert.equal(await preferences.getAttribute("aria-expanded"), "false")
    await page.waitForTimeout(100)
    assert.equal(catalogReads.length, 0)
    await readAll(page).click()
    const reader = page.locator(".mission-reader")
    await reader.waitFor()
    await reader.evaluate(element => { (window as any).savedPreferenceReader = element })
    await preferences.click()
    const agent = page.getByLabel("Coordinator · Agent", { exact: true })
    await agent.locator('option[value="build"]').waitFor({ state: "attached" })
    await agent.selectOption("build")
    await page.getByText("Unsaved changes", { exact: true }).waitFor()
    await preferences.click()
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
    assert.equal(await preferences.getAttribute("aria-expanded"), "false")
    await preferences.click()
    assert.equal(await agent.inputValue(), "build")
    assert.equal(await reader.evaluate(element => element === (window as any).savedPreferenceReader), true)
    assert.equal(await readAll(page).getAttribute("aria-pressed"), "true")
    await agent.focus(); await fixtureCall(page, "refresh")
    assert.equal(await agent.evaluate(element => element === document.activeElement), true)
    for (const width of [440, 280, 390]) {
      await fixtureCall(page, "panelWidth", `${width}px`)
      if (width === 390) await page.setViewportSize({ width, height: 850 })
      await preferences.scrollIntoViewIfNeeded()
      assert.equal(await page.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      const actions = await page.locator(".mission-preferences-actions > button").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top))
      assert.equal(new Set(actions).size, 1, "Save/Reset/Reload share one logical row")
      await page.locator(".mission-preferences").scrollIntoViewIfNeeded()
      await page.screenshot({ path: screenshotPath(`mission-preferences-en-${width}`) })
    }
    owner = { settings: { missionProfileDefaults: [{ template: "custom", profiles: { coordinator: { agent: "other-window" } } }], unrelated: "keep" } }
    await page.locator(".mission-preferences-actions").getByRole("button", { name: "Save", exact: true }).click()
    await page.getByText(await fixtureText(page, "missions.defaults.error"), { exact: true }).waitFor()
    assert.deepEqual(writes[0].expected[0].value, [], "navigation never refreshes the dirty draft's original expectation")
    assert.equal(await agent.inputValue(), "build")
    assert.equal(owner.settings.missionProfileDefaults[0].profiles.coordinator.agent, "other-window")
    await page.locator(".mission-preferences-actions").getByRole("button", { name: "Reload saved defaults", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Discard changes", exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="Coordinator · Agent"]')?.value === "other-window")
    assert.equal(writes.length, 1, "reload never replays the rejected mutation")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("empty Missions exposes collapsed preferences and narrow localized controls without settings-card chrome", async () => {
  for (const locale of ["fr-FR", "he-IL"]) {
    const page = await browser.newPage({ locale, viewport: { width: 1000, height: 850 } })
    try {
      await setup(page)
      await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
      await page.goto(url); await fixtureCall(page, "panelWidth", "280px")
      await page.waitForFunction(() => (window as any).missionFixture.loaded())
      await page.waitForFunction(language => document.documentElement.lang === language, locale.split("-")[0])
      const preferences = await localizedPreferences(page, locale === "fr-FR" ? "Préférences" : "העדפות")
      assert.equal(await preferences.getAttribute("aria-expanded"), "false")
      await page.screenshot({ path: screenshotPath(`mission-empty-${locale}`) })
      await preferences.click()
      assert.equal(await page.locator(".mission-control .settings-card").count(), 0)
      assert.equal(await page.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      const actions = await page.locator(".mission-preferences-actions > button").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top))
      assert.equal(new Set(actions).size, 1)
      await page.screenshot({ path: screenshotPath(`mission-preferences-${locale}-280`) })
      await preferences.click()
      await page.getByRole("button", { name: await fixtureText(page, "missions.control.create"), exact: true }).click()
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
      await setup(page)
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
      assert.equal(await preferences.getAttribute("aria-expanded"), "false")
      await preferences.click()
      assert.equal(await preferences.getAttribute("aria-expanded"), "true")
      await preferences.click()
      assert.equal(await preferences.getAttribute("aria-expanded"), "false")
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

test("Delegation depth reads only on demand, keeps its original Location draft and saves zero/inherit without native reload or global preference writes", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  const mutations: Array<{ url: string; body: any }> = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let reads = 0, depth: number | null = null, expectation = "original-file"
  try {
    await setup(page)
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", route => {
      if (route.request().method() === "GET") {
        reads++
        return route.fulfill({ json: { location: { directory: "fixture" }, capability: { minimum: 0, maximum: 4 }, effectiveDepth: null,
          project: { path: "fixture/opencode.jsonc", depth, expectation } } })
      }
      const body = route.request().postDataJSON(); mutations.push({ url: route.request().url(), body })
      assert.equal(body.expectation, expectation); depth = body.depth; expectation = `saved-${mutations.length}`
      return route.fulfill({ status: 204, body: "" })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await page.waitForFunction(() => (window as any).missionFixture.loaded())
    assert.equal(reads, 0)
    const preferences = page.getByRole("button", { name: "Preferences", exact: true })
    await preferences.click()
    const controls = page.locator(".mission-depth"), input = controls.getByRole("spinbutton", { name: "Maximum depth", exact: true })
    await controls.getByText("fixture/opencode.jsonc", { exact: true }).waitFor()
    assert.equal(await input.getAttribute("min"), "0")
    assert.equal(await input.getAttribute("max"), "4")
    await controls.getByText("Effective depth unknown", { exact: true }).waitFor()
    for (const value of ["-1", "5", "1.5", "9007199254740992"]) {
      await input.fill(value)
      assert.equal(await controls.getByRole("button", { name: "Save Location depth", exact: true }).isDisabled(), true)
    }
    await input.fill(""); await input.press("-")
    assert.equal(await controls.getByRole("button", { name: "Save Location depth", exact: true }).isDisabled(), true, "incomplete numeric input must not delete the override")
    await input.fill("0")
    await preferences.click(); await fixtureCall(page, "mount", false); await fixtureCall(page, "mount", true); await preferences.click()
    assert.equal(await input.inputValue(), "0")
    assert.equal(reads, 1, "dirty drafts never rebase the saved file expectation")
    for (const width of [440, 280, 390]) {
      await fixtureCall(page, "panelWidth", `${width}px`)
      if (width === 390) await page.setViewportSize({ width, height: 850 })
      await controls.scrollIntoViewIfNeeded()
      assert.equal(await page.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: screenshotPath(`mission-delegation-depth-${width}`) })
    }
    await controls.getByRole("button", { name: "Save Location depth", exact: true }).click()
    await controls.getByText("Configuration saved. OpenCode was not reloaded.", { exact: true }).waitFor()
    assert.deepEqual(mutations[0].body, { location: { directory: "fixture" }, depth: 0, expectation: "original-file" })
    await controls.getByRole("button", { name: "Inherit", exact: true }).click()
    await controls.getByRole("button", { name: "Save Location depth", exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".mission-depth input")?.value === "")
    assert.equal(mutations[1].body.depth, null)
    assert.equal(mutations[1].body.expectation, "saved-1")
    assert.ok(mutations.every(item => item.url.includes("/subagent-depth")))
    assert.deepEqual(errors, [])
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
    await setup(page)
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
    const preferences = page.getByRole("button", { name: "Preferences", exact: true }), input = page.locator(".mission-depth input")
    await preferences.click(); await page.getByText("Effective depth: 1", { exact: true }).waitFor()
    depth = 4; expectation = "changed"
    await invalidate(); await page.getByText("Effective depth: 4", { exact: true }).waitFor()
    assert.equal(reads, 2)
    depth = 3; await invalidate(true); await page.getByText("Effective depth: 3", { exact: true }).waitFor()
    assert.equal(reads, 3)
    await input.fill("2"); depth = 5; await invalidate(true); await page.waitForTimeout(150)
    assert.equal(await input.inputValue(), "2"); assert.equal(reads, 3, "dirty file expectation is not rebased")
    await page.getByRole("button", { name: "Save Location depth", exact: true }).click()
    await page.getByText("Save not confirmed. Your draft is kept; refresh before another change. No automatic retry.", { exact: true }).waitFor()
    await invalidate(); await page.waitForTimeout(150)
    assert.equal(reads, 3); assert.equal(writes, 1, "unknown admission is not retried or silently refreshed")
    await preferences.click(); await invalidate(true); await page.waitForTimeout(150)
    assert.equal(reads, 3, "hidden preference demand stays closed")
  } finally { await page.close() }
})

test("config invalidation fences an admitted stale depth response and keeps editing locked through its trailing refresh", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let reads = 0, depth = 1, release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  const invalidate = () => page.evaluate(async () => {
    const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
    serverEvents.dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: { type: "config.updated" } } as any])
  })
  try {
    await setup(page)
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/subagent-depth*", async route => {
      assert.equal(route.request().method(), "GET")
      const snapshot = { location: { directory: "fixture" }, capability: { minimum: 0 }, effectiveDepth: depth,
        project: { path: "fixture/opencode.jsonc", depth, expectation: `depth-${depth}` } }
      if (++reads === 2) { reached(); await held }
      return route.fulfill({ json: snapshot })
    })
    await page.goto(url); await fixtureCall(page, "connectCatalog")
    await page.getByRole("button", { name: "Preferences", exact: true }).click()
    await page.getByText("Effective depth: 1", { exact: true }).waitFor()
    await page.evaluate(() => {
      const bad: string[] = []; (window as any).staleDepthPublications = bad
      new MutationObserver(() => {
        const effective = document.querySelector(".mission-depth-effective")?.textContent
        if (effective === "Effective depth: 2") bad.push(effective)
        const input = document.querySelector<HTMLInputElement>(".mission-depth input")
        if (effective === "Effective depth: 1" && input && !input.disabled) bad.push("old snapshot unlocked")
      }).observe(document.querySelector(".mission-depth")!, { subtree: true, childList: true, characterData: true, attributes: true })
    })
    depth = 2; await invalidate(); await started
    assert.equal(await page.locator(".mission-depth input").isDisabled(), true)
    depth = 4; await invalidate(); release()
    await page.getByText("Effective depth: 4", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-depth input").isEnabled(), true)
    assert.equal(reads, 3)
    assert.deepEqual(await page.evaluate(() => (window as any).staleDepthPublications), [])
  } finally { release(); await page.close() }
})

test("depth uncertainty stays at its original Location through pending navigation and remount, with no replay until explicit refresh", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let writes = 0, reads = 0, release!: () => void, reached!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  try {
    await setup(page)
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
    await page.getByRole("button", { name: "Preferences", exact: true }).click()
    const input = page.locator(".mission-depth input"), save = page.getByRole("button", { name: "Save Location depth", exact: true })
    await page.locator(".mission-depth-path").waitFor(); await input.fill("2")
    await save.click(); await started
    assert.equal(await page.getByRole("button", { name: "Refresh Location depth", exact: true, includeHidden: true }).isDisabled(), true)
    await fixtureCall(page, "directory", "other")
    await page.getByRole("button", { name: "Preferences", exact: true }).click()
    await page.locator(".mission-depth-path").getByText("other/opencode.jsonc", { exact: true }).waitFor()
    assert.equal(await input.inputValue(), "9", "the new Location cannot inherit the old dirty draft")
    release()
    await fixtureCall(page, "directory", "fixture")
    await page.getByText("Save not confirmed. Your draft is kept; refresh before another change. No automatic retry.", { exact: true }).waitFor()
    await fixtureCall(page, "mount", false); await fixtureCall(page, "mount", true)
    assert.equal(await input.inputValue(), "2")
    assert.equal(await save.isDisabled(), true)
    assert.equal(writes, 1)
    assert.equal(reads, 2)
    await page.getByRole("button", { name: "Refresh Location depth", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "Refresh Location depth", exact: true, includeHidden: true }).isDisabled(), true)
    await page.getByRole("dialog").getByRole("button", { name: "Discard changes", exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".mission-depth input")?.value === "1")
    assert.equal(writes, 1)
    assert.equal(reads, 3)
  } finally { release(); await page.close() }
})

test("reader toggles highlight the exact visible content and toggle it off without navigation or writes", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  try {
    await setup(page)
    const value = mission("toggle"), writes: string[] = []
    value.history = [{ revision: 1, source: "user", reason: "Scope clarified", createdAt: 1, addedTaskKeys: [], retiredTasks: [], dependencyUpdates: [] }]
    await page.route("**/api/workspaces/fixture/missions**", route => {
      if (route.request().method() !== "GET") writes.push(route.request().method())
      return route.fulfill({ json: { available: true, missions: [value], generatedAt: value.revision, discardedEvents: 0 } })
    })
    await page.goto(url)
    const overview = readAll(page)
    const task = taskButton(page, "task-one")
    await overview.click()
    assert.equal(await overview.getAttribute("aria-pressed"), "true")
    await overview.click()
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await fixtureCall(page, "panelWidth", "280px")
    await task.click()
    assert.equal(await task.getAttribute("aria-pressed"), "true")
    assert.equal(await overview.getAttribute("aria-pressed"), "false")
    await fixtureCall(page, "refresh")
    await fixtureCall(page, "mount", false); await fixtureCall(page, "mount", true)
    assert.equal(await task.getAttribute("aria-pressed"), "true")
    await task.click()
    assert.equal(await task.getAttribute("aria-pressed"), "false")
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await openResultHistory(page)
    const report = page.locator(".mission-advances .mission-list-preview button")
    await report.click()
    assert.equal(await report.getAttribute("aria-pressed"), "true")
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    assert.equal(await report.getAttribute("aria-pressed"), "false")
    await page.getByRole("button", { name: "Plan changes", exact: true }).click()
    const change = page.locator(".mission-history-list .mission-list-preview button")
    await change.click()
    assert.equal(await change.getAttribute("aria-pressed"), "true")
    await change.click()
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
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [value], cleanups, generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    assert.equal(await page.locator(".mission-guidance, .mission-index-primary").count(), 0)
    await selectedCard(page).locator(".mission-result-text").getByText(value.summary, { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Historique du nettoyage des conversations", exact: true }).isVisible(), false,
      "settled cleanup history stays inside More")
    await selectedCard(page).getByRole("button", { name: "Plus", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "Rapports", exact: true }).count(), 1)
    assert.equal(await page.getByRole("button", { name: "Avancées et résultats", exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Modifications du plan", exact: true }).count(), 0, "no empty plan history")
    const cleanup = page.getByRole("button", { name: "Historique du nettoyage des conversations", exact: true })
    await cleanup.click()
    assert.equal(await page.locator(".mission-cleanup .mission-disclosure-trigger").count(), 1)
    await page.getByText("Ancienne mission", { exact: true }).waitFor()
    await page.getByText("Conservées car elles ont des conversations enfants.", { exact: true }).waitFor()
    await cleanup.click()
    await selectedCard(page).getByRole("button", { name: "Tout lire", exact: true }).click()
    await page.locator(".mission-reader").getByText(value.summary, { exact: true }).waitFor()
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
      if (route.request().method() !== "GET") mutations.push(route.request().method())
      return route.fulfill({ json: { available: true, missions: [value], generatedAt: value.revision, discardedEvents: 0,
        activity: { generatedAt: value.revision, missions: [{ missionId: value.id, actors: activity }] } } })
    })
    const refresh = async () => {
      value.revision++
      const response = page.waitForResponse(response => response.url().endsWith("/missions"))
      await fixtureCall(page, "refresh")
      await response
      await page.waitForFunction(revision => (window as any).missionFixture.snapshot().missions[0]?.revision === revision
        && (window as any).missionFixture.snapshot().status === "ready", value.revision)
    }
    const card = selectedCard(page), checklist = card.locator(".mission-checklist")
    const capture = async (name: string, width: number, panelWidth: string, mobile = false) => {
      const target = mobile ? await browser.newPage({ locale: "en-US", viewport: { width, height: 844 }, isMobile: true, hasTouch: true }) : page
      try {
        if (mobile) {
          await setup(target)
          await target.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [value], generatedAt: value.revision, discardedEvents: 0,
            activity: { generatedAt: value.revision, missions: [{ missionId: value.id, actors: activity }] } } }))
          await target.goto(url)
          await selectedCard(target).locator(".mission-checklist").waitFor()
          if (name.includes("human-request")) {
            await fixtureCall(target, "seedActor")
            await fixtureCall(target, "event", { type: "form.created", data: { form: { id: "form-mobile", sessionID: "ses_background", title: "Choose a supported build route", fields: [{ type: "text", name: "route", label: "Build route" }] } } })
            await target.locator(".mission-attention-list").getByText("Choose a supported build route", { exact: true }).waitFor()
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
    await missionRows(page).first().locator(".mission-index-meta").getByText("Prepared", { exact: true }).waitFor()
    await checklist.getByText("Ready to start. Start the mission to build its plan.", { exact: true }).waitFor()
    assert.equal(await card.locator(".mission-guidance").count(), 0, "the coordinator field appears only while the Mission runs")
    assert.equal(await card.getByRole("button", { name: "More", exact: true }).getAttribute("aria-expanded"), "false")
    assert.equal(await missionRows(page).first().getByRole("button", { name: "Start mission", exact: true }).innerText(), "Start")
    assert.equal(await page.locator(".mission-needs").count(), 0)
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
    await card.locator(".mission-result-meta").getByText("0 of 2 tasks done", { exact: true }).waitFor()
    assert.equal(await taskRow(page, "inspect").locator(".mission-checklist-word").innerText(), "Assigned", "admission is not evidence of running work")
    assert.equal(await taskRow(page, "verify").locator(".mission-checklist-word").innerText(), "Waiting")
    await card.locator(".mission-guidance").waitFor()
    activity = [{ sessionId: "ses_background", state: "running" }]
    await refresh()
    await taskRow(page, "inspect").getByText("Active", { exact: true }).waitFor()
    await capture("during-wide", 1280, "440px")

    const evidence = ["Read-only SDK inventory: no full Xcode.", "```text\nSDK_PATH=/Applications/CommandLineTools\n```\n\n" + "Preserved evidence paragraph.\n\n".repeat(45) + "Final evidence sentinel: unchanged."]
    const blocked = { id: "report-obstacle", taskKey: "inspect", sessionId: "ses_background", outcome: "blocked" as const,
      summary: "The macOS build is blocked because full Xcode is unavailable.", evidence, next: ["Install Xcode or use the verified Windows path."], createdAt: 20 }
    value.tasks[0] = { ...value.tasks[0], status: "needs-input", report: blocked }
    value.reports = [blocked]
    activity = [{ sessionId: "ses_background", state: "idle-without-report" }]
    await refresh()
    await taskRow(page, "inspect").getByText("Blocked", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-control").getByText(blocked.summary, { exact: true }).filter({ visible: true }).count(), 0,
      "source prose belongs in the central reader, not duplicated in the checklist")
    assert.equal(await page.locator(".mission-needs").count(), 0, "a reported blockage is not a human request")
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
    const attention = card.locator(".mission-needs")
    await attention.waitFor()
    assert.equal(await attention.evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector(".mission-result")!) & Node.DOCUMENT_POSITION_FOLLOWING)), true,
      "human decisions precede the result")
    assert.equal(await attention.locator(".mission-attention-count").innerText(), "1")
    await page.locator(".mission-attention-list").getByText("Choose a supported build route", { exact: true }).waitFor()
    await capture("human-request-mobile", 390, "390px", true)
    await fixtureCall(page, "event", { type: "permission.asked", data: { id: "permission-journey", sessionID: "ses_background", action: "shell", resources: ["npm run verify"] } })
    await page.waitForFunction(() => document.querySelector(".mission-attention-count")?.textContent === "2")
    await page.locator(".mission-attention-list").getByText("npm run verify", { exact: true }).waitFor()
    await fixtureCall(page, "event", { type: "form.created", data: { form: { id: "unrelated-form", sessionID: "ses_unrelated", title: "Unrelated request", fields: [] } } })
    assert.equal(await page.locator(".mission-attention-list").getByText("Unrelated request", { exact: true }).count(), 0)
    await fixtureCall(page, "event", { type: "form.replied", data: { id: "form-journey", sessionID: "ses_background", answers: { route: "Windows" } } })
    await page.waitForFunction(() => document.querySelector(".mission-attention-count")?.textContent === "1")
    await fixtureCall(page, "event", { type: "permission.replied", data: { requestID: "permission-journey", sessionID: "ses_background", response: "once" } })
    await attention.waitFor({ state: "detached" })
    await taskRow(page, "inspect").getByText("Blocked", { exact: true }).waitFor()
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
    await card.locator(".mission-result-meta").getByText("2 of 2 tasks done", { exact: true }).waitFor()
    assert.equal(await taskRow(page, "retired").count(), 0, "retired work leaves the current checklist")
    await card.getByText("The declared tasks are complete, but no final project outcome has been recorded yet.", { exact: true }).waitFor()
    assert.equal(await card.getByText(old.summary, { exact: false }).filter({ visible: true }).count(), 0)
    await openResultHistory(page)
    await page.locator(".mission-advances li").filter({ hasText: verifyResult.summary }).locator(".mission-list-status").getByText(/Complete/).waitFor()
    await page.locator(".mission-advances li").filter({ hasText: old.summary }).locator(".mission-list-status").getByText(/Previous attempt/).waitFor()
    await page.getByRole("button", { name: "Show more history", exact: true }).click()
    assert.equal(await page.locator(".mission-advances li").count(), 4)
    await page.locator(".mission-advances li").filter({ hasText: blocked.summary }).locator(".mission-list-status").getByText(/Previous attempt/).waitFor()
    await page.locator(".mission-advances li").filter({ hasText: blocked.summary }).getByRole("button").click()
    await page.locator(".mission-reader").getByText("Final evidence sentinel: unchanged.", { exact: false }).waitFor()
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    value.status = "completed"
    value.summary = "Desktop navigation shipped with an independent review and preserved evidence."
    await refresh()
    await missionRows(page).first().locator(".mission-index-meta").getByText("Completed", { exact: true }).waitFor()
    await card.locator(".mission-result-text").getByText(value.summary, { exact: true }).waitFor()
    assert.equal(await card.locator(".mission-guidance").count(), 0)
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
    const stale = { ...value.reports[0], summary: "Superseded historical copy.", evidence: ["Obsolete evidence."] }
    const current = { ...stale, summary: "Authoritative current task result.", evidence: ["Current source proof: exact bytes retained."], next: ["Proceed to independent review."] }
    value.tasks[0].report = current
    value.reports = [stale]
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [value], generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await openResultHistory(page)
    await page.locator(".mission-advances li").filter({ hasText: current.summary }).getByRole("button").click()
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
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [value], generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await openResultHistory(page)
    await page.locator(".mission-advances li").filter({ hasText: value.reports[0].summary }).getByRole("button").click()
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
    await page.route("**/api/workspaces/fixture/missions**", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, missions: [current], generatedAt: 1, discardedEvents: 0 } })
      const input = route.request().postDataJSON()
      calls.push(input)
      current = { ...current, revision: current.revision + 1,
        runState: input.action === "start" ? "running" : input.action === "pause" ? "paused" : "stopped",
        status: input.action === "stop" ? "stopped" : "active",
        control: { id: "evt_control", missionID: current.id, requestID: input.requestId, expectedRevision: input.expectedRevision, action: input.action,
          targets: [{ sessionID: "ses_fixture", location: { directory: "/fixture" } }], pending: [] },
      }
      if (input.action === "pause" && failPause) {
        failPause = false
        current.control!.pending = ["ses_fixture"]
        return route.fulfill({ status: 503, json: { code: "control-pending" } })
      }
      return route.fulfill({ json: { mission: current } })
    })
    await page.goto(url)
    const row = missionRows(page).first(), play = row.locator(".mission-index-primary")
    assert.equal(await play.getAttribute("aria-label"), "Start mission")
    assert.equal(await play.innerText(), "Start")
    await play.click()
    await row.getByRole("button", { name: "Pause mission", exact: true }).waitFor()
    await page.waitForFunction(() => !(document.querySelector('[aria-label="Pause mission"]') as HTMLButtonElement)?.disabled)
    await row.getByRole("button", { name: "Pause mission", exact: true }).click()
    await page.getByRole("alert").getByText("Action not yet confirmed. Check status before retrying.").waitFor()
    await fixtureCall(page, "mount", false)
    await fixtureCall(page, "mount", true)
    assert.equal(await play.getAttribute("aria-label"), "Check control status", "an unresolved request offers a status check, never a second Pause")
    await clickMissionAction(missionRows(page).first(), "Retry last action")
    await page.waitForFunction(() => { const button = document.querySelector<HTMLButtonElement>('[aria-label="Resume mission"]'); return Boolean(button && !button.disabled) })
    assert.equal(calls[1].requestId, calls[2].requestId)
    assert.equal(calls[1].expectedRevision, calls[2].expectedRevision)
    assert.equal(await play.getAttribute("aria-label"), "Resume mission")
    assert.equal(await page.getByRole("button", { name: "Start mission", exact: true }).count(), 0)
    await play.evaluate(el => { (window as any).savedPlayControl = el })
    await play.click()
    await page.waitForFunction(() => !(document.querySelector('[aria-label="Pause mission"]') as HTMLButtonElement)?.disabled)
    assert.equal(await play.evaluate(el => el === (window as any).savedPlayControl), true)
    await clickMissionAction(row, "Stop…")
    assert.equal(calls.length, 4, "Stop first asks for confirmation")
    await page.getByRole("dialog").getByRole("button", { name: "Stop mission permanently", exact: true }).click()
    await page.getByRole("button", { name: "Objective lifecycle", exact: true }).waitFor()
    await missionRows(page).getByText("Stopped", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-index-primary").count(), 0)
    await fixtureCall(page, "mount", false)
    await fixtureCall(page, "mount", true)
    assert.equal(await page.locator(".mission-index-primary").count(), 0)
    await row.getByRole("button", { name: "More actions", exact: true }).click()
    assert.equal(await page.getByRole("menuitem", { name: "Stop…", exact: true }).count(), 0, "terminal Missions hide Stop")
    await page.keyboard.press("Escape")
    await page.screenshot({ path: screenshotPath("mission-lifecycle-stopped") })
    assert.deepEqual(calls.map(call => call.action), ["start", "pause", "pause", "start", "stop"])
  } finally { await page.close() }
})

test("disclosures, mission selection and reader survive native invalidations, remount and restoration", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    await setup(page)
    let revision = 1
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [mission("one"), { ...mission("two"), revision }], generatedAt: revision, discardedEvents: 0 } }))
    await page.goto(url)
    await page.getByRole("button", { name: "Objective two", exact: true }).click()
    await openMore(page)
    const reports = page.getByRole("button", { name: "Reports", exact: true })
    await reports.click()
    const report = page.locator(".mission-advances .mission-list-item")
    await page.getByRole("button", { name: /^Conversations/ }).click()
    assert.equal(await reports.getAttribute("aria-expanded"), "true")
    assert.equal(await report.locator(".mission-disclosure-trigger").count(), 0)
    await clickMissionAction(report, "Read in chat area")
    await page.locator(".mission-reader .markdown-body p").first().waitFor()
    await page.screenshot({ path: screenshotPath("mission-reader-browser") })
    await page.locator(".mission-reader .window-body").evaluate(el => { el.scrollTop = 600 })
    await reports.focus()
    revision++
    await fixtureCall(page, "refresh")
    await page.waitForResponse(response => response.url().endsWith("/missions"))
    assert.equal(await reports.getAttribute("aria-expanded"), "true")
    assert.equal(await reports.evaluate(el => el === document.activeElement), true)
    assert.equal(await page.getByRole("button", { name: /^Conversations/ }).getAttribute("aria-expanded"), "true")
    assert.ok(await page.locator(".mission-reader .window-body").evaluate(el => el.scrollTop) > 0)
    await fixtureCall(page, "mount", false)
    await fixtureCall(page, "mount", true)
    assert.equal(await reports.getAttribute("aria-expanded"), "true")
    assert.ok(await page.locator(".mission-reader .window-body").evaluate(el => el.scrollTop) > 0)
    await fixtureCall(page, "flush")
    await page.reload()
    await page.locator(".mission-reader").waitFor()
    assert.equal(await reports.getAttribute("aria-expanded"), "true")
    assert.equal(await page.getByRole("button", { name: /^Conversations/ }).getAttribute("aria-expanded"), "true")
    assert.equal(await missionRows(page).locator('.mission-index-select[aria-current="true"]').getAttribute("aria-label"), "Objective two")
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
      const request = route.request(), body = request.postDataJSON()
      if (request.method() === "POST") {
        creates.push(body)
        if (failCreate) return route.fulfill({ status: 503, body: "Unavailable" })
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
      return route.fulfill({ json: { available: true, missions: list.map(m => ({ ...m, revision })), cleanups, generatedAt: revision, discardedEvents: 0 } })
    })
    await page.goto(url)
    await clickMissionAction(missionRows(page).first(), "Edit")
    await page.locator("form.mission-editor textarea").first().fill("My edited objective")
    revision++
    await fixtureCall(page, "refresh")
    await page.waitForResponse(response => response.url().endsWith("/missions"))
    assert.equal(await page.locator("form.mission-editor textarea").first().inputValue(), "My edited objective")
    await page.locator("form.mission-editor button[type=submit]").first().click()
    await page.getByRole("alert").waitFor()
    assert.equal(updates[0].expectedRevision, 1)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.locator("form.mission-editor textarea").first().fill("New mission objective")
    await page.locator("form.mission-editor button[type=submit]").first().click()
    await page.getByRole("alert").waitFor()
    failCreate = false
    await page.locator("form.mission-editor button[type=submit]").first().click()
    await missionRows(page).locator('.mission-index-select[aria-current="true"]', { hasText: "New mission objective" }).waitFor()
    assert.equal(creates.length, 2)
    assert.equal(creates[0].requestId, creates[1].requestId)
    await openMore(page)
    await fixtureCall(page, "flush")
    const storedDisclosures = () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("fixture-native")!).layout).filter(key => key.startsWith("mission-disclosures-")))
    const beforeDelete = await storedDisclosures()
    await clickMissionAction(missionRows(page).filter({ has: page.getByRole("button", { name: "New mission objective", exact: true }) }), "Delete…")
    await page.getByText("Delete this mission? The coordinator and reused conversations will be kept.").waitFor()
    const cleanup = page.getByRole("checkbox", { name: "Also delete specialist conversations created for this mission" })
    assert.equal(await cleanup.isChecked(), false)
    await cleanup.check()
    await page.locator("form").getByRole("button", { name: "Delete mission", exact: true }).click()
    await page.getByRole("alert").getByText("Deletion could not be completed. Retry to finish the remaining cleanup.").waitFor()
    assert.equal(await cleanup.isDisabled(), true)
    await fixtureCall(page, "refresh")
    await page.locator("form").getByRole("button", { name: "Delete mission", exact: true }).click()
    await page.locator("form.mission-editor").waitFor({ state: "detached" })
    await missionRows(page).locator('.mission-index-select[aria-current="true"]', { hasText: "Objective one" }).waitFor()
    assert.equal(deletions.length, 2)
    assert.equal(deletions[0].deleteManagedSessions, true)
    assert.equal(deletions[0].requestId, deletions[1].requestId)
    await fixtureCall(page, "flush")
    assert.equal((await storedDisclosures()).length, beforeDelete.length - 1)
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
      available: true, missions: [value], generatedAt: value.revision, discardedEvents: 0,
    } }))
    await page.goto(url)
    await openMore(page)
    const pending = page.getByRole("status").filter({ hasText: "Coordinator notification pending" })
    await pending.waitFor()
    await page.getByRole("button", { name: "Reports", exact: true }).click()
    await page.locator(".mission-advances .mission-list-status").getByText(/Complete/).waitFor()
    value.reports[0].notificationStatus = "admitted"
    value.revision++
    await fixtureCall(page, "refresh")
    await pending.waitFor({ state: "detached" })
    await page.locator(".mission-advances .mission-list-status").getByText(/Complete/).waitFor()
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
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [value], generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await taskButton(page, "task-next").click()
    await page.getByRole("button", { name: "Depends on Inspect evidence", exact: true }).click()
    await page.locator('.mission-task-reader[data-task-id="task-plan"]').waitFor()
    assert.equal(await taskRow(page, "task-one").locator(".mission-disclosure-trigger").count(), 0)
    await page.locator(".mission-reader").getByRole("heading", { name: "Inspect evidence", exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Back to chat")
    assert.equal(await page.getByRole("button", { name: "Back to chat", exact: true }).evaluate(el => el === document.activeElement), true)
    assert.equal(await page.locator(".mission-reader").getByRole("button", { name: /^(Blocks|Unblocks)/ }).count(), 0, "a completed task omits its trivial Unblocks pointer")
    await openMore(page)
    const history = page.locator(".mission-disclosure", { has: page.getByRole("button", { name: "Plan changes", exact: true }) }).last()
    await history.getByRole("button", { name: "Plan changes", exact: true }).click()
    await history.getByText("Showing the latest 2 changes.").waitFor()
    await history.getByText("Coordinator", { exact: true }).waitFor()
    await history.getByText("You", { exact: true }).waitFor()
    assert.equal(await history.locator(".mission-history-list .mission-disclosure-trigger").count(), 0)
    await clickMissionAction(history.locator(".mission-history-list .mission-list-item").first(), "Read in chat area")
    await page.locator(".mission-reader").getByText("Human clarification", { exact: true }).waitFor()
    await page.locator(".mission-reader").getByText("Old notes", { exact: true }).waitFor()
    await clickMissionAction(history.locator(".mission-history-list .mission-list-item").last(), "Read in chat area")
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
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions: [value], generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    await taskButton(page, "task-one").click()
    await openTaskTechnicalDetails(page)
    await fixtureCall(page, "seedActor")
    await page.locator(".mission-execution-cell", { hasText: "requested/chosen" }).waitFor()
    await page.locator(".mission-execution-cell", { hasText: "native/observed" }).waitFor()
    await page.locator('.mission-execution-cell[data-state="unknown"]', { hasText: "Unknown" }).waitFor()
    await fixtureCall(page, "event", { type: "form.created", data: { form: { id: "form-background", sessionID: "ses_background", title: "Choose the scope", fields: [{ type: "text", name: "scope", label: "Scope" }] } } })
    await page.getByText("Choose the scope", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-attention-list").getByRole("button", { name: "Answer", exact: true }).getAttribute("aria-description"), "Open Background assistant")
    await openMore(page)
    await page.getByRole("button", { name: /^Conversations/ }).click()
    await fixtureCall(page, "event", { type: "form.replied", data: { id: "form-background", sessionID: "ses_background", answers: {} } })
    await page.getByText("Choose the scope", { exact: true }).waitFor({ state: "detached" })
    assert.equal(await page.locator(".mission-needs").count(), 0)
    await clickMissionAction(missionRows(page).first(), "Open conversation")
    await page.getByRole("alert").getByText("Unable to reload session").waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.locator(".mission-execution").scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath("mission-execution-browser"), fullPage: true })
  } finally { await page.close() }
})

test("the real session retains its transcript nodes and draft while a long mission report scrolls independently", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1000, height: 800 } })
  try {
    await setup(page)
    await page.route("**/api/workspaces/browser-instance/missions", route => route.fulfill({ json: { available: true, missions: [mission("reader")], generatedAt: 1, discardedEvents: 0 } }))
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
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions, generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    assert.deepEqual(await page.locator(".mission-checklist li").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.taskKey)), ["research", "design", "implement", "review", "verify", "publish"])
    assert.equal(await page.locator(".mission-graph").isVisible(), false, "simple lists draw no dependency lines by default")
    const lastTask = await page.locator(".mission-checklist li").last().boundingBox()
    assert.ok(lastTask && lastTask.y + lastTask.height < 800, "the complete plan and result summary fit at a normal panel height")
    await openMore(page)
    await page.getByRole("button", { name: "Show dependencies", exact: true }).click()
    await page.locator('.mission-graph path[data-from="review"][data-to="publish"]').waitFor()
    assert.equal(await page.locator(".mission-graph path[data-from]").count(), 6)
    assert.deepEqual(await page.locator(".mission-route-task").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.taskKey)), ["research", "design", "implement", "review", "verify", "publish"])
    const indexRows = await missionRows(page).evaluateAll(rows => rows.map(row => row.getBoundingClientRect().toJSON()))
    assert.ok(indexRows[1].top >= indexRows[0].bottom)
    assert.equal(await page.locator(".mission-control-metrics").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Create mission", exact: true }).innerText(), "Create mission", "creation is discoverable without an icon tooltip")
    await page.screenshot({ path: screenshotPath("mission-compact-overview") })
    await page.getByRole("button", { name: "Reports", exact: true }).click()
    const report = page.locator(".mission-advances .mission-list-item")
    assert.equal(await report.locator(".mission-disclosure-trigger").count(), 0)
    await clickMissionAction(report, "Read in chat area")
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
    await page.getByRole("button", { name: "Back to chat" }).click()
    await page.evaluate(() => { document.querySelector<HTMLElement>(".mission-control")!.style.zoom = "1.25" })
    await page.waitForFunction(() => {
      const svg = document.querySelector<SVGSVGElement>(".mission-graph")!
      const node = svg.querySelectorAll("rect")[5]
      const title = document.querySelector('[data-task-key="publish"] .mission-list-item')!.getBoundingClientRect()
      const point = svg.createSVGPoint()
      point.x = Number(node.getAttribute("x")) + 3
      point.y = Number(node.getAttribute("y")) + 3
      const screen = point.matrixTransform(svg.getScreenCTM()!)
      return Math.abs(screen.y - (title.top + title.height / 2)) < 1
    })
    await page.evaluate(() => { document.querySelector<HTMLElement>(".mission-control")!.style.zoom = "1" })
    await page.setViewportSize({ width: 320, height: 850 })
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.locator("aside").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.screenshot({ path: screenshotPath("mission-compact-rtl") })
    missions = [{ ...value, revision: 2, tasks: value.tasks.filter(task => task.key !== "publish") }]
    await fixtureCall(page, "refresh")
    await page.locator('.mission-route-task[data-task-key="publish"]').waitFor({ state: "detached" })
    assert.equal(await page.locator('.mission-checklist [data-task-key="publish"]').count(), 0)
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
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, missions, generatedAt: 1, discardedEvents: 0 } }))
    await page.goto(url)
    const rows = missionRows(page)
    await rows.nth(2).waitFor()
    for (const [index] of missions.entries()) {
      // Derived titles keep the first clause and cut at a word boundary; the full objective stays in the reader.
      await rows.nth(index).getByRole("button", { name: `Mission ${index}: improve the desktop navigation and keep the…`, exact: true }).waitFor()
      assert.equal(await rows.nth(index).locator(".neutral-badge").count(), 0, "one-time rows carry no mode badge")
    }
    assert.equal(await page.locator(".mission-control-header h2, .mission-control-overview").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Missions", exact: true }).count(), 0)
    assert.equal(await page.locator(".mission-control > .mission-disclosure").count(), 0, "nothing below the card")
    assert.deepEqual(await selectedCard(page).locator(":scope > .mission-disclosure > h3 > .mission-disclosure-trigger").allTextContents(), ["More"])
    assert.equal(await selectedCard(page).getByRole("button", { name: "More", exact: true }).getAttribute("aria-expanded"), "false")
    assert.equal(await selectedCard(page).locator(".mission-guidance").count(), 1, "one coordinator field replaces question/direction disclosures")
    await openMore(page)
    assert.equal(await page.getByRole("button", { name: "Reports", exact: true }).getAttribute("aria-expanded"), "false")
    const title = await rows.first().locator(".mission-index-title bdi").evaluate(el => ({ overflow: getComputedStyle(el).textOverflow, wrap: getComputedStyle(el).whiteSpace }))
    assert.deepEqual(title, { overflow: "ellipsis", wrap: "nowrap" })
    const colors = await rows.locator(".mission-index-meta > span:first-child").evaluateAll(items => items.map(el => getComputedStyle(el).color))
    assert.equal(new Set(colors).size, 3)
    assert.equal(await rows.nth(1).evaluate(el => getComputedStyle(el).borderBottomWidth), "1px")
    await rows.nth(1).locator(".mission-index-select").click()
    await readAll(page).click()
    await page.locator(".mission-reader").getByText("Full context for mission 1", { exact: true }).waitFor()
    assert.equal(await rows.nth(1).locator(".mission-index-select").getAttribute("aria-current"), "true")
    await fixtureCall(page, "seedCoordinators", missions.map(mission => mission.coordinatorSessionId))
    await clickMissionAction(rows.nth(2), "Open conversation")
    await page.waitForFunction(() => (window as any).missionFixture.selectedSession() === "ses_coordinator_2")
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await page.screenshot({ path: screenshotPath("mission-top-level-rows") })
  } finally { await page.close() }
})

test("native activity stays separate from the plan and refreshes only while Missions is visible", async () => {
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
    const response = () => ({ available: true, missions: [value], generatedAt: requests, discardedEvents: 0,
      activity: { generatedAt: requests, missions: [{ missionId: value.id, actors: [
        { sessionId: "ses_running", state: "running" },
        { sessionId: "ses_background", state: "background" },
        { sessionId: "ses_idle", state: "idle-without-report" },
        { sessionId: "ses_unknown", state: "unknown" },
      ] }] } })
    await page.route("**/api/workspaces/fixture/missions", route => { requests += 1; return route.fulfill({ json: response() }) })
    await page.goto(url)
    await openMore(page)
    const activity = page.getByRole("button", { name: /^Conversations/ })
    await activity.click()
    await page.locator('.mission-activity-list [data-state="running"]').waitFor()
    await page.locator('.mission-activity-list [data-state="background"]').waitFor()
    await page.locator('.mission-activity-list [data-state="idle-without-report"]').waitFor()
    await page.locator('.mission-activity-list [data-state="unknown"]').waitFor()
    await page.locator(".mission-activity-list").getByText("Previous investigation title", { exact: true }).waitFor()
    await page.locator(".mission-activity-list").getByText("Current assignment: Verify current native state", { exact: true }).waitFor()
    await taskRow(page, "task-2").getByText("Verify current native state", { exact: true }).waitFor()
    await taskButton(page, "task-2").click()
    await openTaskTechnicalDetails(page)
    assert.equal(await page.getByText("Assignment admitted", { exact: true }).count() > 0, true)

    const beforeToken = requests
    const refreshed = page.waitForResponse(response => response.url().endsWith("/missions"))
    await fixtureCall(page, "refresh")
    await refreshed
    assert.ok(requests > beforeToken)
    assert.equal(await activity.getAttribute("aria-expanded"), "true")

    await fixtureCall(page, "mount", false)
    const hidden = requests
    await fixtureCall(page, "refresh")
    await page.waitForTimeout(100)
    assert.equal(requests, hidden)
    const visibleRefresh = page.waitForResponse(response => response.url().endsWith("/missions"))
    await fixtureCall(page, "mount", true)
    await visibleRefresh
    assert.equal(await activity.getAttribute("aria-expanded"), "true")
    await page.screenshot({ path: screenshotPath("mission-native-activity") })
  } finally { await page.close() }
})
