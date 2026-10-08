import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { reduceMissionEvents, type MissionMap } from "../../missions/model"
import { stableToken } from "../../missions/journal"
import { currentRecurrenceContent } from "../../missions/recurrence-current"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionRoutes } from "./missions"

async function fixture() {
  const fence = new WorktreeDeletionFence(), location = { directory: "/repo" }
  const projectID = "project", scheduleID = "schedule", passageID = "rcp_current"
  const missionID = `msn_${stableToken(`${projectID}\0${passageID}`, 24)}`
  const coordinatorID = `ses_${stableToken(`${missionID}\0coordinator`, 26)}`
  const mission: MissionMap = JSON.parse(JSON.stringify(reduceMissionEvents([{ version: 1, type: "mission.created", id: "created",
    missionID, projectID, projectCanonical: location.directory, objective: "Inspect current work", template: "custom",
    coordinator: { sessionID: coordinatorID, title: "Coordinator", location }, createdAt: 1 }], 1).missions[0]))
  const root = { id: coordinatorID, projectID, location }, child = { ...root, id: "ses_child", parentID: coordinatorID }
  const state = { workspace: { id: "workspace" }, owned: true, connected: true, available: true, plugin: true,
    unknown: false, foreignChild: false, invalidate: false, advance: false, nullPassage: false,
    foreignProject: false, foreignSchedule: false, contentOverflow: false, contentChanged: false }
  const calls: Array<{ method: string; input: unknown }> = []
  const envelope = () => ({ version: 1, projectID: state.foreignProject ? "foreign" : projectID, projectCanonical: location.directory,
    location, scheduleID: state.foreignSchedule ? "foreign" : scheduleID, passageID: state.nullPassage ? null : passageID,
    ...(state.nullPassage ? {} : { mission }) })
  const client = {
    location: { get: async () => ({ project: { id: projectID, canonical: location.directory } }) },
    plugin: { list: async () => ({ data: state.plugin ? [{ id: "codenomad.missions", state: { status: "active" } }] : [] }) },
    rpc: () => ({ recurrenceCurrent: async (input: unknown) => {
      calls.push({ method: "current", input })
      if (state.invalidate) await fence.run(location.directory, [location.directory], async () => {})
      return envelope()
    }, recurrenceCurrentContent: async (input: Parameters<typeof currentRecurrenceContent>[1]) => {
      calls.push({ method: "content", input })
      const page = currentRecurrenceContent(mission, input)
      if (page.passageID !== passageID) throw new Error("Wrong current passage")
      return { ...page, projectCanonical: location.directory, location,
        ...(state.contentOverflow ? { sourceText: "x".repeat(9_002) } : {}), ...(state.contentChanged ? { page: 1 } : {}) }
    } }),
    session: { get: async ({ sessionID }: { sessionID: string }) => {
      if (state.unknown) throw new Error("Unknown native observation")
      return sessionID === coordinatorID ? root : { ...child, ...(state.foreignChild ? { location: { directory: "/foreign" } } : {}) }
    }, list: async (input: { parentID?: string }) => {
      assert(input.parentID, "No global session scan")
      return { data: input.parentID === coordinatorID ? [child] : [], cursor: { next: null } }
    }, inbox: { list: async () => [] }, active: async () => { if (state.advance) state.nullPassage = true; return {} } },
    shell: { list: async () => ({ location, data: [] }) }, form: { list: async () => ({ location, data: [] }) },
    permission: { request: { list: async () => ({ location, data: [] }) } },
  }
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: {
    get: () => state.workspace, getServiceLocation: () => location,
    ownsLocation: async (_id: string, target: typeof location) => state.owned && target.directory === location.directory,
    getSharedServiceConnection: async () => state.available ? { client, assertCurrent() { if (!state.connected) throw new Error("Connection replaced") } } : undefined,
  } as never, worktreeDeletionFence: fence })
  const url = `/api/workspaces/workspace/missions/recurrence/${scheduleID}/current`
  return { app, state, calls, url, passageID, coordinatorID, missionID, mission }
}

