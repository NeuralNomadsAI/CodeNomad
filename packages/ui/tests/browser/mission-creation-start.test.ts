import assert from "node:assert/strict"
import { openMissionProfiles } from "./mission-actions"
import { after, before, test } from "node:test"
import { createServer, type Server } from "node:http"
import { chromium, type Browser, type Page, type Request } from "playwright"
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
async function setup(page: Page, options: { enabled?: boolean; lose?: "create" | "activation" | "play"; realEditor?: boolean } = {}) {
  page.setDefaultTimeout(10_000)
  const values = new Map<string, MissionJsonValue>(), posts: any[] = [], errors: string[] = [], reads: URL[] = []
  const failedRequests: Array<{ method: string; path: string }> = []
  const store = new NativeMissionDocumentStore({ get: async key => values.get(key),
    compareAndSet: async (key, value) => { values.set(key, structuredClone(value)) } }, "project", "/fixture")
  let doc: MissionDocument, enabled = options.enabled ?? true, receipt: any, proof = true
  let activationGate: Promise<void> | undefined
  const result = () => ({ ...missionScheduleView(doc), pending: false,
    document: { ...missionScheduleView(doc).document, control: receipt } })
  page.on("pageerror", error => errors.push(error.message))
  page.on("requestfailed", request => failedRequests.push({ method: request.method(), path: new URL(request.url()).pathname }))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/events?*", route => route.continue({ url: eventsURL }))
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { locale: "en",
    missionProfileDefaults: [{ template: "custom", profiles: configuration.profiles }] } } }))
  if (options.realEditor) {
    await page.route("**/api/workspaces/fixture/subagent-depth*", route => route.fulfill({ json: {
      location: { directory: "/fixture" }, capability: null, effectiveDepth: null, project: null } }))
    await page.route("**/workspaces/fixture/instance/api/{agent,model,provider}**", route => {
      const target = new URL(route.request().url()).pathname
      return route.fulfill({ json: { data: target.endsWith("/agent") ? [{ id: "build", mode: "all" }]
        : target.endsWith("/provider") ? [{ id: "p", name: "Fixture provider" }]
          : [{ providerID: "p", id: "m", name: "Fixture model", status: "active", enabled: true,
            capabilities: { tools: true }, cost: [], limit: { context: 1000, output: 100 }, variants: [] }] } })
    })
  }
  await page.route("**/api/workspaces/fixture/missions/**", async route => {
    const request = route.request(), target = new URL(request.url()).pathname
    if (request.method() === "GET") {
      const link = new URL(request.url())
      reads.push(link)
      if (target.endsWith("/capabilities")) return route.fulfill({ json: { location: { directory: "/fixture" },
        api: { available: true }, enabled, origin: null, activation: { available: true,
          targets: [{ scope: "global", path: "/private/config/opencode.jsonc" }] } } })
      if (target.endsWith("/schedule-settings")) return route.fulfill({ json: { document: proof ? missionDocumentSummary(doc)
        : { ...missionDocumentSummary(doc), scheduleActivation: null } } })
      if (!proof && (link.searchParams.has("requestID") || target.includes("/requests/")))
        return route.fulfill({ status: 503, json: { ...result(), pending: true, code: "schedule-pending", document: { ...result().document, control: null } } })
      return route.fulfill({ json: result() })
    }
    assert.equal(request.method(), "POST")
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
    assert.ok(body.action === "create" || body.action === "play", "unexpected schedule mutation")
    assert.equal(target, body.action === "create" ? "/api/workspaces/fixture/missions/scheduled"
      : "/api/workspaces/fixture/missions/msn_created/schedule")
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
  if (options.realEditor) {
    // MissionEditor refreshes the project after creation. The panel adapter owns
    // that read-only POST protocol independently of the schedule mutation collector.
    await page.route("**/api/workspaces/fixture/missions", route => route.fulfill({ json: {
      available: true, version: 1, projectID: "project", missions: [], cleanups: [], generatedAt: 1, discardedEvents: 0 } }))
  }
  const kinds = ["agent", "model", "provider"], completed: Request[] = []
  const matches = (request: Request, kind: string) => request.method() === "GET"
    && new URL(request.url()).pathname === `/workspaces/fixture/instance/api/${kind}`
  // Capture body-completion receipts without starting action deadlines during navigation.
  const remember = (request: Request) => { if (kinds.some(kind => matches(request, kind))) completed.push(request) }
  page.on("requestfinished", remember)
  const waitForCatalog = () => {
    page.off("requestfinished", remember)
    const early = completed.splice(0) // Initial receipts are consumed once; later waves require new events.
    return Promise.all(kinds.map(async kind => {
      if (!early.some(request => matches(request, kind))) await page.waitForEvent("requestfinished", { predicate: request => matches(request, kind) })
    }))
  }
  await page.goto(options.realEditor ? `${url}?realEditor=1` : url)
  await page.waitForFunction(realEditor => realEditor ? (window as any).realCreationStartFixture : (window as any).creationStartFixture, !!options.realEditor)
  if (options.realEditor) { await openMissionProfiles(page); await waitForCatalog() }
  else page.off("requestfinished", remember)
  return { posts, reads, failedRequests, errors, waitForCatalog, get revision() { return doc.revision },
    set proof(value: boolean) { proof = value }, set activationGate(value: Promise<void>) { activationGate = value } }
}
const save = (page: Page, requested = true) => page.evaluate(({ configuration, requested }) =>
  (window as any).creationStartFixture.save(configuration, requested), { configuration, requested })
const saved = (page: Page) => page.waitForFunction(() => document.querySelector("[data-saved]")?.textContent === "1")

test("direct scheduled creation arms once through exact activation and Play revisions", async () => {
  const page = await browser.newPage(), f = await setup(page, { enabled: false })
  try {
    const saving = save(page)
    await saving; await saved(page)
    assert.equal(await page.getByRole("dialog").count(), 0)
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
      await saved(page)
      assert.deepEqual(f.posts.map(post => post.action), ["create"])
      assert.deepEqual(f.errors, [])
    } finally { await page.close() }
  }
})

test("lost activation remains retained on remount; automatic receipt recovery leaves Play explicit", async () => {
  const page = await browser.newPage()
  await page.clock.install({ time: Date.now() })
  const f = await setup(page, { enabled: false, lose: "activation" })
  try {
    f.proof = false
    const pendingRead = page.waitForResponse(response => response.request().method() === "GET"
      && new URL(response.url()).pathname.endsWith("/schedule-settings"))
    const saving = save(page)
    await saving; await saved(page); await pendingRead
    assert.equal(await page.evaluate(() => (window as any).creationStartFixture.held()?.phase), "activation")
    await page.evaluate(() => (window as any).creationStartFixture.mount(false))
    await page.evaluate(() => (window as any).creationStartFixture.mount(true))
    assert.equal(await page.evaluate(() => (window as any).creationStartFixture.held()?.phase), "activation")
    f.proof = true
    await page.clock.fastForward(5_000)
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
    f.proof = false
    await save(page); await saved(page)
    const held = await page.evaluate(() => (window as any).creationStartFixture.held())
    assert.equal(held.phase, "control")
    assert.equal(held.action, "play"); assert.equal(held.requestID, f.posts[2].requestID)
    await page.evaluate(() => (window as any).creationStartFixture.mount(false))
    await page.evaluate(() => (window as any).creationStartFixture.mount(true))
    assert.equal(await page.evaluate(() => (window as any).creationStartFixture.held()?.requestID), held.requestID)
    assert.deepEqual(f.posts.map(post => post.action ?? "activation"), ["create", "activation", "play"])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
