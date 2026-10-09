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
import { recurrenceControlRequestSchema, recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-create-start", configureServer(s) { s.middlewares.use("/create-start", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/create-start", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/create-start`
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

async function setup(page: Page, control: "acknowledge" | "fail") {
  const errors: string[] = [], creates: Array<Record<string, unknown>> = [], controls: Array<Record<string, unknown>> = []
  let list: MissionMap[] = []
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles }] } } }))
  await page.route("**/api/workspaces/fixture/missions**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: emptyRecurrence() })
    if (request.method() === "GET") return route.fulfill({ json: { available: true, projectID: "project", missions: list, generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions")) {
      const body = request.postDataJSON(); creates.push(body)
      list = [created(body)]
      return route.fulfill({ json: { mission: list[0] } })
    }
    if (path.endsWith("/msn_created/control")) {
      controls.push(request.postDataJSON())
      if (control === "fail") return route.abort()
      list = [{ ...list[0]!, runState: "running", revision: 2 }]
      return route.fulfill({ json: { mission: list[0] } })
    }
    return route.fulfill({ json: {} })
  })
  return { errors, creates, controls }
}

test("Create and start creates once, then starts the created mission once with its exact revision", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page, "acknowledge")
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Audit dependencies. Report outdated packages with their risk.")
    assert.equal(await form.getByLabel("Title", { exact: true }).inputValue(), "Audit dependencies")
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[data-start="true"]') as HTMLButtonElement)?.disabled)
    await captureMissionView(page, "create-default")
    await form.locator("summary").filter({ hasText: /^Options$/ }).click()
    await captureMissionView(page, "create-options")
    await form.locator("summary").filter({ hasText: /^Options$/ }).click()
    await form.getByRole("button", { name: "Create and start", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.equal(fixture.creates.length, 1)
    assert.equal(fixture.creates[0]!.title, "Audit dependencies")
    assert.deepEqual(fixture.controls.map(({ action, expectedRevision }) => ({ action, expectedRevision })), [{ action: "start", expectedRevision: 1 }])
    assert.equal(fixture.controls[0]!.requestId === fixture.creates[0]!.requestId, false, "start has its own request identity")
    assert.equal(await page.getByText(/was created, but/).count(), 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("an unconfirmed start keeps the created mission with Check status instead of resending creation or start", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page, "fail")
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Prepare the release notes")
    await form.getByLabel("Title", { exact: true }).fill("Release notes")
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[data-start="true"]') as HTMLButtonElement)?.disabled)
    await form.getByRole("button", { name: "Create and start", exact: true }).click()
    await form.waitFor({ state: "detached" })
    await page.getByText("“Release notes” was created, but its start was not confirmed.", { exact: false }).waitFor()
    await page.getByRole("button", { name: "Check control status", exact: true }).waitFor()
    await page.getByText("Action not yet confirmed. Check status before retrying.", { exact: true }).waitFor()
    await captureMissionView(page, "create-start-uncertain")
    await page.waitForTimeout(300)
    assert.equal(fixture.creates.length, 1, "creation is never resent")
    assert.equal(fixture.controls.length, 1, "start is never resent automatically")
    assert.equal(fixture.creates[0]!.title, "Release notes")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("daily Create and start creates a paused schedule then sends one Play at revision 0", async () => {
  const page = await browser.newPage({ locale: "en-US", timezoneId: "Europe/Paris", viewport: { width: 900, height: 1000 } })
  const errors: string[] = [], creates: Array<Record<string, unknown>> = [], plays: Array<Record<string, unknown>> = []
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles }] } } }))
  await page.route("**/api/workspaces/fixture/missions**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === "GET") return route.fulfill({ json: path.endsWith("/missions/recurrence") ? emptyRecurrence()
      : { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } })
    if (path.endsWith("/missions/recurrence")) {
      creates.push(request.postDataJSON())
      return route.fulfill({ json: { schedule: { id: "rec_created", revision: 0, state: "paused", digest: "d".repeat(64), projectID: "project", projectCanonical: "/fixture" } } })
    }
    if (path.endsWith("/rec_created/control")) {
      const { directory: _directory, ...body } = request.postDataJSON(); plays.push(body)
      const input = recurrenceControlRequestSchema.parse(body)
      return route.fulfill({ json: { version: 1, ...input, revision: input.expectedRevision + 1, state: "running", controlsComplete: true,
        targets: [], targetsKnown: true, schedulerCancellation: "acknowledged" } })
    }
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("Review yesterday's merged changes and summarize risks.")
    await form.getByLabel("Every day at", { exact: true }).check()
    await form.getByLabel("Daily local time", { exact: true }).fill("07:30")
    assert.match(await form.locator(".mission-create-zone").innerText(), /Europe\/Paris/)
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[data-start="true"]') as HTMLButtonElement)?.disabled)
    await captureMissionView(page, "create-recurring")
    await form.getByRole("button", { name: "Create and start", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.equal(creates.length, 1)
    assert.equal(creates[0]!.title, "Review yesterday's merged changes and summarize risks")
    assert.deepEqual(creates[0]!.clock, { time: "07:30", zone: "Europe/Paris" })
    assert.deepEqual(plays.map(({ action, expectedRevision, scheduleID }) => ({ action, expectedRevision, scheduleID })),
      [{ action: "play", expectedRevision: 0, scheduleID: "rec_created" }])
    assert.equal(await page.getByText(/was created, but/).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
