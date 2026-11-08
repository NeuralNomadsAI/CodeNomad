import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createServer, type Server } from "node:http"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { NativeMissionDocumentStore } from "../../../server/src/missions/mission-document-store"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import { missionDocumentSummary } from "../../../server/src/missions/mission-document-one-time"
import type { MissionDocument } from "../../../server/src/missions/mission-document"
import type { MissionJsonValue } from "../../../server/src/missions/model"

let browser: Browser, url: string, events: Server, eventsURL: string
before(async () => {
  const fixture = await borrowFixture({ name: "mission-creation-start", routes: [{ path: "/start", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-creation-start.tsx"></script></body></html>' }] })
  url = fixture.url
  events = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": new URL(url).origin, "Access-Control-Allow-Credentials": "true" })
    response.write(": fixture\n\n")
  })
  await new Promise<void>(resolve => events.listen(0, "127.0.0.1", resolve))
  eventsURL = `http://127.0.0.1:${(events.address() as { port: number }).port}/api/events`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => {
  try { await browser?.close() }
  finally { if (events) { events.closeAllConnections(); await new Promise<void>(resolve => events.close(() => resolve())) } }
})
const configuration = { title: "Inspect changes", objective: "Inspect changes", notes: "", template: "custom", taskMode: "native",
  profiles: { coordinator: { agent: "build", model: { providerID: "p", id: "m" } },
    roles: { specialist: { agent: "build", model: { providerID: "p", id: "m" } } } }, watchedConversationIDs: [],
  launch: { when: [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }] } }
async function setup(page: Page, options: { enabled?: boolean; lose?: "create" | "activation" | "play" } = {}) {
  page.setDefaultTimeout(10_000)
  const values = new Map<string, MissionJsonValue>(), posts: any[] = [], errors: string[] = []
  const store = new NativeMissionDocumentStore({ get: async key => values.get(key),
    compareAndSet: async (key, value) => { values.set(key, structuredClone(value)) } }, "project", "/fixture")
  let doc: MissionDocument, enabled = options.enabled ?? true, receipt: any
  let activationGate: Promise<void> | undefined
  const result = () => ({ ...missionScheduleView(doc), pending: false,
    document: { ...missionScheduleView(doc).document, control: receipt } })
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/events?*", route => route.continue({ url: eventsURL }))
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { locale: "en" } } }))
  await page.route("**/api/workspaces/fixture/missions/**", async route => {
    const request = route.request(), target = new URL(request.url()).pathname
    if (request.method() === "GET") {
      if (target.endsWith("/capabilities")) return route.fulfill({ json: { location: { directory: "/fixture" },
        api: { available: true }, enabled, origin: null, activation: { available: true,
          targets: [{ scope: "global", path: "/private/config/opencode.jsonc" }] } } })
      if (target.endsWith("/schedule-settings")) return route.fulfill({ json: { document: missionDocumentSummary(doc) } })
      return route.fulfill({ json: result() })
    }
    const body = request.postDataJSON(); posts.push({ ...body, target })
    if (target.endsWith("/schedule-settings")) {
      doc = await store.change(doc.id, body.expectedDocumentRevision, () => true, value => {
        value.scheduleActivation = { requestID: body.requestID, expectedRevision: body.expectedDocumentRevision,
          authority: "a".repeat(64), state: "ready", targets: [], effectiveOrigin: "/private/config/opencode.jsonc" }
      })
      enabled = true
      await activationGate
      if (options.lose === "activation") return route.abort("connectionreset")
      return route.fulfill({ json: { document: missionDocumentSummary(doc) } })
    }
    if (body.action === "create") doc = await store.create("msn_created", { ...body.configuration, profileID: "profile", executionHost: "local",
      roots: [{ mode: "directory-only", directory: "/fixture" }] }, Date.now(), () => true)
    else {
      assert.equal(body.expectedRevision, doc.revision)
      doc = await store.change(doc.id, doc.revision, () => true, value => { value.state = "running"; value.firstPlayedAt = Date.now() })
    }
    receipt = { action: body.action, requestID: body.requestID, expectedRevision: body.expectedRevision, pending: false }
    if (options.lose === body.action) return route.abort("connectionreset")
    return route.fulfill({ json: result() })
  })
  await page.goto(url)
  await page.waitForFunction(() => (window as any).creationStartFixture)
  return { posts, errors, get revision() { return doc.revision }, set activationGate(value: Promise<void>) { activationGate = value } }
}
const save = (page: Page, requested = true) => page.evaluate(({ configuration, requested }) =>
  (window as any).creationStartFixture.save(configuration, requested), { configuration, requested })
