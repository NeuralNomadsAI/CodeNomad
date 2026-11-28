import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../../missions/mission-schedule-carrier-identity"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { markDispatchHookAwareFetch } from "../../opencode/compatibility/transport"
import { rememberRuntime } from "../../opencode/compatibility/runtime"
import { MINIMUM_OPENCODE_VERSION, UnsupportedOpenCodeError } from "../../opencode/runtime-support"
import { OpenCodeSharedService } from "../../workspaces/opencode-service"
import { ROUTER_OPTIONS } from "../routed-path"

const NATIVE_SCHEDULE_CARRIER_MODEL = { providerID: "codenomad-missions-local", id: "schedule-noop" }, NATIVE_SCHEDULE_CARRIER_TITLE = "Mission schedule carrier"
import { registerInstanceProxyRoutes, type InstanceProxyWorkspaceManager } from "../http-server"

const apps: FastifyInstance[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
const prefix = "/workspaces/w/instance"

function fixture() {
  const events: string[] = []
  const uncertainSessions: string[] = []
  const state = {
    metadata: undefined as Record<string, unknown> | undefined, directory: "/repo/worktree",
    locationWorkspaceID: undefined as string | undefined,
    projectID: "project-a",
    parentID: undefined as string | null | undefined,
    createdAt: 1,
    fork: undefined as Record<string, unknown> | undefined,
    current: true,
    connectionError: undefined as unknown,
    profileError: undefined as unknown,
    usePlainFetch: false,
    beforeFetchCheck: async () => {},
  }
  const sessions = new Map<string, { id: string; location: { directory: string; workspaceID?: string }; projectID?: string; parentID?: string | null; fork?: Record<string, unknown>; time?: { created: number }; metadata?: Record<string, unknown>;
    model?: { providerID: string; id: string }; title?: string }>()
  const missing = new Set<string>()
  const session = (id: string) => sessions.get(id) ?? {
    id,
    projectID: state.projectID,
    ...(state.parentID !== undefined ? { parentID: state.parentID } : {}),
    fork: state.fork,
    time: { created: state.createdAt },
    location: state.locationWorkspaceID !== undefined
      ? { directory: state.directory, workspaceID: state.locationWorkspaceID }
      : { directory: state.directory },
    metadata: state.metadata,
  }
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (missing.has(sessionID)) throw Object.assign(new Error("Missing private fixture session"), { _tag: "SessionNotFoundError", sessionID })
        return session(sessionID)
      },
      environment: async () => { events.push("environment") },
    },
  } as unknown as OpenCodeClient
  const endpoint = { url: "http://private-fixture.invalid" }
  const hookAwareFetch = markDispatchHookAwareFetch(async (
    _input: unknown,
    _init?: unknown,
    _media?: unknown,
    dispatchHooks?: { beforeFetch?: () => Promise<void>; onDispatch?: () => void },
  ) => {
    await state.beforeFetchCheck()
    await dispatchHooks?.beforeFetch?.()
    connection.assertCurrent()
    dispatchHooks?.onDispatch?.()
    events.push("forward")
    return Response.json({ ok: true })
  })
  const plainFetch = async () => {
    events.push("plain-forward")
    return Response.json({ ok: true })
  }
  const connection = {
    endpoint, client, profile: async () => { if (state.profileError) throw state.profileError; return "modern" as const },
    assertCurrent() { if (!state.current) throw new Error("replaced connection") }, invalidate() {},
    get fetch() {
      return state.usePlainFetch ? plainFetch : hookAwareFetch
    },
  }
  const workspace = { id: "w", path: "/repo" }
  const manager: InstanceProxyWorkspaceManager = {
    get: (id: string) => (id === "w" ? workspace : undefined) as never,
    getSharedServiceConnection: async () => { if (state.connectionError) throw state.connectionError; return connection },
    getSharedServiceEndpoint: async () => { throw new Error("must keep the acquired endpoint") },
    getSharedServiceClient: async () => { throw new Error("must keep the acquired client") },
    getInstanceAuthorizationHeader: () => undefined, getServiceDirectory: () => "/repo",
    getServiceDirectoryForPath: async (_id, directory) => directory,
    getWorktreeIdentityForPath: async () => "/repo", getSessionEnvironment: async () => ({}),
    ownsLocation: async (_id, location, pinned) => { assert.equal(pinned, client); return location.directory.startsWith("/repo") },
    ownsDirectory: async (_id, directory) => directory.startsWith("/repo"), ownsPath: async () => true,
  }
  const app = Fastify({ routerOptions: ROUTER_OPTIONS }), fence = new WorktreeDeletionFence()
  apps.push(app)
  registerInstanceProxyRoutes(app, {
    workspaceManager: manager,
    worktreeDeletionFence: fence,
    sessionCleanup: {
      enterMutation: () => () => {},
      markUncertain: (sessionId: string) => { uncertainSessions.push(sessionId) },
    } as never,
    logger: { debug() {}, error() {}, isLevelEnabled: () => false } as never,
  })
  return { app, state, events, sessions, missing, fence, manager, uncertainSessions }
}

