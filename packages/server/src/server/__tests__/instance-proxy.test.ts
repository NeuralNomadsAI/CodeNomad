import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import replyFrom from "@fastify/reply-from"
import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import type { Logger } from "../../logger"
import { redactSecrets, registerInstanceProxyRoutes, type InstanceProxyWorkspaceManager } from "../http-server"

const apps: FastifyInstance[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

function logger(): Logger {
  const value = { debug() {}, trace() {}, error() {}, isLevelEnabled() { return false } }
  return value as unknown as Logger
}

async function harness(sessionDirectory = "/repo/worktree") {
  const upstream = Fastify()
  apps.push(upstream)
  let requests = 0
  upstream.all("/*", async (request, reply) => {
    requests++
    reply.header("set-cookie", "upstream_session=secret; Path=/")
    return { url: request.raw.url, body: request.body, headers: request.headers }
  })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const address = upstream.server.address()
  assert.ok(address && typeof address === "object")

  const owned = new Set(["/repo", "/repo/worktree"])
  const sessionGets: string[] = []
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        sessionGets.push(sessionID)
        return { id: sessionID, location: { directory: sessionDirectory } } as SessionInfo
      },
    },
  } as OpenCodeClient
  const manager: InstanceProxyWorkspaceManager = {
    get: () => ({ id: "workspace", path: "/repo" }) as never,
    getSharedServiceEndpoint: async () => ({ url: `http://127.0.0.1:${address.port}` }),
    getInstanceAuthorizationHeader: () => "Basic internal-secret",
    getSharedServiceClient: async () => client,
    ownsDirectory: async (_id, directory) => owned.has(directory),
  }
  const app = Fastify()
  apps.push(app)
  await app.register(replyFrom)
  registerInstanceProxyRoutes(app, { workspaceManager: manager, logger: logger() })
  await app.ready()
  return { app, sessionGets, requestCount: () => requests }
}

describe("instance proxy location enforcement", () => {
  it("preserves an owned worktree for session list and create", async () => {
    const { app } = await harness()
    const listed = await app.inject({
      method: "GET",
      url: "/workspaces/workspace/instance/api/session?directory=%2Frepo%2Fworktree&limit=5",
    })
    assert.equal(listed.statusCode, 200)
    assert.equal(JSON.parse(listed.body).url, "/api/session?directory=%2Frepo%2Fworktree&limit=5")

    const created = await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/session",
      payload: { title: "test", location: { directory: "/repo/worktree", workspaceID: "worktree" } },
    })
    assert.equal(created.statusCode, 200)
    assert.deepEqual(JSON.parse(created.body).body.location, { directory: "/repo/worktree", workspaceID: "worktree" })
  })

  it("defaults session list and create to the workspace root", async () => {
    const { app } = await harness()
    const listed = await app.inject({ method: "GET", url: "/workspaces/workspace/instance/api/session" })
    assert.equal(JSON.parse(listed.body).url, "/api/session?directory=%2Frepo")

    const created = await app.inject({ method: "POST", url: "/workspaces/workspace/instance/api/session", payload: { title: "test" } })
    assert.deepEqual(JSON.parse(created.body).body.location, { directory: "/repo" })
  })

  it("rejects arbitrary locations instead of overwriting them", async () => {
    const { app, requestCount } = await harness()
    const bodyResponse = await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/session",
      payload: { location: { directory: "/other" } },
    })
    const queryResponse = await app.inject({
      method: "GET",
      url: "/workspaces/workspace/instance/api/session?directory=%2Fother",
    })
    assert.equal(bodyResponse.statusCode, 403)
    assert.equal(queryResponse.statusCode, 403)
    assert.equal(requestCount(), 0)
    assert.doesNotMatch(bodyResponse.body, /internal-secret/)
  })

  it("accepts owned and rejects unowned native shell and pty cwd values", async () => {
    const { app, requestCount } = await harness()
    for (const route of ["shell", "pty"]) {
      const accepted = await app.inject({ method: "POST", url: `/workspaces/workspace/instance/api/${route}`, payload: { cwd: "/repo/worktree" } })
      const rejected = await app.inject({ method: "POST", url: `/workspaces/workspace/instance/api/${route}`, payload: { cwd: "/other" } })
      assert.equal(accepted.statusCode, 200)
      assert.equal(rejected.statusCode, 403)
    }
    assert.equal(requestCount(), 2)
  })

  it("strips browser session and hop-by-hop headers in both directions", async () => {
    const { app } = await harness()
    const response = await app.inject({
      method: "GET",
      url: "/workspaces/workspace/instance/api/session",
      headers: {
        authorization: "Bearer browser-secret",
        connection: "keep-alive, x-remove-me",
        cookie: "codenomad_session=browser-secret; other=value",
        "x-forwarded-for": "203.0.113.1",
        "x-remove-me": "secret",
      },
    })
    const headers = JSON.parse(response.body).headers
    assert.equal(headers.authorization, "Basic internal-secret")
    assert.equal(headers.cookie, undefined)
    assert.doesNotMatch(headers.connection ?? "", /x-remove-me/i)
    assert.equal(headers["x-forwarded-for"], undefined)
    assert.equal(headers["x-remove-me"], undefined)
    assert.equal(response.headers["set-cookie"], undefined)
  })

  it("authorizes location-less session routes through the shared client", async () => {
    const { app, sessionGets, requestCount } = await harness()
    const response = await app.inject({ method: "GET", url: "/workspaces/workspace/instance/api/session/session-1/message" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(sessionGets, ["session-1"])
    assert.equal(requestCount(), 1)
  })

  it("rejects sessions owned by another workspace", async () => {
    const { app, requestCount } = await harness("/other")
    const response = await app.inject({ method: "DELETE", url: "/workspaces/workspace/instance/api/session/session-2" })
    assert.equal(response.statusCode, 403)
    assert.equal(requestCount(), 0)
    assert.doesNotMatch(response.body, /internal-secret/)
  })
})

it("redacts secret-bearing fields recursively", () => {
  assert.deepEqual(redactSecrets({
    authorization: "Basic internal-secret",
    apiKey: "key-value",
    nested: { authorizationCode: "code-value", password: "password-value", safe: "visible", retries: 2 },
    items: [{ accessToken: "token-value" }, { clientSecret: "secret-value" }],
  }), {
    authorization: "<redacted>",
    apiKey: "<redacted>",
    nested: { authorizationCode: "<redacted>", password: "<redacted>", safe: "visible", retries: 2 },
    items: [{ accessToken: "<redacted>" }, { clientSecret: "<redacted>" }],
  })
})
