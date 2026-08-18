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

async function harness(
  sessionDirectory = "/repo/worktree",
  activeSessions: Record<string, { type: "running" }> = {},
  sessionLocations: Record<string, string | Error> = {},
  workspacePath = "/repo",
  serviceDirectory = workspacePath,
  pathMappings: Record<string, string> = {},
  ptyDirectories: Record<string, string | Error> = {},
) {
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

  const owned = new Set([workspacePath, serviceDirectory, "/repo", "/repo/worktree"])
  const sessionGets: string[] = []
  const pathOwnershipChecks: string[] = []
  const servicePathCalls: string[] = []
  const client = {
    project: {
      list: async () => [
        { id: "owned-project", canonical: serviceDirectory, time: { created: 1, updated: 1 }, sandboxes: [sessionDirectory, "/other"] },
        { id: "foreign-project", canonical: "/other", time: { created: 1, updated: 1 }, sandboxes: [] },
      ],
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        sessionGets.push(sessionID)
        const location = sessionLocations[sessionID] ?? sessionDirectory
        if (location instanceof Error) throw location
        return { id: sessionID, location: { directory: location } } as SessionInfo
      },
      active: async () => activeSessions,
    },
    pty: {
      list: async () => ({
        location: { directory: serviceDirectory, project: { id: "project", directory: serviceDirectory, canonical: serviceDirectory } },
        data: Object.entries(ptyDirectories).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([id, cwd]) => ({
          id, title: id, command: "npm", args: ["run", "dev"], cwd, status: "running" as const, pid: 42,
        })),
      }),
      get: async ({ ptyID }: { ptyID: string }) => {
        const cwd = ptyDirectories[ptyID] ?? sessionDirectory
        if (cwd instanceof Error) throw cwd
        return { data: { id: ptyID, title: ptyID, command: "npm", args: ["run", "dev"], cwd, status: "running", pid: 42 } }
      },
    },
  } as OpenCodeClient
  const manager: InstanceProxyWorkspaceManager = {
    get: () => ({ id: "workspace", path: workspacePath }) as never,
    getSharedServiceEndpoint: async () => ({ url: `http://127.0.0.1:${address.port}` }),
    getInstanceAuthorizationHeader: () => "Basic internal-secret",
    getServiceDirectory: () => serviceDirectory,
    getServiceDirectoryForPath: async (_id, directory) => directory === workspacePath ? serviceDirectory : owned.has(directory) ? directory : undefined,
    getServicePathForPath: async (_id, candidate) => {
      assert.ok(pathOwnershipChecks.includes(candidate), "prompt path must be ownership-checked before translation")
      servicePathCalls.push(candidate)
      return pathMappings[candidate] ?? candidate
    },
    getSharedServiceClient: async () => client,
    ownsDirectory: async (_id, directory) => owned.has(directory),
    ownsPath: async (_id, candidate) => {
      pathOwnershipChecks.push(candidate)
      return candidate === "/repo" || candidate.startsWith("/repo/") || candidate in pathMappings
    },
  }
  const app = Fastify()
  apps.push(app)
  await app.register(replyFrom)
  registerInstanceProxyRoutes(app, { workspaceManager: manager, logger: logger() })
  await app.ready()
  return { app, servicePathCalls, sessionGets, requestCount: () => requests }
}