test("the public SDK's prompt, command, shell, compact, fork, import, move, update and delete all reach the guarded routes", async () => {
  const f = fixture()
  const sdk = OpenCode.make({ baseUrl: `http://browser-fixture.invalid${prefix}`, fetch: async (input, init) => {
    const request = new Request(input, init)
    const response = await f.app.inject({ method: request.method as "POST", url: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers), payload: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text() })
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } })
  } })
  const sessionID = `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}calendar_abc`
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
  assert.deepEqual(f.events, [])
})

test("reserved schedule session IDs cannot be created, imported or mutated after metadata, model and title removal", async () => {
  const f = fixture(), id = `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}${"b".repeat(40)}`
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
})

test("a native carrier marker is reserved", async () => {
  const f = fixture()
  f.state.metadata = { "codenomad.schedule-carrier": { missionID: "owned" } }
  assert.equal((await f.app.inject({ method: "DELETE", url: `${prefix}/api/session/ses_carrier` })).statusCode, 403)
  assert.deepEqual(f.events, [])
})

test("an ordinary prompt is forwarded with its metadata", async () => {
  const f = fixture()
  const response = await f.app.inject({ method: "POST", url: `${prefix}/api/session/ses_ordinary/prompt`,
    payload: { text: "ordinary", metadata: { application: "preserved" } } })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(f.events, ["environment", "forward"])
})

test("a carrier's reserved ID, model, title or marker refuses ordinary input", async () => {
  const f = fixture()
  for (const candidate of [
    { id: `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}${"a".repeat(40)}` },
    { id: "ses_model_hint", model: NATIVE_SCHEDULE_CARRIER_MODEL }, { id: "ses_title_hint", title: NATIVE_SCHEDULE_CARRIER_TITLE },
    { id: "ses_marker", metadata: { "codenomad.schedule-carrier": {} } },
  ]) {
    f.sessions.set(candidate.id, { ...candidate, location: { directory: "/repo/worktree" } })
    const response = await f.app.inject({ method: "POST", url: `${prefix}/api/session/${candidate.id}/prompt`, payload: { text: "blocked" } })
    assert.equal(response.statusCode, 403, response.body)
  }
  assert.deepEqual(f.events, [])
})

test("session reads are forwarded; importing a foreign existing ID is rejected", async () => {
  const f = fixture()
  assert.equal((await f.app.inject(`${prefix}/api/session/ses_carrier`)).statusCode, 200)
  f.sessions.set("ses_foreign", { id: "ses_foreign", location: { directory: "/foreign" } })
  const response = await f.app.inject({ method: "POST", url: `${prefix}/api/experimental/session/import`,
    payload: { info: { id: "ses_foreign" }, messages: [] } })
  assert.equal(response.statusCode, 403, response.body)
  assert.deepEqual(f.events, ["forward"])
  const release = f.fence.enter(["/repo"])
  assert.ok(release); release()
})

