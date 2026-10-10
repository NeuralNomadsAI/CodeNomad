import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-editor-lifetime"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-create-refusals", configureServer(s) { s.middlewares.use("/create-refusals", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/create-refusals", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/create-refusals`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const OBJECTIVE = "What should the mission do?"
const UNCONFIRMED = "native creation result is unconfirmed"
const profiles = { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m" } },
  roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } } }
function created(body: Record<string, unknown>): MissionMap {
  return { version: 1, id: "msn_created", projectID: "project", projectCanonical: "/fixture", title: body.title as string, objective: body.objective as string,
    template: "custom", status: "active", runState: "prepared", coordinatorSessionId: "ses_coordinator", revision: 1, createdAt: 1, updatedAt: 1,
    history: [], historyTruncated: false, frontier: [], claims: [], actors: [], tasks: [], reports: [] }
}

/** Answers one-time creation POSTs through `answer`; every request is recorded. */
async function setup(page: Page, answer: (route: Route, attempt: number, body: Record<string, unknown>) => Promise<void> | void) {
  const errors: string[] = [], attempts: Array<Record<string, unknown>> = []
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "custom", profiles }] } } }))
  await page.route("**/api/workspaces/fixture/missions**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === "GET") return route.fulfill({ json: path.endsWith("/missions/recurrence")
      ? { version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] }
      : { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } })
    if (request.method() === "POST" && path.endsWith("/missions")) {
      const body = request.postDataJSON(); attempts.push(body)
      return answer(route, attempts.length, body)
    }
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.getByRole("button", { name: "Create mission", exact: true }).click()
  const form = page.locator("form.mission-editor")
  return { errors, attempts, form, objective: form.getByLabel(OBJECTIVE, { exact: true }), submit: form.locator('button[type="submit"]') }
}
const submitReady = (page: Page) => page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)

