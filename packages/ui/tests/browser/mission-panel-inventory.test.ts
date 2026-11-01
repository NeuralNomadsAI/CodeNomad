import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import Fastify from "fastify"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { missionPluginFixture, FIXTURE_PROJECT } from "../../../server/src/missions/mission-plugin-fixture"
import { MissionJournal, parseMissionEvent } from "../../../server/src/missions/journal"
import { registerMissionRoutes } from "../../../server/src/server/routes/missions"
import { WorktreeDeletionFence } from "../../../server/src/workspaces/worktree-session-evacuation"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"

let browser: Browser, url: string
before(async () => {
  url = (await borrowFixture({ name: "mission-panel-inventory", routes: [{ path: "/inventory", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })).url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined }); armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function open() {
  const f = missionPluginFixture(), journal = new MissionJournal(f.storage, FIXTURE_PROJECT.id, FIXTURE_PROJECT.canonical), location = FIXTURE_PROJECT.location
  const prefixes: string[] = [], scan = f.storage.scan.bind(f.storage), native: string[] = [], requests: any[] = [], bytes: number[] = [], mutations: string[] = []
  f.storage.scan = async options => { prefixes.push(options.prefix); return scan(options) }
  const seed = (missionID: string, value: Record<string, unknown>) => {
    const event = parseMissionEvent({ version: 1, projectID: FIXTURE_PROJECT.id, missionID, ...value }); assert.ok(event)
    f.values.set(`codenomad-missions/v2/${journal.projectToken}/${missionID}/${event.id}`, event as never)
  }
  for (let index = 0; index < 230; index++) {
    const id = `msn_inventory_${index}`
    seed(id, { id: "evt_create", type: "mission.created", projectCanonical: "/repo", objective: `Mission ${index}`, title: `Mission ${index}`, template: "custom", coordinator: { sessionID: `ses_${index}`, title: "Coordinator", location }, createdAt: index + 1 })
    if (index >= 120) seed(id, { id: "evt_delete", type: "mission.deleted", requestID: `delete_${index}`, expectedRevision: 1, deleteManagedSessions: true,
      cleanupTargets: [{ sessionID: `ses_removed_${index}`, location }], createdAt: index + 200 })
    else if (index >= 60 && index !== 119) seed(id, { id: "evt_finish", type: "mission.finished", outcome: "completed", summary: "Done", createdAt: index + 200 })
  }
  for (let index = 0; index < 600; index++) {
    const key = `work-${index}`, binding = { generation: 1, parentSessionID: "ses_119", parentMessageID: `msg_${index}`, toolCallID: `call_${index}` }
    seed("msn_inventory_119", { id: `evt_task_${index}`, type: "task.created", task: { id: `tsk_${index}`, key, title: key, brief: "Brief", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 1000 + 2 * index })
    seed("msn_inventory_119", { id: `evt_bind_${index}`, type: "task.native-bound", taskKey: key, binding, actor: { sessionID: `ses_actor_${index}`, title: `Actor ${index}`, managed: true, location }, createdAt: 1001 + 2 * index })
  }
  const forms = [{ id: "far_form", sessionID: "ses_actor_189", title: "Off-page native question", fields: [] }]
  const session = (id: string) => ({ id, projectID: FIXTURE_PROJECT.id, location })
  // One durable control/index, with no unrelated startup-outbox background scans.
  const control = f.control(), plugin = { rpc: (_method: string, input: unknown) => control.panelPage(input as any), dispose: async () => {} }
  const client = { location: { get: async () => ({ ...location, project: { id: FIXTURE_PROJECT.id } }) }, plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ panelPage: async (input: unknown) => plugin.rpc("panelPage", input), content: (input: any) => control.content(input) }),
    session: { get: async ({ sessionID }: { sessionID: string }) => { native.push(`get:${sessionID}`); return session(sessionID) },
      list: async ({ parentID }: { parentID: string }) => { native.push(`children:${parentID}`); return { data: [], cursor: { next: null } } },
      active: async () => { native.push("active"); return {} }, inbox: { list: async () => [] } },
    shell: { list: async () => ({ location, data: [] }) }, form: { list: async () => ({ location, data: forms }) }, permission: { request: { list: async () => ({ location, data: [] }) } } }
  const app = Fastify({ logger: false })
  const workspace = { id: "workspace" }
  registerMissionRoutes(app, { worktreeDeletionFence: new WorktreeDeletionFence(), workspaceManager: { get: () => workspace, getServiceLocation: () => location,
    ownsLocation: async () => true, getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
    getSharedServiceConnection: async () => ({ client, assertCurrent() {} }) } as never })
  await new Promise(resolve => setImmediate(resolve))
  await plugin.rpc("panelPage", { source: "summaries", window: { offset: 0 } }); prefixes.length = 0
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1000, height: 900 } }), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15000)
  await page.addInitScript("Object.assign(window,{__name:f=>f,__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})")
  let failMiddle: false | "summaries" | "cleanups" = false
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith("/missions/panel-page")) {
      const input = request.postDataJSON(); requests.push(input)
      if (failMiddle === input.source && input.window?.offset === 50) return route.fulfill({ status: 503, json: {} })
      const response = await app.inject({ method: "POST", url: "/api/workspaces/workspace/missions/panel-page", payload: input })
      bytes.push(response.rawPayload.length); return route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
    }
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: FIXTURE_PROJECT.id, projectCanonical: "/repo", location, schedules: [] }) })
    if (path.endsWith("/missions/scheduled")) return route.fulfill({ json: { available: true, version: 1, projectID: FIXTURE_PROJECT.id, documents: [], page: { offset: 0, end: 0, total: 0 } } })
    if (path.endsWith("/content")) {
      const response = await app.inject({ method: "GET", url: request.url().replace(/^.*\/api\/workspaces\/fixture\//, "/api/workspaces/workspace/") })
      return route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
    }
    if (path.includes("/missions")) { mutations.push(`${request.method()} ${path}`); return route.fulfill({ status: 500, json: {} }) }
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.waitForFunction(async () => (await import("/src/stores/missions.ts")).missionStore.state("fixture").status === "ready")
  return { page, requests, prefixes, native, bytes, mutations, errors, fail: (value: boolean | "cleanups") => { failMiddle = value === true ? "summaries" : value },
    close: async () => { await page.context().close(); await app.close(); await plugin.dispose() } }
}

test("actual picker discovers a bounded first inventory without maps, traverses/retries the middle, and reads an exact selected target outside it", async t => {
  const f = await open()
  try {
    assert.equal(f.requests.filter(item => item.source === "summaries").length, 1)
    assert.equal(f.requests.filter(item => item.source === "mission" || item.source === "tasks").length, 0)
    assert.equal(f.prefixes.length, 0, "warm discovery/marks read no mission ranges")
    assert.ok(f.native.filter(value => value.startsWith("get:")).length <= 160)
    assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.state("fixture").summaries.length), 50)
    f.fail(true)
    await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.more("fixture", "summaries"))
    await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.more("fixture", "cleanups"))
    assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.progress("fixture", "summaries").failure), "failed")
    await f.page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { selected: "msn_inventory_0" }))
    await f.page.locator(".mission-detail").waitFor()
    assert.deepEqual(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.state("fixture").missions.map(map => map.id)), ["msn_inventory_0"])
    assert.ok(f.requests.filter(item => item.source === "mission").every(item => item.missionID === "msn_inventory_0"))
    f.fail(false)
    await f.page.evaluate(async () => { const s = (await import("/src/stores/missions.ts")).missionStore; await s.more("fixture", "summaries", true); await s.more("fixture", "summaries") })
    assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.progress("fixture", "summaries").loaded), 120)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, []); assert.ok(f.bytes.every(bytes => bytes <= 65536))
    t.diagnostic(`first summary body ${f.bytes[0]} bytes; ${f.requests.length} total panel transfers; ${f.native.filter(item => item.startsWith("get:")).length} native root reads; no legacy list`)
  } finally { await f.close() }
})

