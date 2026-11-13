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
import path from "node:path"
import { showSelection } from "./mission-actions"

let browser: Browser, url: string
before(async () => {
  url = (await borrowFixture({ name: "mission-panel-inventory", routes: [{ path: "/inventory", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })).url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined }); armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function open(extraForms: Array<{ id: string; sessionID: string; title: string; fields: never[] }> = [], holdInitialMarks = false) {
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
  const forms = [{ id: "far_form", sessionID: "ses_actor_189", title: "Off-page native question", fields: [] }, ...extraForms]
  const children = new Map<string, string[]>(), parents = new Map<string, string>(), firstMessages = new Map<string, string>()
  let active: Record<string, object> = {}
  const session = (id: string) => ({ id, projectID: FIXTURE_PROJECT.id, location, ...(parents.has(id) ? { parentID: parents.get(id) } : {}) })
  // One durable control/index, with no unrelated startup-outbox background scans.
  const control = f.control(), plugin = { rpc: (_method: string, input: unknown) => control.panelPage(input as any), dispose: async () => {} }
  const client = { location: { get: async () => ({ ...location, project: { id: FIXTURE_PROJECT.id } }) }, plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ panelPage: async (input: unknown) => plugin.rpc("panelPage", input), content: (input: any) => control.content(input) }),
    session: { get: async ({ sessionID }: { sessionID: string }) => { native.push(`get:${sessionID}`); return session(sessionID) },
      list: async ({ parentID }: { parentID: string }) => { native.push(`children:${parentID}`); return { data: (children.get(parentID) ?? []).map(session), cursor: { next: null } } },
      active: async () => { native.push("active"); return active }, inbox: { list: async () => [] } },
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
  let unavailable: string | undefined
  let releaseMarks!: () => void, marksReady!: () => void, firstMarks = true
  const marksGate = new Promise<void>(resolve => { releaseMarks = resolve }), initialMarksReady = new Promise<void>(resolve => { marksReady = resolve })
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.includes("/instance/api/")) {
      const query = new URL(request.url()).searchParams
      if (path.endsWith("/session/active")) return route.fulfill({ json: { data: active } })
      if (path.endsWith("/session")) return route.fulfill({ json: { data: (children.get(query.get("parentID") ?? "") ?? []).map(session), cursor: {} } })
      if (path.endsWith("/message")) {
        const text = firstMessages.get(path.match(/\/session\/([^/]+)\/message$/)?.[1] ?? query.get("sessionID") ?? "")
        return route.fulfill({ json: { data: text ? [{ type: "user", text }] : [], cursor: {} } })
      }
      return route.fulfill({ json: {} })
    }
    if (path.endsWith("/missions/panel-page")) {
      const input = request.postDataJSON(); requests.push(input)
      const held = holdInitialMarks && firstMarks && input.source === "marks" && !input.missionOffset
      if (held) firstMarks = false
      if (unavailable) return route.fulfill({ json: { available: false, reason: unavailable, missions: [] } })
      if (failMiddle === input.source && input.window?.offset === 50) return route.fulfill({ status: 503, json: {} })
      const response = await app.inject({ method: "POST", url: "/api/workspaces/workspace/missions/panel-page", payload: input })
      if (held) { marksReady(); await marksGate }
      bytes.push(response.rawPayload.length); return route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
    }
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: recurrenceSnapshotSchema.parse({ version: 1, projectID: FIXTURE_PROJECT.id, projectCanonical: "/repo", location, schedules: [] }) })
    if (path.endsWith("/missions/scheduled")) return route.fulfill({ json: { version: 1, projectID: FIXTURE_PROJECT.id, schedules: [] } })
    if (path.endsWith("/schedule") && request.method() === "GET") return route.fulfill({ json: { document: null, pending: false } })
    if (path.endsWith("/content")) {
      const response = await app.inject({ method: "GET", url: request.url().replace(/^.*\/api\/workspaces\/fixture\//, "/api/workspaces/workspace/") })
      return route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
    }
    if (path.includes("/missions")) { mutations.push(`${request.method()} ${path}`); return route.fulfill({ status: 500, json: {} }) }
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.waitForFunction(() => (window as any).missionFixture?.snapshot().status === "ready")
  await page.evaluate(async () => { (window as any).inventoryStore = (await import("/src/stores/missions.ts")).missionStore })
  return { page, requests, prefixes, native, bytes, mutations, errors, fail: (value: boolean | "cleanups") => { failMiddle = value === true ? "summaries" : value },
    initialMarksReady, releaseMarks,
    forms, running: (id?: string) => { active = id ? { [id]: {} } : {} },
    ordinaryChild: (missionID: string) => {
      const parent = `ses_${missionID.split("_").at(-1)}`, child = "ses_directory_helper"
      children.set(parent, [...children.get(parent) ?? [], child]); parents.set(child, parent)
      firstMessages.set(child, "An unrelated helper, without a Mission assignment.")
      return child
    },
    nativeTask: async (missionID: string, key: string) => {
      const parent = `ses_${missionID.split("_").at(-1)}`, child = "ses_native_directory"
      await journal.append(parseMissionEvent({ version: 1, projectID: FIXTURE_PROJECT.id, missionID, id: `evt_create_${key}`,
        type: "task.created", createdAt: 3000, task: { id: `tsk_${key}`, key, title: key, brief: "Brief", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } } })!)
      children.set(parent, [child]); parents.set(child, parent)
      firstMessages.set(child, `# CodeNomad Mission Assignment\n\nYou are a native task actor in mission ${missionID}.\n\nPlaybook: Custom\nRole: Specialist\nTask key: ${key}\nBlocked by: none\n`)
      return child
    },
    finish: async (missionID: string, taskKey: string, at: number) => {
      const task = { id: `tsk_${taskKey}`, key: taskKey, title: taskKey, brief: "Private task body", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }
      const event = { version: 1, projectID: FIXTURE_PROJECT.id, missionID }
      await journal.append(parseMissionEvent({ ...event, id: `evt_create_${taskKey}`, type: "task.created", task, createdAt: at })!)
      await journal.append(parseMissionEvent({ ...event, id: `evt_finish_${taskKey}`, type: "task.reported", createdAt: at + 1,
        report: { id: `rep_${taskKey}`, taskKey, sessionId: `ses_${missionID.split("_").at(-1)}`, delivery: "coordinator-readout",
          outcome: "completed", summary: "Private result body", evidence: [], next: [], createdAt: at + 1 } })!)
      return { id: task.id, status: "completed", updatedAt: at + 1 }
    },
    unavailable: (reason: string) => { unavailable = reason },
    close: async () => { releaseMarks(); await page.context().close(); await app.close(); await plugin.dispose() } }
}

test("an unselected folded Mission propagates every unseen task result and Mark as read clears them without reading a task map", async () => {
  const f = await open(), id = "msn_inventory_59"
  try {
    await f.page.waitForFunction(() => (window as any).missionFixture.snapshot().activity?.missions.length > 0)
    const first = await f.finish(id, "new-first", 3000), second = await f.finish(id, "new-second", 4000)
    await f.page.evaluate(() => (window as any).missionFixture.refresh())
    const row = f.page.locator(`[data-mission-key="mission:${id}"]`), chevron = row.locator(".session-item-expander")
    await row.locator('[data-child-activity="idle"]').waitFor()
    assert.equal(await chevron.getAttribute("aria-expanded"), "false")
    assert.equal(await row.locator('[aria-current="true"]').count(), 0)
    assert.equal(f.requests.filter(request => request.source === "mission" || request.source === "tasks").length, 0)
    if (process.env.CODENOMAD_TEST_SCREENSHOTS) await f.page.locator(".mission-control").screenshot({ path: path.join(process.env.CODENOMAD_TEST_SCREENSHOTS, "missions-unselected-unseen.png") })
    await f.page.evaluate(async ({ id, task, project }) => {
      const { markMissionTasksSeen } = await import("/src/stores/mission-task-seen.ts")
      markMissionTasksSeen(JSON.stringify(["fixture", project]), id, [task])
    }, { id, task: second, project: FIXTURE_PROJECT.id })
    assert.equal(await chevron.getAttribute("data-child-activity"), "idle", "the older unseen result remains after individually reading the newest")
    await chevron.click({ button: "right" })
    await f.page.getByRole("menuitem", { name: "Mark as read", exact: true }).click()
    await f.page.waitForFunction(id => !document.querySelector(`[data-mission-key="mission:${id}"] [data-child-activity]`), id)
    assert.equal(f.requests.filter(request => request.source === "mission" || request.source === "tasks").length, 0)
    assert.notEqual(first.id, second.id)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("Mark as read covers unread task-mark windows through their snapshot when the directory row is older", async () => {
  const f = await open(), id = "msn_inventory_59"
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    for (let index = 0; index < 59; index++) await f.finish(id, `batch-${index}`, 5000 + index * 2)
    await f.page.evaluate(() => (window as any).inventoryStore.refresh("fixture"))
    await f.page.waitForFunction(id => (window as any).inventoryStore.taskMarks("fixture", id).loaded === 59, id)
    await f.page.route("**/missions/panel-page", async route => {
      const input = route.request().postDataJSON()
      if (input.source === "task-marks" && input.missionID === id && input.window.offset === 50) await gate
      return route.fallback()
    })
    await f.finish(id, "batch-59", 5118)
    await f.page.evaluate(id => (window as any).inventoryStore.more("fixture", `task-marks:${id}`, true), id)
    await f.page.waitForFunction(id => {
      const marks = (window as any).inventoryStore.taskMarks("fixture", id)
      return marks.loaded === 50 && marks.loading
    }, id)
    assert.equal(await f.page.evaluate(id => (window as any).missionFixture.snapshot().summaries.find((row: any) => row.id === id).updatedAt, id), 5117)
    assert.equal(await f.page.evaluate(id => (window as any).inventoryStore.taskMarks("fixture", id).through, id), 5119)
    const row = f.page.locator(`[data-mission-key="mission:${id}"]`)
    await row.locator('[data-child-activity="idle"]').waitFor()
    await row.locator(".session-item-expander").click({ button: "right" })
    await f.page.getByRole("menuitem", { name: "Mark as read", exact: true }).click()
    release()
    await f.page.waitForFunction(id => {
      const marks = (window as any).inventoryStore.taskMarks("fixture", id)
      return marks.loaded === 60 && !marks.loading
    }, id)
    assert.equal(await row.locator("[data-child-activity]").count(), 0, "the unread newer task does not relight the hierarchy after the original mark-all gesture")
    assert.equal(f.requests.filter(request => request.source === "mission" || request.source === "tasks").length, 0)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { release(); await f.close() }
})

test("an unselected task actor outside the observation window reuses the session list's known work and question signals", async () => {
  const f = await open(), id = "msn_inventory_119"
  try {
    await f.page.waitForFunction(id => (window as any).inventoryStore.taskMarks("fixture", id).loaded === 600, id)
    await f.page.evaluate(async () => {
      ;(window as any).missionFixture.seedCoordinators(["ses_actor_189"])
      const { setSessions } = await import("/src/stores/session-state.ts")
      setSessions(previous => {
        const own = new Map(previous.get("fixture")), actor = own.get("ses_actor_189")!
        own.set(actor.id, { ...actor, status: "working" })
        return new Map(previous).set("fixture", own)
      })
    })
    const row = f.page.locator(`[data-mission-key="mission:${id}"]`)
    await row.locator('[data-child-activity="working"]').waitFor()
    await f.page.evaluate(() => (window as any).missionFixture.queuePermission("ses_actor_189", "catalog_permission"))
    await row.locator('[data-child-activity="permission"]').waitFor()
    assert.notEqual(await row.locator(".mission-row-flag").getAttribute("data-mark"), "permission")
    assert.equal(f.native.filter(value => value === "get:ses_actor_189").length, 0, "known session signals do not require another actor window")
    assert.equal(f.requests.filter(request => request.source === "mission" || request.source === "tasks").length, 0)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("a folded unselected Mission discovers canonical native work and routes its question colour to the chevron", async () => {
  const f = await open([], true), id = "msn_inventory_59"
  try {
    await f.initialMarksReady
    const child = await f.nativeTask(id, "native-watch")
    f.running(child)
    await f.page.evaluate(async () => {
      ;(window as any).missionFixture.connectCatalog()
      await (window as any).inventoryStore.refresh("fixture")
    })
    f.releaseMarks()
    const row = f.page.locator(`[data-mission-key="mission:${id}"]`)
    await row.locator('[data-child-activity="working"]').waitFor()
    assert.equal(await f.page.evaluate(() => (window as any).inventoryStore.progress("fixture", "marks").failure), undefined,
      "a changed directory during the held initial observation is revalidated before extending it")
    assert.equal(await row.locator('[aria-current="true"]').count(), 0)
    if (process.env.CODENOMAD_TEST_SCREENSHOTS) await f.page.locator(".mission-control").screenshot({ path: path.join(process.env.CODENOMAD_TEST_SCREENSHOTS, "missions-unselected-working.png") })
    f.forms.push({ id: "native_question", sessionID: child, title: "Native task question", fields: [] })
    await f.page.evaluate(() => (window as any).missionFixture.refresh())
    await row.locator('[data-child-activity="permission"]').waitFor()
    assert.notEqual(await row.locator(".mission-row-flag").getAttribute("data-mark"), "permission", "the coordinator's flag does not steal its task's question")
    if (process.env.CODENOMAD_TEST_SCREENSHOTS) await f.page.locator(".mission-control").screenshot({ path: path.join(process.env.CODENOMAD_TEST_SCREENSHOTS, "missions-unselected-question.png") })
    f.forms.splice(f.forms.findIndex(form => form.id === "native_question"), 1)
    const helper = f.ordinaryChild(id)
    f.running(helper)
    await f.page.evaluate(() => (window as any).missionFixture.refresh())
    await f.page.waitForFunction(id => !document.querySelector(`[data-mission-key="mission:${id}"] [data-child-activity]`), id)
    f.forms.push({ id: "helper_question", sessionID: helper, title: "Coordinator helper question", fields: [] })
    await f.page.evaluate(() => (window as any).missionFixture.refresh())
    await row.locator('.mission-row-flag[data-mark="permission"]').waitFor()
    assert.equal(await row.locator("[data-child-activity]").count(), 0, "an unrelated helper is not invented as a task")
    assert.equal(f.requests.filter(request => request.source === "mission" || request.source === "tasks").length, 0)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

for (const [reason, detail] of [["host-unavailable", "host"], ["plugin-unavailable", "plugin"], ["plugin-failed", "pluginFailed"], ["workspace-unavailable", "workspace"]])
  test(`bounded panel renders localized unavailable guidance for ${reason} while retaining its last good inventory`, async () => {
    const f = await open()
    try {
      const before = await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.state("fixture").summaries)
      f.unavailable(reason)
      await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.refresh("fixture", false))
      const state = await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.state("fixture"))
      assert.equal(state.status, "unavailable"); assert.equal(state.reason, reason)
      assert.deepEqual(state.summaries, before)
      const localized = await f.page.evaluate(detail => (window as any).missionFixture.text(`missions.control.unavailable.${detail}`), detail)
      await f.page.getByText(localized, { exact: true }).waitFor()
      assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  })

test("one directory button loads Missions while bounded observation windows automatically follow displayed rows", async () => {
  const f = await open()
  try {
    await f.page.evaluate(async () => { (window as any).inventoryStore = (await import("/src/stores/missions.ts")).missionStore })
    const settled = () => f.page.waitForFunction(() => {
      const store = (window as any).inventoryStore, progress = store.progress("fixture", "marks")
      return !progress.loading && !progress.failure && progress.loaded >= store.state("fixture").summaries.length
    })
    await settled()
    assert.deepEqual(f.requests.filter(item => item.source === "marks").map(item => item.missionOffset ?? 0), [0, 16, 32, 48],
      "state reads stop at the last bounded window covering the 50 displayed rows")
    const paging = f.page.locator(".mission-list-paging")
    assert.equal(await paging.getByRole("button").count(), 0, "ordinary continuation is automatic, like the session list")
    assert.equal(await paging.locator(".settings-info-tip").count(), 0)
    assert.equal(await f.page.locator('.mission-panel-paging[data-lane="marks"], .mission-panel-paging[data-lane="summaries"]').count(), 0)
    await paging.scrollIntoViewIfNeeded()
    await f.page.waitForFunction(() => (window as any).inventoryStore.state("fixture").summaries.length >= 100).catch(async error => {
      console.error(await f.page.evaluate(() => {
        const host = document.querySelector(".mission-control")!, end = document.querySelector(".mission-list-paging")!
        return { loaded: (window as any).inventoryStore.state("fixture").summaries.length, top: host.scrollTop,
          height: host.clientHeight, full: host.scrollHeight, end: end?.getBoundingClientRect().toJSON(), focused: document.activeElement?.tagName }
      }), f.requests.filter(item => item.source === "summaries"))
      throw error
    })
    await settled()
    assert.equal((f.requests.filter(item => item.source === "marks").at(-1)?.missionOffset ?? 0), 96)
    await paging.scrollIntoViewIfNeeded()
    await f.page.waitForFunction(() => (window as any).inventoryStore.state("fixture").summaries.length === 120)
    await settled()
    await paging.waitFor({ state: "detached" })
    assert.equal(await f.page.locator('.mission-panel-paging[data-lane="marks"], .mission-panel-paging[data-lane="summaries"]').count(), 0,
      "exhausted discovery leaves no standalone info icons")
    assert.equal(f.requests.filter(item => item.source === "mission" || item.source === "tasks").length, 0, "directory paging never opens task maps")
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("approaching the directory end automatically adds one page without dropping the first rows", async () => {
  const f = await open()
  try {
    await f.page.waitForFunction(() => (window as any).missionFixture.snapshot().summaries.length === 50)
    const firstId = (await f.page.locator(".mission-row").first().getAttribute("data-mission-key"))!.slice("mission:".length)
    await f.page.locator(".mission-control").hover()
    await f.page.mouse.wheel(0, 1200)
    await f.page.waitForFunction(() => (window as any).missionFixture.snapshot().summaries.length === 100)
    await f.page.waitForTimeout(100)
    assert.equal((await f.page.evaluate(() => (window as any).missionFixture.snapshot().summaries.length)), 100,
      "one visible end adds one page, not the whole remaining inventory")
    assert.equal(await f.page.evaluate(id => (window as any).missionFixture.snapshot().summaries.some((row: { id: string }) => row.id === id), firstId), true,
      "the beginning stays cached even though Virtua may unmount its offscreen rows")
    assert.ok(await f.page.locator(".mission-control").evaluate(element => element.scrollTop) > 500)
    assert.equal(await f.page.locator(".mission-list-paging").count(), 1)
    assert.equal(await f.page.locator(".mission-list-paging button").count(), 0)
    assert.deepEqual(f.requests.filter(item => item.source === "summaries").map(item => item.window?.offset ?? 0), [0, 50])
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("an observation failure parks automatic reads and the one directory Retry resumes its exact failed window", async () => {
  const f = await open()
  try {
    await f.page.evaluate(async () => { (window as any).inventoryStore = (await import("/src/stores/missions.ts")).missionStore })
    await f.page.waitForFunction(() => {
      const state = (window as any).inventoryStore.progress("fixture", "marks")
      return !state.loading && state.loaded >= 50
    })
    let failed = false, attempts = 0
    await f.page.route("**/missions/panel-page", async route => {
      const input = route.request().postDataJSON()
      if (input.source === "marks" && input.missionOffset === 16) {
        attempts++
        if (!failed) { failed = true; return route.fulfill({ status: 503, json: {} }) }
      }
      return route.fallback()
    })
    await f.page.evaluate(() => (window as any).missionFixture.refresh())
    const retry = f.page.locator(".mission-list-paging").getByRole("button", { name: "Try again", exact: true })
    await retry.waitFor()
    assert.equal(attempts, 1)
    await f.page.waitForTimeout(100)
    assert.equal(attempts, 1, "a failed automatic window is never retried by itself")
    await retry.click()
    await f.page.waitForFunction(() => {
      const state = (window as any).inventoryStore.progress("fixture", "marks")
      return !state.loading && !state.failure && state.loaded >= 50
    })
    assert.equal(attempts, 2, "Retry resumes the failed observation offset once")
    assert.equal(await f.page.locator(".mission-list-paging button").count(), 0, "recovered continuation is automatic again")
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

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
    await showSelection(f.page)
    assert.deepEqual(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.state("fixture").missions.map(map => map.id)), ["msn_inventory_0"])
    assert.ok(f.requests.filter(item => item.source === "mission").every(item => item.missionID === "msn_inventory_0"))
    f.fail(false)
    await f.page.evaluate(async () => { const s = (await import("/src/stores/missions.ts")).missionStore; await s.more("fixture", "summaries", true); await s.more("fixture", "summaries") })
    assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.progress("fixture", "summaries").loaded), 120)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, []); assert.ok(f.bytes.every(bytes => bytes <= 65536))
    t.diagnostic(`first summary body ${f.bytes[0]} bytes; ${f.requests.length} total panel transfers; ${f.native.filter(item => item.startsWith("get:")).length} native root reads; no legacy list`)
  } finally { await f.close() }
})

test("a closed row's coordinator question seen only by the marks lane reddens its flag and opens from it", async () => {
  const f = await open([{ id: "coordinator_form", sessionID: "ses_119", title: "Coordinator question", fields: [] }])
  try {
    // Nothing is selected: the Mission's map is unread and the UI's native queue never saw the form.
    const row = f.page.locator(".mission-row").filter({ has: f.page.locator(".session-item-title", { hasText: /^Mission 119$/ }) })
    await row.locator('.mission-row-flag[data-mark="permission"]').waitFor()
    assert.equal(await f.page.locator("section.mission-detail").count(), 0)
    const opened = f.page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/session/ses_119"))
    await row.locator(".mission-row-select").click()
    await opened
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("601-actor selection keeps its header small and reaches a real off-page question via explicit actor windows", async t => {
  const f = await open()
  try {
    await f.page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { selected: "msn_inventory_119" }))
    await showSelection(f.page)
    assert.equal(await f.page.getByText("Off-page native question", { exact: true }).count(), 0)
    await f.page.waitForFunction(() => {
      const state = (window as any).inventoryStore.progress("fixture", "activity:msn_inventory_119")
      return state.total !== undefined && !state.loading
    })
    const before = f.native.length
    await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.more("fixture", "activity:msn_inventory_119"))
    await f.page.locator('[data-mission-key="mission:msn_inventory_119"] [data-child-activity="permission"]').waitFor()
    assert.notEqual(await f.page.locator('[data-mission-key="mission:msn_inventory_119"] .mission-row-flag').getAttribute("data-mark"), "permission", "task attention belongs to the chevron even before its row is rendered")
    assert.ok(f.native.slice(before).filter(item => item.startsWith("get:")).length <= 160)
    assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.observations("fixture", "msn_inventory_119").every(page => page.coverage !== "observed")), true)
    assert.ok(f.requests.filter(item => item.source === "mission").every(item => item.header === true))
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
    t.diagnostic(`off-page window roots ${f.native.slice(before).filter(item => item.startsWith("get:")).length}; largest body ${Math.max(...f.bytes)} bytes`)
  } finally { await f.close() }
})

for (const index of [0, 119]) test(`passive refresh keeps mission ${index}'s geometry and nodes stable while the existing toolbar shows reads`, async () => {
  const f = await open()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await f.page.evaluate(async index => (await import("/src/stores/mission-view-state.ts")).updateMissionProjectView("fixture", { selected: `msn_inventory_${index}` }), index)
    await showSelection(f.page)
    await f.page.waitForFunction(() => !(window as any).inventoryStore.reading("fixture"))
    if (index === 0) {
      await f.page.evaluate(async () => {
        const store = (await import("/src/stores/missions.ts")).missionStore
        for (let page = 0; store.progress("fixture", "marks").more; page++) {
          if (page >= 8) throw new Error("Marks traversal did not finish")
          await store.more("fixture", "marks")
        }
      })
      assert.equal(await f.page.locator('.mission-panel-paging[data-lane="marks"]').count(), 0, "observations have no separate footer or lone info slot")
    }
    const geometry = () => f.page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
      ".mission-control-header,.mission-action-bar,.mission-tree,.mission-flow,.mission-panel-paging")].map(element => {
      const box = element.getBoundingClientRect()
      return [element.className, box.x, box.y, box.width, box.height, element.scrollTop]
    }))
    const buttons = () => f.page.locator(".mission-control button").allTextContents()
    const actions = () => f.page.locator(".mission-control-header button,.mission-action-bar button").allTextContents()
    const before = await geometry(), labels = await buttons()
    const actionLabels = await actions()
    const stableNode = f.page.locator(index ? ".mission-tree-node" : ".mission-detail").first()
    const node = await stableNode.elementHandle()
    const screenshot = async (name: string) => {
      if (process.env.CODENOMAD_TEST_SCREENSHOTS) await f.page.screenshot({ path: path.join(process.env.CODENOMAD_TEST_SCREENSHOTS, `${name}-${index}.png`) })
    }
    await screenshot("missions-before-refresh")
    await f.page.route("**/missions/panel-page", async route => { await gate; return route.fallback() })
    // Exercise the same event dispatcher as live plugin invalidations, not a
    // manually animated spinner or a substitute test component.
    await f.page.evaluate(() => (window as any).missionFixture.refresh())
    await f.page.locator('.mission-control-header button[aria-label="Refresh mission map"] .animate-spin').waitFor()
    assert.deepEqual(await geometry(), before)
    assert.deepEqual(await buttons(), labels)
    assert.equal(await stableNode.evaluate((current, old) => current === old, node), true)
    assert.equal(await f.page.locator(".mission-panel-paging p:not([role=status])").count(), 0)
    assert.equal(await f.page.getByText(/^Activity and requests cover|^Read in this traversal/).count(), 0)
    await screenshot("missions-during-refresh")
    release()
    await f.page.waitForFunction(() => !(window as any).inventoryStore.reading("fixture"))
    assert.deepEqual(await geometry(), before)
    assert.deepEqual(await actions(), actionLabels)
    // Re-observation follows the displayed directory, without a separate user control.
    if (index === 0) {
      assert.equal(await f.page.evaluate(async () => (await import("/src/stores/missions.ts")).missionStore.progress("fixture", "marks").more), true)
      assert.equal(await f.page.locator('.mission-panel-paging[data-lane="marks"]').count(), 0)
      assert.equal(await f.page.locator('.mission-list-paging button').count(), 0)
    }
    await screenshot("missions-after-refresh")
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { release?.(); await f.close() }
})

test("a schedule-only background read uses the same top-right indicator after panel reads settle", async () => {
  const f = await open()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await f.page.waitForFunction(() => !(window as any).inventoryStore.reading("fixture"))
    await f.page.route("**/missions/scheduled?**", async route => { await gate; return route.fallback() })
    await f.page.evaluate(() => (window as any).missionFixture.refresh())
    const spinner = f.page.locator('.mission-control-header button[aria-label="Refresh mission map"] .animate-spin')
    await spinner.waitFor()
    await f.page.waitForFunction(() => !(window as any).inventoryStore.reading("fixture"))
    assert.equal(await spinner.isVisible(), true)
    release()
    await spinner.waitFor({ state: "detached" })
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { release?.(); await f.close() }
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