test("pre-send creation refusals keep the draft, re-enable Create and explain the refusal", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const refusals = [
    { status: 503, json: { error: "Mission plugin unavailable", code: "creation-unavailable" }, message: /Nothing was sent/ },
    { status: 409, json: { error: "Worktree deletion is in progress", code: "creation-worktree-deleting" }, message: /worktree deletion is in progress/i },
  ]
  try {
    const fixture = await setup(page, (route, attempt, body) => attempt <= refusals.length
      ? route.fulfill({ status: refusals[attempt - 1]!.status, json: refusals[attempt - 1]!.json })
      : route.fulfill({ json: { mission: created(body) } }))
    await fixture.objective.fill("Survives transient refusals")
    for (const refusal of refusals) {
      await submitReady(page)
      await fixture.submit.click()
      await page.getByRole("alert").filter({ hasText: refusal.message }).waitFor()
      assert.doesNotMatch(await page.getByRole("alert").innerText(), new RegExp(UNCONFIRMED))
      assert.equal(await page.evaluate(() => window.missionEditorLifetime.held()), undefined, "no window-wide hold remains")
      assert.equal(await fixture.objective.inputValue(), "Survives transient refusals")
      assert.equal(await fixture.objective.isDisabled(), false)
      await submitReady(page)
    }
    await fixture.submit.click()
    await fixture.form.waitFor({ state: "detached" })
    assert.equal(fixture.attempts.length, 3, "only explicit user submissions were sent")
    assert.equal(new Set(fixture.attempts.map(body => body.requestId)).size, 1, "an unchanged draft keeps its request identity")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

/** Daily creation: answers recurrence POSTs through `answer` (later page routes win). */
async function setupDaily(page: Page, answer: (route: Route, attempt: number) => Promise<void> | void) {
  const fixture = await setup(page, route => route.abort())
  const attempts: Array<Record<string, unknown>> = []
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => {
    if (route.request().method() !== "POST") return route.fallback()
    attempts.push(route.request().postDataJSON())
    return answer(route, attempts.length)
  })
  await fixture.objective.fill("Review merged changes daily")
  await fixture.form.getByLabel("Every day at", { exact: true }).check()
  await fixture.form.getByLabel("Daily local time", { exact: true }).fill("07:30")
  return { ...fixture, attempts }
}
const schedule = { schedule: { id: "rec_created", revision: 0, state: "paused", digest: "d".repeat(64), projectID: "project", projectCanonical: "/fixture" } }

test("daily pre-send refusals keep the draft and Create available with the same request identity", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  const refusals = [
    { status: 503, json: { error: "Mission plugin unavailable", code: "creation-unavailable" }, message: /Nothing was sent/ },
    { status: 409, json: { error: "Worktree deletion is in progress", code: "creation-worktree-deleting" }, message: /worktree deletion is in progress/i },
    { status: 403, json: { error: "Recurrence directory is not owned" }, message: /was not admitted/ },
  ]
  try {
    const fixture = await setupDaily(page, (route, attempt) => attempt <= refusals.length
      ? route.fulfill({ status: refusals[attempt - 1]!.status, json: refusals[attempt - 1]!.json })
      : route.fulfill({ json: schedule }))
    for (const refusal of refusals) {
      await submitReady(page)
      await fixture.submit.click()
      await page.getByRole("alert").filter({ hasText: refusal.message }).waitFor()
      assert.equal(await fixture.objective.inputValue(), "Review merged changes daily")
      assert.equal(await fixture.objective.isDisabled(), false)
    }
    await submitReady(page)
    await fixture.submit.click()
    await fixture.form.waitFor({ state: "detached" })
    assert.equal(fixture.attempts.length, refusals.length + 1, "only explicit user submissions were sent")
    assert.equal(new Set(fixture.attempts.map(body => body.requestID)).size, 1, "an unchanged draft keeps its request identity")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("a daily codeless or uncertain failure stays held without a resend", async () => {
  for (const json of [{ error: "Recurrence creation unavailable or uncertain" }, { error: "settlement unknown", code: "creation-uncertain" }]) {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
    try {
      const fixture = await setupDaily(page, route => route.fulfill({ status: json.code ? 409 : 503, json }))
      await submitReady(page)
      await fixture.submit.click()
      await page.waitForFunction(() => (document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
      await fixture.form.evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
      await page.waitForTimeout(200)
      assert.equal(await fixture.submit.isDisabled(), true, JSON.stringify(json))
      assert.equal(fixture.attempts.length, 1, "no automatic or manual replay")
      assert.deepEqual(fixture.errors, [])
    } finally { await page.close() }
  }
})

test("a codeless server failure stays an exact uncertain hold without a resend", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  try {
    const fixture = await setup(page, route => route.fulfill({ status: 503, json: { error: "Mission plugin unavailable" } }))
    await fixture.objective.fill("Possibly committed")
    await submitReady(page)
    await fixture.submit.click()
    await page.getByRole("alert").filter({ hasText: UNCONFIRMED }).waitFor()
    assert.equal(await fixture.submit.isDisabled(), true)
    assert.equal((await page.evaluate(() => window.missionEditorLifetime.held()))?.requestId, fixture.attempts[0]!.requestId)
    await page.waitForTimeout(200)
    assert.equal(fixture.attempts.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("a newer editor whose adopted pending hold becomes uncertain keeps its unsent draft with truthful wording", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 1000 } })
  let release!: () => void
  const reply = new Promise<void>(resolve => { release = resolve })
  try {
    const fixture = await setup(page, async route => {
      await reply
      return route.fulfill({ status: 409, json: { error: "Mission creation settlement is unknown", code: "creation-uncertain" } })
    })
    await fixture.objective.fill("First pending create")
    await submitReady(page)
    await fixture.submit.click()
    await page.waitForFunction(() => document.querySelector('form.mission-editor button[type="submit"]')?.textContent !== "Create")
    await fixture.form.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await fixture.objective.fill("Newer unsent draft")
    await submitReady(page)
    await fixture.submit.click()
    release()
    const alert = page.getByRole("alert").filter({ hasText: "Another creation request from this window is unconfirmed" })
    await alert.waitFor()
    assert.match(await alert.innerText(), /draft shown here was not sent/)
    assert.doesNotMatch(await alert.innerText(), /exactly as sent/)
    assert.equal(await fixture.objective.inputValue(), "Newer unsent draft", "the unsent draft is not replaced or misattributed")
    assert.equal(await fixture.submit.isDisabled(), true)
    assert.equal(await fixture.form.getByRole("button", { name: "Save as brief", exact: true }).isDisabled(), false, "the unsent draft can still be kept as a brief")
    assert.equal((await page.evaluate(() => window.missionEditorLifetime.held()))?.objective, "First pending create")
    await page.waitForTimeout(200)
    assert.equal(fixture.attempts.length, 1, "the newer draft was never sent")

    // Reopening shows the held original with the sender's wording.
    await fixture.form.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    assert.equal(await fixture.objective.inputValue(), "First pending create")
    await page.getByRole("alert").filter({ hasText: "keeps the request exactly as sent" }).waitFor()
    assert.deepEqual(fixture.errors, [])
  } finally { release(); await page.close() }
})