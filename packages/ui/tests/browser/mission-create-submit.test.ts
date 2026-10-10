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
import { captureMissionView } from "./mission-view-capture"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-create-submit", configureServer(s) { s.middlewares.use("/create-submit", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/create-submit", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/create-submit`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const OBJECTIVE = "What should the mission do?"
const profiles = { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m" } },
  roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } } }
const emptyRecurrence = () => recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] })
function created(body: Record<string, unknown>): MissionMap {
  return { version: 1, id: "msn_created", projectID: "project", projectCanonical: "/fixture", title: body.title as string, objective: body.objective as string,
    template: "custom", status: "active", runState: "prepared", coordinatorSessionId: "ses_coordinator", revision: 1, createdAt: 1, updatedAt: 1,
    history: [], historyTruncated: false, frontier: [], claims: [], actors: [], tasks: [], reports: [] }
}

async function setup(page: Page) {
  const errors: string[] = [], creates: Array<Record<string, unknown>> = [], controls: string[] = []
  let list: MissionMap[] = []
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles }] } } }))
  await page.route("**/api/workspaces/fixture/missions**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith("/control")) { controls.push(path); return route.abort() }
    if (request.method() === "GET") return route.fulfill({ json: path.endsWith("/missions/recurrence") ? emptyRecurrence()
      : { available: true, projectID: "project", missions: list, generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/recurrence")) {
      creates.push(request.postDataJSON())
      return route.fulfill({ json: { schedule: { id: "rec_created", revision: 0, state: "paused", digest: "d".repeat(64), projectID: "project", projectCanonical: "/fixture" } } })
    }
    if (path.endsWith("/missions")) {
      const body = request.postDataJSON(); creates.push(body)
      list = [created(body)]
      return route.fulfill({ json: { mission: list[0] } })
    }
    return route.fulfill({ json: {} })
  })
  return { errors, creates, controls }
}

const submitReady = (page: Page) => page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)

async function assertSingleCreate(form: ReturnType<Page["locator"]>) {
  const submits = form.locator('button[type="submit"]')
  assert.equal(await submits.count(), 1, "creation offers one submit button")
  assert.equal(await submits.innerText(), "Create")
  assert.equal(await form.getByRole("checkbox").count(), 0, "no automatic-start option")
  await form.getByRole("button", { name: "Create", exact: true }).click()
  await form.waitFor({ state: "detached" })
}

test("Create creates one paused one-time mission and never sends a lifecycle control", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Audit dependencies. Report outdated packages with their risk.")
    assert.equal(await form.getByLabel("Title", { exact: true }).inputValue(), "Audit dependencies")
    await submitReady(page)
    await captureMissionView(page, "create-default")
    await form.locator("summary").filter({ hasText: /^Options$/ }).click()
    await captureMissionView(page, "create-options")
    await form.locator("summary").filter({ hasText: /^Options$/ }).click()
    await assertSingleCreate(form)
    await page.waitForTimeout(300)
    assert.equal(fixture.creates.length, 1)
    assert.equal(fixture.creates[0]!.title, "Audit dependencies")
    assert.deepEqual(fixture.controls, [], "Play stays a separate explicit action")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("daily Create stores a paused schedule and never sends Play", async () => {
  const page = await browser.newPage({ locale: "en-US", timezoneId: "Europe/Paris", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Review yesterday's merged changes and summarize risks.")
    await form.getByLabel("Every day at", { exact: true }).check()
    await form.getByLabel("Daily local time", { exact: true }).fill("07:30")
    assert.match(await form.locator(".mission-create-zone").innerText(), /Europe\/Paris/)
    await submitReady(page)
    await captureMissionView(page, "create-recurring")
    await assertSingleCreate(form)
    await page.waitForTimeout(300)
    assert.equal(fixture.creates.length, 1)
    assert.equal(fixture.creates[0]!.title, "Review yesterday's merged changes and summarize risks")
    assert.deepEqual(fixture.creates[0]!.clock, { time: "07:30", zone: "Europe/Paris" })
    assert.deepEqual(fixture.controls, [], "Play stays a separate explicit action")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})
