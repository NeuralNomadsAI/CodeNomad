import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { registerMissionRoutes } from "./missions"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { stableToken } from "../../missions/journal"
import { fixture } from "../../missions/journal-history-fixture"
import { describeMissionBodies } from "../../missions/mission-body-descriptors"
import { compactMissionMap } from "../../missions/mission-compact-map"
import { FIXTURE_PROJECT, missionPluginFixture } from "../../missions/mission-plugin-fixture"
import { missionTaskOrder } from "../../missions/mission-task-order"
import { MISSION_PANEL_PAGE_BYTES, missionPanelPage } from "../../missions/mission-panel-page"

const snapshot = {
  version: 1 as const,
  projectID: "project-1",
  generatedAt: 1,
  missions: [],
  discardedEvents: 0,
}

const listed = { ...snapshot, cleanups: [], summaries: [], summariesVersion: "version-1" }

function manager(options: {
  workspace?: boolean
  directory?: string
  plugin?: "active" | "failed" | "missing"
  projectID?: string
  rpcError?: unknown
  /** A plugin build registered before `list` and `mission`. */
  legacy?: boolean
  /** What the `mission` RPC answers. */
  missionRead?: object
  panelRead?: object
} = {}) {
  const calls: Array<{ method: string; value: unknown }> = []
  const plugin = options.plugin ?? "active"
  const workspace = { id: "workspace-1" }
  let fakeClient: unknown
  const value = {
      get: (id: string) => options.workspace === false || id !== "workspace-1" ? undefined : workspace,
      getSharedServiceConnection: async () => ({ client: await value.getSharedServiceClient(), assertCurrent() {} }),
      getServiceLocation: (id: string) => id === "workspace-1" ? { directory: options.directory ?? "/owned/repo" } : undefined,
      ownsLocation: async () => true,
      getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
      getSharedServiceClient: async () => fakeClient ??= ({
        location: { get: async (input: unknown) => {
          calls.push({ method: "location", value: input })
          return { directory: "/owned/repo", project: { id: options.projectID ?? "project-1" } }
        } },
        plugin: {
          list: async (input: unknown) => {
            calls.push({ method: "list", value: input })
            return {
              location: { directory: "/owned/repo" },
              data: plugin === "missing" ? [] : [{
                id: "codenomad.missions",
                features: { server: true },
                state: plugin === "active" ? { status: "active" } : { status: "failed", error: "broken" },
              }],
            }
          },
        },
        session: { active: async () => { calls.push({ method: "active", value: undefined }); return {} } },
        shell: { list: async () => ({ location: { directory: "/owned/repo" }, data: [] }) },
        form: { list: async () => ({ location: { directory: "/owned/repo" }, data: [] }) },
        permission: { request: { list: async () => ({ location: { directory: "/owned/repo" }, data: [] }) } },
        rpc: (definition: { id: string }) => {
          calls.push({ method: "rpc-definition", value: definition.id })
          const missing = { type: "rpc.method_not_found", message: "Unknown RPC method" }
          return {
            panelPage: async (input: unknown, callOptions: unknown) => {
              calls.push({ method: "panel-page", value: { input, callOptions } })
              if (options.legacy) throw missing
              if (options.rpcError) throw options.rpcError
              return options.panelRead
            },
            snapshot: async (input: unknown, callOptions: unknown) => {
              calls.push({ method: "snapshot", value: { input, callOptions } })
              if (options.rpcError) throw options.rpcError
              return snapshot
            },
            list: async (input: unknown, callOptions: unknown) => {
              calls.push({ method: "list-rpc", value: { input, callOptions } })
              if (options.legacy) throw missing
              if (options.rpcError) throw options.rpcError
              return listed
            },
            mission: async (input: { missionID: string }, callOptions: unknown) => {
              calls.push({ method: "mission-rpc", value: { input, callOptions } })
              if (options.legacy) throw missing
              if (options.rpcError) throw options.rpcError
              return options.missionRead ?? { version: 1, projectID: "project-1", generatedAt: 2, cleanups: [] }
            },
          }
        },
      }),
  }
  return { calls, value: value as never }
}

