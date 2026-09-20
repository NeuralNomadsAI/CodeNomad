import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import type { OpenCodeClient } from "@opencode/client"
import type { Endpoint } from "@opencode/client/service"
import { registerInstanceProxyRoutes, type InstanceProxyWorkspaceManager } from "../http-server"
import { createRuntimeFetch } from "../../opencode/compatibility/transport"
import { rememberRuntime } from "../../opencode/compatibility/runtime"
import { LOCATION_CONTEXT_HEADER, locationRequestOptions } from "../../opencode/compatibility/location"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { OpenCodeSharedService } from "../../workspaces/opencode-service"
import { legacyContractFixture } from "../../opencode/compatibility/contract-fixture"

test("modern proxy preserves Forms scope and rejects obsolete selectors in cursors and history", async () => {
  const upstream = Fastify()
  let forwarded = 0
  upstream.all("/*", async request => { forwarded++; return { method: request.method, url: request.url, body: request.body, headers: request.headers } })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint: Endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`, auth: { type: "basic", username: "opencode", password: "fixture" } }
  rememberRuntime(endpoint, { version: "2.0.11", pid: 1, discovery: "info" })
  const client = { session: { get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: sessionID === "foreign" ? "/foreign" : "/native" } }) } } as unknown as OpenCodeClient
  const connection = { endpoint, client, fetch: createRuntimeFetch(endpoint), assertCurrent() {}, invalidate() {}, profile: async () => "modern" as const }
  const directories = new Set(["/host", "/native"])
  const manager: InstanceProxyWorkspaceManager = {
    get: () => ({ id: "w", path: "/host" }) as never,
    getSharedServiceEndpoint: async () => { throw new Error("Pinned request must not reacquire endpoint") },
    getSharedServiceConnection: async () => connection,
    getSharedServiceClient: async () => { throw new Error("Pinned request must not reacquire client") },
    getSessionEnvironment: async () => ({}),
    getInstanceAuthorizationHeader: () => undefined,
    getServiceDirectory: () => "/native",
    getServiceDirectoryForPath: async (_id, directory) => directories.has(directory) ? "/native" : undefined,
    getWorktreeIdentityForPath: async (_id, directory) => directories.has(directory) ? "root" : undefined,
    ownsDirectory: async (_id, directory) => directories.has(directory), ownsPath: async () => false,
    ownsLocation: async (_id, location, pinned) => {
      assert.equal(pinned, client)
      return directories.has(location.directory) && (location.workspaceID === undefined || location.workspaceID === "one")
    },
  }
  const app = Fastify()
  registerInstanceProxyRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence(), logger: { debug() {}, error() {}, isLevelEnabled: () => false } as never })
  const prefix = "/workspaces/w/instance"
  const context = (workspaceID: string) => locationRequestOptions({ directory: "/host", workspaceID })!.headers
  try {
    const form = await app.inject({ method: "DELETE", url: `${prefix}/api/session/global/form/f`, headers: { "x-opencode-directory": encodeURIComponent("/host"), cookie: "browser=secret" } })
    assert.equal(form.statusCode, 200, form.body)
    assert.equal(form.json().url, "/api/session/global/form/f")
    assert.equal(form.json().method, "DELETE")
    assert.equal(form.json().headers["x-opencode-directory"], encodeURIComponent("/native"))
    assert.equal(form.json().headers["x-opencode-workspace"], undefined)
    assert.equal(form.json().headers[LOCATION_CONTEXT_HEADER], undefined)
    assert.equal(form.json().headers.cookie, undefined)
    const create = await app.inject({ method: "POST", url: `${prefix}/api/session`, payload: { location: { directory: "/host" } } })
    assert.equal(create.statusCode, 200, create.body)
    assert.deepEqual(create.json().body.location, { directory: "/native" })
    const cursor = (workspace?: string) => Buffer.from(JSON.stringify({ directory: "/native", workspace, anchor: { id: "s", time: 1, direction: "next" } })).toString("base64url")
    const listed = await app.inject(`${prefix}/api/session?cursor=${cursor()}&directory=/foreign`)
    assert.equal(listed.statusCode, 200, listed.body)
    assert.equal(new URL(listed.json().url, endpoint.url).searchParams.get("cursor"), cursor())
    assert.equal(new URL(listed.json().url, endpoint.url).searchParams.has("workspace"), false)
    const before = forwarded
    for (const request of [
      { method: "DELETE" as const, url: `${prefix}/api/session/global/form/f`, headers: { ...context("two"), "x-opencode-directory": encodeURIComponent("/host") } },
      { method: "PATCH" as const, url: `${prefix}/api/session/foreign`, payload: { title: "forbidden" } },
      { method: "GET" as const, url: `${prefix}/api/session?cursor=${cursor("two")}` },
      ...["workspace", "location[workspace]", "workspaceID", "location[workspaceID]"].map(key => ({
        method: "GET" as const, url: `${prefix}/api/session?cursor=${cursor()}&${key}=one`,
      })),
      { method: "POST" as const, url: `${prefix}/api/experimental/session/import`, payload: {
        location: { directory: "/host", workspaceID: "one" }, info: { location: { directory: "/host", workspaceID: "one" } },
        messages: [{ type: "location-switched", location: { directory: "/host", workspaceID: "two" } }],
      } },
      { method: "POST" as const, url: `${prefix}/api/experimental/session/import`, payload: {
        location: { directory: "/host" }, info: { location: { directory: "/host" } },
        messages: [{ type: "location-switched", location: { directory: "/host" }, previous: { location: { directory: "/foreign" } } }],
      } },
    ]) assert.ok([400, 403].includes((await app.inject(request)).statusCode))
    assert.equal(forwarded, before, "foreign identity is refused before forwarding any mutation")
  } finally { await app.close(); await upstream.close() }
})

test("future releases advertising retired schemas are refused before functional calls", async () => {
  const upstream = Fastify()
  const calls: string[] = []
  upstream.get("/openapi.json", async () => { calls.push("schema"); return legacyContractFixture })
  upstream.all("/api/*", async () => {
    calls.push("forms")
    assert.fail("a retired contract must not receive functional calls")
  })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}` }
  rememberRuntime(endpoint, { version: "2.0.100", pid: 1, discovery: "info" })
  const service = new OpenCodeSharedService()
  try {
    await assert.rejects(service.client({ kind: "lifecycle", identity: "isolated-test", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } }), { code: "opencode_update_required" })
    assert.deepEqual(calls, ["schema"])
  } finally { await service.shutdown(); await upstream.close() }
})