test("late beforeFetch connection replacement rejects prompt with 502 before dispatch without markUncertain", async () => {
  const f = fixture()
  f.state.beforeFetchCheck = async () => { f.state.current = false }
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_late_fail/prompt`,
    payload: { text: "blocked before send" },
  })
  assert.equal(response.statusCode, 502, response.body)
  assert.equal(response.headers["x-codenomad-before-dispatch"], "1")
  assert.deepEqual(response.json(), { error: "opencode_unavailable_before_send" })
  assert.deepEqual(f.events, ["environment"])
  assert.deepEqual(f.uncertainSessions, [])
})

test("service acquisition and profile negotiation failures classify as marked 502 before dispatch", async () => {
  const f = fixture()
  f.state.connectionError = new Error("service starting")
  const first = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_acq_fail/prompt`,
    payload: { text: "blocked during acquisition" },
  })
  assert.equal(first.statusCode, 502, first.body)
  assert.equal(first.headers["x-codenomad-before-dispatch"], "1")
  assert.deepEqual(first.json(), { error: "opencode_unavailable_before_send" })
  assert.deepEqual(f.events, [])

  f.state.connectionError = undefined
  f.state.profileError = new Error("negotiation unavailable")
  const second = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_neg_fail/command`,
    payload: { name: "build", text: "blocked during negotiation" },
  })
  assert.equal(second.statusCode, 502, second.body)
  assert.equal(second.headers["x-codenomad-before-dispatch"], "1")
  assert.deepEqual(second.json(), { error: "opencode_unavailable_before_send" })
  assert.deepEqual(f.events, [])
})

test("carrier metadata appearing before final dispatch check rejects prompt with 403", async () => {
  const f = fixture()
  f.state.beforeFetchCheck = async () => {
    f.state.metadata = { "codenomad.schedule-carrier": true }
  }
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_late_carrier/prompt`,
    payload: { text: "blocked on late carrier marker" },
  })
  assert.equal(response.statusCode, 403, response.body)
  assert.deepEqual(f.events, ["environment"])
  assert.deepEqual(f.uncertainSessions, [])
})

test("duplicate x-codenomad-session-directory headers are rejected with 400 before dispatch", async () => {
  const f = fixture()
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_dup_header/prompt`,
    headers: { "x-codenomad-session-directory": ["/repo/worktree", "/repo/worktree"] },
    payload: { text: "duplicate header" },
  })
  assert.equal(response.statusCode, 400, response.body)
  assert.equal(response.headers["x-codenomad-before-dispatch"], "1")
  assert.deepEqual(f.events, [])
})

test("a plain fetch without dispatch-hook support is rejected with marked 502 before any upstream call", async () => {
  const f = fixture()
  f.state.usePlainFetch = true
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_plain_fetch/prompt`,
    payload: { text: "must never reach upstream" },
  })
  assert.equal(response.statusCode, 502, response.body)
  assert.equal(response.headers["x-codenomad-before-dispatch"], "1")
  assert.deepEqual(response.json(), { error: "opencode_unavailable_before_send" })
  assert.deepEqual(f.events, [], "plain fetch must be rejected before environment or upstream dispatch")
  assert.deepEqual(f.uncertainSessions, [])
})

