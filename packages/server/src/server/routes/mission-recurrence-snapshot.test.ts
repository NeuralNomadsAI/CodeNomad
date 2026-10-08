import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionRecurrenceSnapshot } from "./mission-recurrence-snapshot"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

test("owned recurrence snapshots expose simple metadata; foreign, oversized and stale projections fail closed", async () => {
  const app = Fastify(), fence = new WorktreeDeletionFence(), workspace = {}
  const location = { directory: "/project" }
  const schedule = { id: "schedule_one", title: "Daily review", revision: 1, state: "interrupted", clock: { time: "07:00", zone: "UTC" },
    nextDueAt: null, interruptionReason: "service-restart", pending: null, latestResult: null, history: [], actions: ["resume", "stop"], controls: [] }
  let snapshot: unknown = { version: 1, projectID: "project", projectCanonical: "/project", location, schedules: [schedule] }
  let owned = true, connected = true, invalidate = false, writes = 0
  registerMissionRecurrenceSnapshot(app, { worktreeDeletionFence: fence, workspaceManager: {
    get: () => workspace, getServiceLocation: () => location, ownsLocation: async () => owned,
    getSharedServiceConnection: async () => ({ assertCurrent: () => { if (!connected) throw new Error("Connection changed") }, client: {
      location: { get: async () => ({ project: { id: "project", canonical: "/project" } }) },
      plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      rpc: () => ({ recurrenceSnapshot: async () => { if (invalidate) await fence.run(location.directory, [location.directory], async () => {}); return snapshot },
        recurrenceControl: async () => { writes++ } }),
    } }),
  } as never })
  const read = () => app.inject({ method: "GET", url: "/api/workspaces/owned/missions/recurrence" })
  try {
    const response = await read()
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { version: 1, projectID: "project", schedules: [schedule] })
    assert(!response.body.includes("/project")); assert.equal(writes, 0)
    for (const bad of [{ ...schedule, epoch: 1 }, { ...schedule, consigne: "private" }, { ...schedule, history: Array(31).fill({}) },
      { ...schedule, state: "running", nextDueAt: null }]) {
      snapshot = { version: 1, projectID: "project", projectCanonical: "/project", location, schedules: [bad] }
      assert.equal((await read()).statusCode, 503)
    }
    snapshot = { version: 1, projectID: "other", projectCanonical: "/project", location, schedules: [schedule] }
    assert.equal((await read()).statusCode, 502)
    snapshot = { version: 1, projectID: "project", projectCanonical: "/project", location, schedules: [schedule] }
    owned = false; assert.equal((await read()).statusCode, 403); owned = true
    connected = false; assert.equal((await read()).statusCode, 503); connected = true
    invalidate = true; assert.equal((await read()).statusCode, 503)
    assert.equal(writes, 0)
  } finally { await app.close() }
})