test("opt-in panel pages fit the actual HTTP wire and fail bounded without legacy snapshot/list fallback", async () => {
  const panel = missionPanelPage({ source: "summaries", projectID: "project-1" }, [{ actors: Array(3_000).fill("\u0000😀€\\\"") }])
  for (const options of [{ panelRead: panel }, { legacy: true }, { panelRead: { ...panel, projectID: "foreign" } },
    { panelRead: { ...panel, unexpected: "x".repeat(MISSION_PANEL_PAGE_BYTES) } }, { rpcError: new Error("bad".repeat(100_000)) }]) {
    const f = manager(options), app = Fastify({ logger: false })
    registerMissionRoutes(app, { workspaceManager: f.value })
    try {
      const reply = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions/panel-page", payload: { source: "summaries" } })
      assert.ok(reply.rawPayload.length <= MISSION_PANEL_PAGE_BYTES, `${reply.rawPayload.length} bytes`)
      assert.deepEqual(reply.json(), options.panelRead === panel ? panel : { available: false, reason: options.rpcError ? "workspace-unavailable" : "plugin-unavailable", missions: [] })
      assert.equal(f.calls.filter(call => ["snapshot", "list-rpc", "mission-rpc", "active"].includes(call.method)).length, 0)
      const before = f.calls.length
      const bad = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions/panel-page", payload: { source: "summaries", field: "actors" } })
      assert.deepEqual([bad.statusCode, bad.json()], [400, { available: false, reason: "invalid-request" }])
      const oversized = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions/panel-page", payload: { source: "summaries", junk: "x".repeat(20_000) } })
      assert.equal(oversized.statusCode, 413)
      assert.ok(oversized.rawPayload.length < 1_024)
      assert.equal(f.calls.length, before, "invalid selectors never reach the plugin")
    } finally { await app.close() }
  }
})

function mutationManager(options: { owns?: boolean; error?: unknown; dropProfiles?: boolean; dropTaskMode?: boolean
  pluginInactive?: boolean; noConnection?: boolean; locationError?: unknown; createError?: unknown } = {}) {
  const calls: Array<{ method: string; value: unknown }> = []
  const workspace = { id: "workspace-1" }
  const value = {
    get: (id: string) => id === "workspace-1" ? workspace : undefined,
    getServiceLocation: (id: string) => id === "workspace-1" ? { directory: "/owned/repo" } : undefined,
    ownsLocation: async (_id: string, location: { directory: string }) => {
      calls.push({ method: "owns", value: location })
      return options.owns ?? location.directory !== "/foreign"
    },
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
    getSharedServiceConnection: async () => options.noConnection ? undefined : ({ client: await value.getSharedServiceClient(), assertCurrent() {} }),
    getSharedServiceClient: async () => ({
      location: { get: async ({ location }: { location: { directory: string } }) => {
        if (options.locationError) throw options.locationError
        return { directory: location.directory, project: { id: "project-1" } }
      } },
      session: { get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID, projectID: "project-1", location: { directory: "/owned/repo" },
      }) },
      plugin: { list: async ({ location }: { location: { directory: string } }) => ({
        data: [{ id: "codenomad.missions", state: { status: options.pluginInactive ? "failed" : "active" } }], location }) },
      rpc: (definition: { id: string }) => {
        calls.push({ method: "rpc", value: definition.id })
        return {
          create: async (input: any, rpcOptions: unknown) => {
            calls.push({ method: "create", value: { input, rpcOptions } })
            if (options.createError) throw options.createError
            const id = `msn_${stableToken(`project-1\0${input.requestID}`, 24)}`
            const sessionID = input.coordinatorSessionID ?? `ses_${stableToken(`${id}\0coordinator`, 26)}`
            return { mission: { id, projectID: "project-1", coordinatorSessionId: sessionID,
              ...(options.dropTaskMode ? {} : { taskMode: input.taskMode }),
              ...(input.profiles === undefined || options.dropProfiles ? {} : { profiles: structuredClone(input.profiles) }),
              actors: [{ sessionId: sessionID, kind: "coordinator", location: input.expectedCoordinatorLocation }] } }
          },
          lifecycle: async (input: unknown, rpcOptions: unknown) => {
            calls.push({ method: "lifecycle", value: { input, rpcOptions } })
            if (options.error) throw options.error
            return { mission: { id: "msn_1" } }
          },
          update: async (input: unknown, rpcOptions: unknown) => {
            calls.push({ method: "update", value: { input, rpcOptions } })
            if (options.error) throw options.error
            return { mission: { id: "msn_1" } }
          },
          delete: async (input: unknown, rpcOptions: unknown) => {
            calls.push({ method: "delete", value: { input, rpcOptions } })
            if (options.error) throw options.error
            return { deleted: true }
          },
          recover: async (input: unknown, rpcOptions: unknown) => {
            calls.push({ method: "recover", value: { input, rpcOptions } })
            if (options.error) throw options.error
            return { mission: { id: "msn_1" }, admitted: true }
          },
          snapshot: async () => snapshot,
        }
      },
    }) as never,
  }
  return { calls, value: value as never }
}

