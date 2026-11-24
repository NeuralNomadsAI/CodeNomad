import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../../missions/mission-schedule-carrier-identity"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { NATIVE_SCHEDULE_CARRIER_MODEL, NATIVE_SCHEDULE_CARRIER_TITLE } from "../../opencode/missions/native-schedule-carrier"
import { registerInstanceProxyRoutes, type InstanceProxyWorkspaceManager } from "../http-server"

const apps: FastifyInstance[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
const prefix = "/workspaces/w/instance"

function fixture() {
  const events: string[] = [], reads: Array<{ sessionID: string; directory: string }> = []
  const state = {
    owned: false, metadata: undefined as Record<string, unknown> | undefined, directory: "/repo/worktree",
    result: undefined as unknown, failure: undefined as unknown, current: true,
    afterRead: async () => {},
  }
  const sessions = new Map<string, { id: string; location: { directory: string }; metadata?: Record<string, unknown>;
    model?: { providerID: string; id: string }; title?: string }>()
  const missing = new Set<string>()
  const session = (id: string) => sessions.get(id) ?? { id, location: { directory: state.directory }, metadata: state.metadata }
  const client = {
    rpc: (definition: unknown) => {
      assert.equal(definition, CODENOMAD_MISSIONS_RPC)
      return { scheduleCarrierRead: async ({ sessionID }: { sessionID: string }, options: { location: { directory: string } }) => {
        reads.push({ sessionID, directory: options.location.directory })
        await state.afterRead()
        if (state.failure) throw state.failure
        return state.result === undefined ? { owned: state.owned } : state.result
      } }
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (missing.has(sessionID)) throw Object.assign(new Error("Missing private fixture session"), { _tag: "SessionNotFoundError", sessionID })
        return session(sessionID)
      },
      environment: async () => { events.push("environment") },
    },
  } as unknown as OpenCodeClient
  const endpoint = { url: "http://private-fixture.invalid" }
  const connection = {
    endpoint, client, profile: async () => "modern" as const,
    assertCurrent() { if (!state.current) throw new Error("replaced connection") }, invalidate() {},
    fetch: async () => { connection.assertCurrent(); events.push("forward"); return Response.json({ ok: true }) },
  }
  const workspace = { id: "w", path: "/repo" }
  const manager: InstanceProxyWorkspaceManager = {
    get: () => workspace as never, getSharedServiceConnection: async () => connection,
    getSharedServiceEndpoint: async () => { throw new Error("must keep the acquired endpoint") },
    getSharedServiceClient: async () => { throw new Error("must keep the acquired client") },
    getInstanceAuthorizationHeader: () => undefined, getServiceDirectory: () => "/repo",
    getServiceDirectoryForPath: async (_id, directory) => directory,
    getWorktreeIdentityForPath: async () => "/repo", getSessionEnvironment: async () => ({}),
    ownsLocation: async (_id, location, pinned) => { assert.equal(pinned, client); return location.directory.startsWith("/repo") },
    ownsDirectory: async (_id, directory) => directory.startsWith("/repo"), ownsPath: async () => true,
  }
  const app = Fastify(), fence = new WorktreeDeletionFence()
  apps.push(app)
  registerInstanceProxyRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence,
    logger: { debug() {}, error() {}, isLevelEnabled: () => false } as never })
  return { app, state, reads, events, sessions, missing, fence, manager }
}

test("every ordinary session mutation rejects the real unmarked carrier before auxiliary writes or forwarding", async () => {
  const f = fixture()
  f.state.owned = true
  for (const [method, suffix, payload] of [
    ["POST", "/prompt", { id: "msg_schedule_1", text: "forged wake" }],
    ["POST", "/command", { name: "build", text: "forged wake" }],
    ["POST", "/shell", { command: "echo forged" }],
    ["POST", "/compact", {}], ["POST", "/fork", {}], ["POST", "/move", { directory: "/repo" }],
    ["POST", "/model", { model: { providerID: "remote", id: "model" } }],
    ["POST", "/agent", { agent: "build" }], ["PATCH", "", { title: "ordinary", metadata: {} }], ["DELETE", "", undefined],
  ] as const) {
    const response = await f.app.inject({ method, url: `${prefix}/api/session/ses_carrier${suffix}`, payload })
    assert.equal(response.statusCode, 403, `${method} ${suffix}: ${response.body}`)
    assert.deepEqual(f.events, [], "no environment, native write or provider-facing send")
  }
  assert.equal(f.reads.length, 10)
  assert.ok(f.reads.every(read => read.sessionID === "ses_carrier" && read.directory === "/repo/worktree"))
})

