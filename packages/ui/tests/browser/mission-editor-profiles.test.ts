import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type {} from "./fixtures/mission-editor-lifetime"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-editor-profiles", configureServer(s) { s.middlewares.use("/editor-profiles", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/editor-profiles", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/editor-profiles`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
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
  await page.route("**/api/workspaces/fixture/missions**", route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/missions/recurrence")
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
    await page.locator("form.mission-editor summary").filter({ hasText: /^Agents · defaults and overrides$/ }).click()
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
after(async () => { await browser?.close(); await server?.close() })

test("real editor sends exact coordinator/reviewer model variants and deep-held unknown creation keeps them across remount", async () => {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = []
  const writes: Array<Record<string, unknown>> = [], catalogReads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
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
    return route.fulfill({ json: { data: [
      { providerID: "p", id: "m", enabled: true, capabilities: { tools: true }, variants: [{ id: "high" }, { id: "low" }] },
      { providerID: "p", id: "disabled", enabled: false, capabilities: { tools: true }, variants: [] },
    ] } })
  })
  try {
    await page.goto(url)
    // Reuse the fixture's real owned-instance store and generated Promise client.
    await page.evaluate(async () => {
      const instancesPath = "/src/stores/instances.ts", clientPath = "/src/stores/opencode-client.ts"
      const [{ updateInstance }, { getRootClient }] = await Promise.all([import(instancesPath), import(clientPath)])
      updateInstance("fixture", { client: getRootClient("fixture") })
    })
    assert.equal(catalogReads.length, 0, "a closed editor has no catalog demand")
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.getByLabel("Objective", { exact: true }).fill("Profile fixture")
    await page.getByLabel("Playbook", { exact: true }).selectOption("pocock-fix-bug")
    assert.equal(catalogReads.length, 0, "collapsed overrides have no catalog demand")
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).count(), 0)
    await page.locator("form.mission-editor summary").filter({ hasText: /^Agents · defaults and overrides$/ }).click()
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
    await page.locator("form.mission-editor").getByText("Optional task presets", { exact: true }).click()
    await page.getByLabel("Implementer · Agent", { exact: true }).selectOption("all")
    const geometry = await root.evaluate(select => ({ radius: getComputedStyle(select).borderRadius,
      rowWidth: select.closest("fieldset")!.getBoundingClientRect().width, formWidth: select.closest("form")!.getBoundingClientRect().width }))
    assert.equal(geometry.radius, "0px")
    assert.ok(geometry.rowWidth <= geometry.formWidth, "compact profile row fits the narrow editor")
    assert.equal(await page.getByLabel("Specification reviewer · Model", { exact: true }).locator('option').filter({ hasText: "disabled" }).count(), 0)
    await page.getByRole("button", { name: "Save", exact: true }).click()
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
    const changedDefaults = [{ template: "custom", profiles: { coordinator: { agent: "all", model: { providerID: "p", id: "m", variant: "low" } }, roles: { specialist: { agent: "all" } } } }]
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
    await page.locator("form.mission-editor summary").filter({ hasText: /^Agents · defaults and overrides$/ }).click()
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Thinking", { exact: true }).inputValue(), "high")
    assert.equal(await page.getByLabel("Specification reviewer · Thinking", { exact: true }).inputValue(), "low")
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).inputValue(), "root-only")
    assert.equal(await page.getByLabel("Specification reviewer · Agent", { exact: true }).inputValue(), "child-only")
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    await page.getByRole("button", { name: "Refresh mission map", exact: true }).last().click()
    assert.equal(writes.length, 1)
    assert.equal(catalogReads.length, 2, "uncertain draft does not refresh or replace its original profile")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
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
    await page.evaluate(async () => {
      const instancesPath = "/src/stores/instances.ts", clientPath = "/src/stores/opencode-client.ts"
      const [{ updateInstance }, { getRootClient }] = await Promise.all([import(instancesPath), import(clientPath)])
      updateInstance("fixture", { client: getRootClient("fixture") })
    })
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.getByLabel("Objective", { exact: true }).fill("Saved default snapshot")
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(await page.getByLabel("Playbook", { exact: true }).isDisabled(), true)
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).count(), 0)
    await page.locator("form.mission-editor").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    assert.deepEqual(writes, [], "pending defaults fence direct form admission, not just the Save button")
    release()
    await page.getByRole("button", { name: "Save", exact: true }).waitFor()
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
    assert.match(await page.locator("form.mission-editor").innerText(), /saved-root/)
    assert.match(await page.locator("form.mission-editor").innerText(), /saved-child/)
    assert.equal(await page.locator("form.mission-editor details").filter({ has: page.locator("summary").filter({ hasText: /^Agents · defaults and overrides$/ }) }).evaluate(element => (element as HTMLDetailsElement).open), false)
    assert.equal(await page.locator("form.mission-editor").getByLabel("Coordinator · Agent", { exact: true }).count(), 0)
    assert.deepEqual(catalogs, [])
    await page.getByRole("button", { name: "Save", exact: true }).click()
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
    assert.equal(await form.locator("details").first().locator("summary").innerText(), "Saved briefs")
    await form.getByLabel("Objective", { exact: true }).fill("Daily review\nReview the latest work and report changes.")
    const mode = form.locator("select").filter({ has: page.locator('option[value="recurring"]') })
    await mode.selectOption("recurring")
    const zone = form.getByLabel("Time zone (IANA)", { exact: true })
    assert.equal(await zone.inputValue(), "America/New_York", "the system zone stays the default")
    // Suggestions come from the runtime's own IANA list, when it has one.
    const suggestions = await zone.evaluate(input => [...((input as HTMLInputElement).list?.options ?? [])].map(option => option.value))
    assert.ok(suggestions.includes("Europe/Paris") && suggestions.includes("America/New_York"), "native time-zone suggestions")
    // Notes come before the creation hint, which closes the form body.
    const order = await form.evaluate(element => {
      const notes = [...element.querySelectorAll("label")].find(label => label.textContent?.startsWith("Notes"))
      const hint = element.querySelector(".mission-editor-start-hint")
      return Boolean(notes && hint && notes.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    assert.equal(order, true)
    await zone.fill("Not/A_Time_Zone")
    assert.equal(await zone.getAttribute("aria-invalid"), "true")
    await form.getByRole("alert").filter({ hasText: "Enter a valid IANA time zone" }).waitFor()
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    await zone.fill("America/New_York")
    assert.equal(await zone.getAttribute("aria-invalid"), "false")
    const title = form.locator('input[maxlength="120"]')
    assert.equal(await title.inputValue(), "Daily review")
    assert.equal(await form.locator("textarea").first().inputValue(), "Daily review\nReview the latest work and report changes.")
    assert.equal(await form.locator('input[type="number"]').count(), 0)
    assert.doesNotMatch(await form.innerText(), /Publications|Native calls|Effect budget/)
    assert.equal(await form.getByLabel("Coordinator · Agent", { exact: true }).count(), 0)
    const overrides = form.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Agents · defaults and overrides$/ }) })
    assert.equal(await overrides.evaluate(element => (element as HTMLDetailsElement).open), false)
    await form.locator("textarea").first().fill("Updated daily review\nKeep the reference conversation in context.")
    assert.equal(await title.inputValue(), "Updated daily review")
    await title.fill("My daily schedule")
    await mode.selectOption("once")
    assert.equal(await form.getByLabel("Objective", { exact: true }).inputValue(), "Updated daily review\nKeep the reference conversation in context.")
    await mode.selectOption("recurring")
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
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").filter({ hasText: /unconfirmed/ }).waitFor()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].title, "My daily schedule")
    assert.equal(writes[0].instructions, "Updated daily review\nKeep the reference conversation in context.")
    assert.deepEqual(writes[0].watchedConversationIDs, ["ses_reference"])
    assert.deepEqual(writes[0].profiles, profiles)
    assert.equal(writes[0].taskMode, "independent")
    assert.equal("budgets" in writes[0], false)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