test("brokers only the reviewed mission list RPC at the owned workspace location", async () => {
  const fake = manager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value, worktreeDeletionFence: new WorktreeDeletionFence() })

  const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.available, true)
  assert.deepEqual({ ...body, activity: undefined }, { available: true, ...listed, activity: undefined })
  assert.equal(typeof body.activity.generatedAt, "number")
  assert.deepEqual(body.activity.missions, [])
  assert.deepEqual(fake.calls, [
    { method: "location", value: { location: { directory: "/owned/repo" } } },
    { method: "list", value: { location: { directory: "/owned/repo" } } },
    { method: "rpc-definition", value: "codenomad.missions" },
    { method: "list-rpc", value: { input: {}, callOptions: { location: { directory: "/owned/repo" } } } },
    { method: "active", value: undefined },
  ])
  await app.close()
})

test("passes the panel's includes and summary version through, bounded and deduplicated", async () => {
  const fake = manager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value })
  const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions?include=msn_a,msn_b,msn_a&summaries=version-0" })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(fake.calls.find(call => call.method === "list-rpc")?.value,
    { input: { include: ["msn_a", "msn_b"], summariesVersion: "version-0" }, callOptions: { location: { directory: "/owned/repo" } } })
  for (const url of ["?include=a,b,c,d,e", `?include=${"x".repeat(101)}`, `?summaries=${"v".repeat(65)}`]) {
    const refused = await app.inject({ method: "GET", url: `/api/workspaces/workspace-1/missions${url}` })
    assert.equal(refused.statusCode, 400, url)
  }
  await app.close()
})

test("a plugin without the list RPC is unavailable: its snapshot, every full map, is never read in its place", async () => {
  const fake = manager({ legacy: true })
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value })
  const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions?include=msn_a&summaries=version-0" })
  assert.deepEqual(response.json(), { available: false, reason: "plugin-unavailable", missions: [] })
  assert.deepEqual(fake.calls.filter(call => call.method.endsWith("-rpc") || call.method === "snapshot").map(call => call.method), ["list-rpc"])
  // Any other RPC failure stays a failure: no fallback read hides it.
  const failing = manager({ rpcError: { type: "rpc.internal", message: "boom" } })
  const other = Fastify({ logger: false })
  registerMissionRoutes(other, { workspaceManager: failing.value })
  assert.deepEqual((await other.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })).json(),
    { available: false, reason: "plugin-unavailable", missions: [] })
  assert.equal(failing.calls.some(call => call.method === "snapshot"), false)
  await app.close(); await other.close()
})

test("the admission read brokers only the full snapshot RPC", async () => {
  const fake = manager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value })
  const map = { id: "msn_a", projectID: "project-1", controlUnavailable: true }
  Object.assign(snapshot, { missions: [map], controlUnavailable: true })
  try {
    const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions/msn_a/admission" })
    assert.deepEqual(response.json(), { available: true, version: 1, projectID: "project-1", generatedAt: 1, mission: map, cleanups: [], controlUnavailable: true })
    assert.deepEqual(fake.calls.filter(call => call.method.endsWith("-rpc") || call.method === "snapshot").map(call => call.method), ["snapshot"])
  } finally { Object.assign(snapshot, { missions: [] }); delete (snapshot as { controlUnavailable?: boolean }).controlUnavailable; await app.close() }
  const foreign = manager({ projectID: "project-2" })
  const other = Fastify({ logger: false })
  registerMissionRoutes(other, { workspaceManager: foreign.value })
  assert.equal((await other.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions/msn_a/admission" })).statusCode, 502)
  await other.close()
})

test("damage written outside the index generation refuses admission while the display read misses it", async () => {
  const f = fixture(8), control = f.control()
  const { mission } = await control.create({ requestID: "admission", objective: "Admission gate", template: "custom" })
  await control.list()
  f.tamper(`${f.prefix}/stray`, {})
  const client = {
    location: { get: async () => ({ directory: "/repo", project: { id: "project-1" } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ mission: (input: { missionID: string }) => control.mission(input.missionID), snapshot: () => control.snapshot() }),
  }
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: { get: () => ({ id: "workspace-1" }), getServiceLocation: () => ({ directory: "/repo" }),
    getSharedServiceConnection: async () => ({ client, assertCurrent() {} }) } as never })
  try {
    const display = (await app.inject({ method: "GET", url: `/api/workspaces/workspace-1/missions/${mission.id}` })).json()
    const admission = (await app.inject({ method: "GET", url: `/api/workspaces/workspace-1/missions/${mission.id}/admission` })).json()
    assert.deepEqual([display.controlUnavailable, display.mission.controlUnavailable], [undefined, undefined], "a hint, never proof")
    assert.deepEqual([admission.controlUnavailable, admission.mission.controlUnavailable], [true, true])
    // The display map is compact; the admission map is the snapshot's, whole.
    assert.deepEqual([display.mission.objective, display.mission.excerpt, admission.mission.objective], [undefined, "Admission gate", "Admission gate"])
  } finally { await app.close() }
})