const saved = (page: Page) => page.waitForFunction(() => document.querySelector("[data-saved]")?.textContent === "1")

test("direct scheduled creation arms once through exact activation and Play revisions", async () => {
  const page = await browser.newPage(), f = await setup(page, { enabled: false })
  try {
    const saving = save(page)
    const dialog = page.getByRole("dialog")
    await dialog.getByText("/private/config/opencode.jsonc", { exact: false }).waitFor()
    await dialog.getByRole("button", { name: "Start", exact: true }).click()
    await saving; await saved(page)
    assert.deepEqual(f.posts.map(post => post.action ?? "activation"), ["create", "activation", "play"])
    assert.equal(f.posts[2].expectedRevision, f.posts[1].expectedDocumentRevision + 1)
    await page.evaluate(() => (window as any).creationStartFixture.repeat())
    assert.equal(f.posts.length, 3)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("unchecked creation stays paused and recovered creation never autostarts", async () => {
  for (const lose of [undefined, "create"] as const) {
    const page = await browser.newPage(), f = await setup(page, { lose })
    try {
      await save(page, !!lose)
      if (lose) {
        await page.evaluate(() => (window as any).creationStartFixture.reconcile())
      }
      await saved(page)
      assert.deepEqual(f.posts.map(post => post.action), ["create"])
      assert.deepEqual(f.errors, [])
    } finally { await page.close() }
  }
})

test("lost activation remains retained on remount; receipt recovery leaves Play explicit", async () => {
  const page = await browser.newPage(), f = await setup(page, { enabled: false, lose: "activation" })
  try {
    const saving = save(page)
    await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click()
    await saving; await saved(page)
    assert.equal(await page.evaluate(() => (window as any).creationStartFixture.held()?.phase), "activation")
    await page.evaluate(() => (window as any).creationStartFixture.mount(false))
    await page.evaluate(() => (window as any).creationStartFixture.mount(true))
    await page.getByRole("button", { name: "Refresh saved request", exact: true }).click()
    await page.waitForFunction(() => (window as any).creationStartFixture.held()?.phase === "publication")
    assert.deepEqual(f.posts.map(post => post.action ?? "activation"), ["create", "activation"])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("view departure after activation dispatch fences its direct Play continuation", async () => {
  const page = await browser.newPage(), f = await setup(page, { enabled: false })
  let release!: () => void
  f.activationGate = new Promise<void>(resolve => { release = resolve })
  try {
    const saving = save(page)
    await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click()
    await page.waitForFunction(() => (window as any).creationStartFixture.held()?.phase === "activation")
    await page.evaluate(() => (window as any).creationStartFixture.activate(false))
    release(); await saving
    assert.deepEqual(f.posts.map(post => post.action ?? "activation"), ["create", "activation"])
    assert.equal(await page.locator("[data-saved]").textContent(), "0")
    assert.deepEqual(f.errors, [])
  } finally { release(); await page.close() }
})

test("lost scheduled Play keeps its exact original control across helper disposal and remount", async () => {
  const page = await browser.newPage(), f = await setup(page, { lose: "play" })
  try {
    await save(page); await saved(page)
    const held = await page.evaluate(() => (window as any).creationStartFixture.held())
    assert.equal(held.action, "play"); assert.equal(held.requestID, f.posts[1].requestID)
    await page.evaluate(() => (window as any).creationStartFixture.mount(false))
    await page.evaluate(() => (window as any).creationStartFixture.mount(true))
    assert.equal(await page.evaluate(() => (window as any).creationStartFixture.held()?.requestID), held.requestID)
    assert.deepEqual(f.posts.map(post => post.action), ["create", "play"])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
