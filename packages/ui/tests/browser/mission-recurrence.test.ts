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
import { recurrenceControlHttpSchema, recurrenceControlRequestSchema, recurrenceControlStatusSchema } from "../../../server/src/missions/recurrence-control-contract"
import { recurrenceHumanRequestID } from "../../../server/src/missions/recurrence-authority-contract"
import { controlOperationID, controlReceiptID } from "../../../server/src/missions/receipt-identity"
import { captureMissionView } from "./mission-view-capture"

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
    if (template === "custom") {
      await captureMissionView(page, "creation-recurring-inputs")
      await page.locator("aside").evaluate(node => { node.scrollTop = 0 })
      await captureMissionView(page, "creation-recurring-top")
    }
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
    if (template === "custom") await captureMissionView(page, "created-paused-schedule")
    assert.equal(await page.getByRole("button", { name: /Run now|Play|Resume|Stop schedule/ }).count(), 0)
    await page.evaluate(() => window.missionEditorLifetime.activate(false))
    const beforeHidden = reads
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
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

test("qualified Interrupted resumes only on click; unknown control survives native refresh without replay", async () => {
  const page = await browser.newPage({ locale: "fr-FR", viewport: { width: 320, height: 740 }, hasTouch: true })
  const writes: Array<{ requestID: string; expectedEpoch: number; expectedRevision: number; action: string; directory: string }> = []
  let statusReads = 0
  let outcome: "committed" | "unknown" = "unknown"
  let releaseMutation!: () => void, mutationObserved!: () => void
  const delayedMutation = new Promise<void>(resolve => { releaseMutation = resolve })
  const mutationStarted = new Promise<void>(resolve => { mutationObserved = resolve })
  let releaseStatus!: () => void, statusObserved!: () => void
  const delayedStatus = new Promise<void>(resolve => { releaseStatus = resolve })
  const statusStarted = new Promise<void>(resolve => { statusObserved = resolve })
  const schedule = { id: "rec_controls", revision: 4, scheduleRevision: 1, state: "interrupted", epoch: 2,
    clock: { time: "09:00", zone: "Europe/Paris" }, pendingPassageID: null as string | null, settledCount: 1,
    controlCapability: { version: 1, actions: ["play", "pause", "stop"] } }
  let capability = false
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  const mission = { version: 1, id: "msn_fixture", projectID: "project", projectCanonical: "/fixture", objective: "Review",
    template: "custom", notes: "", coordinatorSessionId: "ses_fixture", status: "active", runState: "paused",
    actors: [{ sessionId: "ses_fixture", kind: "coordinator", managed: true, title: "Coordinator", roles: [],
      location: { directory: "/fixture" }, joinedAt: 1 }], frontier: [], claims: [], revision: 1, createdAt: 1,
    updatedAt: 1, history: [], historyTruncated: false, tasks: [], reports: [] }
  await page.route("**/api/workspaces/*/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: [mission], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/api/workspaces/*/missions/recurrence", route => route.fulfill({ json: { version: 1, projectID: "project",
    schedules: [{ ...schedule, ...(capability ? {} : { controlCapability: undefined }) }] } }))
  await page.route("**/api/workspaces/*/missions/recurrence/*/control", async route => {
    const body = route.request().postDataJSON()
    recurrenceControlHttpSchema.parse(body)
    writes.push(body); mutationObserved()
    await delayedMutation
    return route.fulfill({ status: 503, json: { error: "Unknown result" } })
  })
  await page.route("**/api/workspaces/*/missions/recurrence/*/control/status", async route => {
    const { directory: _directory, ...body } = route.request().postDataJSON()
    recurrenceControlRequestSchema.parse({ ...body, scheduleID: schedule.id })
    statusReads++
    if (statusReads === 1) {
      statusObserved(); await delayedStatus
      return route.fulfill({ status: 503, json: { error: "Status still unknown" } })
    }
    const result = recurrenceControlStatusSchema.parse({ version: 1, scheduleID: schedule.id, requestID: writes[0]?.requestID,
      expectedRevision: 4, epoch: 3, outcome, controlsComplete: outcome === "committed",
      ...(outcome === "committed" ? { revision: 5, state: "running" } : {}) })
    return route.fulfill({ json: result })
  })
  try {
    await page.goto(url)
    await page.evaluate(async () => {
      const { addFormToQueue } = await import("/src/stores/forms.ts")
      addFormToQueue("fixture", { id: "form_review", sessionID: "ses_fixture", title: "Native decision", fields: [], location: { directory: "/fixture" } } as any)
    })
    const resume = page.getByRole("button", { name: `Reprendre le programme ${schedule.id}` })
    await page.getByText("Interrompue", { exact: true }).waitFor()
    await page.getByText("Native decision").waitFor()
    const order = await page.evaluate(() => ({ attention: document.querySelector(".mission-attention-list")?.getBoundingClientRect().top,
      control: document.querySelector(".mission-recurrence-item")?.getBoundingClientRect().top }))
    assert.ok(order.attention !== undefined && order.control !== undefined && order.attention < order.control,
      "native Attention remains above recurring controls")
    assert.equal(await resume.count(), 0, "unsigned or unqualified schedules never show Play")
    assert.equal(writes.length, 0)
    capability = true
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence("rec_controls"))
    await resume.waitFor()
    assert.equal(writes.length, 0, "native event revalidation never resumes an interrupted schedule")
    await page.evaluate(async () => {
      const { serverEvents } = await import("/src/lib/server-events.ts")
      ;(serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: "fixture", status: "connected" }])
    })
    assert.equal(writes.length, 0, "reconnect never submits a mutation")
    schedule.pendingPassageID = "pas_unconfirmed"
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence("rec_controls"))
    await resume.waitFor({ state: "hidden" })
    assert.equal(await page.getByRole("button", { name: /Run now/ }).count(), 0, "no unqualified manual passage action")
    schedule.pendingPassageID = null
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence("rec_controls"))
    await resume.waitFor()
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    assert.equal(await resume.evaluate(node => getComputedStyle(node).borderRadius), "0px")
    const bounds = await page.locator(".mission-recurrence-item").evaluate(node => ({ item: node.getBoundingClientRect().width,
      parent: node.parentElement!.getBoundingClientRect().width }))
    assert.ok(bounds.item <= bounds.parent, "RTL touch item stays within the narrow panel")
    await resume.focus()
    assert.equal(await resume.evaluate(node => document.activeElement === node), true)
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence("rec_controls"))
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('.mission-recurrence-controls button[aria-label^="Reprendre"]')
      return button && !button.disabled
    })
    assert.equal(await resume.evaluate(node => document.activeElement === node), true, "native refresh preserves keyboard focus")
    await page.keyboard.press("Enter")
    await mutationStarted
    schedule.clock.time = "09:01"
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence("rec_controls"))
    await page.getByText(/09:01/).waitFor()
    assert.equal(await page.getByRole("button", { name: `Vérifier le résultat de ${schedule.id}` }).isDisabled(), true,
      "same-schedule refresh does not unlock an in-flight mutation")
    releaseMutation()
    await page.getByRole("button", { name: `Vérifier le résultat de ${schedule.id}` }).waitFor({ state: "visible" })
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('.mission-recurrence-controls button[aria-label^="Vérifier"]')
      return button && !button.disabled
    })
    assert.equal(writes.length, 1)
    assert.deepEqual({ action: writes[0].action, expectedEpoch: writes[0].expectedEpoch,
      expectedRevision: writes[0].expectedRevision, directory: writes[0].directory },
    { action: "play", expectedEpoch: 2, expectedRevision: 4, directory: "/fixture" })
    assert.match(writes[0].requestID, /^rhuman_[a-f0-9]{64}$/)
    assert.equal(writes[0].requestID, recurrenceHumanRequestID(schedule.id, 3, "authorize"), "request identity matches the actual native helper")
    assert.equal(await resume.isDisabled(), true)
    await page.getByRole("button", { name: "Actualiser les programmes" }).click()
    assert.equal(writes.length, 1, "explicit schedule refresh is read-only and retains the exact held request")
    await page.getByRole("button", { name: `Vérifier le résultat de ${schedule.id}` }).click()
    await statusStarted
    schedule.clock.time = "09:02"
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence("rec_controls"))
    await page.getByText(/09:02/).waitFor({ state: "attached" })
    assert.equal(await page.getByRole("button", { name: `Vérifier le résultat de ${schedule.id}` }).isDisabled(), true)
    releaseStatus()
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('.mission-recurrence-controls button[aria-label^="Vérifier"]')
      return button && !button.disabled
    })
    assert.equal(statusReads, 1)
    await page.getByRole("button", { name: `Vérifier le résultat de ${schedule.id}` }).click()
    assert.equal(statusReads, 2)
    assert.equal(writes.length, 1, "unknown status retry is read-only; the mutation never replays")
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    await page.getByRole("button", { name: `Vérifier le résultat de ${schedule.id}` }).waitFor()
    outcome = "committed"
    await page.getByRole("button", { name: `Vérifier le résultat de ${schedule.id}` }).click()
    assert.equal(statusReads, 3)
    assert.equal(await resume.isDisabled(), true, "even an exact receipt waits for a fresh signed epoch snapshot")
    schedule.revision = 5; schedule.epoch = 3; schedule.state = "running"
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence("rec_controls"))
    await page.getByRole("button", { name: `Suspendre le programme ${schedule.id}` }).waitFor()
    assert.equal(writes.length, 1, "exact read only reconciles the original mutation")
    schedule.revision = 6; schedule.epoch = 4; schedule.state = "interrupted"
    await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence("rec_controls"))
    await page.evaluate(() => window.missionEditorLifetime.instance("other"))
    await page.getByRole("button", { name: `Reprendre le programme ${schedule.id}` }).waitFor()
    assert.equal(writes.length, 1, "unresolved request remains bound to its original instance")
    await page.evaluate(() => {
      const subtle = crypto.subtle, original = subtle.digest.bind(subtle)
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      ;(window as any).releaseControlDigest = release
      Object.getPrototypeOf(subtle).digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
        await gate; return original(...args)
      }
    })
    await page.getByRole("button", { name: `Reprendre le programme ${schedule.id}` }).click()
    await page.evaluate(() => window.missionEditorLifetime.instance("fixture"))
    await page.evaluate(() => (window as any).releaseControlDigest())
    await page.waitForTimeout(100)
    assert.equal(writes.length, 1, "navigation before asynchronous identity calculation cannot write to the old session")
    await page.evaluate(() => window.missionEditorLifetime.activate(false))
    await page.waitForTimeout(100)
    assert.equal(writes.length, 1, "inactive navigation has no stale-session write")
  } finally { await page.close() }
})