test("the single-mission read brokers the mission RPC, falling back to the snapshot of an older plugin", async () => {
  const fake = manager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value })
  const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions/msn_a" })
  assert.deepEqual(response.json(), { available: true, version: 1, projectID: "project-1", generatedAt: 2, cleanups: [] })
  assert.deepEqual(fake.calls.find(call => call.method === "mission-rpc")?.value,
    { input: { missionID: "msn_a" }, callOptions: { location: { directory: "/owned/repo" } } })
  assert.equal(fake.calls.some(call => call.method === "snapshot" || call.method === "active"), false, "no full read, no activity")
  // Fastify refuses an over-long parameter (404) before the schema would (400).
  assert.ok([400, 404].includes((await app.inject({ method: "GET", url: `/api/workspaces/workspace-1/missions/${"x".repeat(101)}` })).statusCode))
  assert.equal(fake.calls.filter(call => call.method === "mission-rpc").length, 1)

  const legacy = manager({ legacy: true })
  const old = Fastify({ logger: false })
  registerMissionRoutes(old, { workspaceManager: legacy.value })
  const cleanup = { missionID: "msn_a", deletionID: "evt_a", requestID: "request", expectedRevision: 2, deleteManagedSessions: false,
    objective: "A", removed: 0, retained: 0, pending: 0, reasons: [], createdAt: 3 }
  ;(snapshot as { cleanups?: unknown[] }).cleanups = [cleanup, { ...cleanup, missionID: "msn_b", deletionID: "evt_b" }]
  try {
    assert.deepEqual((await old.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions/msn_a" })).json(),
      { available: true, version: 1, projectID: "project-1", generatedAt: 1, cleanups: [cleanup] })
  } finally { delete (snapshot as { cleanups?: unknown }).cleanups }
  const foreign = manager({ projectID: "project-2" })
  const other = Fastify({ logger: false })
  registerMissionRoutes(other, { workspaceManager: foreign.value })
  const refused = await other.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions/msn_a" })
  assert.equal(refused.statusCode, 502)
  await app.close(); await old.close(); await other.close()
})

test("an older plugin's full maps reach the panel compact, described when they carry no descriptors; admission stays full", async () => {
  const f = fixture(9), control = f.control()
  const created = (await control.create({ requestID: "older", objective: "Older objective", notes: "Older notes", template: "custom" })).mission
  await control.update({ missionID: created.id, requestID: "edit", expectedRevision: created.revision, objective: "Edited objective", notes: "Edited notes" })
  // Without actors, the list projects no activity.
  const full = { ...(await control.snapshot()).missions[0], actors: [] }
  const compact = JSON.parse(JSON.stringify(compactMissionMap(full)))
  assert.deepEqual([compact.objective, compact.notes, compact.excerpt, Object.keys(compact.bodies).sort()], [undefined, undefined, "Edited objective", ["notes", "objective"]])
  const paths = { list: "/api/workspaces/workspace-1/missions", read: `/api/workspaces/workspace-1/missions/${full.id}`,
    admission: `/api/workspaces/workspace-1/missions/${full.id}/admission` }
  // A plugin from before body descriptors, and one that sends them on full maps.
  for (const sent of [full, describeMissionBodies(full)]) {
    const fake = manager({ missionRead: { version: 1, projectID: "project-1", generatedAt: 2, mission: sent, cleanups: [] } })
    const app = Fastify({ logger: false })
    registerMissionRoutes(app, { workspaceManager: fake.value })
    Object.assign(listed, { missions: [sent] }); Object.assign(snapshot, { missions: [sent] })
    try {
      assert.deepEqual((await app.inject({ method: "GET", url: paths.list })).json().missions, [compact])
      assert.deepEqual((await app.inject({ method: "GET", url: paths.read })).json().mission, compact)
      assert.deepEqual((await app.inject({ method: "GET", url: paths.admission })).json().mission, JSON.parse(JSON.stringify(sent)), "the snapshot's map, as sent")
    } finally { Object.assign(listed, { missions: [] }); Object.assign(snapshot, { missions: [] }); await app.close() }
  }
  // A plugin without `mission` answers from its snapshot: that one map, compact.
  const legacy = manager({ legacy: true })
  const old = Fastify({ logger: false })
  registerMissionRoutes(old, { workspaceManager: legacy.value })
  Object.assign(snapshot, { missions: [full] })
  try { assert.deepEqual((await old.inject({ method: "GET", url: paths.read })).json().mission, compact) }
  finally { Object.assign(snapshot, { missions: [] }); await old.close() }
})