test("601-actor selection keeps its header small and reaches real off-page Needs you via explicit actor windows", async t => {
  const f = await open()
  try {
    await f.page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { selected: "msn_inventory_119" }))
    await f.page.locator(".mission-detail").waitFor()
    assert.equal(await f.page.getByText("Off-page native question", { exact: true }).count(), 0)
    await f.page.waitForFunction(async () => {
      const state = (await import("/src/stores/missions.ts")).missionStore.progress("fixture", "activity:msn_inventory_119")
      return state.total !== undefined && !state.loading
    })
    const before = f.native.length
    await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.more("fixture", "activity:msn_inventory_119"))
    await f.page.getByText("Off-page native question", { exact: true }).waitFor()
    assert.ok(f.native.slice(before).filter(item => item.startsWith("get:")).length <= 160)
    assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.observations("fixture", "msn_inventory_119").every(page => page.coverage !== "observed")), true)
    assert.ok(f.requests.filter(item => item.source === "mission").every(item => item.header === true))
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
    t.diagnostic(`off-page window roots ${f.native.slice(before).filter(item => item.startsWith("get:")).length}; largest body ${Math.max(...f.bytes)} bytes`)
  } finally { await f.close() }
})

test("cleanup discovery keeps a failed middle window through a passive first-window refresh and retries without a control effect", async () => {
  const f = await open()
  try {
    f.fail("cleanups")
    await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.more("fixture", "cleanups"))
    await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.refresh("fixture"))
    assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.progress("fixture", "cleanups").failure), "failed")
    f.fail(false)
    await f.page.evaluate(async () => { const s = (await import("/src/stores/missions.ts")).missionStore; await s.more("fixture", "cleanups", true); await s.more("fixture", "cleanups") })
    assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.progress("fixture", "cleanups").loaded), 110)
    assert.equal(await f.page.evaluate(async () => new Set((await import("/src/stores/missions.ts")).missionStore.state("fixture").cleanups!.map(row => JSON.stringify([row.missionID, row.requestID, row.expectedRevision, row.deleteManagedSessions]))).size), 110)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("persisted fields expose independently verified raw JSON pages through the real producer", async () => {
  const f = await open()
  try {
    await f.page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", {
      selected: "msn_inventory_119", reader: { missionId: "msn_inventory_119", kind: "overview" } }))
    await f.page.getByText("Technical details", { exact: true }).click()
    await f.page.getByText("Read persisted fields", { exact: true }).click()
    const actors = f.page.locator(".mission-panel-fields > details").filter({ has: f.page.locator("summary > bdi", { hasText: /^actors$/ }) })
    await actors.locator("summary").click()
    await actors.getByRole("button", { name: "Read raw JSON pages", exact: true }).click()
    await actors.getByText(/^Raw JSON page 1 of [1-9]/).waitFor()
    await actors.getByRole("button", { name: "Next page", exact: true }).click()
    await actors.getByText(/^Raw JSON page 2 of [1-9]/).waitFor()
    const raw = f.requests.filter(item => item.text)
    assert.deepEqual(raw.map(item => item.window.offset), [0, 1]); assert.ok(raw[1].window.order)
    assert.ok(raw.every(item => item.field === "actors" && item.missionID === "msn_inventory_119"))
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