for (const action of ["pause", "stop"] as const) test(`partial ${action} retains its exact intent across remount and offers only explicit remaining-control retry`, async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 320, height: 740 }, hasTouch: true })
  const id = `rec_partial_${action}`, requestID = recurrenceHumanRequestID(id, 3, action === "pause" ? "pause" : "revoke")
  const operationID = controlOperationID("msn_passage", requestID), writes: any[] = []
  let reads = 0
  let schedule: any = { id, revision: 4, scheduleRevision: 1, state: "running", epoch: 2,
    clock: { time: "09:00", zone: "UTC" }, pendingPassageID: null, pendingStatus: null, pendingAdmission: null,
    settledCount: 0, latestResult: null, history: [], controlCapability: { version: 1, actions: ["pause", "stop"] } }
  const target = (sessionID: string) => ({ sessionID, location: { directory: "/fixture" } })
  const receipt = (sessionID: string) => ({ receiptID: controlReceiptID(operationID, sessionID), sessionID, acknowledgementState: "known",
    nativeAcknowledgement: { missionID: "msn_passage", operationID, sessionID, action, disposition: "interrupt-observed",
      interrupt: { interrupted: true }, cancellations: [] } })
  const nativeControl = { id: operationID, missionID: "msn_passage", requestID, action, expectedRevision: 1,
    targets: [target("ses_root"), target("ses_worker")], pending: ["ses_worker"], receipts: [receipt("ses_root")] }
  const original = { scheduleID: id, requestID, action, expectedRevision: 4, expectedEpoch: 2, directory: "/fixture" }
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  const mission = { version: 1, id: "msn_fixture", projectID: "project", projectCanonical: "/fixture", objective: "Review",
    template: "custom", coordinatorSessionId: "ses_fixture", status: "active", runState: "paused",
    actors: [{ sessionId: "ses_fixture", kind: "coordinator", managed: true, title: "Coordinator", roles: [],
      location: { directory: "/fixture" }, joinedAt: 1 }], frontier: [], claims: [], revision: 1, createdAt: 1,
    updatedAt: 1, history: [], historyTruncated: false, tasks: [], reports: [] }
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: [mission], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => { reads++; return route.fulfill({ json: { version: 1, projectID: "project", schedules: [schedule] } }) })
  await page.route(`**/missions/recurrence/${id}/control`, route => {
    const body = recurrenceControlHttpSchema.parse(route.request().postDataJSON())
    writes.push(body)
    assert.deepEqual(body, writes.length === 1 ? original : { ...original, retry: true }, "retry preserves the original complete human identity")
    schedule = { ...schedule, revision: 5, epoch: 3, state: action === "pause" ? "paused" : "stopped",
      controlsComplete: false, nativeControl, controlRetry: { scheduleID: id, requestID, action, expectedRevision: 4, expectedEpoch: 2 },
      controlCapability: { version: 1, actions: action === "pause" ? ["pause", "stop"] : ["stop"] } }
    if (writes.length < 3) return route.fulfill({ status: 503, json: { error: "Original remaining-control outcome unknown" } })
    const completed = { ...nativeControl, pending: [], receipts: [receipt("ses_root"), receipt("ses_worker")] }
    schedule = { ...schedule, controlsComplete: true, nativeControl: completed, controlRetry: undefined,
      controlCapability: { version: 1, actions: action === "pause" ? ["play", "stop"] : [] } }
    return route.fulfill({ json: { version: 1, scheduleID: id, requestID, revision: 5, epoch: 3, state: schedule.state,
      controlsComplete: true, schedulerCancellation: "acknowledged", nativeControl: completed } })
  })
  await page.route(`**/missions/recurrence/${id}/control/status`, route => {
    const body = route.request().postDataJSON(), { directory: _directory, ...identity } = body
    recurrenceControlRequestSchema.parse({ ...identity, scheduleID: id })
    assert.equal("retry" in body, false, "status is a read-only endpoint, not another retry admission")
    return route.fulfill({ json: recurrenceControlStatusSchema.parse({ version: 1, scheduleID: id, requestID,
      expectedRevision: 4, epoch: 3, revision: 5, state: schedule.state, outcome: "unknown", controlsComplete: false,
      schedulerCancellation: "unknown", nativeControl: schedule.nativeControl }) })
  })
  try {
    await page.goto(url)
    await page.evaluate(async () => {
      const { addFormToQueue } = await import("/src/stores/forms.ts")
      addFormToQueue("fixture", { id: "form_control", sessionID: "ses_fixture", title: "Native control decision", fields: [], location: { directory: "/fixture" } } as any)
    })
    const row = page.locator(".mission-recurrence-item"), retry = row.getByRole("button", { name: `Retry remaining controls for ${id}` })
    await row.getByRole("button", { name: `${action === "pause" ? "Pause" : "Stop"} schedule ${id}`, exact: true }).click()
    await row.getByRole("button", { name: `Check control outcome for ${id}` }).waitFor()
    await page.evaluate(id => window.missionEditorLifetime.invalidateRecurrence(id), id)
    await retry.waitFor()
    await row.getByText("Pending native targets: 1").waitFor()
    await page.getByText("Native control decision", { exact: true }).waitFor()
    assert.equal(await row.getByRole("button", { name: /Play schedule|Resume schedule/ }).count(), 0)
    if (action === "stop") assert.equal(await row.getByRole("button", { name: `Stop schedule ${id}`, exact: true }).count(), 0, "terminal Stop never becomes a new Stop intent")
    else assert.equal(await row.getByRole("button", { name: `Stop schedule ${id}`, exact: true }).isDisabled(), true)
    const order = await page.evaluate(() => ({ attention: document.querySelector(".mission-attention-list")!.getBoundingClientRect().top,
      controls: document.querySelector(".mission-recurrence-controls")!.getBoundingClientRect().top }))
    assert.ok(order.attention < order.controls)
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    await retry.waitFor()
    assert.equal(writes.length, 1, "remount does not replay a partial denial control")
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await retry.focus()
    await captureMissionView(page, `partial-${action}-rtl`)
    await page.evaluate(id => window.missionEditorLifetime.invalidateRecurrence(id), id)
    await page.waitForFunction(() => { const button = document.querySelector<HTMLButtonElement>('.mission-recurrence-controls button[aria-label^="Retry remaining"]'); return button && !button.disabled })
    assert.equal(await retry.evaluate(node => document.activeElement === node), true)
    assert.equal(await retry.evaluate(node => getComputedStyle(node).borderRadius), "0px")
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => { const button = document.querySelector<HTMLButtonElement>('.mission-recurrence-controls button[aria-label^="Retry remaining"]'); return button && !button.disabled })
    assert.equal(writes.length, 2)
    const beforeRead = reads
    await row.getByRole("button", { name: `Check control outcome for ${id}` }).click()
    await page.getByRole("button", { name: "Refresh schedules" }).click()
    await page.waitForResponse(response => response.url().endsWith("/missions/recurrence"))
    assert.ok(reads > beforeRead)
    assert.equal(writes.length, 2, "outcome/list refresh never posts another retry")
    assert.equal(await row.getByRole("button", { name: `Check control outcome for ${id}` }).count(), 1, "a snapshot does not clear the unknown retry hold")
    // Clock cancellation can remain unknown after all root receipts arrived.
    schedule = { ...schedule, nativeControl: { ...nativeControl, pending: [], receipts: [receipt("ses_root"), receipt("ses_worker")] } }
    await page.evaluate(id => window.missionEditorLifetime.invalidateRecurrence(id), id)
    await row.getByText("Pending native targets: 1").waitFor({ state: "hidden" })
    await retry.click()
    await retry.waitFor({ state: "hidden" })
    assert.equal(writes.length, 3)
    if (action === "stop") assert.equal(await row.getByRole("button", { name: /Play schedule|Resume schedule|Stop schedule/ }).count(), 0)
  } finally { await page.close() }
})