test("the task route brokers the tasks RPC, and pages an older plugin's single-mission read itself", async () => {
  const f = missionPluginFixture(), control = () => f.control()
  let mission = (await control().create({ requestID: "pages", objective: "Pages", template: "custom" })).mission
  for (let round = 0; round < 3; round++) mission = (await control().revise(mission.coordinatorSessionId, { missionID: mission.id, expectedRevision: mission.revision,
    requestID: `round-${round}`, reason: "More", retireTasks: [], dependencyUpdates: [], addTasks: Array.from({ length: 24 }, (_, index) => ({ taskKey: `task-${round}-${index}`,
      title: `Task ${round}.${index}`, brief: "Brief", role: "specialist", blockedBy: round ? [`task-${round - 1}-${index}`] : [] })) })).mission
  const full = (await control().snapshot()).missions[0], order = (await control().mission(mission.id)).mission!.taskPage!.order
  const keys = missionTaskOrder(full.tasks).map(task => task.key)
  const missing = { type: "rpc.method_not_found", message: "Unknown RPC method" }
  const route = async (legacy: boolean) => {
    const client = {
      location: { get: async () => ({ directory: "/repo", project: { id: FIXTURE_PROJECT.id } }) },
      plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      rpc: () => ({
        tasks: async (input: never) => { if (legacy) throw missing; return control().tasks(input) },
        // An older plugin's single read: its full map with descriptors.
        mission: async (input: { missionID: string }) => legacy ? { ...(await control().mission(input.missionID)), mission: describeMissionBodies(full) }
          : control().mission(input.missionID),
      }),
    }
    const app = Fastify({ logger: false })
    registerMissionRoutes(app, { workspaceManager: { get: () => ({ id: "workspace-1" }), getServiceLocation: () => ({ directory: "/repo" }),
      getSharedServiceConnection: async () => ({ client, assertCurrent() {} }) } as never })
    return app
  }
  const url = (query: string) => `/api/workspaces/workspace-1/missions/${mission.id}/tasks?${query}`
  for (const legacy of [false, true]) {
    const app = await route(legacy)
    try {
      const page = (await app.inject({ method: "GET", url: url(`order=${order}&offset=50`) })).json()
      assert.deepEqual([page.available, page.taskPage.offset, page.taskPage.end, page.tasks.map((task: { key: string }) => task.key)],
        [true, 50, 72, keys.slice(50)], `legacy ${legacy}`)
      const named = (await app.inject({ method: "GET", url: url(`order=${order}&keys=task-0-0,task-2-23`) })).json()
      assert.deepEqual(named.tasks.map((task: { key: string }) => task.key), ["task-0-0", "task-2-23"])
      assert.equal((await app.inject({ method: "GET", url: url("order=other&offset=0") })).json().refused, "order-changed")
      const attention = (await app.inject({ method: "GET", url: url(`order=${order}&attention=0`) })).json()
      assert.deepEqual([attention.tasks, attention.taskPage.attention], [[], { counts: { notifications: 0, blocked: 0, failed: 0, recovery: 0 }, omitted: 0,
        sequence: page.taskPage.attention.sequence, offset: 0, end: 0 }])
      const names = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(",")
      for (const query of ["offset=0&keys=task-0-0", "offset=0&attention=0", "order=x", `keys=${names("k", 51)}`, `keys=${names("k", 30)}&ids=${names("i", 21)}`, "offset=-1"]) {
        assert.equal((await app.inject({ method: "GET", url: url(query) })).statusCode, 400, query)
      }
    } finally { await app.close() }
  }
})

test("does not accept a client-controlled directory or expose generic RPC", async () => {
  const fake = manager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value })

  await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions?directory=/foreign" })
  assert.equal(JSON.stringify(fake.calls).includes("foreign"), false)
  const arbitrary = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions/rpc", payload: { method: "other" } })
  assert.equal(arbitrary.statusCode, 404)
  await app.close()
})

test("returns an optional capability response for missing, failed, or unreachable plugins", async () => {
  for (const [options, reason] of [
    [{ plugin: "missing" as const }, "plugin-unavailable"],
    [{ plugin: "failed" as const }, "plugin-failed"],
    [{ rpcError: { type: "rpc.not_found", message: "missing" } }, "plugin-unavailable"],
  ] as const) {
    const fake = manager(options)
    const app = Fastify({ logger: false })
    registerMissionRoutes(app, { workspaceManager: fake.value })
    const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { available: false, reason, missions: [] })
    await app.close()
  }
})

