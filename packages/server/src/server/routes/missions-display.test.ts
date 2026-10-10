import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionRoutes } from "./missions"
import { reduceMissionEvents } from "../../missions/model"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

async function fixture(kind: "valid" | "no-fence" | "delete-aba" | "connection" | "workspace" | "moved-child") {
  const fence = new WorktreeDeletionFence()
  let workspace = { id: "workspace-test" }, connected = true
  const location = { directory: "/repo", workspaceID: "native-location" }
  const parent = { id: "ses_parent", projectID: "project-test", location }
  const child = { ...parent, id: "ses_child", parentID: parent.id,
    location: kind === "moved-child" ? { ...location, workspaceID: "foreign-location" } : location }
  const snapshot = reduceMissionEvents([{ version: 1, id: "created", missionID: "mission-test", projectID: "project-test",
    projectCanonical: "/repo", type: "mission.created", objective: "Display native family", template: "custom",
    coordinator: { sessionID: parent.id, title: "Parent", location }, createdAt: 1 }], 1)
  const client = {
    location: { get: async () => ({ ...location, project: { id: "project-test" } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ snapshot: async () => {
      if (kind === "delete-aba") await fence.run("/repo", ["/repo"], async () => {})
      return snapshot
    } }),
    session: {
      active: async () => {
        if (kind === "connection") connected = false
        if (kind === "workspace") workspace = { id: "workspace-test" }
        return {}
      },
      get: async ({ sessionID }: { sessionID: string }) => sessionID === parent.id ? parent : child,
      list: async ({ parentID }: { parentID: string }) => ({ data: parentID === parent.id ? [child] : [], cursor: { next: null } }),
      inbox: { list: async () => [] },
    },
    shell: { list: async () => ({ location, data: [] }) },
    form: { list: async () => ({ location, data: [] }) },
    permission: { request: { list: async () => ({ location, data: [] }) } },
  }
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: {
    get: () => workspace,
    getServiceLocation: () => location,
    getSharedServiceConnection: async () => ({ client, assertCurrent() { if (!connected) throw new Error("replaced") } }),
    ownsLocation: async () => true,
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
  } as never, ...(kind === "no-fence" ? {} : { worktreeDeletionFence: fence }) })
  try {
    const response = await app.inject({ method: "GET", url: "/api/workspaces/workspace-test/missions" })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().available, true)
    return response.json().activity.missions[0]
  } finally { await app.close() }
}

test("display route exposes only validated actual native descendant identities", async () => {
  const activity = await fixture("valid")
  assert.equal(activity.family.state, "observed")
  assert.deepEqual(activity.family.members, [
    { sessionId: "ses_parent", actorSessionId: "ses_parent", kind: "declared" },
    { sessionId: "ses_child", parentSessionId: "ses_parent", actorSessionId: "ses_parent", kind: "ordinary" },
  ])
})

for (const kind of ["no-fence", "delete-aba", "connection", "workspace", "moved-child"] as const) {
  test(`display route refuses family attribution after ${kind}`, async () => {
    const activity = await fixture(kind)
    assert.deepEqual(activity.family, { state: "unknown", members: [] })
  })
}
