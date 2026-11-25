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
import { missionPanelPage } from "../../../server/src/missions/mission-panel-page"
import { projectMissionPanel } from "../../../server/src/missions/mission-panel-projection"
import { readMissionContent } from "../../../server/src/missions/mission-content"
import { contentDigest } from "../../../server/src/missions/content-digest"
import { activityActorWindow, missionActivityContext } from "../../../server/src/missions/mission-activity-context"
import { recurrenceCurrentPageInput } from "../../../server/src/missions/recurrence-current"
import type { MissionJsonValue, MissionMap } from "../../../server/src/missions/model"
import type { RecurrenceSchedule } from "../../src/stores/mission-recurrence"
import { inlineMissionEntry, missionRow, missionRows, missionToolbar, missionToolbarAction } from "./mission-actions"
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

async function openPanel(options: {
  includeActiveMission?: boolean
  includeActiveSchedule?: boolean
  emptyOneTime?: boolean
  withPassages?: boolean
  initialMissionView?: Record<string, unknown>
  holdSummaries?: () => Promise<void>
  holdHeader?: () => Promise<void>
  holdSchedules?: () => Promise<void>
  holdRecurrence?: () => Promise<void>
  holdSessionGet?: (url: string) => Promise<void>
  extraMissions?: (seed: (missionID: string, value: Record<string, unknown>) => void) => void
  activeSessions?: Record<string, { status: string }>
  forms?: Array<{ id: string; sessionID: string; title: string; fields: Array<{ id: string; type: string; label: string }> }>
  extraSessions?: Array<[string, Record<string, unknown>]>
  omitSessions?: string[]
  secondDailySchedule?: boolean
} = {}) {
  const f = missionPluginFixture(), journal = new MissionJournal(f.storage, FIXTURE_PROJECT.id, FIXTURE_PROJECT.canonical), location = FIXTURE_PROJECT.location
  const seed = (missionID: string, value: Record<string, unknown>) => {
    const event = parseMissionEvent({ version: 1, projectID: FIXTURE_PROJECT.id, missionID, ...value }); assert.ok(event)
    f.values.set(`codenomad-missions/v2/${journal.projectToken}/${missionID}/${event.id}`, event as never)
  }
  if (!options.emptyOneTime) {
    // Completed older one-time mission with a task (updatedAt = 2_000).
    seed("msn_done", { id: "evt_create", type: "mission.created", projectCanonical: "/repo", objective: "Old completed mission", title: "Old completed mission",
      template: "custom", coordinator: { sessionID: "ses_done", title: "Coordinator", location }, createdAt: 1_000 })
    seed("msn_done", { id: "evt_task", type: "task.created", task: { id: "tsk_done", key: "done-task", title: "Done task", brief: "Brief", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 1_500 })
    seed("msn_done", { id: "evt_finish", type: "mission.finished", outcome: "completed", summary: "Finished", createdAt: 2_000 })
  }

  if (options.includeActiveMission) {
    seed("msn_active", { id: "evt_create", type: "mission.created", projectCanonical: "/repo", objective: "Active one-time mission", title: "Active one-time mission",
      template: "custom", coordinator: { sessionID: "ses_active", title: "Coordinator", location }, createdAt: 3_000 })
    seed("msn_active", { id: "evt_task", type: "task.created", task: { id: "tsk_active", key: "active-task", title: "Active task", brief: "Brief", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 3_500 })
  }
  options.extraMissions?.(seed)

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
  const runningView = missionScheduleView(runningDoc, false, { state: "known", nativeStatus: "active", nextDueAt: future, wakeCount: 1, timeGeneration: runningDoc.timeGeneration, kind: "launch" }).document!
  if (options.withPassages) {
    runningView.history = [{
      id: "psg_missing_hist", missionID: "msn_missing_hist", coordinatorSessionID: "ses_missing_run",
      messageID: "msg_hist", configurationGeneration: 1, timeGeneration: 1,
      createdAt: 1_200, dueAt: 1_200, origin: { kind: "manual" }, admittedAt: 1_200,
      configurationDigest: "a".repeat(64), settledAt: 1_300, outcome: "completed",
    } as any]
  }
  const unifiedSchedules = [
    missionScheduleView(idleDoc, false, { state: "known", nativeStatus: "active", nextDueAt: future, wakeCount: 0, timeGeneration: idleDoc.timeGeneration, kind: "launch" }).document!,
    ...(options.includeActiveSchedule === false ? [] : [runningView]),
  ]

  // Legacy daily schedule with recent result (activityAt = 4_000) and far-future nextDueAt.
  const dailySchedules: RecurrenceSchedule[] = [{
    id: "rec_recent", title: "Recent daily schedule", revision: 2, activityAt: 4_000, state: "running", clock: { time: "08:00", zone: "UTC" },
    nextDueAt: future,
    pending: options.withPassages
      ? { passageID: "psg_daily_live", status: "running", trigger: "daily", missionID: "msn_daily_live", conversationID: "ses_daily_coord" }
      : null,
    controls: [], actions: ["pause", "stop", "run-now"],
    latestResult: { passageID: "psg_d1", dueAt: 3_900, settledAt: 4_000, outcome: "completed" },
    history: [{ passageID: "psg_d1", dueAt: 3_900, settledAt: 4_000, outcome: "completed" }],
  }, ...(options.secondDailySchedule ? [{
    id: "rec_second", title: "Second daily schedule", revision: 2, activityAt: 3_800, state: "running" as const, clock: { time: "09:00", zone: "UTC" },
    nextDueAt: future,
    pending: { passageID: "psg_daily_second", status: "running" as const, trigger: "daily" as const, missionID: "msn_daily_second", conversationID: "ses_daily_second" },
    controls: [], actions: ["pause", "stop", "run-now"] as RecurrenceSchedule["actions"],
    latestResult: { passageID: "psg_d2", dueAt: 3_700, settledAt: 3_800, outcome: "completed" as const },
    history: [{ passageID: "psg_d2", dueAt: 3_700, settledAt: 3_800, outcome: "completed" as const }],
  }] : [])]

  const schedCoord = runningDoc.pending!.coordinatorSessionID
  const passageMaps: Record<string, { passageID: string; owner: "daily" | "scheduled"; map: MissionMap; withForm?: boolean }> = options.withPassages ? {
    rec_recent: {
      passageID: "psg_daily_live", owner: "daily",
      map: {
        version: 1, id: "msn_daily_live", projectID: FIXTURE_PROJECT.id, projectCanonical: FIXTURE_PROJECT.canonical,
        objective: "Daily passage objective", title: "Daily passage", template: "custom", taskMode: "native",
        status: "active", runState: "running", coordinatorSessionId: "ses_daily_coord",
        revision: 2, createdAt: 4_000, updatedAt: 9_999, history: [], historyTruncated: false, frontier: [], claims: [], reports: [],
        actors: [{ sessionId: "ses_daily_coord", kind: "coordinator", managed: false, title: "Daily coordinator", roles: ["coordinator"], location, joinedAt: 4_000 }],
        tasks: [{ id: "tsk_daily_task", key: "daily-task", title: "Daily preview task", brief: "Daily passage brief", role: "specialist",
          status: "dispatching", outstandingExecution: false, blockedBy: [], actorSessionId: "ses_daily_actor", executionMode: { kind: "native", parentTaskKey: null }, createdAt: 4_000, updatedAt: 9_999 }],
      },
    },
    msn_sched_active: {
      passageID: runningDoc.pending!.id, owner: "scheduled", withForm: true,
      map: {
        version: 1, id: runningDoc.pending!.missionID, projectID: FIXTURE_PROJECT.id, projectCanonical: FIXTURE_PROJECT.canonical,
        objective: "Unified passage objective", title: "Unified passage", template: "custom", taskMode: "native",
        status: "active", runState: "running", coordinatorSessionId: schedCoord,
        revision: 2, createdAt: 4_900, updatedAt: 9_500, history: [], historyTruncated: false, frontier: [], claims: [], reports: [],
        actors: [
          { sessionId: schedCoord, kind: "coordinator", managed: false, title: "Unified coordinator", roles: ["coordinator"], location, joinedAt: 4_900 },
          { sessionId: "ses_sched_actor", kind: "specialist", managed: false, title: "Unified specialist", roles: ["specialist"], location, joinedAt: 4_900 },
          { sessionId: "ses_sched_plain", kind: "specialist", managed: false, title: "Unified plain specialist", roles: ["specialist"], location, joinedAt: 4_900 },
        ],
        tasks: [
          { id: "tsk_sched_plain", key: "sched-plain-task", title: "Unified plain task", brief: "Unified passage brief", role: "specialist",
            status: "dispatching", outstandingExecution: false, blockedBy: [], actorSessionId: "ses_sched_plain", executionMode: { kind: "native", parentTaskKey: null }, createdAt: 4_900, updatedAt: 9_500 },
          { id: "tsk_sched_task", key: "sched-task", title: "Unified preview task", brief: "Unified form task brief", role: "specialist",
            status: "dispatching", outstandingExecution: false, blockedBy: [], actorSessionId: "ses_sched_actor", executionMode: { kind: "native", parentTaskKey: null }, createdAt: 4_900, updatedAt: 9_500 },
        ],
      },
    },
  } : {}

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
      active: async () => options.activeSessions ?? {},
      inbox: { list: async () => [] },
    },
    shell: { list: async () => ({ location, data: [] }) },
    form: { list: async () => ({ location, data: options.forms ?? [] }) },
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
  const savedSnapshot = options.initialMissionView ? {
    version: 1,
    activeProject: "fixture",
    tabs: { fixture: { missions: options.initialMissionView } },
  } : null
  await page.addInitScript(`Object.assign(window,{__name:f=>f,__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:${JSON.stringify(savedSnapshot)}}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async route => {
    const request = route.request(), link = new URL(request.url()), path = link.pathname
    // A held stream: a closed one reconnects continuously, and each reconnection refreshes the panel.
    if (path === "/api/events") return new Promise<void>(() => {})
    if (path === "/api/storage/config/ui") return route.fulfill({ json: { settings: { locale: "en" } } })
    if (options.holdSessionGet && path.includes("/session/")) await options.holdSessionGet(request.url())
    if (path.endsWith("/missions/panel-page")) {
      const input = request.postDataJSON()
      panelRequests.push(input)
      if (input.source === "summaries" && options.holdSummaries) await options.holdSummaries()
      if (input.source === "mission" && input.header && options.holdHeader) await options.holdHeader()
      const response = await app.inject({ method: "POST", url: "/api/workspaces/fixture/missions/panel-page", payload: input })
      return route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
    }
    if (path.includes("/missions/") && path.endsWith("/content")) {
      const missionID = path.split("/missions/")[1].split("/")[0]
      const response = await app.inject({ method: "GET", url: `/api/workspaces/fixture/missions/${missionID}/content${link.search}` })
      return route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
    }
    if (path.endsWith("/missions/scheduled/capabilities")) {
      return route.fulfill({ json: { location, api: { available: true }, enabled: true, origin: null, activation: { available: true, targets: [] } } })
    }
    if (path.endsWith("/missions/scheduled")) {
      scheduleListCalls.push(Date.now())
      if (options.holdSchedules) await options.holdSchedules()
      return route.fulfill({ json: { version: 1, projectID: FIXTURE_PROJECT.id, schedules: unifiedSchedules } })
    }
    if (/\/missions\/recurrence\/[^/]+\/passages\/[^/]+$/.test(path)) {
      return route.fulfill({ json: { version: 1, projectID: FIXTURE_PROJECT.id, scheduleID: "rec_recent", passageID: "psg_d1",
        dueAt: 3_900, settledAt: 4_000, outcome: "completed", mission: { version: 1, id: "msn_d1", projectID: FIXTURE_PROJECT.id,
          projectCanonical: FIXTURE_PROJECT.canonical, objective: "Past daily run", title: "Past daily run", template: "custom",
          status: "completed", coordinatorSessionId: "ses_daily_coord", revision: 1, createdAt: 3_900, updatedAt: 4_000,
          actors: [], tasks: [], reports: [], frontier: [], claims: [], history: [], historyTruncated: false } } })
    }
    const passageMatch = path.match(/\/missions\/recurrence\/([^/]+)\/current(?:\/[^/]+\/page)?$/)
    if (passageMatch) {
      const scheduleID = passageMatch[1], isPage = path.endsWith("/page")
      const entry = passageMaps[scheduleID]
      if (!isPage) {
        currentPassageCalls.push(request.url())
        if (!entry) return route.fulfill({ json: { version: 1, ownerRevision: 1, projectID: FIXTURE_PROJECT.id, scheduleID, passageID: null } })
        return route.fulfill({ json: {
          version: 1, ownerRevision: 2, projectID: FIXTURE_PROJECT.id, scheduleID, passageID: entry.passageID,
          source: {
            owner: entry.owner, projectID: FIXTURE_PROJECT.id, scheduleID, passageID: entry.passageID,
            missionID: entry.map.id, digest: "a".repeat(43),
            ...(entry.owner === "scheduled" ? { configurationGeneration: runningDoc.configurationGeneration, timeGeneration: runningDoc.timeGeneration } : {}),
          },
        } })
      }
      if (entry) {
        const input = recurrenceCurrentPageInput.parse(request.postDataJSON())
        const damage = { discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
        if (input.body) {
          return route.fulfill({ json: missionPanelPage({ source: "mission", field: "body", missionID: entry.map.id, projectID: FIXTURE_PROJECT.id, revision: entry.map.revision,
            ...damage, passage: input.source, window: { offset: 0, end: 1, total: 1, order: contentDigest(JSON.stringify(input.body)) } },
          [{ available: true, ...readMissionContent(FIXTURE_PROJECT.id, input.body, entry.map) }], input.selector.cursor) })
        }
        if (input.selector.source === "activity") {
          const members = entry.withForm ? [
            { sessionId: "ses_sched_child", parentSessionId: "ses_sched_actor", actorSessionId: "ses_sched_actor", kind: "ordinary" as const },
          ] : []
          const items = entry.withForm ? [{
            kind: "form" as const, actorSessionId: "ses_sched_actor",
            request: { id: "form_sched_child", sessionID: "ses_sched_child", title: "Approve preview step", fields: [{ id: "ok", type: "text", label: "Ok" }] },
          }] : []
          const actors = entry.withForm
            ? [{ sessionId: entry.map.coordinatorSessionId, state: "running" as const }, { sessionId: "ses_sched_actor", state: "form" as const }, { sessionId: "ses_sched_plain", state: "running" as const }]
            : [{ sessionId: entry.map.coordinatorSessionId, state: "running" as const }]
          return route.fulfill({ json: missionPanelPage({ source: "activity", missionID: entry.map.id, projectID: FIXTURE_PROJECT.id, revision: entry.map.revision,
            ...damage, passage: input.source, phase: "observed", observedAt: 10 }, [{
            context: activityActorWindow(missionActivityContext(entry.map, damage), 0, 160), coverage: "observed",
            requests: { state: "observed", items },
            activity: { actors, family: { state: "observed", members } },
          }], input.selector.cursor) })
        }
        return route.fulfill({ json: projectMissionPanel(entry.map, input.selector, damage, { passage: input.source }) })
      }
    }
    if (path.endsWith("/missions/recurrence")) {
      if (options.holdRecurrence) await options.holdRecurrence()
      return route.fulfill({ json: { version: 1, projectID: FIXTURE_PROJECT.id, schedules: dailySchedules } })
    }
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.evaluate(async ([initialView, sc, projId, extraSessions, omitSessions]) => {
    ;(window as any).missionFixture.connectCatalog()
    const { updateInstance } = await import("/src/stores/instances.ts")
    updateInstance("fixture", { metadata: { project: { id: projId } } as any })
    ;(window as any).inventoryStore = (await import("/src/stores/missions.ts")).missionStore
    const { setSessions } = await import("/src/stores/session-state.ts")
    const entries: Array<[string, any]> = [
      ["ses_chat", { id: "ses_chat", parentID: null, title: "Ordinary chat", time: { created: 1, updated: 1 } } as any],
      ["ses_done", { id: "ses_done", parentID: null, title: "Done coord", time: { created: 1, updated: 1 } } as any],
      ["ses_active", { id: "ses_active", parentID: null, title: "Active coord", time: { created: 1, updated: 1 } } as any],
      ["ses_daily_coord", { id: "ses_daily_coord", parentID: null, title: "Daily coord", time: { created: 1, updated: 1 } } as any],
      ["ses_daily_actor", { id: "ses_daily_actor", parentID: "ses_daily_coord", title: "Daily actor", time: { created: 1, updated: 1 } } as any],
      ["ses_daily_second", { id: "ses_daily_second", parentID: null, title: "Second daily coord", time: { created: 1, updated: 1 } } as any],
      [sc, { id: sc, parentID: null, title: "Sched coord", time: { created: 1, updated: 1 } } as any],
      ["ses_sched_actor", { id: "ses_sched_actor", parentID: sc, title: "Sched actor", time: { created: 1, updated: 1 } } as any],
      ["ses_sched_plain", { id: "ses_sched_plain", parentID: sc, title: "Sched plain", time: { created: 1, updated: 1 } } as any],
      ["ses_sched_child", { id: "ses_sched_child", parentID: "ses_sched_actor", title: "Sched child", time: { created: 1, updated: 1 } } as any],
      ...extraSessions,
    ]
    const omitted = new Set(omitSessions.map(id => id === "__schedCoord__" ? sc : id))
    setSessions(new Map([["fixture", new Map(entries.filter(([id]) => !omitted.has(id)))]]))
    if (initialView) {
      const { updateMissionProjectView } = await import("/src/stores/mission-view-state.ts")
      updateMissionProjectView("fixture", initialView as any)
    }
  }, [options.initialMissionView ?? null, schedCoord, FIXTURE_PROJECT.id, options.extraSessions ?? [], options.omitSessions ?? []] as const)
  await page.waitForFunction(() => (window as any).missionFixture?.snapshot().status === "ready")
  if (!options.holdHeader) await page.waitForFunction(() => !(window as any).inventoryStore.reading("fixture"))
  return { page, panelRequests, scheduleListCalls, currentPassageCalls, errors, schedCoord, close: async () => { await page.context().close(); await app.close(); await plugin.dispose() } }
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
    f.panelRequests.length = 0; f.currentPassageCalls.length = 0; f.scheduleListCalls.length = 0

    // 1. Collapsed completed one-time mission: ZERO header/task/activity/schedule-list requests, NO MissionTracking.
    await (await inlineMissionEntry(f.page, "Old completed mission")).click()
    await f.page.waitForTimeout(150)
    assert.equal(f.panelRequests.filter(r => r.source === "mission" || r.source === "tasks" || r.source === "activity").length, 0,
      "selecting collapsed completed mission issues zero header/task/activity reads")
    assert.equal(f.scheduleListCalls.length, 0, "selecting a mission does not reload the schedule directory")
    assert.equal(await f.page.locator(".mission-tree").count(), 0, "collapsed completed mission mounts no task tree")
    assert.equal(await missionToolbarAction(f.page, "Summary").isEnabled(), true)
    assert.equal(await missionToolbarAction(f.page, "Open conversation").isEnabled(), true)
    assert.equal(await missionToolbarAction(f.page, "Delete selected mission…").isEnabled(), true)

    // 2. Collapsed active one-time mission: header-only read, ZERO tasks/activity/schedule-list, NO MissionTracking.
    f.panelRequests.length = 0; f.scheduleListCalls.length = 0
    await (await inlineMissionEntry(f.page, "Active one-time mission")).click()
    await f.page.waitForFunction(() => (window as any).inventoryStore.state("fixture").missions.some((m: any) => m.id === "msn_active"))
    await f.page.waitForTimeout(150)
    assert.equal(f.panelRequests.filter(r => r.source === "mission" && r.header).length, 1, "active collapsed row loads header only")
    assert.equal(f.panelRequests.filter(r => r.source === "tasks" || r.source === "activity").length, 0,
      "collapsed active mission loads zero tasks and zero activity")
    assert.equal(f.scheduleListCalls.length, 0, "selecting active mission does not reload the schedule directory")
    assert.equal(await f.page.locator(".mission-tree").count(), 0, "collapsed active mission mounts no task tree")
    assert.equal(await missionToolbarAction(f.page, "Stop mission permanently").isEnabled(), true)

    // 3. Expanding the chevron loads tasks + activity and mounts MissionTracking; collapsing unmounts it with ZERO extra header reads.
    await missionRow(f.page, "Active one-time mission").locator(".session-item-expander").click()
    await f.page.locator(".mission-tree").getByText("Active task", { exact: true }).waitFor()
    assert.ok(f.panelRequests.some(r => r.source === "tasks"), "expanding chevron loads tasks")
    assert.ok(f.panelRequests.some(r => r.source === "activity"), "expanding chevron starts activity observation")
    f.panelRequests.length = 0
    await missionRow(f.page, "Active one-time mission").locator(".session-item-expander").click()
    await f.page.locator(".mission-tree").waitFor({ state: "detached" })
    await f.page.waitForTimeout(150)
    assert.equal(f.panelRequests.filter(r => r.source === "mission" || r.source === "tasks" || r.source === "activity").length, 0,
      "collapsing selected mission revokes only detail demand without re-reading the header")

    // 4. Selecting a collapsed schedule triggers ZERO /current and ZERO schedule-list reads; expanding chevron triggers /current.
    f.currentPassageCalls.length = 0; f.scheduleListCalls.length = 0
    await (await inlineMissionEntry(f.page, "Active unified schedule")).click()
    await f.page.waitForTimeout(150)
    assert.equal(f.currentPassageCalls.length, 0, "selecting collapsed schedule issues zero /current reads")
    assert.equal(f.scheduleListCalls.length, 0, "selecting a loaded schedule serves from snapshot without reloading schedule list")
    assert.equal(await missionToolbarAction(f.page, "Pause").isEnabled(), true)
    await missionRow(f.page, "Active unified schedule").locator(".session-item-expander").click()
    await f.page.waitForFunction(() => document.querySelector('.mission-row[data-mission-key="scheduled:msn_sched_active"] .session-item-expander')?.getAttribute("aria-expanded") === "true")
    await f.page.waitForTimeout(150)
    assert.ok(f.currentPassageCalls.length >= 1, "expanding schedule chevron loads /current")
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("unrelated non-mission activity events do not trigger idle refreshes or spin the refresh button", async () => {
  const f = await openPanel({ includeActiveMission: false, includeActiveSchedule: false })
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
    assert.equal(f.scheduleListCalls.length, beforeSchedules, "zero schedule refreshes for unrelated activity when no schedule has pendingPassage")
    assert.equal(await f.page.locator('.mission-control-header button[aria-label="Refresh mission map"] .animate-spin').count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("schedule previews preserve reader passage identity, open Form requests, keep task toolbar on collapse, surface missing conversation errors, and keep stable row order", async () => {
  const f = await openPanel({ includeActiveMission: true, withPassages: true })
  try {
    await (await inlineMissionEntry(f.page, "Active unified schedule")).waitFor()
    await (await inlineMissionEntry(f.page, "Recent daily schedule")).waitFor()
    const order = () => missionRows(f.page).locator(".mission-row").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-mission-key")))
    const initialOrder = await order()

    // Open the reader on a one-time mission so the reader is ALREADY open.
    await (await inlineMissionEntry(f.page, "Old completed mission")).click()
    await missionToolbarAction(f.page, "Summary").click()
    await f.page.locator(".mission-reader").waitFor()

    // 1a. Expand unselected daily preview and select its task with the reader open.
    await missionRow(f.page, "Recent daily schedule").locator(".session-item-expander").click()
    const dailyTask = f.page.locator('.mission-tree .mission-tree-node[data-task-key="daily-task"] .mission-tree-task')
    await dailyTask.waitFor()
    await dailyTask.click()
    await f.page.locator(".mission-reader .window-title").getByText("Daily preview task", { exact: true }).waitFor()
    const dailyTarget = await f.page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).missionProjectView("fixture").reader)
    assert.equal(dailyTarget?.recurrence?.scheduleID, "rec_recent")
    assert.equal(dailyTarget?.recurrence?.passageID, "psg_daily_live")
    assert.equal(dailyTarget?.recurrence?.owner, undefined)
    assert.deepEqual(await order(), initialOrder, "selecting/expanding daily schedule with newer live passage updatedAt does not reorder rows")

    // 1c (H). With the daily passage task reader open, selecting a task from an expanded one-time mission preview is explicitly passage-free.
    await missionRow(f.page, "Active one-time mission").locator(".session-item-expander").click()
    const oneTimeTask = f.page.locator('.mission-tree .mission-tree-node[data-task-key="active-task"] .mission-tree-task')
    await oneTimeTask.waitFor()
    await oneTimeTask.click()
    await f.page.locator(".mission-reader .window-title").getByText("Active task", { exact: true }).waitFor()
    const oneTimeTarget = await f.page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).missionProjectView("fixture").reader)
    assert.equal(oneTimeTarget?.missionId, "msn_active")
    assert.equal(oneTimeTarget?.recurrence, undefined, "selecting a one-time task never inherits the previous daily passage")

    // 1b. Expand unselected unified preview and select its ordinary task while the reader is STILL open.
    await missionRow(f.page, "Active unified schedule").locator(".session-item-expander").click()
    const schedTask = f.page.locator('.mission-tree .mission-tree-node[data-task-key="sched-plain-task"] .mission-tree-task')
    await schedTask.waitFor()
    await schedTask.click()
    await f.page.locator(".mission-reader .window-title").getByText("Unified plain task", { exact: true }).waitFor()
    const schedTarget = await f.page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).missionProjectView("fixture").reader)
    assert.equal(schedTarget?.recurrence?.scheduleID, "msn_sched_active")
    assert.equal(schedTarget?.recurrence?.owner, "scheduled")
    assert.deepEqual(await order(), initialOrder, "selecting/expanding unified schedule does not reorder rows")

    // 3 (F). Passive passage update must NOT remount the selected task toolbar DOM; collapsing keeps it mounted.
    const openTaskBtn = missionToolbar(f.page).getByRole("button", { name: "Open the task's conversation", exact: true })
    await openTaskBtn.and(f.page.locator(":enabled")).waitFor()
    await openTaskBtn.evaluate(node => { (node as any).__stableToolbarNode = true })
    const beforeCurrent = f.currentPassageCalls.length
    await f.page.evaluate(async () => {
      const { serverEvents } = await import("/src/lib/server-events.ts")
      serverEvents.dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: { type: "rpc.codenomad.missions.changed" } } as any])
    })
    for (const deadline = Date.now() + 5_000; f.currentPassageCalls.length <= beforeCurrent && Date.now() < deadline;) await f.page.waitForTimeout(25)
    await f.page.waitForTimeout(150)
    assert.equal(await openTaskBtn.evaluate(node => Boolean((node as any).__stableToolbarNode)), true,
      "passive passage update does not remount the selected task toolbar")
    await missionRow(f.page, "Active unified schedule").locator(".session-item-expander").click()
    await schedTask.waitFor({ state: "detached" })
    assert.equal(await openTaskBtn.count(), 1, "collapsing a schedule with a selected task keeps the task toolbar mounted")
    assert.equal(await openTaskBtn.isEnabled(), true, "task conversation button remains enabled after collapse")

    // 2a. Clicking a red task awaiting a Form in an UNSELECTED schedule preview opens the asking child.
    await (await inlineMissionEntry(f.page, "Old completed mission")).click()
    await missionRow(f.page, "Active unified schedule").locator(".session-item-expander").click()
    const previewTask = f.page.locator('.mission-schedule-preview .mission-tree .mission-tree-node[data-task-key="sched-task"] .mission-tree-task')
    await previewTask.waitFor()
    await f.page.locator('.mission-schedule-preview .mission-tree .mission-tree-node[data-task-key="sched-task"][data-state="input"]').waitFor()
    await previewTask.click()
    await f.page.waitForFunction(() => (window as any).missionFixture.selectedSession() === "ses_sched_child")
    assert.equal(await f.page.locator(".mission-control-stale[role='alert']").count(), 0)

    // 2b. Missing hydrated session from a unified schedule's past run (in preview) surfaces navigation error, not silent no-op.
    await (await inlineMissionEntry(f.page, "Old completed mission")).click()
    const pastRunOpen = f.page.locator(".mission-schedule-preview .mission-past-runs button").first()
    await pastRunOpen.waitFor()
    await pastRunOpen.click()
    await f.page.locator(".mission-control-stale[role='alert']").waitFor()
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("expanded native schedule passage skips /current re-read on unrelated activity and refreshes on passage descendant activity", async () => {
  const f = await openPanel({ includeActiveMission: false, withPassages: true })
  try {
    await (await inlineMissionEntry(f.page, "Active unified schedule")).waitFor()
    f.currentPassageCalls.length = 0
    await missionRow(f.page, "Active unified schedule").locator(".session-item-expander").click()
    await f.page.locator('.mission-tree .mission-tree-node[data-task-key="sched-task"]').waitFor()
    await f.page.waitForTimeout(150)
    const before = f.currentPassageCalls.length
    assert.equal(before, 1, "expanding unified schedule reads /current once")

    // Emit unrelated root session activity: expanded native passage must NOT re-read /current.
    await f.page.evaluate(async () => {
      const { serverEvents } = await import("/src/lib/server-events.ts")
      serverEvents.dispatchBatch([
        { type: "instance.event", instanceId: "fixture", event: { type: "session.execution.started", data: { sessionID: "ses_chat" } } } as any,
      ])
    })
    await f.page.waitForTimeout(ACTIVITY_REFRESH_INTERVAL_MS + 1_000)
    assert.equal(f.currentPassageCalls.length, before, "expanded native passage skips /current re-read for unrelated root activity")

    // Emit descendant activity of the passage coordinator: MUST refresh /current.
    await f.page.evaluate(async () => {
      const { serverEvents } = await import("/src/lib/server-events.ts")
      serverEvents.dispatchBatch([
        { type: "instance.event", instanceId: "fixture", event: { type: "session.execution.started", data: { sessionID: "ses_sched_child" } } } as any,
      ])
    })
    for (const deadline = Date.now() + ACTIVITY_REFRESH_INTERVAL_MS + 2_000; f.currentPassageCalls.length <= before && Date.now() < deadline;) {
      await f.page.waitForTimeout(50)
    }
    assert.ok(f.currentPassageCalls.length > before, "passage descendant activity refreshes /current")
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("schedule-only project keeps refresh button unspun and enabled during passive refreshes, spinning on manual click until ALL reads settle", async () => {
  let holdNext = false, started!: () => void, release!: () => void
  const arm = () => {
    holdNext = true
    const reached = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    return { reached, release: () => { holdNext = false; release() }, gate }
  }
  let activeGate: Promise<void> | undefined
  let holdSched = false, schedStarted!: () => void, releaseSched!: () => void
  let schedGate: Promise<void> | undefined
  let holdRec = false, recStarted!: () => void, releaseRec!: () => void
  let recGate: Promise<void> | undefined
  const f = await openPanel({
    emptyOneTime: true,
    holdSummaries: async () => {
      if (!holdNext) return
      holdNext = false
      started()
      await activeGate
    },
    holdSchedules: async () => {
      if (!holdSched) return
      holdSched = false
      schedStarted()
      await schedGate
    },
    holdRecurrence: async () => {
      if (!holdRec) return
      holdRec = false
      recStarted()
      await recGate
    },
  })
  try {
    await (await inlineMissionEntry(f.page, "Active unified schedule")).waitFor()
    const refreshBtn = f.page.locator('.mission-control-header button[aria-label="Refresh mission map"]')
    assert.equal(await refreshBtn.isDisabled(), false)
    assert.equal(await refreshBtn.locator(".animate-spin").count(), 0)

    // Trigger a passive journal refresh on the schedule-only project (rows().length === 0).
    const passive = arm()
    activeGate = passive.gate
    await f.page.evaluate(() => (window as any).missionFixture.refresh())
    await passive.reached
    await f.page.waitForTimeout(100)
    assert.equal(await refreshBtn.locator(".animate-spin").count(), 0, "passive refresh on schedule-only project does not spin")
    assert.equal(await refreshBtn.isDisabled(), false, "refresh button stays enabled during passive refresh")
    passive.release()
    await f.page.waitForFunction(() => (window as any).missionFixture.snapshot().status === "ready")

    // Clicking refresh manually spins and disables until journal, schedule AND recurrence reads all settle.
    const manual = arm()
    activeGate = manual.gate
    holdSched = true
    const schedReached = new Promise<void>(resolve => { schedStarted = resolve })
    schedGate = new Promise<void>(resolve => { releaseSched = resolve })
    holdRec = true
    const recReached = new Promise<void>(resolve => { recStarted = resolve })
    recGate = new Promise<void>(resolve => { releaseRec = resolve })
    await refreshBtn.click()
    await Promise.all([manual.reached, schedReached, recReached])
    assert.equal(await refreshBtn.locator(".animate-spin").count(), 1, "manual refresh spins the button")
    assert.equal(await refreshBtn.isDisabled(), true, "manual refresh disables the button while running")
    // Release journal first: spinner must STAY active while schedule and recurrence reads are still in flight.
    manual.release()
    await f.page.waitForTimeout(120)
    assert.equal(await refreshBtn.locator(".animate-spin").count(), 1, "spinner stays active while schedule and recurrence reads finish")
    assert.equal(await refreshBtn.isDisabled(), true)
    releaseSched()
    await f.page.waitForTimeout(120)
    assert.equal(await refreshBtn.locator(".animate-spin").count(), 1, "spinner stays active while recurrence read finishes")
    releaseRec()
    await f.page.waitForFunction(() => !(document.querySelector('.mission-control-header button[aria-label="Refresh mission map"]') as HTMLButtonElement)?.disabled)
    assert.equal(await refreshBtn.locator(".animate-spin").count(), 0)
    assert.deepEqual(f.errors, [])
  } finally {
    release?.(); releaseSched?.(); releaseRec?.()
    await f.close()
  }
})

test("restored selectedTask on a collapsed completed mission waits for the real header instead of clearing", async () => {
  let headerStarted!: () => void, releaseHeader!: () => void
  const headerReached = new Promise<void>(resolve => { headerStarted = resolve })
  const headerGate = new Promise<void>(resolve => { releaseHeader = resolve })
  const f = await openPanel({
    initialMissionView: { selected: "msn_done", selectedTask: { missionId: "msn_done", taskId: "tsk_done" } },
    holdHeader: async () => { headerStarted(); await headerGate },
  })
  try {
    await headerReached
    await f.page.waitForTimeout(100)
    const duringLoad = await f.page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).missionProjectView("fixture").selectedTask)
    assert.deepEqual(duringLoad, { missionId: "msn_done", taskId: "tsk_done" }, "restored selectedTask on collapsed completed mission is not cleared before real header loads")
    releaseHeader()
    await f.page.waitForFunction(() => !(window as any).inventoryStore.reading("fixture"))
    await f.page.waitForTimeout(100)
    const afterLoad = await f.page.evaluate(async () => (await import("/src/stores/mission-view-state.ts")).missionProjectView("fixture").selectedTask)
    assert.deepEqual(afterLoad, { missionId: "msn_done", taskId: "tsk_done" }, "restored selectedTask survives real header reconciliation")
    assert.equal(await missionToolbar(f.page).locator(".mission-overview-toggle").isEnabled(), true)
    assert.deepEqual(f.errors, [])
  } finally {
    releaseHeader?.()
    await f.close()
  }
})

test("collapsed >10-actor missions keep bounded activity observation for toolbar Recover and Interrupt now without loading task pages (A)", async () => {
  const location = FIXTURE_PROJECT.location
  const seedMany = (seed: (missionID: string, value: Record<string, unknown>) => void, missionID: string, title: string, baseAt: number, gracefulPause: boolean) => {
    seed(missionID, { id: "evt_create", type: "mission.created", projectCanonical: "/repo", objective: title, title,
      template: "custom", coordinator: { sessionID: `ses_${missionID}_coord`, title: "Coordinator", location }, createdAt: baseAt })
    for (let i = 1; i <= 10; i++) {
      seed(missionID, { id: `evt_task_${i}`, type: "task.created", task: { id: `tsk_${missionID}_${i}`, key: `t-${i}`, title: `Task ${i}`,
        brief: "Brief", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: baseAt + i * 2 })
      seed(missionID, { id: `evt_bound_${i}`, type: "task.native-bound", taskKey: `t-${i}`,
        binding: { generation: 1, parentSessionID: `ses_${missionID}_coord`, parentMessageID: `msg_${i}`, toolCallID: `call_${i}` },
        actor: { sessionID: `ses_${missionID}_a${i}`, title: `Actor ${i}`, managed: true, location }, createdAt: baseAt + i * 2 + 1 })
    }
    if (gracefulPause) {
      seed(missionID, { id: "evt_pause", type: "mission.control-requested", requestID: "req_gpause", expectedRevision: 21,
        action: "pause", graceful: true, targets: [], createdAt: baseAt + 30 })
    }
  }
  const f = await openPanel({
    includeActiveMission: false,
    extraMissions: seed => {
      seedMany(seed, "msn_recover_11", "Idle coordinator 11 actors", 6_000, false)
      seedMany(seed, "msn_pause_11", "Gracefully paused 11 actors", 7_000, true)
    },
    // Actor #10 (the 11th actor, beyond MISSION_MARK_ACTORS = 10) is running on msn_pause_11.
    activeSessions: { ses_msn_pause_11_a10: { status: "running" } },
  })
  try {
    await (await inlineMissionEntry(f.page, "Idle coordinator 11 actors")).waitFor()
    await (await inlineMissionEntry(f.page, "Gracefully paused 11 actors")).waitFor()

    // Scenario A1: collapsed running mission with 11 actors and idle-without-report coordinator shows Recover instead of Pause.
    f.panelRequests.length = 0
    await (await inlineMissionEntry(f.page, "Idle coordinator 11 actors")).click()
    await missionToolbarAction(f.page, "Recover interrupted mission").and(f.page.locator(":enabled")).waitFor()
    assert.equal(f.panelRequests.some(r => r.source === "activity" && r.missionID === "msn_recover_11"), true, "reads bounded activity for >10-actor selected mission")
    assert.equal(f.panelRequests.some(r => r.source === "tasks"), false, "collapsed mission loads zero task pages")
    assert.equal(await f.page.locator(".mission-tree").count(), 0)

    // Scenario A2: collapsed gracefully paused mission whose only running actor is actor #11 offers Interrupt now.
    f.panelRequests.length = 0
    await (await inlineMissionEntry(f.page, "Gracefully paused 11 actors")).click()
    await f.page.waitForFunction(() => (window as any).inventoryStore.observations("fixture", "msn_pause_11").length > 0)
    await missionToolbarAction(f.page, "More actions").click()
    await f.page.getByRole("menuitem", { name: "Interrupt now", exact: true }).waitFor()
    assert.equal(await f.page.getByRole("menuitem", { name: "Interrupt now", exact: true }).isEnabled(), true,
      "Interrupt now is enabled when the only running actor is beyond directory marks")
    assert.equal(f.panelRequests.some(r => r.source === "tasks"), false, "collapsed gracefully paused mission loads zero task pages")
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("passage demand stays owned by its exact schedule and reader target, never leaking to another collapsed schedule (G)", async () => {
  let hydrateReached!: () => void, releaseHydrate!: () => void
  const hydrateStarted = new Promise<void>(resolve => { hydrateReached = resolve })
  const hydrateGate = new Promise<void>(resolve => { releaseHydrate = resolve })
  const f = await openPanel({
    includeActiveMission: false,
    withPassages: true,
    secondDailySchedule: true,
    omitSessions: ["__schedCoord__"],
    holdSessionGet: async url => {
      if (url.includes("/session/")) {
        hydrateReached()
        await hydrateGate
      }
    },
  })
  try {
    await (await inlineMissionEntry(f.page, "Active unified schedule")).waitFor()
    await (await inlineMissionEntry(f.page, "Recent daily schedule")).waitFor()
    await (await inlineMissionEntry(f.page, "Second daily schedule")).waitFor()

    // Scenario G2: select collapsed "Second daily schedule", expand "Recent daily schedule" preview and open one of its archived past runs.
    // Opening an unrelated archived reader must NOT make collapsed "Second daily schedule" read its /current.
    f.currentPassageCalls.length = 0
    await (await inlineMissionEntry(f.page, "Second daily schedule")).click()
    await f.page.waitForTimeout(100)
    assert.equal(f.currentPassageCalls.filter(u => u.includes("rec_second")).length, 0)
    await missionRow(f.page, "Recent daily schedule").locator(".session-item-expander").click()
    const pastRun = f.page.locator(".mission-schedule-preview .mission-past-run").first()
    await pastRun.waitFor()
    await pastRun.click()
    await f.page.locator(".mission-reader").waitFor()
    await f.page.waitForTimeout(150)
    assert.equal(f.currentPassageCalls.filter(u => u.includes("rec_second")).length, 0,
      "opening another schedule's archived run never triggers /current on an unrelated collapsed selected schedule")

    // Close the reader by toggling the past run button off before Scenario G1.
    await pastRun.click()
    await f.page.locator(".mission-reader").waitFor({ state: "detached" })
    // Collapse Recent daily schedule preview.
    await missionRow(f.page, "Recent daily schedule").locator(".session-item-expander").click()

    // Scenario G1: mark Active unified schedule red via permission on its coordinator, click it so openingPassage holds during session hydration,
    // then immediately select collapsed Second daily schedule: Second daily schedule must NOT read /current.
    await f.page.evaluate(sc => (window as any).missionFixture.queuePermission(sc, "perm_sched_g1"), f.schedCoord)
    await f.page.locator('.mission-row[data-mission-key="scheduled:msn_sched_active"] .mission-row-mark[data-mark="permission"]').waitFor()
    f.currentPassageCalls.length = 0
    await (await inlineMissionEntry(f.page, "Active unified schedule")).click()
    await hydrateStarted
    await (await inlineMissionEntry(f.page, "Second daily schedule")).click()
    await f.page.waitForTimeout(150)
    assert.equal(f.currentPassageCalls.filter(u => u.includes("rec_second")).length, 0,
      "selecting schedule B while schedule A's question navigation is in flight never loads B's /current")
    assert.deepEqual(f.errors, [])
  } finally {
    releaseHydrate?.()
    await f.close()
  }
})

test("clicking a red task in an unselected >10-actor one-time preview opens the asking actor beyond directory marks on the FIRST click (I)", async () => {
  const location = FIXTURE_PROJECT.location
  const f = await openPanel({
    includeActiveMission: false,
    extraMissions: seed => {
      seed("msn_preview_11", { id: "evt_create", type: "mission.created", projectCanonical: "/repo", objective: "Preview 11 actors", title: "Preview 11 actors",
        template: "custom", coordinator: { sessionID: "ses_p11_coord", title: "Coordinator", location }, createdAt: 6_000 })
      for (let i = 1; i <= 10; i++) {
        seed("msn_preview_11", { id: `evt_task_${i}`, type: "task.created", task: { id: `tsk_p11_${i}`, key: `p11-${i}`, title: `Preview task ${i}`,
          brief: "Brief", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 6_000 + i * 2 })
        seed("msn_preview_11", { id: `evt_bound_${i}`, type: "task.native-bound", taskKey: `p11-${i}`,
          binding: { generation: 1, parentSessionID: "ses_p11_coord", parentMessageID: `msg_p11_${i}`, toolCallID: `call_p11_${i}` },
          actor: { sessionID: `ses_p11_a${i}`, title: `Actor ${i}`, managed: true, location }, createdAt: 6_000 + i * 2 + 1 })
      }
    },
    forms: [{ id: "form_p11_10", sessionID: "ses_p11_a10", title: "Approve 11th actor", fields: [{ id: "ok", type: "text", label: "Ok" }] }],
    extraSessions: [
      ["ses_p11_coord", { id: "ses_p11_coord", parentID: null, title: "P11 coord", time: { created: 1, updated: 1 } }],
      ["ses_p11_a10", { id: "ses_p11_a10", parentID: "ses_p11_coord", title: "P11 actor 10", time: { created: 1, updated: 1 } }],
    ],
  })
  try {
    // Select another row so "Preview 11 actors" is UNSELECTED.
    await (await inlineMissionEntry(f.page, "Old completed mission")).click()
    await missionRow(f.page, "Preview 11 actors").locator(".session-item-expander").click()
    const redTask = f.page.locator('.mission-tree .mission-tree-node[data-task-key="p11-10"][data-state="input"] .mission-tree-task')
    await redTask.waitFor()
    await redTask.click()
    await f.page.waitForFunction(() => (window as any).missionFixture.selectedSession() === "ses_p11_a10")
    assert.equal(await f.page.locator(".mission-control-stale[role='alert']").count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