test("current recurrence route exposes real bounded native ancestry and exact-reader pages without mutations", async () => {
  const f = await fixture()
  try {
    const response = await f.app.inject({ method: "GET", url: f.url })
    assert.equal(response.statusCode, 200)
    const result = response.json()
    assert.equal(result.mission.id, f.missionID)
    assert.deepEqual(result.activity.missions[0].family, { state: "observed", members: [
      { sessionId: f.coordinatorID, actorSessionId: f.coordinatorID, kind: "declared" },
      { sessionId: "ses_child", parentSessionId: f.coordinatorID, actorSessionId: f.coordinatorID, kind: "ordinary" },
    ] })
    assert.deepEqual(f.calls, [{ method: "current", input: { scheduleID: "schedule" } }, { method: "current", input: { scheduleID: "schedule" } }])
    assert.equal(result.projectCanonical, undefined)
    assert.equal(result.location, undefined)
    const page = await f.app.inject({ method: "GET", url: `${f.url}/${f.passageID}/content?kind=overview&section=objective&page=0&revision=1` })
    assert.equal(page.statusCode, 200)
    assert.equal(page.json().sourceText, "Inspect current work")
    assert.equal(page.json().projectCanonical, undefined)
    assert.equal(page.json().location, undefined)
    assert.equal((await f.app.inject({ method: "GET", url: `${f.url}/rcp_former/content?kind=overview&section=objective` })).statusCode, 503)
    for (const query of ["sessionID=ses_arbitrary", "missionID=msn_arbitrary", "directory=/foreign"]) {
      const count: number = f.calls.length
      assert.equal((await f.app.inject({ method: "GET", url: `${f.url}?${query}` })).statusCode, 400)
      assert.equal((await f.app.inject({ method: "GET", url: `${f.url}/${f.passageID}/content?${query}` })).statusCode, 400)
      assert.equal(f.calls.length, count)
    }
    f.state.unknown = true
    const unknown = await f.app.inject({ method: "GET", url: f.url })
    assert.equal(unknown.statusCode, 200)
    assert.deepEqual(unknown.json().activity.missions[0].family, { state: "unknown", members: [] })
    assert.equal(unknown.json().activity.missions[0].actors[0].state, "unknown")
    f.state.nullPassage = true
    assert.deepEqual((await f.app.inject({ method: "GET", url: f.url })).json(), { version: 1, projectID: "project", scheduleID: "schedule", passageID: null })
  } finally { await f.app.close() }
})

for (const kind of ["available", "connected", "plugin", "owned", "foreignProject", "foreignSchedule", "invalidate", "advance"] as const) {
  test(`current recurrence route fences ${kind}`, async () => {
    const f = await fixture()
    try {
      f.state[kind] = !["available", "connected", "plugin", "owned"].includes(kind)
      const result = await f.app.inject({ method: "GET", url: f.url })
      assert.equal(result.statusCode, kind === "owned" ? 403 : 503)
      assert.equal(result.json().mission, undefined)
    } finally { await f.app.close() }
  })
}

for (const kind of ["contentOverflow", "contentChanged"] as const) {
  test(`current recurrence content rejects ${kind}`, async () => {
    const f = await fixture()
    try {
      f.state[kind] = true
      assert.equal((await f.app.inject({ method: "GET", url: `${f.url}/${f.passageID}/content?kind=overview&section=objective` })).statusCode, 503)
    } finally { await f.app.close() }
  })
}

test("semantic content targets keep exact reports/history separate from current task results", async () => {
  const f = await fixture()
  try {
    const report = { id: "report_current", taskKey: "task_key", sessionId: "ses_child", outcome: "completed" as const,
      summary: "Current exact result", evidence: ["one", "two"], next: ["next"], artifact: { result: true }, createdAt: 3 }
    const historical = { ...report, id: "report_old", summary: "Historical exact result", createdAt: 2 }
    f.mission.tasks.push({ id: "task_id", key: "task_key", title: "Task", brief: "Exact brief", role: "specialist", status: "completed",
      blockedBy: [], createdAt: 1, updatedAt: 3, outstandingExecution: false, report })
    f.mission.reports.push(historical, report)
    f.mission.history.push({ revision: 2, reason: "Exact reason", objective: { before: "old", after: "new" },
      addedTaskKeys: [], retiredTasks: [], dependencyUpdates: [], createdAt: 2 })
    const read = (kind: string, itemId: string, section: string) => f.app.inject({ method: "GET",
      url: `${f.url}/${f.passageID}/content?kind=${kind}&itemId=${itemId}&section=${section}` })
    assert.equal((await read("task", "task_id", "brief")).json().sourceText, "Exact brief")
    assert.equal((await read("task", "task_id", "summary")).json().sourceText, report.summary)
    assert.equal((await read("report", "report_old", "summary")).json().sourceText, historical.summary)
    assert.equal((await read("report", "report_current", "evidence")).json().sourceText, "one\n\ntwo")
    assert.deepEqual(JSON.parse((await read("report", "report_current", "artifact")).json().sourceText), report.artifact)
    assert.equal((await read("change", "2", "summary")).json().sourceText, "Exact reason")
    assert.deepEqual(JSON.parse((await read("change", "2", "objective")).json().sourceText), { before: "old", after: "new" })
    f.mission.tasks[0].replacedByTaskKey = "replacement"
    assert.equal((await read("task", "task_id", "summary")).statusCode, 503, "historical result cannot become current")
    assert.equal((await read("report", "report_current", "summary")).statusCode, 200, "historical source remains readable")
    assert.equal((await read("task", "missing", "brief")).statusCode, 503)
    const count: number = f.calls.length
    assert.equal((await f.app.inject({ method: "GET", url: `${f.url}/${f.passageID}/content?kind=task&section=brief` })).statusCode, 400)
    assert.equal(f.calls.length, count)
    f.mission.objective = "x".repeat(8_999) + "😀" + "tail"
    const pages = [0, 1].map(page => currentRecurrenceContent(f.mission, { scheduleID: "schedule", passageID: f.passageID,
      kind: "overview", section: "objective", page }).sourceText)
    assert.equal(pages.join(""), f.mission.objective, "paging preserves a boundary surrogate pair without overlap")
  } finally { await f.app.close() }
})
