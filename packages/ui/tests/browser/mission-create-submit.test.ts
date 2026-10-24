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

// Later page routes win: answer one-time creation POSTs, fall back for everything else.
async function answerCreates(page: Page, answer: (route: import("playwright").Route, attempt: number) => Promise<void> | void) {
  const attempts: Array<Record<string, unknown>> = []
  await page.route("**/api/workspaces/fixture/missions", route => {
    if (route.request().method() !== "POST") return route.fallback()
    attempts.push(route.request().postDataJSON())
    return answer(route, attempts.length)
  })
  return attempts
}
const UNCONFIRMED = "native creation result is unconfirmed"

for (const loss of ["lost fetch", "undecodable acknowledgement"] as const) {
  test(`${loss} holds the exact original creation across edit, close/remount and project changes without a second create`, async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
    const fixture = await setup(page)
    const attempts = await answerCreates(page, route => loss === "lost fetch" ? route.abort("connectionreset")
      : route.fulfill({ status: 200, contentType: "application/json", body: '{"mission":{"id":' }))
    try {
      await page.goto(url)
      await page.getByRole("button", { name: "Create mission", exact: true }).click()
      const form = page.locator("form.mission-editor"), objective = form.getByLabel(OBJECTIVE, { exact: true })
      await objective.fill("Original lost create")
      await submitReady(page)
      await form.getByRole("button", { name: "Create", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: UNCONFIRMED }).waitFor()
      assert.equal(await objective.isDisabled(), true, "the unknown contract cannot be edited into a new request")
      assert.equal(await form.locator('button[type="submit"]').isDisabled(), true)
      const original = await page.evaluate(() => window.missionEditorLifetime.held())
      assert.equal(original!.requestId, attempts[0].requestId)
      await form.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.evaluate(() => window.missionEditorLifetime.project("other-project"))
      await page.evaluate(() => window.missionEditorLifetime.project("project"))
      await page.evaluate(() => window.missionEditorLifetime.mount(false))
      await page.evaluate(() => window.missionEditorLifetime.mount(true))
      await page.getByRole("button", { name: "Create mission", exact: true }).click()
      assert.equal(await objective.inputValue(), "Original lost create")
      assert.equal(await objective.isDisabled(), true)
      assert.equal(await form.locator('button[type="submit"]').isDisabled(), true)
      await form.evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
      await page.waitForTimeout(200)
      assert.equal(attempts.length, 1, "no automatic or manual replay under any identity")
      assert.deepEqual(await page.evaluate(() => window.missionEditorLifetime.held()), original)
      assert.deepEqual(fixture.controls, [], "an unknown create never starts execution")
      assert.deepEqual(fixture.errors, [])
    } finally { await page.close() }
  })
}

test("a newer editor cannot submit while a creation reply is pending and keeps its draft after the original succeeds", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  let release!: () => void
  const reply = new Promise<void>(resolve => { release = resolve })
  const attempts = await answerCreates(page, async route => {
    if (attempts.length === 1) await reply
    return route.fallback()
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor"), objective = form.getByLabel(OBJECTIVE, { exact: true })
    await objective.fill("First pending create")
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await page.waitForFunction(() => document.querySelector('form.mission-editor button[type="submit"]')?.textContent !== "Create")
    await form.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await objective.fill("Newer draft")
    await submitReady(page)
    await form.locator('button[type="submit"]').click()
    await page.waitForTimeout(200)
    assert.equal(attempts.length, 1, "the pending original fences a second logical creation")
    assert.equal(await objective.inputValue(), "Newer draft", "a pending hold does not overwrite the newer draft")
    assert.equal(await form.locator('button[type="submit"]').isDisabled(), true)
    release()
    await submitReady(page)
    assert.equal(await objective.inputValue(), "Newer draft")
    assert.equal(await page.evaluate(() => window.missionEditorLifetime.held()), undefined)
    assert.equal(fixture.creates.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})

test("a definitive creation rejection releases the request, keeps the draft editable and admits a corrected creation", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  const attempts = await answerCreates(page, (route, attempt) => attempt === 1
    ? route.fulfill({ status: 400, json: { error: "Invalid mission creation request" } }) : route.fallback())
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor"), objective = form.getByLabel(OBJECTIVE, { exact: true })
    await objective.fill("Rejected create")
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.doesNotMatch(await page.getByRole("alert").innerText(), new RegExp(UNCONFIRMED))
    assert.equal(await page.evaluate(() => window.missionEditorLifetime.held()), undefined)
    assert.equal(await objective.isDisabled(), false)
    await objective.fill("Corrected create")
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.equal(attempts.length, 2)
    assert.notEqual(attempts[1].requestId, attempts[0].requestId, "a changed payload is a new logical request")
    assert.equal(fixture.creates.length, 1)
    assert.deepEqual(fixture.controls, [])
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("clearing the daily time and choosing Once creates a one-time mission without flipping back to Daily", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel(OBJECTIVE, { exact: true }).fill("One-time after clearing the schedule")
    await form.getByLabel("Every day at", { exact: true }).check()
    await form.getByLabel("Daily local time", { exact: true }).fill("")
    await form.getByLabel("Once", { exact: true }).check()
    await submitReady(page)
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await form.waitFor({ state: "detached", timeout: 3_000 }).catch(() => undefined)
    assert.equal(await form.count(), 0, "native validation must not block Once for an inactive daily time")
    assert.equal(fixture.creates.length, 1)
    assert.equal(fixture.creates[0]!.clock, undefined, "the one-time route received the creation, not a schedule")
    assert.equal(fixture.creates[0]!.objective, "One-time after clearing the schedule")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("daily Create stores a paused schedule and never sends Play", async () => {
  const page = await browser.newPage({ locale: "en-US", timezoneId: "Europe/Paris", viewport: { width: 900, height: 1000 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    // First wait after navigation: allow for a cold page boot late in a long serial run.
    await page.getByRole("button", { name: "Create mission", exact: true }).click({ timeout: 60_000 })
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