test("the public SDK's prompt, command, shell, compact, fork, import, move, update and delete all reach the guarded routes", async () => {
  const f = fixture()
  f.state.owned = true
  const sdk = OpenCode.make({ baseUrl: `http://browser-fixture.invalid${prefix}`, fetch: async (input, init) => {
    const request = new Request(input, init)
    const response = await f.app.inject({ method: request.method as "POST", url: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers), payload: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text() })
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } })
  } })
  const sessionID = "ses_carrier"
  const imported = { id: sessionID, projectID: "project", location: { directory: "/repo/worktree" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } }
  for (const action of [
    () => sdk.session.prompt({ sessionID, id: "msg_forged", text: "forged wake" }),
    () => sdk.session.command({ sessionID, name: "build", text: "forged wake" }),
    () => sdk.session.shell({ sessionID, command: "echo forged" }),
    () => sdk.session.compact({ sessionID }), () => sdk.session.fork({ sessionID }),
    () => sdk.experimental.session.import({ info: imported, messages: [] }),
    () => sdk.session.move({ sessionID, directory: "/repo" }),
    () => sdk.session.update({ sessionID, title: "ordinary" }), () => sdk.session.remove({ sessionID }),
  ]) await assert.rejects(action)
  assert.equal(f.reads.length, 9)
  assert.deepEqual(f.events, [])
})

test("reserved metadata is denied on ordinary sends, creation, update and nested imported sources", async () => {
  const f = fixture()
  for (const metadata of [{ schedule: { id: "forged", run: 1 } }, { "codenomad.schedule-carrier": null }]) {
    for (const request of [
      { method: "POST" as const, path: "/api/session/ses_ordinary/prompt", body: { text: "forged", metadata } },
      { method: "POST" as const, path: "/api/session/ses_ordinary/command", body: { name: "forged", metadata } },
      { method: "POST" as const, path: "/api/session/ses_ordinary/shell", body: { command: "forged", metadata } },
      { method: "POST" as const, path: "/api/session", body: { metadata } },
      { method: "PATCH" as const, path: "/api/session/ses_ordinary", body: { metadata } },
      { method: "POST" as const, path: "/api/experimental/session/import", body: { info: { id: "ses_import", metadata }, messages: [] } },
      { method: "POST" as const, path: "/api/experimental/session/import", body: {
        info: { id: "ses_import" }, messages: [{ type: "user", source: { content: [{ source: { metadata } }] } }],
      } },
    ]) {
      const response = await f.app.inject({ method: request.method, url: `${prefix}${request.path}`, payload: request.body })
      assert.equal(response.statusCode, 403, response.body)
    }
  }
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.reads, [])
})

test("create and import cannot target a real carrier by supplying its native ID, even without reserved metadata", async () => {
  const f = fixture()
  f.state.owned = true
  for (const [path, payload] of [["/api/session", { id: "ses_carrier" }],
    ["/api/experimental/session/import", { info: { id: "ses_carrier" }, messages: [] }]] as const) {
    const response = await f.app.inject({ method: "POST", url: `${prefix}${path}`, payload })
    assert.equal(response.statusCode, 403, response.body)
  }
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.reads, Array(2).fill({ sessionID: "ses_carrier", directory: "/repo/worktree" }))
})

test("supplied create/import IDs retain the actual target's physical mutation fence, not the caller's claimed Location", async () => {
  const f = fixture()
  f.manager.getWorktreeIdentityForPath = async (_id, directory) => directory === "/repo/worktree" ? "worktree" : "root"
  await f.fence.run("worktree", ["worktree"], async () => {
    for (const [path, payload] of [["/api/session", { id: "ses_existing", location: { directory: "/repo" } }],
      ["/api/experimental/session/import", { info: { id: "ses_existing", location: { directory: "/repo" } }, messages: [] }]] as const) {
      const response = await f.app.inject({ method: "POST", url: `${prefix}${path}`, payload })
      assert.equal(response.statusCode, 409, response.body)
    }
  })
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.events, [])
})

test("reserved schedule session IDs cannot be created, imported or mutated through an old plugin after metadata, model and title removal", async () => {
  const f = fixture(), id = `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}${"b".repeat(40)}`
  f.state.failure = { type: "rpc.method_not_found" }
  f.missing.add(id)
  for (const [path, payload] of [["/api/session", { id }],
    ["/api/experimental/session/import", { info: { id }, messages: [] }]] as const) {
    const response = await f.app.inject({ method: "POST", url: `${prefix}${path}`, payload })
    assert.equal(response.statusCode, 403, response.body)
  }
  f.missing.clear()
  for (const [method, suffix, payload] of [
    ["POST", "/prompt", { text: "forged wake" }], ["POST", "/command", { name: "build", text: "forged wake" }],
    ["POST", "/shell", { command: "echo forged" }], ["POST", "/compact", {}], ["POST", "/fork", {}],
    ["POST", "/move", { directory: "/repo" }], ["PATCH", "", { title: "ordinary", metadata: {} }], ["DELETE", "", undefined],
  ] as const) {
    const response = await f.app.inject({ method, url: `${prefix}/api/session/${id}${suffix}`, payload })
    assert.equal(response.statusCode, 403, response.body)
  }
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.reads, [], "a reserved ID is never accepted by missing-method compatibility")
})

