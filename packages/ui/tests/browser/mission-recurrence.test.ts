import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-editor-lifetime"

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

test("real editor creates a paused schedule with exact inputs; list stays read-only and cache-first", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 375, height: 800 } })
  const writes: Array<Record<string, any>> = []
  let reads = 0, snapshot: any = { version: 1, projectID: "project", schedules: [] }
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
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
    await form.getByLabel("Execution mode").selectOption("recurring")
    await form.getByLabel("Permanent instructions").fill("Review new changes")
    await form.getByLabel("Daily local time").fill("08:15")
    await form.getByLabel("Time zone (IANA)").fill("Europe/Paris")
    await form.getByLabel(/Followed conversation IDs/).fill("ses_123")
    for (const role of ["Coordinator", "Default task"]) {
      const row = form.locator("fieldset").filter({ has: page.locator("legend").getByText(role, { exact: true }) })
      await row.locator("select").nth(0).selectOption("all")
      await row.locator("select").nth(1).selectOption(JSON.stringify(["p", "m"]))
    }
    await form.getByLabel("Time zone (IANA)").fill("UTC+2")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await form.getByRole("alert").getByText(/valid local time/).waitFor()
    assert.equal(writes.length, 0, "invalid civil clock never reaches the native route")
    await form.getByLabel("Time zone (IANA)").fill("Europe/Paris")
    await form.getByText("Passage budgets", { exact: true }).click()
    const effects = form.locator(".mission-recurrence-budgets input").first()
    assert.equal(await effects.inputValue(), "3", "default funds the three required native effects")
    await effects.fill("2")
    await form.getByText("Passage budgets", { exact: true }).click()
    await form.getByRole("alert").getByText(/At least 3 effects/).waitFor()
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(writes.length, 0, "a too-small effect budget never reaches creation")
    await form.getByText("Passage budgets", { exact: true }).click()
    await effects.fill("3")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByText("08:15 · Europe/Paris").waitFor()
    assert.equal(writes.length, 1)
    assert.match(writes[0].requestID, /^[0-9a-f-]{36}$/)
    assert.deepEqual(writes[0].watchedConversationIDs, ["ses_123"])
    assert.deepEqual(writes[0].budgets, { effects: 3, nativeCalls: 8, inboxMessages: 32, publications: 0 })
    assert.deepEqual(writes[0].profiles, { coordinator: { agent: "all", model: { providerID: "p", id: "m" } }, roles: { specialist: { agent: "all", model: { providerID: "p", id: "m" } } } })
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
    await form.getByLabel("Permanent instructions").fill("Never duplicate")
    for (const role of ["Coordinator", "Default task"]) {
      const row = form.locator("fieldset").filter({ has: page.locator("legend").getByText(role, { exact: true }) })
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
    assert.equal(await form.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.equal(writes.length, 1)
  } finally { await page.close() }
})