test("a backend without its local bridge reports that it hosts no Missions before reading OpenCode", async () => {
  const fake = manager()
  const app = Fastify({ logger: false })
  let published = false
  registerMissionRoutes(app, { workspaceManager: fake.value, missionsHost: () => published })
  const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { available: false, reason: "host-unavailable", missions: [] })
  assert.deepEqual(fake.calls, [], "neither the inventory nor the plugin is read")
  // An unknown workspace stays a 404 rather than a host answer.
  assert.equal((await app.inject({ method: "GET", url: "/api/workspaces/foreign/missions" })).statusCode, 404)
  published = true
  assert.equal((await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })).json().available, true)
  await app.close()
})

test("rejects unknown workspaces before touching OpenCode", async () => {
  const fake = manager({ workspace: false })
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value })
  const response = await app.inject({ method: "GET", url: "/api/workspaces/foreign/missions" })
  assert.equal(response.statusCode, 404)
  assert.deepEqual(fake.calls, [])
  await app.close()
})

test("targeted recovery exposes only strict explicit inputs at the owned location", async () => {
  const fake = mutationManager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value, worktreeDeletionFence: new WorktreeDeletionFence() })
  const url = "/api/workspaces/workspace-1/missions/msn_1/recover"
  const payload = { expectedRevision: 3, target: "report", taskKey: "review" }
  const response = await app.inject({ method: "POST", url, payload })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { mission: { id: "msn_1" }, admitted: true })
  assert.deepEqual(fake.calls.find(call => call.method === "recover")?.value, {
    input: { missionID: "msn_1", ...payload }, rpcOptions: { location: { directory: "/owned/repo" } },
  })
  for (const invalid of [{ ...payload, directory: "/foreign" }, { ...payload, target: "replay" }, { ...payload, expectedRevision: 0 }]) {
    assert.equal((await app.inject({ method: "POST", url, payload: invalid })).statusCode, 400)
  }
  assert.equal(fake.calls.filter(call => call.method === "recover").length, 1)
  await app.close()
})

test("brokers typed mission create, update and delete only at authorized project locations", async () => {
  const fake = mutationManager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value, worktreeDeletionFence: new WorktreeDeletionFence() })
  const create = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions", payload: {
    objective: "Ship it", template: "wayfinder", coordinatorSessionId: "ses_existing", directory: "/owned/repo", requestId: "create-1",
  } })
  assert.equal(create.statusCode, 200)
  assert.deepEqual(create.json(), { mission: { id: `msn_${stableToken("project-1\0create-1", 24)}`, projectID: "project-1",
    taskMode: "native", coordinatorSessionId: "ses_existing", actors: [{ sessionId: "ses_existing", kind: "coordinator", location: { directory: "/owned/repo" } }] } })
  assert.deepEqual(fake.calls.find((call) => call.method === "create")?.value, {
    input: { prepared: true, requestID: "create-1", objective: "Ship it", template: "wayfinder", taskMode: "native", coordinatorSessionID: "ses_existing", expectedCoordinatorLocation: { directory: "/owned/repo" } },
    rpcOptions: { location: { directory: "/owned/repo" } },
  })
  const update = await app.inject({ method: "PATCH", url: "/api/workspaces/workspace-1/missions/msn_1", payload: {
    objective: "Updated", expectedRevision: 1, requestId: "update-1",
  } })
  assert.equal(update.statusCode, 200)
  const deletion = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace-1/missions/msn_1", payload: {
    expectedRevision: 2, requestId: "delete-1",
  } })
  assert.equal(deletion.statusCode, 200)
  assert.deepEqual(deletion.json(), { deleted: true })
  assert.deepEqual(fake.calls.find((call) => call.method === "delete")?.value, {
    input: { missionID: "msn_1", requestID: "delete-1", expectedRevision: 2 },
    rpcOptions: { location: { directory: "/owned/repo" } },
  })
  const callsBeforeForeign = fake.calls.length
  const foreign = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions", payload: {
    objective: "No", template: "custom", directory: "/foreign", requestId: "foreign-1",
  } })
  assert.equal(foreign.statusCode, 403)
  assert.equal(fake.calls.slice(callsBeforeForeign).some((call) => call.method === "rpc"), false)
  const invalid = await app.inject({ method: "PATCH", url: "/api/workspaces/workspace-1/missions/msn_1", payload: {
    objective: "Bad", expectedRevision: 0, requestId: "invalid-1",
  } })
  assert.equal(invalid.statusCode, 400)
  await app.close()
})

