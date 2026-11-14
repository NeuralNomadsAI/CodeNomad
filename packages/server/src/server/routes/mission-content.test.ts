import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { MISSION_INSPECT_OUTPUT_LIMIT } from "../../missions/inspect-view"
import { missionPluginFixture } from "../../missions/mission-plugin-fixture"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionRoutes } from "./missions"

const escaped = (length: number, mark: string) => `${mark}${"\u0001".repeat(length - mark.length - 1)}.`

/** The real routes over the real plugin's `content` handler and its control. */
async function routeFixture() {
  const f = missionPluginFixture(), plugin = await f.plugin()
  const location = { directory: "/repo" }, state = { foreignProject: false, missingMethod: false }
  const client = {
    location: { get: async () => ({ project: { id: "project-1", canonical: "/repo" } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ content: async (input: unknown) => {
      if (state.missingMethod) throw Object.assign(new Error("Unknown RPC method"), { type: "rpc.method_not_found" })
      const result = await plugin.rpc("content", input)
      return state.foreignProject ? { ...result, projectID: "foreign" } : result
    } }),
  }
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: {
    get: () => ({ id: "workspace" }), getServiceLocation: () => location, getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
    ownsLocation: async () => true, getSharedServiceConnection: async () => ({ client, assertCurrent() {} }),
  } as never, worktreeDeletionFence: new WorktreeDeletionFence() })
  return { f, plugin, app, state }
}

test("the content route serves a mission body in slices that fit, each pinned by its digest, and refuses invalid reads", async () => {
  const { f, plugin, app, state } = await routeFixture()
  try {
    const objective = escaped(20_000, "Objective")
    const mission = (await f.control().create({ requestID: "route", objective, template: "custom" })).mission
    const url = (query: string) => `/api/workspaces/workspace/missions/${mission.id}/content?${query}`
    let text = "", query = "kind=mission&field=objective&offset=0", slices = 0
    for (;;) {
      const response = await app.inject({ method: "GET", url: url(query) })
      assert.equal(response.statusCode, 200, response.body.slice(0, 200))
      assert.ok(response.body.length <= MISSION_INSPECT_OUTPUT_LIMIT && JSON.stringify(response.json(), null, 2).length <= MISSION_INSPECT_OUTPUT_LIMIT + 32,
        `${response.body.length} characters`)
      const body = response.json()
      assert.deepEqual([body.available, body.projectID, body.missionID, body.revision], [true, "project-1", mission.id, mission.revision])
      text += body.content.text; slices++
      if (body.content.next === undefined) break
      query = `kind=mission&field=objective&digest=${body.content.digest}&offset=${body.content.next}`
    }
    assert.equal(text, objective)
    assert.ok(slices > 1, "the escaped objective spans slices")
    // Each kind names exactly its identity; a later slice repeats its digest.
    for (const invalid of ["kind=mission&field=objective", "kind=task&field=brief&offset=0", "kind=mission&field=objective&offset=5",
      "kind=inspection&field=templates&offset=0", "kind=mission&field=objective&offset=-1", "kind=mission&field=objective&offset=0&extra=1"]) {
      assert.equal((await app.inject({ method: "GET", url: url(invalid) })).statusCode, 400, invalid)
    }
    // A foreign project's answer and a plugin without the method are unavailable, never content.
    state.foreignProject = true
    const foreign = await app.inject({ method: "GET", url: url("kind=mission&field=objective&offset=0") })
    assert.deepEqual([foreign.statusCode, foreign.json().available], [502, false])
    state.foreignProject = false; state.missingMethod = true
    const missing = (await app.inject({ method: "GET", url: url("kind=mission&field=objective&offset=0") })).json()
    assert.deepEqual([missing.available, missing.reason], [false, "plugin-unavailable"], "a plugin without the method, as native reports it")
  } finally { await app.close(); await plugin.dispose() }
})
