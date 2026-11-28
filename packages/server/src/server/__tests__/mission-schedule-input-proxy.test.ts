import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../../missions/mission-schedule-carrier-identity"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

const NATIVE_SCHEDULE_CARRIER_MODEL = { providerID: "codenomad-missions-local", id: "schedule-noop" }, NATIVE_SCHEDULE_CARRIER_TITLE = "Mission schedule carrier"
import { registerInstanceProxyRoutes, type InstanceProxyWorkspaceManager } from "../http-server"

const apps: FastifyInstance[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
const prefix = "/workspaces/w/instance"

function fixture() {
  const events: string[] = []
  const state = { metadata: undefined as Record<string, unknown> | undefined, directory: "/repo/worktree", current: true }
  const sessions = new Map<string, { id: string; location: { directory: string }; metadata?: Record<string, unknown>;
    model?: { providerID: string; id: string }; title?: string }>()
  const missing = new Set<string>()
  const session = (id: string) => sessions.get(id) ?? { id, location: { directory: state.directory }, metadata: state.metadata }
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
  return { app, state, events, sessions, missing, fence, manager }
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
