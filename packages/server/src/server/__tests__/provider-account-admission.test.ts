import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import type { Logger } from "../../logger"
import type { OpenCodeClient } from "@opencode/client"
import { AccountSelectionFailed, ProviderAccountsService } from "../../provider-accounts/service"
import { registerInstanceProxyRoutes, type InstanceProxyWorkspaceManager } from "../http-server"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { createRuntimeFetch } from "../../opencode/compatibility/transport"

async function fixture() {
  const upstream = Fastify(), app = Fastify()
  const events: string[] = []
  const state = { fail: false, owned: true }
  upstream.all("/*", async () => { events.push("forward"); return {} })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}` }
  const workspace = { id: "w", path: "/project" }
  const client = { session: {
    get: async () => ({ id: "ses_fixture", location: { directory: "/project" } }),
    environment: async () => { events.push("environment") },
  } } as unknown as OpenCodeClient
  const connection = { endpoint, client, fetch: createRuntimeFetch(endpoint), assertCurrent: () => {},
    invalidate: () => {}, profile: async () => "modern" }
  const manager: InstanceProxyWorkspaceManager = {
    get: () => workspace as never, getSharedServiceConnection: async () => connection as never,
    getSharedServiceEndpoint: async () => endpoint as never, getInstanceAuthorizationHeader: () => "Basic private",
    getSharedServiceClient: async () => client, getServiceDirectory: () => "/project",
    getServiceDirectoryForPath: async (_id, directory) => directory === "/project" ? directory : undefined,
    getWorktreeIdentityForPath: async () => "/project", getSessionEnvironment: async () => ({}),
    ownsLocation: async () => state.owned, ownsDirectory: async () => true, ownsPath: async () => true,
  }
  const accounts = { beforeSend: async (_connection: unknown, _sessionID: string, _signal: AbortSignal, validate: (directory: string) => Promise<boolean>) => {
    events.push("selection"); assert.equal(await validate("/project"), true)
    if (state.fail) throw new AccountSelectionFailed()
  }, manual: () => { events.push("manual"); return () => { events.push("release") } } } as unknown as ProviderAccountsService
  registerInstanceProxyRoutes(app, { workspaceManager: manager, accounts, worktreeDeletionFence: new WorktreeDeletionFence(),
    logger: { debug() {}, error() {}, isLevelEnabled: () => false } as unknown as Logger })
  return { app, state, events, close: async () => { await app.close(); await upstream.close() } }
}

test("quota selection precedes prompt and command forwarding, never shell or foreign requests", async () => {
  const f = await fixture()
  try {
    for (const action of ["prompt", "command", "shell"]) {
      f.events.length = 0
      const response = await f.app.inject({ method: "POST", url: `/workspaces/w/instance/api/session/ses_fixture/${action}`,
        payload: action === "prompt" ? { text: "fixture" } : action === "command" ? { name: "fixture" } : { command: "fixture" } })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(f.events, action === "shell" ? ["environment", "forward"] : ["environment", "selection", "forward"])
    }
    f.events.length = 0; f.state.owned = false
    assert.equal((await f.app.inject({ method: "POST", url: "/workspaces/w/instance/api/session/ses_fixture/prompt", payload: { text: "fixture" } })).statusCode, 403)
    assert.deepEqual(f.events, [])
  } finally { await f.close() }
})

test("ambiguous activation failure blocks forwarding and manual switches fence their native write", async () => {
  const f = await fixture()
  try {
    f.state.fail = true
    const response = await f.app.inject({ method: "POST", url: "/workspaces/w/instance/api/session/ses_fixture/prompt", payload: { text: "fixture" } })
    assert.equal(response.statusCode, 502)
    assert.equal(response.json().error, "PROVIDER_ACCOUNT_SELECTION_FAILED")
    assert.deepEqual(f.events, ["environment", "selection"])
    f.events.length = 0
    assert.equal((await f.app.inject({ method: "POST", url: "/workspaces/w/instance/api/credential/cre_fixture/activate" })).statusCode, 200)
    assert.deepEqual(f.events, ["manual", "forward", "release"])
  } finally { await f.close() }
})