test("maps only declared native mutation codes and keeps opaque plugin failures unavailable", async () => {
  for (const [error, status] of [
    [{ type: "mission.rejected", message: "Reload", data: { code: "revision-conflict" } }, 409],
    [{ type: "mission.rejected", message: "Different request", data: { code: "request-conflict" } }, 409],
    [{ type: "mission.rejected", message: "Missing", data: { code: "mission-not-found" } }, 404],
    [{ type: "mission.rejected", message: "Foreign", data: { code: "foreign-session" } }, 403],
    [{ type: "rpc.internal", message: "revision-conflict: private failure", data: { code: "revision-conflict" } }, 503],
    [{ type: "mission.rejected", message: "private failure", data: { code: "constructor" } }, 503],
    [new Error("Mission changed; private failure"), 503],
  ] as const) {
    const app = Fastify()
    try {
      registerMissionRoutes(app, { workspaceManager: mutationManager({ error }).value, worktreeDeletionFence: new WorktreeDeletionFence() })
      const response = await app.inject({ method: "PATCH", url: "/api/workspaces/workspace-1/missions/msn_1",
        payload: { requestId: "edit", objective: "Edited", expectedRevision: 1 } })
      assert.equal(response.statusCode, status)
      if (status === 503) assert.deepEqual(response.json(), { error: "Mission plugin unavailable" })
      else assert.equal(response.json().error, error.message)
    } finally { await app.close() }
  }
})

test("forwards only an explicit boolean session-cleanup option through the typed delete RPC", async () => {
  const fake = mutationManager()
  const app = Fastify()
  registerMissionRoutes(app, { workspaceManager: fake.value, worktreeDeletionFence: new WorktreeDeletionFence() })
  try {
    for (const option of [true, false]) {
      const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace-1/missions/msn_1",
        payload: { requestId: "delete-1", expectedRevision: 2, deleteManagedSessions: option } })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(fake.calls.filter((call) => call.method === "delete").at(-1)?.value, {
        input: { missionID: "msn_1", requestID: "delete-1", expectedRevision: 2, deleteManagedSessions: option },
        rpcOptions: { location: { directory: "/owned/repo" } },
      })
    }
    const before = fake.calls.length
    for (const option of ["true", 1, null, {}]) {
      const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace-1/missions/msn_1",
        payload: { requestId: "delete-1", expectedRevision: 2, deleteManagedSessions: option } })
      assert.equal(response.statusCode, 400)
    }
    assert.equal(fake.calls.length, before)
  } finally { await app.close() }
})

test("explicit lifecycle routes validate controls and preserve retry identity at the owned location", async () => {
  const app = Fastify()
  const fixture = mutationManager()
  registerMissionRoutes(app, { workspaceManager: fixture.value as never, worktreeDeletionFence: new WorktreeDeletionFence() })
  try {
    const url = "/api/workspaces/workspace-1/missions/msn_1/control"
    const payload = { action: "pause", requestId: "pause-request", expectedRevision: 7 }
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 200)
    assert.deepEqual(fixture.calls.find(call => call.method === "lifecycle")?.value, {
      input: { action: "pause", requestID: "pause-request", expectedRevision: 7, missionID: "msn_1" },
      rpcOptions: { location: { directory: "/owned/repo" } },
    })
    for (const invalid of [{ ...payload, action: "resume" }, { ...payload, expectedRevision: 0 }, { ...payload, sessionID: "ses_foreign" }, { ...payload, directory: "/foreign" }]) {
      assert.equal((await app.inject({ method: "POST", url, payload: invalid })).statusCode, 400)
    }
    assert.equal((await app.inject({ method: "POST", url: url.replace("workspace-1", "unknown"), payload })).statusCode, 404)
    assert.equal(fixture.calls.filter(call => call.method === "lifecycle").length, 1)
  } finally { await app.close() }
})

test("cleanup-pending crosses the route as a retryable declared failure", async () => {
  const app = Fastify()
  registerMissionRoutes(app, { workspaceManager: mutationManager({
    error: { type: "mission.rejected", message: "Mission deleted; retry cleanup", data: { code: "cleanup-pending" } },
  }).value, worktreeDeletionFence: new WorktreeDeletionFence() })
  try {
    const response = await app.inject({ method: "DELETE", url: "/api/workspaces/workspace-1/missions/msn_1",
      payload: { requestId: "delete-1", expectedRevision: 2, deleteManagedSessions: true } })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { error: "Mission deleted; retry cleanup", code: "cleanup-pending" })
  } finally { await app.close() }
})

