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
      getServiceDirectory: (id: string) => id === "workspace-1" ? (options.directory ?? "/owned/repo") : undefined,
      getSharedServiceClient: async () => ({
        plugin: {
          awaitActivation: async (input: unknown) => { calls.push({ method: "await", value: input }) },
          list: async (input: unknown) => {
            calls.push({ method: "list", value: input })
            return {
              location: { directory: "/owned/repo", project: { id: options.projectID ?? "project-1" } },
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

test("brokers only the reviewed mission snapshot RPC at the owned workspace location", async () => {
  const fake = manager()
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: fake.value })

  const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-1/missions" })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { available: true, ...snapshot })
  assert.deepEqual(fake.calls, [
    { method: "await", value: { location: { directory: "/owned/repo" } } },
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