test("Unavailable execution still exposes verified denial actions without Resume or new-work admission", async () => {
  const page = await browser.newPage({ locale: "en-US" }), posts: Array<{ path: string; body: unknown }> = []
  const id = "rec_retained_artifact"
  let verified = false
  let schedule: any = { id, revision: 4, scheduleRevision: 1, state: "unavailable", epoch: 2,
    clock: { time: "09:00", zone: "UTC" }, pendingPassageID: null, pendingStatus: null, pendingAdmission: null,
    settledCount: 0, latestResult: null, history: [] }
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    if (route.request().method() !== "GET") posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    return route.fulfill({ json: {} })
  })
  await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } }))
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => route.fulfill({ json: { version: 1, projectID: "project",
    schedules: [{ ...schedule, ...(verified ? { controlCapability: { version: 1, actions: schedule.epoch === 2 ? ["pause", "stop"] : ["stop"] } } : {}) }] } }))
  await page.route(`**/missions/recurrence/${id}/control`, route => {
    const body = recurrenceControlHttpSchema.parse(route.request().postDataJSON())
    posts.push({ path: new URL(route.request().url()).pathname, body })
    assert.deepEqual(body, { scheduleID: id, requestID: recurrenceHumanRequestID(id, 3, "pause"), action: "pause",
      expectedRevision: 4, expectedEpoch: 2, directory: "/fixture" })
    schedule = { ...schedule, revision: 5, epoch: 3 }
    return route.fulfill({ json: { version: 1, scheduleID: id, requestID: body.requestID, revision: 5, epoch: 3,
      state: "paused", controlsComplete: true, schedulerCancellation: "acknowledged" } })
  })
  try {
    await page.goto(url)
    const row = page.locator(".mission-recurrence-item"), pause = row.getByRole("button", { name: `Pause schedule ${id}`, exact: true })
    await row.getByText("Unavailable", { exact: true }).waitFor()
    assert.equal(await row.getByRole("button", { name: /Pause schedule|Stop schedule|Play schedule|Resume schedule/ }).count(), 0,
      "unknown execution without verified actions grants no controls")
    verified = true
    await page.evaluate(id => window.missionEditorLifetime.invalidateRecurrence(id), id)
    await pause.waitFor()
    await page.waitForFunction(() => { const button = document.querySelector<HTMLButtonElement>('.mission-recurrence-controls button[aria-label^="Pause schedule"]'); return button && !button.disabled })
    assert.equal(await row.getByText("Unavailable", { exact: true }).count(), 1)
    assert.equal(await row.getByRole("button", { name: `Stop schedule ${id}`, exact: true }).isEnabled(), true)
    assert.equal(await row.getByRole("button", { name: /Play schedule|Resume schedule/ }).count(), 0)
    await pause.click()
    await pause.waitFor({ state: "hidden" })
    assert.equal(posts.length, 1)
    assert.equal(posts[0].path, `/api/workspaces/fixture/missions/recurrence/${id}/control`)
    await page.getByRole("button", { name: "Refresh schedules" }).click()
    await page.waitForResponse(response => response.url().endsWith("/missions/recurrence"))
    assert.equal(posts.length, 1, "refresh cannot repeat denial or admit new work")
    assert.equal(await row.getByRole("button", { name: /Play schedule|Resume schedule/ }).count(), 0)
  } finally { await page.close() }
})
