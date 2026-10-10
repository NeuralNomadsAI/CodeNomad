import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-editor-lifetime"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-settings-brief", configureServer(s) { s.middlewares.use("/settings-brief", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/settings-brief", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/settings-brief`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const profiles = { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m", variant: "high" } },
  roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } } }
const finished: MissionMap = { version: 1, id: "msn_done", projectID: "project", projectCanonical: "/fixture", title: "Dependency audit",
  objective: "Audit dependencies and report risky upgrades.", notes: "  Keep notes verbatim.\n", template: "custom", profiles, taskMode: "independent",
  status: "completed", runState: "stopped", summary: "All done", coordinatorSessionId: "ses_coordinator", revision: 9, createdAt: 1, updatedAt: 2,
  history: [], historyTruncated: false, frontier: [], claims: [], actors: [], tasks: [], reports: [] } as MissionMap

async function setup(page: Page, preferences: "accept" | "reject") {
  const errors: string[] = [], writes: Array<Record<string, any>> = [], missionWrites: string[] = []
  let settings: Record<string, unknown> = {}
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`window.__preferencesCalls=[];Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true,
    openPreferences:async(...args)=>{window.__preferencesCalls.push(JSON.parse(JSON.stringify(args)));${preferences === "reject" ? "throw new Error('Invalid preferences section')" : ""}}}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui*", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { settings } })
    const body = route.request().postDataJSON(), patch = new URL(route.request().url()).searchParams.get("conditional") ? body.patch : body
    writes.push(patch); settings = { ...settings, ...patch.settings }
    return route.fulfill({ json: { settings } })
  })
  await page.route("**/api/workspaces/fixture/missions**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() !== "GET") { missionWrites.push(path); return route.abort() }
    return route.fulfill({ json: path.endsWith("/missions/recurrence")
      ? recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] })
      : { available: true, projectID: "project", missions: [finished], generatedAt: 1, discardedEvents: 0 } })
  })
  await page.goto(url)
  await page.evaluate(async () => {
    const instances = "/src/stores/instances.ts", view = "/src/stores/mission-view-state.ts"
    ;(await import(instances)).setActiveInstanceId("fixture")
    ;(await import(view)).updateMissionProjectView("/fixture", { selected: "msn_done" })
  })
  return { errors, writes, missionWrites }
}

const settingsOpen = (page: Page) => page.evaluate(async () => { const path = "/src/stores/settings-screen.ts"; return (await import(path)).settingsOpen() })
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __preferencesCalls: unknown[] }).__preferencesCalls)

test("the Missions gear opens the native Preferences window at Missions with the active project context", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page, "accept")
  try {
    await page.locator(".mission-control-header").getByRole("button", { name: "Preferences", exact: true }).click()
    await page.waitForFunction(() => (window as unknown as { __preferencesCalls: unknown[] }).__preferencesCalls.length === 1)
    const [[section, context, toggle, resume]] = await calls(page) as Array<[string, { instanceId?: string; location?: { directory: string } }, boolean, boolean]>
    assert.equal(section, "missions")
    assert.equal(context.instanceId, "fixture")
    assert.equal(context.location?.directory, "/fixture")
    assert.deepEqual([toggle, resume], [false, false])
    assert.equal(await settingsOpen(page), false, "no embedded Settings beside the native window")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("a native rejection is reported instead of opening embedded Settings", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page, "reject")
  try {
    await page.locator(".mission-control-header").getByRole("button", { name: "Preferences", exact: true }).click()
    await page.getByText("Preferences could not open in their window.", { exact: false }).waitFor()
    assert.equal((await calls(page)).length, 1, "never retried")
    assert.equal(await settingsOpen(page), false)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("Save as brief copies only a finished Mission's recorded inputs and launches nothing", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page, "accept")
  try {
    const detail = page.locator("section.mission-detail")
    await detail.getByRole("button", { name: "Save as brief", exact: true }).click()
    const name = detail.getByLabel("Brief name", { exact: true })
    assert.equal(await name.inputValue(), "Dependency audit", "the Mission title prefills the name")
    await name.fill("Weekly dependency audit")
    await detail.getByRole("button", { name: "Save brief", exact: true }).click()
    await detail.getByRole("button", { name: "Save as brief", exact: true }).waitFor()
    assert.equal(fixture.writes.length, 1)
    const [saved] = fixture.writes[0]!.settings.missionModels as Array<Record<string, unknown>>
    assert.match(saved!.id as string, /^[0-9a-f-]{36}$/)
    assert.notEqual(saved!.id, finished.id)
    const { id: _id, ...inputs } = saved!
    assert.deepEqual(inputs, { version: 1, name: "Weekly dependency audit", objective: finished.objective, notes: finished.notes,
      template: "custom", profiles, taskMode: "independent" })
    assert.deepEqual(fixture.missionWrites, [], "saving a brief never creates, starts or edits a Mission")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})