test("a session replaced under the same ID and location before dispatch is rejected with marked 403 while reordered fork keys stay allowed", async () => {
  const f = fixture()
  f.state.fork = { sessionID: "ses_parent", messageID: "msg_1" }
  f.state.parentID = undefined
  f.state.beforeFetchCheck = async () => {
    f.state.fork = { messageID: "msg_1", sessionID: "ses_parent" }
    f.state.parentID = null
  }
  const reordered = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_reordered_fork/prompt`,
    payload: { text: "reordered fork keys and absent-vs-null parentID must stay allowed" },
  })
  assert.equal(reordered.statusCode, 200, reordered.body)
  assert.deepEqual(f.events, ["environment", "forward"])
  f.state.parentID = undefined

  f.events.length = 0
  f.state.beforeFetchCheck = async () => {
    f.state.projectID = "project-replaced"
    f.state.createdAt = 999
  }
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_replaced_identity/prompt`,
    payload: { text: "blocked on replaced record identity" },
  })
  assert.equal(response.statusCode, 403, response.body)
  assert.equal(response.headers["x-codenomad-before-dispatch"], "1")
  assert.deepEqual(f.events, ["environment"])
  assert.deepEqual(f.uncertainSessions, [])

  // Changing only a non-directory field of location must also fail closed before dispatch.
  f.events.length = 0
  f.state.projectID = "project-a"
  f.state.createdAt = 1
  f.state.locationWorkspaceID = "ws-a"
  f.state.beforeFetchCheck = async () => {
    f.state.locationWorkspaceID = "ws-b"
  }
  const locationChanged = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_location_meta_changed/prompt`,
    payload: { text: "blocked on non-directory location change" },
  })
  assert.equal(locationChanged.statusCode, 403, locationChanged.body)
  assert.equal(locationChanged.headers["x-codenomad-before-dispatch"], "1")
  assert.deepEqual(f.events, ["environment"])
  assert.deepEqual(f.uncertainSessions, [])
})

test("pre-handler 400/413/426 keep Fastify error envelopes and carry x-codenomad-before-dispatch across routed variants", async () => {
  const f = fixture()
  for (const url of [
    `${prefix}/api/session/ses_bad_json/prompt`,
    `${prefix}/api/session/ses_bad_json/prompt;v=1`,
    `${prefix}/api/session/ses_bad_json/%70rompt`,
  ]) {
    const badJson = await f.app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: "{invalid",
    })
    assert.equal(badJson.statusCode, 400, badJson.body)
    assert.equal(badJson.headers["x-codenomad-before-dispatch"], "1")
    const body = badJson.json() as { statusCode?: number; code?: string; error?: string; message?: string }
    assert.equal(body.statusCode, 400)
    assert.equal(body.error, "Bad Request")
    assert.equal(typeof body.message, "string")
  }

  const tooLargeCommand = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_big_cmd/command`,
    payload: { name: "build", text: "x".repeat(1024 * 1024) },
  })
  assert.equal(tooLargeCommand.statusCode, 413, tooLargeCommand.body)
  assert.equal(tooLargeCommand.headers["x-codenomad-before-dispatch"], "1")
  const tooLargeBody = tooLargeCommand.json() as { statusCode?: number; code?: string; error?: string; message?: string }
  assert.equal(tooLargeBody.statusCode, 413)
  assert.equal(tooLargeBody.code, "FST_ERR_CTP_BODY_TOO_LARGE")
  assert.equal(tooLargeBody.error, "Payload Too Large")

  // Single trailing slash runs attachment budget validation; double trailing slashes are rejected with 403 (parity with Rust).
  const trailingInvalidData = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_trailing/prompt/`,
    payload: { text: "bad attachment", files: [{ uri: "data:;base64,abc" }] },
  })
  assert.equal(trailingInvalidData.statusCode, 400, trailingInvalidData.body)
  assert.equal(trailingInvalidData.headers["x-codenomad-before-dispatch"], "1")

  for (const doubleSlash of [
    `${prefix}/api/session/ses_trailing/prompt//`,
    `${prefix}/api/session/ses_trailing/command//`,
  ]) {
    const refused = await f.app.inject({
      method: "POST",
      url: doubleSlash,
      payload: { text: "double slash not allowed" },
    })
    assert.equal(refused.statusCode, 403, refused.body)
    const refusedMalformed = await f.app.inject({
      method: "POST",
      url: doubleSlash,
      headers: { "content-type": "application/json" },
      payload: "{invalid",
    })
    assert.equal(refusedMalformed.statusCode, 403, refusedMalformed.body)
    const refusedBadMediaType = await f.app.inject({
      method: "POST",
      url: doubleSlash,
      headers: { "content-type": "not-a-media-type" },
      payload: "{invalid",
    })
    assert.equal(refusedBadMediaType.statusCode, 403, refusedBadMediaType.body)
  }

  // Disallowed double-slash routes must not short-circuit workspace lookup (404) or preHandler auth (401).
  const missingWorkspaceDoubleSlash = await f.app.inject({
    method: "POST",
    url: "/workspaces/missing/instance/api/session/ses_trailing/prompt//",
    headers: { "content-type": "application/json" },
    payload: "{invalid",
  })
  assert.equal(missingWorkspaceDoubleSlash.statusCode, 404, missingWorkspaceDoubleSlash.body)

  const gatedApp = Fastify({ routerOptions: ROUTER_OPTIONS })
  apps.push(gatedApp)
  gatedApp.addHook("preHandler", (_request, reply, done) => {
    void reply.code(401).send({ error: "Unauthorized" })
    done()
  })
  registerInstanceProxyRoutes(gatedApp, {
    workspaceManager: f.manager,
    worktreeDeletionFence: f.fence,
    logger: { debug() {}, error() {}, isLevelEnabled: () => false } as never,
  })
  const unauthDoubleSlash = await gatedApp.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_trailing/prompt//`,
    headers: { "content-type": "application/json" },
    payload: "{invalid",
  })
  assert.equal(unauthDoubleSlash.statusCode, 401, unauthDoubleSlash.body)

  f.state.profileError = new UnsupportedOpenCodeError("2.0.0")
  const upgrade = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_old_runtime/command/`,
    payload: { name: "build", text: "blocked on 426" },
  })
  assert.equal(upgrade.statusCode, 426, upgrade.body)
  assert.equal(upgrade.headers["x-codenomad-before-dispatch"], "1")
  const upgradeBody = upgrade.json() as {
    error?: string
    message?: string
    actualVersion?: string
    minimumVersion?: string
    reason?: string
  }
  assert.equal(upgradeBody.error, "opencode_update_required")
  assert.equal(upgradeBody.actualVersion, "2.0.0")
  assert.equal(typeof upgradeBody.minimumVersion, "string")
  assert.equal(typeof upgradeBody.message, "string")
  assert.equal(typeof upgradeBody.reason, "string")
  assert.deepEqual(f.events, [])
})

test("a real OpenCodeSharedService connection passes dispatch-hook validation for POST prompt", async () => {
  const upstream = Fastify()
  apps.push(upstream)
  const upstreamCalls: string[] = []
  upstream.get("/api/session/:id", async (request) => ({
    data: {
      id: (request.params as { id: string }).id,
      projectID: "project-live",
      location: { directory: "/repo" },
      time: { created: 1, updated: 1 },
    },
  }))
  upstream.put("/api/session/:id/environment", async (_request, reply) => {
    upstreamCalls.push("environment")
    return reply.code(204).send()
  })
  upstream.post("/api/session/:id/prompt", async () => {
    upstreamCalls.push("prompt")
    return { data: { id: "msg_live_ok" } }
  })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const port = (upstream.server.address() as { port: number }).port
  const liveEndpoint = { url: `http://127.0.0.1:${port}` }
  rememberRuntime(liveEndpoint, { version: MINIMUM_OPENCODE_VERSION, pid: process.pid, discovery: "status" })
  const shared = new OpenCodeSharedService()
  await shared.endpoint({
    kind: "lifecycle",
    identity: "live-proxy-test",
    lifecycle: {
      discover: async () => liveEndpoint,
      ensure: async () => liveEndpoint,
    },
  })
  const connection = await shared.acquire()
  const manager: InstanceProxyWorkspaceManager = {
    get: () => ({ id: "w", path: "/repo" } as never),
    getSharedServiceConnection: async () => connection,
    getSharedServiceEndpoint: async () => connection.endpoint,
    getSharedServiceClient: async () => connection.client,
    getInstanceAuthorizationHeader: () => undefined,
    getServiceDirectory: () => "/repo",
    getServiceDirectoryForPath: async (_id, directory) => directory,
    getWorktreeIdentityForPath: async () => "/repo",
    getSessionEnvironment: async () => ({}),
    ownsLocation: async (_id, location) => location.directory === "/repo",
    ownsDirectory: async (_id, directory) => directory === "/repo",
    ownsPath: async () => true,
  }
  const app = Fastify()
  apps.push(app)
  registerInstanceProxyRoutes(app, {
    workspaceManager: manager,
    worktreeDeletionFence: new WorktreeDeletionFence(),
    logger: { debug() {}, error() {}, isLevelEnabled: () => false } as never,
  })
  const response = await app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_real_service/prompt`,
    payload: { id: "msg_live_ok", text: "real service connection" },
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(upstreamCalls, ["environment", "prompt"])
})

test("session move fence blocks concurrent prompt posts with 409 before dispatch", async () => {
  const f = fixture()
  let releaseMove!: () => void
  const moveEntered = new Promise<void>(resolve => {
    void f.fence.runSession("ses_moving", async () => {
      resolve()
      await new Promise<void>(done => { releaseMove = done })
    })
  })
  await moveEntered
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/api/session/ses_moving/prompt`,
    payload: { text: "blocked during move" },
  })
  assert.equal(response.statusCode, 409, response.body)
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.uncertainSessions, [])
  releaseMove()
})
