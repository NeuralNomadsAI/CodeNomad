import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-editor-lifetime"
import { missionProfileRoles } from "../../../server/src/missions/playbook-profiles"
import { MISSION_LIFECYCLE_TEXT_LIMIT } from "../../../server/src/missions/lifecycle-input"
import { recurrenceInputBudget } from "../../../server/src/missions/recurrence-read-budget"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-recurrence", configureServer(s) { s.middlewares.use("/recurrence", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/recurrence", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/recurrence`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("source budget and actual native whole-input preflights never raise ceilings or retain certified no-effect holds", async () => {
  const page = await browser.newPage({ locale: "en-US" }), posts: Array<Record<string, any>> = []
  const directory = `/native/owned/${"long-root-".repeat(30)}`, watchedConversationIDs = ["ses_one", "ses_two"]
  const selected = { agent: "all", model: { providerID: "p", id: "m" } }
  const profiles = { coordinator: selected, roles: { specialist: selected } }
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/workspaces/fixture/instance/api/location*", route => route.fulfill({ json: { directory,
    project: { id: "project", directory, canonical: directory } } }))
  await page.route("**/api/storage/config/ui*", route => route.fulfill({ json: { settings: {
    missionProfileDefaults: [{ template: "custom", profiles, taskMode: "native" }] } } }))
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
    posts.push(route.request().postDataJSON())
    return route.fulfill({ status: 400, json: { error: "Native whole-input preflight refused before effect", code: "recurrence-input-capacity" } })
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel("Execution mode").selectOption("recurring")
    await form.getByLabel("Permanent instructions").fill("Review sources")
    await form.getByLabel(/Followed conversation IDs/).fill(watchedConversationIDs.join("\n"))
    await form.getByRole("alert").getByText(/At least 5 effects and 2 inbox messages/).waitFor()
    await form.getByText("Passage budgets", { exact: true }).click()
    const inputs = form.locator(".mission-recurrence-budgets input")
    assert.equal(await inputs.nth(0).inputValue(), "3", "watch selection never raises the selected effect ceiling")
    assert.equal(await inputs.nth(0).getAttribute("min"), "5")
    assert.equal(await inputs.nth(2).getAttribute("min"), "2")
    await inputs.nth(0).fill("5"); await inputs.nth(2).fill("1")
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(posts.length, 0)
    await inputs.nth(2).fill("2")
    const maximum = recurrenceInputBudget({ consigne: "", watchedConversationIDs, roots: [{ directory }] }).instructionsMaximum
    assert(maximum < MISSION_LIFECYCLE_TEXT_LIMIT)
    await form.getByLabel("Permanent instructions").fill("x".repeat(maximum + 1))
    await form.getByRole("alert").getByText(/Instructions plus followed-conversation context/).waitFor()
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(posts.length, 0, "the actual native root's envelope is included, not the display folder")
    await form.getByLabel("Permanent instructions").fill("x".repeat(maximum))
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('form.mission-editor button[type="submit"]')?.disabled)
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").getByText(/Instructions plus followed-conversation context/).waitFor()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].instructions.length, maximum)
    assert.equal(posts[0].budgets.effects, 5); assert.equal(posts[0].budgets.inboxMessages, 2)
    assert.equal(await page.evaluate(async () => {
      const { uncertainRecurrence } = await import("/src/stores/mission-recurrence-drafts.ts")
      return Boolean(uncertainRecurrence(JSON.stringify(["fixture", "/fixture", "project"])))
    }), false, "a certified prepublication refusal is never an uncertain creation")
    await form.getByRole("button", { name: "Cancel" }).click()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await form.getByLabel("Objective", { exact: true }).fill("One-time still available")
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), false)
    assert.equal(posts.length, 1, "refresh/remount never replays the rejected request")
  } finally { await page.close() }
})

test("saved Pocock briefs copy into fresh paused recurring drafts without saving schedule or invocation state", async () => {
  const page = await browser.newPage({ locale: "en-US" }), creates: Array<Record<string, any>> = [], writes: Array<Record<string, any>> = []
  const selected = { agent: "all", model: { providerID: "p", id: "m" } }
  const profiles = { coordinator: selected, roles: Object.fromEntries(missionProfileRoles["pocock-fix-bug"].map(role => [role, selected])) }
  const model = { version: 1, id: "11111111-2222-4333-8444-555555555555", name: "Saved Pocock brief",
    objective: "Fix the requested bug", notes: "  Saved technical notes\n<keep verbatim>  ", template: "pocock-fix-bug", profiles, taskMode: "independent" }
  let bucket: Record<string, any> = { unrelated: "keep", settings: { missionModels: [model], missionProfileDefaults: [] } }
  const schedules: Array<Record<string, any>> = []
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/workspaces/fixture/instance/api/location*", route => route.fulfill({ json: { directory: "/fixture",
    project: { id: "project", directory: "/fixture", canonical: "/fixture" } } }))
  await page.route("**/api/storage/config/ui*", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: bucket })
    const body = route.request().postDataJSON()
    assert.equal(new URL(route.request().url()).searchParams.get("conditional"), "missions-v1")
    for (const expected of body.expected) {
      assert.equal(expected.present, Object.prototype.hasOwnProperty.call(bucket.settings, expected.key))
      if (expected.present) assert.deepEqual(expected.value, bucket.settings[expected.key])
    }
    writes.push(body.patch)
    bucket = { ...bucket, ...body.patch, settings: { ...bucket.settings, ...body.patch.settings } }
    return route.fulfill({ json: bucket })
  })
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { version: 1, projectID: "project", schedules } })
    const body = route.request().postDataJSON(); creates.push(body)
    const schedule = { id: `rec_brief_${creates.length}`, revision: 0, scheduleRevision: 0, state: "paused", clock: body.clock, pendingPassageID: null, settledCount: 0 }
    schedules.push(schedule)
    return route.fulfill({ json: { schedule } })
  })
  try {
    await page.goto(url)
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("button", { name: "Create mission", exact: true }).click()
      const form = page.locator("form.mission-editor")
      await form.getByLabel("Execution mode").selectOption("recurring")
      await form.getByLabel("Daily local time").fill("14:20")
      await form.getByLabel("Time zone (IANA)").fill("UTC")
      await form.getByLabel(/Followed conversation IDs/).fill("ses_retained")
      await form.getByText("Passage budgets", { exact: true }).click()
      await form.locator(".mission-recurrence-budgets input").first().fill("8")
      await form.locator("summary").getByText("Saved briefs", { exact: true }).click()
      await form.getByLabel("Saved brief", { exact: true }).selectOption(model.id)
      await form.getByRole("button", { name: "Use this brief", exact: true }).click()
      assert.equal(await form.getByLabel("Execution mode").inputValue(), "recurring")
      assert.equal(await form.getByLabel("Permanent instructions").inputValue(), model.objective)
      assert.equal(await form.getByLabel("Notes", { exact: true }).inputValue(), model.notes)
      assert.equal(await form.getByLabel("Playbook", { exact: true }).inputValue(), model.template)
      assert.equal(await form.getByLabel("Task sessions", { exact: true }).inputValue(), "independent")
      assert.equal(await form.getByLabel("Daily local time").inputValue(), "14:20")
      assert.equal(await form.getByLabel(/Followed conversation IDs/).inputValue(), "ses_retained")
      assert.equal(creates.length, attempt, "using a saved brief admits no work")
      if (!attempt) {
        await form.getByLabel("Brief name", { exact: true }).fill("Another recurring brief")
        await form.getByRole("button", { name: "Save brief", exact: true }).click()
        await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('form.mission-editor input[aria-label="Brief name"]')?.value)
        assert.equal(creates.length, 0)
        const saved = writes[0].settings.missionModels[1]
        assert.deepEqual(Object.keys(saved).sort(), ["version", "id", "name", "objective", "notes", "template", "profiles", "taskMode"].sort())
        assert.deepEqual(saved.profiles, model.profiles); assert.equal(saved.notes, model.notes)
        assert.equal(saved.objective, model.objective); assert.equal(bucket.unrelated, "keep")
      }
      await form.getByRole("button", { name: "Save", exact: true }).click()
      await page.getByText(`rec_brief_${attempt + 1}`, { exact: true }).waitFor()
      const request = creates[attempt]
      assert.equal(request.template, model.template); assert.equal(request.instructions, model.objective)
      assert.equal(request.notes, model.notes); assert.equal(request.taskMode, model.taskMode)
      assert.deepEqual(request.profiles, model.profiles)
      assert.deepEqual(request.clock, { time: "14:20", zone: "UTC" })
      assert.deepEqual(request.watchedConversationIDs, ["ses_retained"])
      assert.equal(request.budgets.effects, 8)
      assert.notEqual(request.requestID, model.id)
    }
    assert.notEqual(creates[0].requestID, creates[1].requestID)
    assert.equal(await page.getByText("Paused", { exact: true }).count(), 2)
    assert.equal(await page.getByRole("button", { name: /Run now|Play|Resume|Stop schedule/ }).count(), 0)
  } finally { await page.close() }
})

test("oversized instructions never write; certified capacity keeps recurring and one-shot creation usable after remount", async () => {
  const page = await browser.newPage({ locale: "en-US" }), writes: Array<Record<string, any>> = []
  const selected = { agent: "all", model: { providerID: "p", id: "m" } }
  const profiles = { coordinator: selected, roles: { specialist: selected } }
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui*", route => route.fulfill({ json: { settings: {
    missionProfileDefaults: [{ template: "custom", profiles, taskMode: "native" }] } } }))
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
    writes.push(route.request().postDataJSON())
    return route.fulfill({ status: 503, json: { error: "Capacity reached", code: "recurrence-capacity" } })
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel("Execution mode").selectOption("recurring")
    const instructions = form.getByLabel("Permanent instructions")
    assert.equal(await instructions.getAttribute("maxlength"), String(MISSION_LIFECYCLE_TEXT_LIMIT))
    await instructions.evaluate((element, limit) => {
      const textarea = element as HTMLTextAreaElement
      textarea.value = "x".repeat(limit + 1); textarea.dispatchEvent(new Event("input", { bubbles: true }))
    }, MISSION_LIFECYCLE_TEXT_LIMIT)
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    await form.getByRole("alert").getByText(/within 16384 characters/).waitFor()
    assert.equal(writes.length, 0)
    await instructions.fill("x".repeat(MISSION_LIFECYCLE_TEXT_LIMIT))
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").getByText(/Nothing was created/).waitFor()
    assert.equal(writes[0].instructions.length, MISSION_LIFECYCLE_TEXT_LIMIT)
    await page.waitForTimeout(100)
    assert.equal(writes.length, 1, "certified capacity never auto retries")
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), false)
    assert.equal(await page.evaluate(async () => {
      const { uncertainRecurrence } = await import("/src/stores/mission-recurrence-drafts.ts")
      return Boolean(uncertainRecurrence(JSON.stringify(["fixture", "/fixture", "project"])))
    }), false)
    await form.getByRole("button", { name: "Cancel" }).click()
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    assert.equal(await form.getByLabel("Execution mode").inputValue(), "once")
    await form.getByLabel("Objective", { exact: true }).fill("One-shot remains allowed")
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), false)
    await form.getByLabel("Execution mode").selectOption("recurring")
    await form.getByLabel("Permanent instructions").fill("An explicit retry")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").getByText(/Nothing was created/).waitFor()
    assert.equal(writes.length, 2, "remounted recurring creation is not permanently fenced")
  } finally { await page.close() }
})

for (const failure of ["unavailable", "invalid"] as const) {
  test(`recurring form exposes owner ${failure} recovery and reloads exact custom defaults`, async () => {
    const page = await browser.newPage({ locale: "en-US" }), writes: Array<Record<string, any>> = []
    let failed = true
    const profiles = { coordinator: { agent: "all", model: { providerID: "p", id: "m" } },
      roles: { specialist: { agent: "all", model: { providerID: "p", id: "m" } } } }
    await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
      claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/storage/config/ui*", route => failed
      ? failure === "unavailable" ? route.fulfill({ status: 503, json: { error: "Owner unavailable" } })
        : route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "not-custom" }] } } })
      : route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles, taskMode: "native" }] } } }))
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } }))
    await page.route("**/api/workspaces/fixture/missions/recurrence", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
      writes.push(route.request().postDataJSON())
      return route.fulfill({ json: { schedule: { id: "rec_recovered", state: "paused", revision: 0, scheduleRevision: 0 } } })
    })
    try {
      await page.goto(url)
      await page.getByRole("button", { name: "Create mission", exact: true }).click()
      const form = page.locator("form.mission-editor")
      await form.getByLabel("Execution mode").selectOption("recurring")
      await form.getByLabel("Permanent instructions").fill("Keep the original draft")
      await form.getByRole("alert").getByText(failure === "unavailable" ? /settings are unavailable/ : /saved defaults cannot be read safely/).waitFor()
      assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
      assert.equal(writes.length, 0)
      failed = false
      await form.getByRole("button", { name: "Reload saved defaults" }).click()
      await form.getByRole("button", { name: "Save", exact: true }).waitFor({ state: "visible" })
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('form.mission-editor button[type="submit"]')?.disabled)
      assert.equal(await form.getByLabel("Permanent instructions").inputValue(), "Keep the original draft")
      await form.getByRole("button", { name: "Save", exact: true }).click()
      await page.waitForFunction(() => !document.querySelector("form.mission-editor"))
      assert.equal(writes.length, 1)
      assert.deepEqual(writes[0].profiles, profiles)
    } finally { await page.close() }
  })
}

for (const template of ["custom", "pocock-fix-bug", "wayfinder"] as const) test(`real editor creates a paused ${template} schedule with exact inputs; list stays read-only and cache-first`, async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 375, height: 800 } })
  const writes: Array<Record<string, any>> = []
  let reads = 0, snapshot: any = { version: 1, projectID: "project", schedules: [] }
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/workspaces/fixture/instance/api/location*", route => route.fulfill({ json: { directory: "/fixture",
    project: { id: "project", directory: "/fixture", canonical: "/fixture" } } }))
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => {
    if (route.request().method() === "GET") { reads++; return route.fulfill({ json: snapshot }) }
    const body = route.request().postDataJSON(); writes.push(body)
    snapshot = { version: 1, projectID: "project", schedules: [{ id: "rec_fixture", revision: 0, scheduleRevision: 0,
      state: "paused", clock: body.clock, pendingPassageID: null, settledCount: 0 }] }
    return route.fulfill({ json: { schedule: snapshot.schedules[0] } })
  })
  await page.route("**/workspaces/fixture/instance/api/agent**", route => route.fulfill({ json: { data: [{ id: "all", mode: "all" }] } }))
  await page.route("**/workspaces/fixture/instance/api/model**", route => route.fulfill({ json: { data: [{ providerID: "p", id: "m", enabled: true, capabilities: { tools: true }, variants: [] }] } }))
  try {
    await page.goto(url)
    await page.evaluate(async () => {
      const [{ updateInstance }, { getRootClient }] = await Promise.all([import("/src/stores/instances.ts"), import("/src/stores/opencode-client.ts")])
      updateInstance("fixture", { client: getRootClient("fixture") })
    })
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel("Playbook", { exact: true }).selectOption(template)
    await form.getByLabel("Execution mode").selectOption("recurring")
    assert.equal(await form.getByLabel("Playbook", { exact: true }).inputValue(), template)
    await form.getByLabel("Permanent instructions").fill("Review new changes")
    const notes = "  Optional working context\n<keep verbatim> & notes  "
    await form.getByLabel("Notes", { exact: true }).fill(notes)
    await form.getByLabel("Daily local time").fill("08:15")
    await form.getByLabel("Time zone (IANA)").fill("Europe/Paris")
    await form.getByLabel(/Followed conversation IDs/).fill("ses_123")
    await form.getByText("Passage budgets", { exact: true }).click()
    const effects = form.locator(".mission-recurrence-budgets input").first()
    assert.equal(await effects.inputValue(), "3", "following a source never silently raises a human ceiling")
    await effects.fill("4")
    await form.getByText("Passage budgets", { exact: true }).click()
    assert.equal(await form.locator(".mission-profile-row").count(), missionProfileRoles[template].length + 1)
    for (const row of await form.locator(".mission-profile-row").all()) {
      await row.locator("select").nth(0).selectOption("all")
      await row.locator("select").nth(1).selectOption(JSON.stringify(["p", "m"]))
    }
    await form.getByLabel("Time zone (IANA)").fill("UTC+2")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").getByText(/valid local time/).waitFor()
    assert.equal(writes.length, 0, "invalid civil clock never reaches the native route")
    await form.getByLabel("Time zone (IANA)").fill("Europe/Paris")
    await form.getByText("Passage budgets", { exact: true }).click()
    assert.equal(await effects.inputValue(), "4", "one source needs a fourth reserved effect")
    await effects.fill("2")
    await form.getByText("Passage budgets", { exact: true }).click()
    await form.getByRole("alert").getByText(/At least 4 effects/).waitFor()
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(writes.length, 0, "a too-small effect budget never reaches creation")
    await form.getByText("Passage budgets", { exact: true }).click()
    await effects.fill("4")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByText("08:15 · Europe/Paris").waitFor()
    assert.equal(writes.length, 1)
    assert.match(writes[0].requestID, /^[0-9a-f-]{36}$/)
    assert.equal(writes[0].template, template)
    assert.equal(writes[0].notes, notes)
    assert.deepEqual(writes[0].watchedConversationIDs, ["ses_123"])
    assert.deepEqual(writes[0].budgets, { effects: 4, nativeCalls: 8, inboxMessages: 32, publications: 0 })
    const selected = { agent: "all", model: { providerID: "p", id: "m" } }
    assert.deepEqual(writes[0].profiles, { coordinator: selected,
      roles: Object.fromEntries(missionProfileRoles[template].map(role => [role, selected])) })
    assert.equal(await page.getByText("Paused", { exact: true }).count(), 1)
    assert.equal(await page.getByRole("button", { name: /Run now|Play|Resume|Stop schedule/ }).count(), 0)
    await page.evaluate(() => window.missionEditorLifetime.activate(false))
    const beforeHidden = reads
    await page.evaluate(() => window.missionEditorLifetime.invalidate())
    await page.waitForTimeout(130)
    assert.equal(reads, beforeHidden)
    await page.evaluate(() => window.missionEditorLifetime.activate(true))
    await page.waitForResponse(response => response.url().endsWith("/missions/recurrence") && response.request().method() === "GET")
    assert.ok(reads > beforeHidden)
    const radius = await page.locator(".mission-recurrence-item").evaluate(node => getComputedStyle(node).borderRadius)
    assert.equal(radius, "0px")
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    const layout = await page.locator(".mission-recurrence-list").evaluate(node => ({ width: node.getBoundingClientRect().width,
      item: node.querySelector(".mission-recurrence-item")!.getBoundingClientRect().width }))
    assert.ok(layout.item <= layout.width, "compact RTL schedule stays inside the panel")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("uncertain creation refreshes the visible read-only list and preserves the exact draft across remount", async () => {
  const page = await browser.newPage({ locale: "en-US" }); const writes: Array<{ requestID: string }> = []
  let reads = 0, snapshot: any = { version: 1, projectID: "project", schedules: [] }
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => {
    if (route.request().method() === "GET") { reads++; return route.fulfill({ json: snapshot }) }
    const body = route.request().postDataJSON(); writes.push(body)
    snapshot = { version: 1, projectID: "project", schedules: [{ id: "rec_uncertain", revision: 0, scheduleRevision: 0,
      state: "paused", clock: body.clock, pendingPassageID: null, settledCount: 0 }] }
    return route.fulfill({ status: 503, json: { error: "Unknown result" } })
  })
  await page.route("**/workspaces/fixture/instance/api/agent**", route => route.fulfill({ json: { data: [{ id: "all", mode: "all" }] } }))
  await page.route("**/workspaces/fixture/instance/api/model**", route => route.fulfill({ json: { data: [{ providerID: "p", id: "m", enabled: true, capabilities: { tools: true }, variants: [] }] } }))
  try {
    await page.goto(url)
    await page.evaluate(async () => {
      const [{ updateInstance }, { getRootClient }] = await Promise.all([import("/src/stores/instances.ts"), import("/src/stores/opencode-client.ts")])
      updateInstance("fixture", { client: getRootClient("fixture") })
    })
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel("Execution mode").selectOption("recurring")
    await form.getByLabel("Playbook", { exact: true }).selectOption("wayfinder")
    await form.getByLabel("Permanent instructions").fill("Never duplicate")
    const heldNotes = "  Uncertain optional notes\nkeep every space  "
    await form.getByLabel("Notes", { exact: true }).fill(heldNotes)
    for (const row of await form.locator(".mission-profile-row").all()) {
      await row.locator("select").nth(0).selectOption("all")
      await row.locator("select").nth(1).selectOption(JSON.stringify(["p", "m"]))
    }
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").waitFor()
    assert.equal(await page.getByText("rec_uncertain").count(), 0, "a failed write is not a read-only list update")
    const beforeRefresh = reads
    await form.getByRole("button", { name: "Refresh" }).click()
    await page.getByText("rec_uncertain").waitFor()
    assert.ok(reads > beforeRefresh, "Refresh reads through the mounted list rather than dropping the result")
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(async () => {
      const { uncertainRecurrence } = await import("/src/stores/mission-recurrence-drafts.ts")
      return uncertainRecurrence(JSON.stringify(["fixture", "/fixture", "project"]))?.requestID
    }), writes[0].requestID, "a list observation cannot settle an uncertain request")
    await form.getByRole("button", { name: "Cancel" }).click()
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    assert.equal(await form.getByLabel("Permanent instructions").inputValue(), "Never duplicate")
    assert.equal(await form.getByLabel("Notes", { exact: true }).inputValue(), heldNotes)
    assert.equal(await form.getByLabel("Playbook", { exact: true }).inputValue(), "wayfinder")
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(writes.length, 1)
  } finally { await page.close() }
})
