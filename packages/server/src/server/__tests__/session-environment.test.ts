import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import { OpenCode } from "@opencode/client"
import { registerInstanceProxyRoutes, type InstanceProxyWorkspaceManager } from "../http-server"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { sessionEnvironment } from "../../workspaces/session-environment"
import { SESSION_ENVIRONMENT_FAILED_ERROR_CODE } from "../../api-types"
import type { MemoryService } from "../../memory/service"

const apps: FastifyInstance[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
const prefix = "/workspaces/w/instance/api/session/"

async function harness(memory?: Pick<MemoryService, "sessionTitles"> & Partial<Pick<MemoryService, "getSettings">>, supported = true) {
  const calls: string[] = []
  const snapshots = new Map<string, Record<string, string>>()
  const sends: Array<{ sessionID: string; variables?: Record<string, string>; body: unknown }> = []
  const control = {
    configured: { TEMP: "T:/", TMP: "T:/", TMPDIR: "T:/" } as Record<string, string>,
    environmentStatus: 204,
    beforeEnvironment: async () => {},
    afterEnvironment: () => {},
    beforeInstructions: async () => {},
    beforeMemory: async (_method: string) => {},
    current: true,
    openapiStatus: 200,
    memoryStatus: 204,
    openapiReads: 0,
  }
  const upstream = Fastify({ forceCloseConnections: true })
  apps.push(upstream)
  const entries = "/api/experimental/session/{sessionID}/instructions/entries"
  upstream.get("/openapi.json", async (_request, reply) => {
    control.openapiReads++
    return control.openapiStatus === 200 ? { openapi: "3.1.0", paths: supported
      ? { [entries]: { get: {} }, [`${entries}/{key}`]: { put: {}, delete: {} } } : {} }
      : reply.code(control.openapiStatus).send({ error: "PRIVATE MEMORY" })
  })
  upstream.post("/api/rpc/codenomad.missions/scheduleCarrierRead", async (_request, reply) =>
    reply.code(400).send({ _tag: "RpcError", type: "rpc.method_not_found", message: "Unknown RPC method" }))
  upstream.get("/api/session/:id", async request => {
    const { id } = request.params as { id: string }
    return { data: { id, location: { directory: id === "foreign" ? "/other" : "/repo" } } }
  })
  upstream.put("/api/session/:id/environment", async (request, reply) => {
    const { id } = request.params as { id: string }
    calls.push(`environment:${id}`)
    await control.beforeEnvironment()
    if (control.environmentStatus !== 204) return reply.code(control.environmentStatus).send({ secret: "DO-NOT-LEAK" })
    snapshots.set(id, (request.body as { variables: Record<string, string> }).variables)
    control.afterEnvironment()
    return reply.code(204).send()
  })
  upstream.all("/api/session/:id/:action", async request => {
    const { id, action } = request.params as { id: string; action: string }
    calls.push(`${request.method}:${action}:${id}`)
    sends.push({ sessionID: id, variables: snapshots.get(id), body: request.body })
    return { data: [] }
  })
  upstream.route({ method: ["PUT", "DELETE"], url: "/api/experimental/session/:id/instructions/entries/:key",
    handler: async (request, reply) => {
      if ((request.params as { key: string }).key === "codenomad.memory") {
        calls.push(`memory:${request.method}`)
        await control.beforeMemory(request.method)
        if (control.memoryStatus !== 204) return reply.code(control.memoryStatus).send({ error: "PRIVATE MEMORY" })
      }
      await control.beforeInstructions(); return reply.code(204).send()
    },
  })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}` }
  const assertCurrent = () => { if (!control.current) throw new Error("Stale connection") }
  const fetcher: typeof fetch = (input, init) => { assertCurrent(); return fetch(input, init) }
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: fetcher })
  const manager: InstanceProxyWorkspaceManager = {
    get: () => ({ id: "w", path: "/repo" }) as never,
    getSharedServiceEndpoint: async () => endpoint,
    getSharedServiceClient: async () => { throw new Error("Must use the pinned client") },
    getSharedServiceConnection: async () => ({ endpoint, client, fetch: fetcher, assertCurrent, invalidate() {}, profile: async () => "modern" }),
    getInstanceAuthorizationHeader: () => undefined,
    getWorktreeIdentityForPath: async () => "root",
    ownsLocation: async (_id, location) => location.directory === "/repo",
    ownsDirectory: async (_id, directory) => directory === "/repo",
    ownsPath: async () => true,
    getSessionEnvironment: async () => sessionEnvironment(control.configured, {
      platform: "win32", environment: { Path: "C:/tools", TEMP: "C:/base", SystemRoot: "C:/Windows" },
    }),
  }
  const app = Fastify()
  apps.push(app)
  const fence = new WorktreeDeletionFence()
  const logs: unknown[] = []
  registerInstanceProxyRoutes(app, {
    workspaceManager: manager, worktreeDeletionFence: fence,
    memory: memory ? { getSettings: () => ({ enabled: true }), ...memory } as MemoryService : undefined,
    logger: { debug() {}, error: (...args: unknown[]) => logs.push(args), isLevelEnabled: () => false } as never,
  })
  await app.ready()
  return { app, calls, sends, control, manager, fence, logs }
}

test("proxy prompt and command await memory replacement/removal; shell bypasses it and missing capability stays silent", async () => {
  let titles: any = { global: [], project: [] }
  const memory = { sessionTitles: async (sessionID: string) => { assert.equal(sessionID, "one"); return titles } }
  const f = await harness(memory)
  const send = (action: string) => f.app.inject({ method: "POST", url: `${prefix}one/${action}`, payload: {} })
  assert.equal((await send("prompt")).statusCode, 200)
  titles = null
  assert.equal((await send("command")).statusCode, 200)
  assert.equal((await send("shell")).statusCode, 200)
  assert.deepEqual(f.calls, ["environment:one", "memory:PUT", "POST:prompt:one", "environment:one", "memory:DELETE", "POST:command:one", "environment:one", "POST:shell:one"])
  const absent = await harness({ sessionTitles: async () => { throw new Error("must not read") } }, false)
  assert.equal((await absent.app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: {} })).statusCode, 200)
  assert.deepEqual(absent.calls, ["environment:one", "POST:prompt:one"])
})

test("proxy memory failure clears its stale key and admits input while releasing its mutation fence", async () => {
  const f = await harness({ sessionTitles: async () => { throw new Error("PRIVATE MEMORY") } })
  const response = await f.app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: {} })
  assert.equal(response.statusCode, 200)
  assert(!response.body.includes("PRIVATE"))
  assert.equal(f.sends.length, 1)
  assert(f.calls.includes("memory:DELETE"))
  await f.fence.run("delete", ["root"], async () => {})
})

test("QA regression: disabled/discovery/cleanup outages never block proxy prompts or commands", async () => {
  for (const enabled of [false, true]) for (const mode of ["discovery", "remove", "put"]) {
    let storageReads = 0
    const f = await harness({ getSettings: () => ({ enabled }), sessionTitles: async () => { storageReads++; return {} } })
    if (mode === "discovery") f.control.openapiStatus = 503
    else f.control.memoryStatus = 503
    for (const action of ["prompt", "command"]) {
      const response = await f.app.inject({ method: "POST", url: `${prefix}one/${action}`, payload: {} })
      assert.equal(response.statusCode, 200, `${enabled}/${mode}/${action}: ${response.body}`)
    }
    assert.equal(f.sends.length, 2)
    assert.equal(f.control.openapiReads, enabled ? 2 : 0)
    assert.equal(storageReads, enabled && mode !== "discovery" ? 2 : 0)
    assert.equal(f.calls.filter(call => call === "memory:DELETE").length, 2)
    await f.fence.run("delete", ["root"], async () => {})
  }
})

for (const mode of ["put", "remove", "cleanup"] as const) test(`proxy admits input after a hanging memory ${mode} exhausts its own budget`, { timeout: 10_000 }, async () => {
  const f = await harness({ getSettings: () => ({ enabled: mode !== "remove" }), sessionTitles: async () => ({}) })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.control.beforeMemory = async method => { if (mode !== "cleanup" || method === "DELETE") await gate }
  if (mode === "cleanup") f.control.memoryStatus = 503
  try {
    const response = await f.app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: {} })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(f.sends.length, 1)
    assert.deepEqual(f.calls.filter(call => call.startsWith("memory:")), mode === "cleanup" ? ["memory:PUT", "memory:DELETE"] : [`memory:${mode === "put" ? "PUT" : "DELETE"}`])
    await f.fence.run("delete", ["root"], async () => {})
  } finally { release() }
})

test("every prompt applies current profile values before forwarding, including removal and other sessions", async () => {
  const { app, calls, sends, control } = await harness()
  const send = (id: string) => app.inject({ method: "POST", url: `${prefix}${id}/prompt`, payload: { text: "hello" } })
  assert.equal((await send("one")).statusCode, 200)
  control.configured = { TEMP: "U:/" }
  assert.equal((await send("one")).statusCode, 200)
  assert.equal((await send("two")).statusCode, 200)
  control.configured = {}
  assert.equal((await send("one")).statusCode, 200)
  assert.deepEqual(calls, ["environment:one", "POST:prompt:one", "environment:one", "POST:prompt:one", "environment:two", "POST:prompt:two", "environment:one", "POST:prompt:one"])
  assert.deepEqual(sends.map(send => send.variables?.TEMP), ["T:/", "U:/", "U:/", "C:/base"])
  assert.equal(sends[1].variables?.TMP, undefined)
  assert.equal(sends[3].variables?.Path, "C:/tools")
  assert.deepEqual(sends[0].body, { text: "hello" })
})

test("session shell and custom commands also apply the environment, but reads and other writes do not", async () => {
  const { app, calls } = await harness()
  for (const action of ["shell", "command"]) {
    assert.equal((await app.inject({ method: "POST", url: `${prefix}one/${action}`, payload: {} })).statusCode, 200)
  }
  assert.equal((await app.inject({ method: "GET", url: `${prefix}one/message` })).statusCode, 200)
  assert.equal((await app.inject({ method: "POST", url: `${prefix}one/interrupt`, payload: {} })).statusCode, 200)
  assert.deepEqual(calls, ["environment:one", "POST:shell:one", "environment:one", "POST:command:one", "GET:message:one", "POST:interrupt:one"])
})

test("waits for the environment acknowledgement before admitting a prompt", async () => {
  const { app, control, sends } = await harness()
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  control.beforeEnvironment = () => { started(); return new Promise<void>(resolve => { release = resolve }) }
  const pending = app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: { text: "hello" } }).then(value => value)
  await ready
  assert.equal(sends.length, 0)
  release()
  assert.equal((await pending).statusCode, 200)
  assert.equal(sends.length, 1)
})

test("advisory Git context timeout permits the send after successful environment synchronization", async () => {
  const { app, control, sends, logs } = await harness()
  let release!: () => void
  control.beforeInstructions = () => new Promise<void>(resolve => { release = resolve })
  try {
    const started = Date.now()
    const response = await app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: { text: "hello" } })
    assert.equal(response.statusCode, 200, response.body)
    assert.ok(Date.now() - started < 10_000, "advisory deadline must not consume the environment timeout")
    assert.equal(sends.length, 1)
    assert.equal(logs.length, 0, "advisory timeout is not an environment failure")
  } finally { release?.() }
})

test("unauthorized sessions and direct environment writes never set an environment", async () => {
  const { app, calls } = await harness()
  assert.equal((await app.inject({ method: "POST", url: `${prefix}foreign/prompt`, payload: { text: "no" } })).statusCode, 403)
  assert.equal((await app.inject({ method: "PUT", url: `${prefix}one/environment`, payload: { variables: { TEMP: "untrusted" } } })).statusCode, 403)
  assert.deepEqual(calls, [])
})

test("environment failures stop admission, expose no environment data and release the mutation fence", async () => {
  const { app, control, sends, logs, fence } = await harness()
  for (const status of [400, 401, 404, 500]) {
    control.environmentStatus = status
    const response = await app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: { text: "hello" } })
    assert.equal(response.statusCode, 502)
    assert.deepEqual(response.json(), { error: SESSION_ENVIRONMENT_FAILED_ERROR_CODE })
    assert.equal(sends.length, 0)
  }
  assert.equal(JSON.stringify(logs).includes("DO-NOT-LEAK"), false)
  await fence.run("delete", ["root"], async () => {})
  control.environmentStatus = 204
  assert.equal((await app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: {} })).statusCode, 200)
})

test("a connection replaced while preparing or applying the environment cannot receive the prompt", async () => {
  const { app, control, manager, calls, sends } = await harness()
  const original = manager.getSessionEnvironment
  manager.getSessionEnvironment = async (...args) => { const env = await original(...args); control.current = false; return env }
  assert.equal((await app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: {} })).statusCode, 502)
  assert.deepEqual(calls, [])
  manager.getSessionEnvironment = original
  control.current = true
  control.afterEnvironment = () => { control.current = false }
  assert.equal((await app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: {} })).statusCode, 502)
  assert.equal(sends.length, 0)
})

test("worktree deletion waits for environment admission and blocks further sends", async () => {
  const { app, control, fence, calls } = await harness()
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  control.beforeEnvironment = () => { started(); return new Promise<void>(resolve => { release = resolve }) }
  const pending = app.inject({ method: "POST", url: `${prefix}one/prompt`, payload: {} }).then(value => value)
  await ready
  let deleted = false
  const deletion = fence.run("delete", ["root"], async () => { deleted = true })
  assert.equal((await app.inject({ method: "POST", url: `${prefix}two/prompt`, payload: {} })).statusCode, 409)
  assert.equal(deleted, false)
  assert.deepEqual(calls, ["environment:one"])
  release()
  assert.equal((await pending).statusCode, 200)
  await deletion
  assert.equal(deleted, true)
})

test("disconnect during environment preparation cancels admission before any native write", async () => {
  const { app, manager, calls } = await harness()
  let ready!: () => void
  let cancelled!: () => void
  const preparing = new Promise<void>(resolve => { ready = resolve })
  const aborted = new Promise<void>(resolve => { cancelled = resolve })
  manager.getSessionEnvironment = async (_id, signal) => {
    ready()
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => {
      cancelled()
      reject(signal!.reason)
    }, { once: true }))
  }
  await app.listen({ host: "127.0.0.1", port: 0 })
  const port = (app.server.address() as { port: number }).port
  const controller = new AbortController()
  const request = fetch(`http://127.0.0.1:${port}${prefix}one/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: controller.signal,
  })
  const rejected = assert.rejects(request)
  await preparing
  controller.abort()
  await rejected
  await aborted
  assert.deepEqual(calls, [])
})