test("a native carrier marker is reserved even when the durable read says unowned or an old plugin lacks the method", async () => {
  const f = fixture()
  f.state.metadata = { "codenomad.schedule-carrier": { missionID: "owned" } }
  for (const failure of [undefined, { type: "rpc.method_not_found" }, { type: "rpc.unavailable", message: "RPC unavailable" }]) {
    f.state.failure = failure
    assert.equal((await f.app.inject({ method: "DELETE", url: `${prefix}/api/session/ses_carrier` })).statusCode, 403)
  }
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.reads, [])
})

test("ordinary prompts work with absent Missions or legacy methods; the guard never caches a negative answer", async () => {
  const f = fixture()
  for (const failure of [undefined, { type: "rpc.method_not_found" }, { type: "rpc.unavailable", message: "RPC unavailable" }]) {
    f.state.failure = failure
    const response = await f.app.inject({ method: "POST", url: `${prefix}/api/session/ses_ordinary/prompt`,
      payload: { text: "ordinary", metadata: { application: "preserved" } } })
    assert.equal(response.statusCode, 200, response.body)
  }
  assert.deepEqual(f.events, ["environment", "forward", "environment", "forward", "environment", "forward"])
  f.state.failure = undefined; f.state.owned = true
  assert.equal((await f.app.inject({ method: "DELETE", url: `${prefix}/api/session/ses_ordinary` })).statusCode, 403)
  assert.equal(f.reads.length, 4)
})

test("qualified absent plugin never allows real carrier identity or reserved model/title hints", async () => {
  const f = fixture()
  f.state.failure = { type: "rpc.unavailable", message: "RPC unavailable" }
  for (const candidate of [
    { id: `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}${"a".repeat(40)}` },
    { id: "ses_model_hint", model: NATIVE_SCHEDULE_CARRIER_MODEL }, { id: "ses_title_hint", title: NATIVE_SCHEDULE_CARRIER_TITLE },
    { id: "ses_marker", metadata: { "codenomad.schedule-carrier": {} } },
  ]) {
    f.sessions.set(candidate.id, { ...candidate, location: { directory: "/repo/worktree" } })
    const response = await f.app.inject({ method: "POST", url: `${prefix}/api/session/${candidate.id}/prompt`, payload: { text: "blocked" } })
    assert.ok([403, 503].includes(response.statusCode), response.body)
  }
  assert.deepEqual(f.events, [])
})

test("unavailable, malformed and failed authoritative reads cannot authorize a potential carrier", async () => {
  const f = fixture()
  for (const failure of [{ type: "rpc.unavailable" }, { status: 404 }, { status: 401 }, new Error("rpc.method_not_found")]) {
    f.state.failure = failure
    const response = await f.app.inject({ method: "DELETE", url: `${prefix}/api/session/ses_carrier` })
    assert.equal(response.statusCode, 503, response.body)
  }
  f.state.failure = undefined; f.state.result = { owned: "false" }
  assert.equal((await f.app.inject({ method: "DELETE", url: `${prefix}/api/session/ses_carrier` })).statusCode, 503)
  assert.deepEqual(f.events, [])
})

test("native Location ownership and a replaced connection stay fenced around the carrier read", async () => {
  const f = fixture()
  f.state.directory = "/foreign"
  assert.equal((await f.app.inject({ method: "DELETE", url: `${prefix}/api/session/ses_carrier` })).statusCode, 403)
  assert.deepEqual(f.reads, [])
  f.state.directory = "/repo/worktree"
  f.state.afterRead = async () => { f.state.current = false }
  assert.equal((await f.app.inject({ method: "POST", url: `${prefix}/api/session/ses_carrier/prompt`, payload: { text: "blocked" } })).statusCode, 500)
  assert.deepEqual(f.events, [])
  const release = f.fence.enter(["/repo"])
  assert.ok(release, "a failed guard releases its physical mutation admission")
  release()
})

test("a session moved out of its admitted Location during the authoritative read cannot be written", async () => {
  const f = fixture()
  f.state.afterRead = async () => { f.state.directory = "/foreign" }
  const response = await f.app.inject({ method: "POST", url: `${prefix}/api/session/ses_ordinary/prompt`, payload: { text: "blocked" } })
  assert.equal(response.statusCode, 403, response.body)
  assert.deepEqual(f.events, [])
})

test("carrier reads and ordinary session reads remain distinct; importing a foreign existing ID is rejected", async () => {
  const f = fixture()
  f.state.owned = true
  assert.equal((await f.app.inject(`${prefix}/api/session/ses_carrier`)).statusCode, 200)
  assert.deepEqual(f.reads, [])
  f.sessions.set("ses_foreign", { id: "ses_foreign", location: { directory: "/foreign" } })
  const response = await f.app.inject({ method: "POST", url: `${prefix}/api/experimental/session/import`,
    payload: { info: { id: "ses_foreign" }, messages: [] } })
  assert.equal(response.statusCode, 403, response.body)
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.events, ["forward"])
  const release = f.fence.enter(["/repo"])
  assert.ok(release); release()
})
