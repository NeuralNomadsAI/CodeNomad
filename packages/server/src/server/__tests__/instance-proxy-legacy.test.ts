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

test("legacy authority precedes translation for Forms, session writes, cursors and imported history", async () => {
  const upstream = Fastify()
  let forwarded = 0
  upstream.all("/*", async request => { forwarded++; return { method: request.method, url: request.url, body: request.body, headers: request.headers } })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint: Endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`, auth: { type: "basic", username: "opencode", password: "fixture" } }
  rememberRuntime(endpoint, { version: "2.0.3", pid: 1, discovery: "health" })
  const client = { session: { get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: "/native", workspaceID: sessionID === "foreign" ? "two" : "one" } }) } } as unknown as OpenCodeClient
  const connection = { endpoint, client, fetch: createRuntimeFetch(endpoint), assertCurrent() {}, invalidate() {}, profile: async () => "legacy" as const }
  const directories = new Set(["/host", "/native"])
  const manager: InstanceProxyWorkspaceManager = {
    get: () => ({ id: "w", path: "/host" }) as never,
    getSharedServiceEndpoint: async () => { throw new Error("Pinned request must not reacquire endpoint") },
    getSharedServiceConnection: async () => connection,
    getSharedServiceClient: async () => { throw new Error("Pinned request must not reacquire client") },
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
    const form = await app.inject({ method: "DELETE", url: `${prefix}/api/session/global/form/f`, headers: { ...context("one"), "x-opencode-directory": encodeURIComponent("/host"), cookie: "browser=secret" } })
    assert.equal(form.statusCode, 200, form.body)
    assert.equal(form.json().url, "/api/session/global/form/f/cancel")
    assert.equal(form.json().method, "POST")
    assert.equal(form.json().headers["x-opencode-directory"], encodeURIComponent("/native"))
    assert.equal(form.json().headers["x-opencode-workspace"], "one")
    assert.equal(form.json().headers[LOCATION_CONTEXT_HEADER], undefined)
    assert.equal(form.json().headers.cookie, undefined)
    const create = await app.inject({ method: "POST", url: `${prefix}/api/session`, headers: context("one"), payload: { location: { directory: "/host" } } })
    assert.equal(create.statusCode, 200, create.body)
    assert.deepEqual(create.json().body.location, { directory: "/native", workspaceID: "one" })
    const cursor = (workspace: string) => Buffer.from(JSON.stringify({ directory: "/native", workspace, anchor: { id: "s", time: 1, direction: "next" } })).toString("base64url")
    const listed = await app.inject(`${prefix}/api/session?cursor=${cursor("one")}&workspace=ignored&directory=/foreign`)
    assert.equal(listed.statusCode, 200, listed.body)
    assert.equal(new URL(listed.json().url, endpoint.url).searchParams.get("cursor"), cursor("one"))
    assert.equal(new URL(listed.json().url, endpoint.url).searchParams.has("workspace"), false)
    const before = forwarded
    for (const request of [
      { method: "DELETE" as const, url: `${prefix}/api/session/global/form/f`, headers: { ...context("two"), "x-opencode-directory": encodeURIComponent("/host") } },
      { method: "PATCH" as const, url: `${prefix}/api/session/foreign`, payload: { title: "forbidden" } },
      { method: "GET" as const, url: `${prefix}/api/session?cursor=${cursor("two")}` },
      { method: "POST" as const, url: `${prefix}/api/experimental/session/import`, payload: {
        location: { directory: "/host", workspaceID: "one" }, info: { location: { directory: "/host", workspaceID: "one" } },
        messages: [{ type: "location-switched", location: { directory: "/host", workspaceID: "two" } }],
      } },
    ]) assert.equal((await app.inject(request)).statusCode, 403)
    assert.equal(forwarded, before, "foreign identity is refused before forwarding any mutation")
  } finally { await app.close(); await upstream.close() }
})

test("the first legacy-context proxy request after reconnect negotiates before authorization", async () => {
  const upstream = Fastify()
  const calls: string[] = []
  upstream.get("/openapi.json", async () => { calls.push("schema"); return legacyContractFixture })
  upstream.get("/api/form/request", async request => {
    calls.push("forms")
    assert.equal((request.query as Record<string, string>)["location[workspace]"], "one")
    return { data: [], location: { directory: "/repo", workspaceID: "one" } }
  })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}` }
  rememberRuntime(endpoint, { version: "next-contract", pid: 1, discovery: "health" })
  const service = new OpenCodeSharedService()
  await service.client({ kind: "lifecycle", identity: "isolated-test", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  const app = Fastify()
  registerInstanceProxyRoutes(app, { workspaceManager: {
    get: () => ({ path: "/repo" }) as never,
    getSharedServiceConnection: () => service.acquire(), getSharedServiceEndpoint: async () => endpoint,
    getSharedServiceClient: () => service.client(), getInstanceAuthorizationHeader: () => undefined,
    getWorktreeIdentityForPath: async () => "root", ownsDirectory: async () => true, ownsPath: async () => false,
    ownsLocation: async (_id, location) => {
      assert.deepEqual(calls, ["schema"], "contract must be selected before profile-dependent authorization")
      return location.directory === "/repo" && (location.workspaceID === undefined || location.workspaceID === "one")
    },
  }, worktreeDeletionFence: new WorktreeDeletionFence(), logger: { debug() {}, error() {} } as never })
  try {
    const response = await app.inject({ url: "/workspaces/w/instance/api/form?location[directory]=/repo", headers: locationRequestOptions({ directory: "/repo", workspaceID: "one" })!.headers })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(calls, ["schema", "forms"])
  } finally { await service.shutdown(); await app.close(); await upstream.close() }
})
