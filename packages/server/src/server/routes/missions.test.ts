import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { registerMissionRoutes } from "./missions"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { stableToken } from "../../missions/journal"

const snapshot = {
  version: 1 as const,
  projectID: "project-1",
  generatedAt: 1,
  missions: [],
  discardedEvents: 0,
}

function manager(options: {
  workspace?: boolean
  directory?: string
  plugin?: "active" | "failed" | "missing"
  projectID?: string
  rpcError?: unknown
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
          return {
            snapshot: async (input: unknown, callOptions: unknown) => {
              calls.push({ method: "snapshot", value: { input, callOptions } })
              if (options.rpcError) throw options.rpcError
              return snapshot
            },
          }
        },
      }),
  }
  return { calls, value: value as never }
}

function mutationManager(options: { owns?: boolean; error?: unknown; dropProfiles?: boolean; dropTaskMode?: boolean } = {}) {
  const calls: Array<{ method: string; value: unknown }> = []
  const value = {
    get: (id: string) => id === "workspace-1" ? { id } : undefined,
    getServiceLocation: (id: string) => id === "workspace-1" ? { directory: "/owned/repo" } : undefined,
    ownsLocation: async (_id: string, location: { directory: string }) => {
      calls.push({ method: "owns", value: location })
      return options.owns ?? location.directory !== "/foreign"
    },
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
    getSharedServiceConnection: async () => ({ client: await value.getSharedServiceClient(), assertCurrent() {} }),
    getSharedServiceClient: async () => ({
      location: { get: async ({ location }: { location: { directory: string } }) => ({
        directory: location.directory, project: { id: "project-1" },
      }) },
      session: { get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID, projectID: "project-1", location: { directory: "/owned/repo" },
      }) },
      plugin: { list: async ({ location }: { location: { directory: string } }) => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }], location }) },
      rpc: (definition: { id: string }) => {
        calls.push({ method: "rpc", value: definition.id })
        return {
          create: async (input: any, rpcOptions: unknown) => {
            calls.push({ method: "create", value: { input, rpcOptions } })
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

test("brokers only the reviewed mission snapshot RPC at the owned workspace location", async () => {
  const fake = manager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value, worktreeDeletionFence: new WorktreeDeletionFence() })

  const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.available, true)
  assert.deepEqual({ ...body, activity: undefined }, { available: true, ...snapshot, activity: undefined })
  assert.equal(typeof body.activity.generatedAt, "number")
  assert.deepEqual(body.activity.missions, [])
  assert.deepEqual(fake.calls, [
    { method: "location", value: { location: { directory: "/owned/repo" } } },
    { method: "list", value: { location: { directory: "/owned/repo" } } },
    { method: "rpc-definition", value: "codenomad.missions" },
    { method: "snapshot", value: { input: {}, callOptions: { location: { directory: "/owned/repo" } } } },
    { method: "active", value: undefined },
  ])
  await app.close()
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
  for (const options of [
    { plugin: "missing" as const },
    { plugin: "failed" as const },
    { rpcError: { type: "rpc.not_found", message: "missing" } },
  ]) {
    const fake = manager(options)
    const app = Fastify({ logger: false })
    registerMissionRoutes(app, { workspaceManager: fake.value })
    const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { available: false, reason: "plugin-unavailable", missions: [] })
    await app.close()
  }
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
  registerMissionRoutes(app, { workspaceManager: fake.value })
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
      registerMissionRoutes(app, { workspaceManager: mutationManager({ error }).value })
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
  registerMissionRoutes(app, { workspaceManager: fake.value })
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
  registerMissionRoutes(app, { workspaceManager: fixture.value as never })
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
  }).value })
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
        payload: { objective: "Profiles", template: "pocock-fix-bug", requestId: "profiles-exact", profiles } })
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
