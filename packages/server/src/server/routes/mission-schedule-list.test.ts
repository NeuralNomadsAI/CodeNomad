import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { registerMissionScheduleList } from "./mission-schedule-list"

async function fixture(t: test.TestContext) {
  const app = Fastify({ logger: false }), workspace = {}, calls: unknown[] = []
  const state = { active: true, owned: true, project: "project", error: false, api: true, enabled: false, forbidden: false,
    abort: () => {}, list: undefined as (() => void) | undefined, prepare: undefined as (() => void) | undefined }
  const client = { location: { get: async ({ location }: { location: { directory: string } }) => ({ ...location, project: { id: "project", canonical: "/project" } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ scheduleList: async (input: unknown) => {
      calls.push(input); state.list?.(); if (state.error) throw new Error("rpc.method_not_found")
      return { version: 1, projectID: state.project, schedules: [], next: "schedule_next" }
    } }) }
  const connection = { client, assertCurrent: () => { if (!state.active) throw new Error("Connection retired") } }
  const manager = { get: () => workspace, getServiceLocation: () => ({ directory: "/project" }), getSharedServiceConnection: async () => connection,
    ownsLocation: async () => state.owned, getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
    getWorktreeIdentityForPath: async () => "/project" }
  app.addHook("preHandler", async request => { state.abort = () => request.raw.emit("aborted") })
  registerMissionScheduleList(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence(),
    scheduleCapability: { read: async () => ({ location: { directory: "/project" }, api: state.api ? { available: true } : { available: false, reason: "missing-api" },
      enabled: state.enabled, origin: "/config/opencode.jsonc" }) },
    scheduleSettingsActivation: { prepare: async () => {
      calls.push("prepare-read-only"); state.prepare?.()
      if (state.forbidden) throw new PluginControlsError("Explicit project OFF", "forbidden")
      return { authority: "a".repeat(64), targets: [{ scope: "project", path: "/project/opencode.jsonc", expectation: "secret-expectation", resultDigest: "secret-result" }] }
    } },
  } as never)
  t.after(() => app.close())
  const get = (query = "", capability = false) => app.inject({ method: "GET",
    url: `/api/workspaces/owned/missions/scheduled${capability ? "/capabilities" : ""}${query}` })
  return { app, state, calls, get }
}

test("public list passes only the bounded cursor and returns no mutation fallback", async t => {
  const f = await fixture(t)
  assert.equal((await f.get("?after=schedule_previous&limit=2")).statusCode, 200)
  assert.deepEqual(f.calls, [{ after: "schedule_previous", limit: 2 }])
  for (const query of ["?limit=9", "?limit=0", "?after=../outside", "?unknown=true"])
    assert.equal((await f.get(query)).statusCode, 400)
  assert.equal(f.calls.length, 1)
  f.state.error = true
  assert.equal((await f.get()).statusCode, 503)
  assert.equal(f.calls.length, 2)
})

test("capability distinguishes missing API, activable OFF and explicit refusal without writing or exporting digests", async t => {
  const f = await fixture(t)
  let response = await f.get("", true)
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().enabled, false)
  assert.equal(response.json().activation.available, true)
  assert.doesNotMatch(response.body, /expectation|secret-|authority|resultDigest/)
  f.state.forbidden = true
  response = await f.get("", true)
  assert.equal(response.json().activation.reason, "forbidden")
  f.state.api = false
  response = await f.get("", true)
  assert.equal(response.json().api.reason, "missing-api")
  assert.equal(response.json().activation.available, false)
  assert.equal(f.calls.length, 2, "missing API cannot prepare activation")
})

test("late connection/ownership/cancellation changes and foreign project data are never published", async t => {
  for (const change of ["connection", "ownership", "abort", "project"]) {
    const f = await fixture(t)
    f.state.list = () => {
      if (change === "connection") f.state.active = false
      if (change === "ownership") f.state.owned = false
      if (change === "abort") f.state.abort()
      if (change === "project") f.state.project = "foreign"
    }
    const response = await f.get()
    assert.notEqual(response.statusCode, 200, change)
    assert.equal(response.json().schedules, undefined)
  }
  const f = await fixture(t)
  f.state.prepare = () => { f.state.active = false }
  assert.notEqual((await f.get("", true)).statusCode, 200)
})