describe("instance proxy location enforcement", () => {
  it("filters the project list and its sandboxes to the workspace", async () => {
    const { app, requestCount } = await harness()
    const response = await app.inject({ method: "GET", url: "/workspaces/workspace/instance/api/project" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body), [{
      id: "owned-project",
      canonical: "/repo",
      time: { created: 1, updated: 1 },
      sandboxes: ["/repo/worktree"],
    }])
    assert.equal(requestCount(), 0)
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

  it("filters PTYs and rejects foreign PTY access", async () => {
    const { app, requestCount } = await harness("/repo/worktree", {}, {}, "/repo", "/repo", {}, {
      owned: "/repo/worktree",
      foreign: "/other",
    })

    const listed = await app.inject({
      method: "GET",
      url: "/workspaces/workspace/instance/api/pty?location%5Bdirectory%5D=%2Frepo%2Fworktree",
    })
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(JSON.parse(listed.body).data.map((pty: { id: string }) => pty.id), ["owned"])
    assert.equal((await app.inject({
      method: "GET",
      url: "/workspaces/workspace/instance/api/pty?location%5Bdirectory%5D=%2Fother",
    })).statusCode, 403)

    assert.equal((await app.inject({
      method: "GET",
      url: "/workspaces/workspace/instance/api/pty/foreign?location%5Bdirectory%5D=%2Frepo%2Fworktree",
    })).statusCode, 403)
    assert.equal(requestCount(), 0)
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
        "x-opencode-directory": "/other",
        "x-opencode-workspace": "foreign-workspace",
        "x-opencode-routing-test": "foreign-route",
        "x-remove-me": "secret",
      },
    })
    const headers = JSON.parse(response.body).headers
    assert.equal(headers.authorization, "Basic internal-secret")
    assert.equal(headers.cookie, undefined)
    assert.doesNotMatch(headers.connection ?? "", /x-remove-me/i)
    assert.equal(headers["x-forwarded-for"], undefined)
    assert.equal(headers["x-opencode-directory"], undefined)
    assert.equal(headers["x-opencode-workspace"], undefined)
    assert.equal(headers["x-opencode-routing-test"], undefined)
    assert.equal(headers["x-remove-me"], undefined)
    assert.equal(response.headers["set-cookie"], undefined)
  })

  it("rejects sessions owned by another workspace", async () => {
    const { app, requestCount } = await harness("/other")
    const response = await app.inject({ method: "DELETE", url: "/workspaces/workspace/instance/api/session/session-2" })
    assert.equal(response.statusCode, 403)
    assert.equal(requestCount(), 0)
    assert.doesNotMatch(response.body, /internal-secret/)
  })

  it("rejects deletion through a double-encoded alias of a foreign session", async () => {
    const { app, sessionGets, requestCount } = await harness("/repo/worktree", {}, {
      "foreign%25session": "/other",
    })
    const response = await app.inject({
      method: "DELETE",
      url: "/workspaces/workspace/instance/api/session/foreign%2525session",
    })
    assert.equal(response.statusCode, 403)
    assert.deepEqual(sessionGets, ["foreign%25session"])
    assert.equal(requestCount(), 0)
  })

  it("filters active sessions to the workspace without failing on stale ids", async () => {
    const active = { owned: { type: "running" as const }, foreign: { type: "running" as const }, stale: { type: "running" as const } }
    const { app, sessionGets, requestCount } = await harness("/repo/worktree", active, {
      foreign: "/other",
      stale: new Error("missing"),
    })
    const response = await app.inject({ method: "GET", url: "/workspaces/workspace/instance/api/session/active" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body), { owned: { type: "running" } })
    assert.deepEqual(sessionGets.sort(), ["foreign", "owned", "stale"])
    assert.equal(requestCount(), 0)
  })

  it("blocks global routes through a workspace", async () => {
    const { app, requestCount } = await harness()
    for (const route of ["global/dispose", "global/config", "global/upgrade"]) {
      const response = await app.inject({ method: "POST", url: `/workspaces/workspace/instance/${route}` })
      assert.equal(response.statusCode, 403)
    }
    for (const route of ["event", "debug/location"]) {
      const response = await app.inject({ method: "GET", url: `/workspaces/workspace/instance/api/${route}` })
      assert.equal(response.statusCode, 403)
    }
    assert.equal((await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/service/stop",
      payload: { instanceID: "instance-1" },
    })).statusCode, 403)
    assert.equal((await app.inject({ method: "GET", url: "/workspaces/workspace/instance/api/permission/saved" })).statusCode, 403)
    assert.equal((await app.inject({ method: "DELETE", url: "/workspaces/workspace/instance/api/permission/saved/global-rule" })).statusCode, 403)
    assert.equal(requestCount(), 0)
  })

  it("rejects literal and encoded dot-segment aliases before authorization", async () => {
    const { app, sessionGets, requestCount } = await harness("/other")
    for (const route of [
      "api/session/owned/%2e%2e/foreign",
      "api/session/owned/%252e%252e/%252e%252e/event",
      "api/session/owned/../../debug/location",
    ]) {
      const response = await app.inject({ method: "GET", url: `/workspaces/workspace/instance/${route}` })
      assert.ok([400, 403, 404].includes(response.statusCode), `${route}: ${response.statusCode}`)
    }
    assert.deepEqual(sessionGets, ["foreign"])
    assert.equal(requestCount(), 0)
  })

  it("validates prompt file ownership before translating root, worktree, and Windows URIs", async () => {
    const mappings = {
      "/repo/notes.txt": "/home/dev/repo/notes.txt",
      "/repo/worktree/notes.txt": "/home/dev/worktree/notes.txt",
      "C:/repo/notes.txt": "/mnt/c/repo/notes.txt",
    }
    const { app, servicePathCalls, requestCount } = await harness("/repo/worktree", {}, {}, "/repo", "/repo", mappings)
    const malformed = await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/session/session-1/prompt",
      payload: { text: "read this", files: [{ uri: "file:///%ZZ" }] },
    })
    assert.equal(malformed.statusCode, 400)

    const foreign = await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/session/session-1/prompt",
      payload: { text: "read this", files: [{ uri: "file:///other/secret.txt" }] },
    })
    assert.equal(foreign.statusCode, 403)
    const traversed = await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/session/session-1/prompt",
      payload: { text: "read this", files: [{ uri: "file:///repo/worktree/../../other/secret.txt" }] },
    })
    assert.equal(traversed.statusCode, 403)
    assert.equal(requestCount(), 0)
    assert.deepEqual(servicePathCalls, [])

    const owned = await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/session/session-1/prompt",
      payload: { text: "read this", files: [
        { uri: "file:///repo/notes.txt" },
        { uri: "file:///repo/worktree/notes.txt" },
        { uri: "file:///C:/repo/notes.txt" },
      ] },
    })
    assert.equal(owned.statusCode, 200)
    assert.deepEqual(JSON.parse(owned.body).body.files.map((file: { uri: string }) => file.uri), [
      "file:///home/dev/repo/notes.txt",
      "file:///home/dev/worktree/notes.txt",
      "file:///mnt/c/repo/notes.txt",
    ])
    assert.deepEqual(servicePathCalls, Object.keys(mappings))
    assert.equal(requestCount(), 1)
  })

  it("defaults and validates only schema-defined imported session locations", async () => {
    const { app, requestCount } = await harness()
    const accepted = await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/session/import",
      payload: {
        info: { id: "session-1", metadata: { location: { directory: "/other" } } },
        messages: [{
          type: "location-switched",
          location: { directory: "/repo/worktree" },
          previous: { location: null },
          metadata: { location: { directory: "/other" } },
          content: [{ type: "tool", state: { input: { location: "/other" } } }],
        }],
      },
    })
    assert.equal(accepted.statusCode, 200)
    const body = JSON.parse(accepted.body).body
    assert.deepEqual(body.location, { directory: "/repo" })
    assert.deepEqual(body.info.location, { directory: "/repo" })
    assert.deepEqual(body.messages[0].previous.location, { directory: "/repo" })
    assert.deepEqual(body.messages[0].metadata.location, { directory: "/other" })
    assert.equal(body.messages[0].content[0].state.input.location, "/other")

    const rejected = await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/session/import",
      payload: {
        info: { id: "session-2", location: { directory: "/repo" } },
        messages: [{ type: "location-switched", location: { directory: "/repo/worktree" }, previous: { location: { directory: "/other" } } }],
      },
    })
    assert.equal(rejected.statusCode, 403)
    assert.equal(requestCount(), 1)
  })

  it("never sends workspace credentials to an encoded or backslash foreign origin", async () => {
    const foreign = Fastify()
    apps.push(foreign)
    const credentials: unknown[] = []
    foreign.all("/*", async (request) => credentials.push(request.headers.authorization))
    await foreign.listen({ host: "127.0.0.1", port: 0 })
    const address = foreign.server.address()
    assert.ok(address && typeof address === "object")

    const { app, requestCount } = await harness()
    for (const prefix of ["%2F%2F", "%5C%5C"]) {
      const proxyResponse: Awaited<ReturnType<typeof app.inject>> = await app.inject({
        method: "GET",
        url: `/workspaces/workspace/instance/${prefix}127.0.0.1:${address.port}/steal`,
      })
      assert.equal(proxyResponse.statusCode, 400)
      assert.doesNotMatch(proxyResponse.body, /internal-secret/)
    }
    assert.equal(requestCount(), 0)
    assert.deepEqual(credentials, [])
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
