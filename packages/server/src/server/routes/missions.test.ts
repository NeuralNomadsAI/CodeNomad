import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { registerMissionRoutes } from "./missions"

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
  return {
    calls,
    value: {
      get: (id: string) => options.workspace === false || id !== "workspace-1" ? undefined : { id },
      getServiceLocation: (id: string) => id === "workspace-1" ? { directory: options.directory ?? "/owned/repo" } : undefined,
      getSharedServiceClient: async () => ({
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
    } as never,
  }
}

function mutationManager(options: { owns?: boolean; error?: unknown } = {}) {
  const calls: Array<{ method: string; value: unknown }> = []
  const value = {
    get: (id: string) => id === "workspace-1" ? { id } : undefined,
    getServiceLocation: (id: string) => id === "workspace-1" ? { directory: "/owned/repo" } : undefined,
    ownsLocation: async (_id: string, location: { directory: string }) => {
      calls.push({ method: "owns", value: location })
      return options.owns ?? location.directory !== "/foreign"
    },
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
          create: async (input: unknown, rpcOptions: unknown) => { calls.push({ method: "create", value: { input, rpcOptions } }); return { mission: { id: "msn_1" } } },
          update: async (input: unknown, rpcOptions: unknown) => {
            calls.push({ method: "update", value: { input, rpcOptions } })
            if (options.error) throw options.error
            return { mission: { id: "msn_1" } }
          },
          delete: async (input: unknown, rpcOptions: unknown) => { calls.push({ method: "delete", value: { input, rpcOptions } }); return { deleted: true } },
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
  registerMissionRoutes(app, { workspaceManager: fake.value })

  const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { available: true, ...snapshot })
  assert.deepEqual(fake.calls, [
    { method: "location", value: { location: { directory: "/owned/repo" } } },
    { method: "list", value: { location: { directory: "/owned/repo" } } },
    { method: "rpc-definition", value: "codenomad.missions" },
    { method: "snapshot", value: { input: {}, callOptions: { location: { directory: "/owned/repo" } } } },
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

test("brokers typed mission create, update and delete only at authorized project locations", async () => {
  const fake = mutationManager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value })
  const create = await app.inject({ method: "POST", url: "/api/workspaces/workspace-1/missions", payload: {
    objective: "Ship it", template: "wayfinder", coordinatorSessionId: "ses_existing", directory: "/owned/repo", requestId: "create-1",
  } })
  assert.equal(create.statusCode, 200)
  assert.deepEqual(create.json(), { mission: { id: "msn_1" } })
  assert.deepEqual(fake.calls.find((call) => call.method === "create")?.value, {
    input: { requestID: "create-1", objective: "Ship it", template: "wayfinder", coordinatorSessionID: "ses_existing" },
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