test("creation forwards exact role profiles and refuses a response that silently drops them", async () => {
  const profiles = { coordinator: { agent: "lead", model: { providerID: "owned", id: "large", variant: "deep" } },
    roles: { "review-standards": { agent: "reviewer" }, validator: { model: { providerID: "owned", id: "small", variant: "quick" } } } }
  for (const dropProfiles of [false, true]) {
    const fake = mutationManager({ dropProfiles })
    const app = Fastify({ logger: false })
    registerMissionRoutes(app, { workspaceManager: fake.value, worktreeDeletionFence: new WorktreeDeletionFence() })
    try {
      const result = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions",
        payload: { objective: "Profiles", template: "debug", requestId: "profiles-exact", profiles } })
      assert.equal(result.statusCode, dropProfiles ? 409 : 200)
      const sent = fake.calls.find(call => call.method === "create")!.value as { input: { profiles: unknown } }
      assert.deepEqual(sent.input.profiles, profiles)
      if (dropProfiles) assert.equal(result.json().code, "creation-uncertain")
      else assert.deepEqual(result.json().mission.profiles, profiles)
    } finally { await app.close() }
  }
})

test("malformed and wrong-playbook profiles refuse before creation dispatch", async () => {
  const fake = mutationManager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value, worktreeDeletionFence: new WorktreeDeletionFence() })
  try {
    for (const profiles of [{ roles: { validator: { agent: "child" } } },
      { coordinator: { model: { providerID: "owned", id: "large", forged: "bad" } } },
      { roles: { __unknown: { agent: "child" } } }]) {
      const result = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions",
        payload: { objective: "Profiles", template: "wayfinder", requestId: "bad-profiles", profiles } })
      assert.equal(result.statusCode, 400)
    }
    assert.equal(fake.calls.length, 0)
  } finally { await app.close() }
})

test("creation forwards both task policies; dropping independent mode retains an uncertain hold", async t => {
  for (const taskMode of ["native", "independent"] as const) for (const dropTaskMode of [false, true]) {
    const fake = mutationManager({ dropTaskMode }), app = Fastify({ logger: false })
    t.after(() => app.close())
    registerMissionRoutes(app, { workspaceManager: fake.value, worktreeDeletionFence: new WorktreeDeletionFence() })
    const response = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions",
      payload: { objective: "Task policy", template: "custom", requestId: "mode-exact", taskMode } })
    const uncertain = dropTaskMode && taskMode === "independent"
    assert.equal(response.statusCode, uncertain ? 409 : 200)
    assert.equal((fake.calls.find(call => call.method === "create")!.value as { input: { taskMode: string } }).input.taskMode, taskMode)
    if (uncertain) assert.equal(response.json().code, "creation-uncertain")
  }
  const fake = mutationManager(), app = Fastify({ logger: false }); t.after(() => app.close())
  registerMissionRoutes(app, { workspaceManager: fake.value, worktreeDeletionFence: new WorktreeDeletionFence() })
  for (const taskMode of [null, "root", false, {}]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions",
      payload: { objective: "Invalid policy", template: "custom", requestId: "bad-mode", taskMode } })).statusCode, 400)
  }
  assert.equal(fake.calls.length, 0)
})

test("creation refusals before the native create carry no-effect codes; dispatched failures stay uncertain", async t => {
  const create = async (options: Parameters<typeof mutationManager>[0], fence: WorktreeDeletionFence | null = new WorktreeDeletionFence()) => {
    const fake = mutationManager(options), app = Fastify({ logger: false })
    t.after(() => app.close())
    registerMissionRoutes(app, { workspaceManager: fake.value, ...(fence ? { worktreeDeletionFence: fence } : {}) })
    const response = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions",
      payload: { objective: "Refusal", template: "custom", requestId: "refusal-1" } })
    return { status: response.statusCode, body: response.json(), creates: fake.calls.filter(call => call.method === "create").length }
  }
  for (const [label, result] of [
    ["missing fence", await create({}, null)],
    ["inactive plugin", await create({ pluginInactive: true })],
    ["no connection", await create({ noConnection: true })],
    ["pre-dispatch transport failure", await create({ locationError: new Error("private socket failure") })],
  ] as const) {
    assert.deepEqual({ status: result.status, code: result.body.code, creates: result.creates },
      { status: 503, code: "creation-unavailable", creates: 0 }, label)
    assert.ok(!JSON.stringify(result.body).includes("private"), label)
  }

  const fence = new WorktreeDeletionFence()
  let release!: () => void
  const deletion = fence.run("/owned/repo", ["/owned/repo"], () => new Promise<void>(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.deepEqual(await create({}, fence), { status: 409, body: { error: "Worktree deletion is in progress", code: "creation-worktree-deleting" }, creates: 0 })
  } finally { release(); await deletion }

  // Once the native create was attempted, nothing proves the absence of an effect.
  const dispatched = await create({ createError: new Error("socket closed after write") })
  assert.deepEqual({ status: dispatched.status, code: dispatched.body.code, creates: dispatched.creates },
    { status: 409, code: "creation-uncertain", creates: 1 })
  // Ordinary validation refusals remain reviewed codeless statuses.
  assert.equal((await create({ owns: false })).status, 403)
})
