import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import Fastify from "fastify"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { missionPluginFixture, FIXTURE_PROJECT } from "../../../server/src/missions/mission-plugin-fixture"
import { MissionJournal, parseMissionEvent } from "../../../server/src/missions/journal"
import { registerMissionRoutes } from "../../../server/src/server/routes/missions"
import { WorktreeDeletionFence } from "../../../server/src/workspaces/worktree-session-evacuation"
import { NativeMissionDocumentStore } from "../../../server/src/missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../../server/src/missions/mission-document-state"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import type { MissionJsonValue } from "../../../server/src/missions/model"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { inlineMissionEntry, missionRow, missionRows, missionToolbarAction } from "./mission-actions"
import { ACTIVITY_REFRESH_INTERVAL_MS } from "../../src/lib/event-refresh-scheduler"

let browser: Browser, url: string
before(async () => {
  url = (await borrowFixture({ name: "mission-panel-ux", routes: [{ path: "/panel-ux",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })).url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const profiles = {
  coordinator: { agent: "coordinator", model: { providerID: "p", id: "m" } },
  roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } },
}

async function openPanel(options: { includeActiveMission?: boolean } = {}) {
  const f = missionPluginFixture(), journal = new MissionJournal(f.storage, FIXTURE_PROJECT.id, FIXTURE_PROJECT.canonical), location = FIXTURE_PROJECT.location
  const seed = (missionID: string, value: Record<string, unknown>) => {
    const event = parseMissionEvent({ version: 1, projectID: FIXTURE_PROJECT.id, missionID, ...value }); assert.ok(event)
    f.values.set(`codenomad-missions/v2/${journal.projectToken}/${missionID}/${event.id}`, event as never)
  }
  // Completed older one-time mission with a task (updatedAt = 2_000).
  seed("msn_done", { id: "evt_create", type: "mission.created", projectCanonical: "/repo", objective: "Old completed mission", title: "Old completed mission",
    template: "custom", coordinator: { sessionID: "ses_done", title: "Coordinator", location }, createdAt: 1_000 })
  seed("msn_done", { id: "evt_task", type: "task.created", task: { id: "tsk_done", key: "done-task", title: "Done task", brief: "Brief", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 1_500 })
  seed("msn_done", { id: "evt_finish", type: "mission.finished", outcome: "completed", summary: "Finished", createdAt: 2_000 })

  if (options.includeActiveMission) {
    seed("msn_active", { id: "evt_create", type: "mission.created", projectCanonical: "/repo", objective: "Active one-time mission", title: "Active one-time mission",
      template: "custom", coordinator: { sessionID: "ses_active", title: "Coordinator", location }, createdAt: 3_000 })
    seed("msn_active", { id: "evt_task", type: "task.created", task: { id: "tsk_active", key: "active-task", title: "Active task", brief: "Brief", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 3_500 })
  }

  // Unified schedules: one idle with a far-future nextDueAt (activityAt = 500), one with an active pendingPassage (activityAt = 5_000).
  const docValues = new Map<string, MissionJsonValue>()
  const docStore = new NativeMissionDocumentStore({
    get: async key => docValues.get(key),
    compareAndSet: async (key, value) => { docValues.set(key, structuredClone(value)) },
  }, FIXTURE_PROJECT.id, location.directory)
  const baseConfig = {
    objective: "Scheduled check", template: "custom" as const, profiles, taskMode: "native" as const,
    profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only" as const, directory: location.directory }],
    watchedConversationIDs: [], launch: { timing: { kind: "every" as const, intervalMs: 900_000 }, condition: null, ends: { maxLaunches: null, at: null, afterMs: null } },
  }
  const idleDoc = await docStore.create("msn_sched_idle", { ...baseConfig, title: "Idle future schedule" }, 500, () => true)
  const activeDoc = await docStore.create("msn_sched_active", { ...baseConfig, title: "Active unified schedule" }, 1_000, () => true)
  const runningDoc = await docStore.change(activeDoc.id, activeDoc.revision, () => true, doc => {
    changes.play(doc, "req_play", 4_800, [])
    doc.synchronization = null
    changes.reserve(doc, { kind: "manual", requestID: "req_active" }, 4_900, [])
    changes.admitted(doc, doc.pending!.id, 5_000)
  })
  const future = Date.now() + 86_400_000
  const unifiedSchedules = [
    missionScheduleView(idleDoc, false, { state: "known", nativeStatus: "active", nextDueAt: future, wakeCount: 0, timeGeneration: idleDoc.timeGeneration, kind: "launch" }).document!,
    missionScheduleView(runningDoc, false, { state: "known", nativeStatus: "active", nextDueAt: future, wakeCount: 1, timeGeneration: runningDoc.timeGeneration, kind: "launch" }).document!,
  ]

  // Legacy daily schedule with recent result (activityAt = 4_000) and far-future nextDueAt.
  const dailySchedules: RecurrenceSchedule[] = [{
    id: "rec_recent", title: "Recent daily schedule", revision: 2, state: "running", clock: { time: "08:00", zone: "UTC" },
    nextDueAt: future, pending: null, controls: [], actions: ["pause", "stop", "run-now"],
    latestResult: { passageID: "psg_d1", dueAt: 3_900, settledAt: 4_000, outcome: "completed" },
    history: [{ passageID: "psg_d1", dueAt: 3_900, settledAt: 4_000, outcome: "completed" }],
  }]

  const panelRequests: any[] = [], scheduleListCalls: number[] = [], currentPassageCalls: string[] = [], errors: string[] = []
  const control = f.control()
  const plugin = { rpc: (_method: string, input: unknown) => control.panelPage(input as any), dispose: async () => {} }
  const client = {
    location: { get: async () => ({ ...location, project: { id: FIXTURE_PROJECT.id } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ panelPage: async (input: unknown) => plugin.rpc("panelPage", input), content: (input: any) => control.content(input) }),
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: FIXTURE_PROJECT.id, location }),
      list: async () => ({ data: [], cursor: { next: null } }),
      active: async () => ({}),
      inbox: { list: async () => [] },
    },
    shell: { list: async () => ({ location, data: [] }) },
    form: { list: async () => ({ location, data: [] }) },
    permission: { request: { list: async () => ({ location, data: [] }) } },
  }
  const app = Fastify({ logger: false })
  const workspace = { id: "fixture" }
  registerMissionRoutes(app, {
    worktreeDeletionFence: new WorktreeDeletionFence(),
    workspaceManager: {
      get: () => workspace,
      getServiceLocation: () => location,
      ownsLocation: async () => true,
      getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
      getSharedServiceConnection: async () => ({ client, assertCurrent() {} }),
    } as never,
  })

  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 900 } })
  page.setDefaultTimeout(15_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript("Object.assign(window,{__name:f=>f,__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})")
  await page.route("**/api/**", async route => {
    const request = route.request(), link = new URL(request.url()), path = link.pathname
    // A held stream: a closed one reconnects continuously, and each reconnection refreshes the panel.
    if (path === "/api/events") return new Promise<void>(() => {})
    if (path === "/api/storage/config/ui") return route.fulfill({ json: { settings: { locale: "en" } } })
    if (path.endsWith("/missions/panel-page")) {
      const input = request.postDataJSON()
      panelRequests.push(input)
      const response = await app.inject({ method: "POST", url: "/api/workspaces/fixture/missions/panel-page", payload: input })
      return route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
    }
    if (path.endsWith("/missions/scheduled/capabilities")) {
      return route.fulfill({ json: { location, api: { available: true }, enabled: true, origin: null, activation: { available: true, targets: [] } } })
    }
    if (path.endsWith("/missions/scheduled")) {
      scheduleListCalls.push(Date.now())
      return route.fulfill({ json: { version: 1, projectID: FIXTURE_PROJECT.id, schedules: unifiedSchedules } })
    }
    if (/\/missions\/recurrence\/[^/]+\/current$/.test(path)) {
      currentPassageCalls.push(request.url())
      const scheduleID = path.match(/\/missions\/recurrence\/([^/]+)\/current$/)![1]
      return route.fulfill({ json: { version: 1, ownerRevision: 1, projectID: FIXTURE_PROJECT.id, scheduleID, passageID: null } })
    }
    if (path.endsWith("/missions/recurrence")) {
      return route.fulfill({ json: { version: 1, projectID: FIXTURE_PROJECT.id, schedules: dailySchedules } })
    }
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.evaluate(() => (window as any).missionFixture.connectCatalog())
  await page.waitForFunction(() => (window as any).missionFixture?.snapshot().status === "ready")
  await page.evaluate(async () => {
    ;(window as any).inventoryStore = (await import("/src/stores/missions.ts")).missionStore
    const { setSessions } = await import("/src/stores/session-state.ts")
    setSessions(new Map([["fixture", new Map([
      ["ses_chat", { id: "ses_chat", parentID: null, title: "Ordinary chat", time: { created: 1, updated: 1 } } as any],
      ["ses_done", { id: "ses_done", parentID: null, title: "Done coord", time: { created: 1, updated: 1 } } as any],
      ["ses_active", { id: "ses_active", parentID: null, title: "Active coord", time: { created: 1, updated: 1 } } as any],
    ])]]))
  })
  await page.waitForFunction(() => !(window as any).inventoryStore.reading("fixture"))
  return { page, panelRequests, scheduleListCalls, currentPassageCalls, errors, close: async () => { await page.context().close(); await app.close(); await plugin.dispose() } }
}

test("unified sorting orders all mission kinds by real recent activity descending, ignoring future nextDueAt", async () => {
  const f = await openPanel({ includeActiveMission: true })
  try {
    await (await inlineMissionEntry(f.page, "Active unified schedule")).waitFor()
    await (await inlineMissionEntry(f.page, "Recent daily schedule")).waitFor()
    const keys = await missionRows(f.page).locator(".mission-row").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-mission-key")))
    assert.deepEqual(keys, [
      "scheduled:msn_sched_active", // activityAt = 5_000 (active pendingPassage)
      "schedule:rec_recent",        // activityAt = 4_000 (recent completed daily run)
      "mission:msn_active",         // updatedAt = 3_500
      "mission:msn_done",           // updatedAt = 2_000
      "scheduled:msn_sched_idle",   // activityAt = 500 (future nextDueAt ignored)
    ])
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("selecting collapsed rows skips task/activity/passage reads until chevron expansion, while toolbar actions stay available", async () => {
  const f = await openPanel({ includeActiveMission: true })
  try {
    await (await inlineMissionEntry(f.page, "Old completed mission")).waitFor()
    f.panelRequests.length = 0; f.currentPassageCalls.length = 0

    // 1. Collapsed completed one-time mission: ZERO header/task/activity requests, NO MissionTracking.
    await (await inlineMissionEntry(f.page, "Old completed mission")).click()
    await f.page.waitForTimeout(150)
    assert.equal(f.panelRequests.filter(r => r.source === "mission" || r.source === "tasks" || r.source === "activity").length, 0,
      "selecting collapsed completed mission issues zero header/task/activity reads")
    assert.equal(await f.page.locator(".mission-tree").count(), 0, "collapsed completed mission mounts no task tree")
    assert.equal(await missionToolbarAction(f.page, "Summary").isEnabled(), true)
    assert.equal(await missionToolbarAction(f.page, "Open conversation").isEnabled(), true)
    assert.equal(await missionToolbarAction(f.page, "Delete selected mission…").isEnabled(), true)

    // 2. Collapsed active one-time mission: header-only read, ZERO tasks/activity, NO MissionTracking.
    f.panelRequests.length = 0
    await (await inlineMissionEntry(f.page, "Active one-time mission")).click()
    await f.page.waitForFunction(() => (window as any).inventoryStore.state("fixture").missions.some((m: any) => m.id === "msn_active"))
    await f.page.waitForTimeout(150)
    assert.equal(f.panelRequests.filter(r => r.source === "mission" && r.header).length, 1, "active collapsed row loads header only")
    assert.equal(f.panelRequests.filter(r => r.source === "tasks" || r.source === "activity").length, 0,
      "collapsed active mission loads zero tasks and zero activity")
    assert.equal(await f.page.locator(".mission-tree").count(), 0, "collapsed active mission mounts no task tree")
    assert.equal(await missionToolbarAction(f.page, "Stop mission permanently").isEnabled(), true)

    // 3. Expanding the chevron loads tasks + activity and mounts MissionTracking; collapsing unmounts it.
    await missionRow(f.page, "Active one-time mission").locator(".session-item-expander").click()
    await f.page.locator(".mission-tree").getByText("Active task", { exact: true }).waitFor()
    assert.ok(f.panelRequests.some(r => r.source === "tasks"), "expanding chevron loads tasks")
    assert.ok(f.panelRequests.some(r => r.source === "activity"), "expanding chevron starts activity observation")
    await missionRow(f.page, "Active one-time mission").locator(".session-item-expander").click()
    await f.page.locator(".mission-tree").waitFor({ state: "detached" })

    // 4. Selecting a collapsed schedule triggers ZERO /current reads; expanding chevron triggers /current.
    f.currentPassageCalls.length = 0
    await (await inlineMissionEntry(f.page, "Active unified schedule")).click()
    await f.page.waitForTimeout(150)
    assert.equal(f.currentPassageCalls.length, 0, "selecting collapsed schedule issues zero /current reads")
    assert.equal(await missionToolbarAction(f.page, "Pause").isEnabled(), true)
    await missionRow(f.page, "Active unified schedule").locator(".session-item-expander").click()
    await f.page.waitForFunction(() => document.querySelector('.mission-row[data-mission-key="scheduled:msn_sched_active"] .session-item-expander')?.getAttribute("aria-expanded") === "true")
    await f.page.waitForTimeout(150)
    assert.ok(f.currentPassageCalls.length >= 1, "expanding schedule chevron loads /current")
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("unrelated non-mission activity events do not trigger idle refreshes or spin the refresh button", async () => {
  const f = await openPanel({ includeActiveMission: false })
  try {
    await (await inlineMissionEntry(f.page, "Old completed mission")).waitFor()
    await f.page.waitForTimeout(200)
    const beforePanel = f.panelRequests.length, beforeSchedules = f.scheduleListCalls.length
    await f.page.evaluate(async () => {
      const { serverEvents } = await import("/src/lib/server-events.ts")
      serverEvents.dispatchBatch([
        { type: "instance.event", instanceId: "fixture", event: { type: "session.execution.started", data: { sessionID: "ses_chat" } } } as any,
        { type: "instance.event", instanceId: "fixture", event: { type: "session.execution.succeeded", data: { sessionID: "ses_chat" } } } as any,
      ])
    })
    // An activity refresh is due only ACTIVITY_REFRESH_INTERVAL_MS after the previous one settled.
    await f.page.waitForTimeout(ACTIVITY_REFRESH_INTERVAL_MS + 1_000)
    assert.equal(f.panelRequests.length, beforePanel, "zero panel refreshes for unrelated activity when no active mission exists")
    assert.equal(f.scheduleListCalls.length, beforeSchedules, "zero schedule refreshes for unrelated activity on native schedules")
    assert.equal(await f.page.locator('.mission-control-header button[aria-label="Refresh mission map"] .animate-spin').count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
