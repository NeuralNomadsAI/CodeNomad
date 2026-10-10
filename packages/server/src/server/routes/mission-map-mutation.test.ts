import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { registerMissionRoutes } from "./missions"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

const routes = [
  { method: "PATCH", url: "/api/workspaces/workspace-1/missions/msn_1", rpc: "update", payload: { objective: "Edited", expectedRevision: 1, requestId: "edit" } },
  { method: "POST", url: "/api/workspaces/workspace-1/missions/msn_1/control", rpc: "lifecycle", payload: { action: "pause", expectedRevision: 1, requestId: "pause" } },
  { method: "DELETE", url: "/api/workspaces/workspace-1/missions/msn_1", rpc: "delete", payload: { expectedRevision: 1, requestId: "delete" } },
  { method: "POST", url: "/api/workspaces/workspace-1/missions/msn_1/recover", rpc: "recover", payload: { expectedRevision: 1, target: "coordinator" } },
] as const

function harness(hooks: { inventory?(state: State): void; dispatch?(state: State): Promise<void> } = {}) {
  const state = { workspace: { id: "workspace-1" } as object | undefined, current: true, rpcs: [] as string[], entries: 0, fence: new WorktreeDeletionFence(50) }
  const enter = state.fence.enter.bind(state.fence)
  state.fence.enter = (directories: string[]) => { state.entries++; return enter(directories) }
  const client = {
    location: { get: async ({ location }: { location: { directory: string } }) => ({ directory: location.directory, project: { id: "project-1" } }) },
    plugin: { list: async () => { hooks.inventory?.(state); return { data: [{ id: "codenomad.missions", state: { status: "active" } }] } } },
    rpc: () => new Proxy({}, { get: (_target, name: string) => async () => {
      state.rpcs.push(name)
      await hooks.dispatch?.(state)
      return name === "delete" ? { deleted: true } : { mission: { id: "msn_1" } }
    } }),
  }
  const manager = {
    get: () => state.workspace,
    getServiceLocation: () => state.workspace ? { directory: "/owned/repo" } : undefined,
    getSharedServiceConnection: async () => ({ client, assertCurrent: () => { if (!state.current) throw new Error("Connection replaced") } }),
    ownsLocation: async () => state.workspace !== undefined,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
  }
  return { state, manager }
}
type State = ReturnType<typeof harness>["state"]

async function inject(h: ReturnType<typeof harness>, route: typeof routes[number], fence = true) {
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, { workspaceManager: h.manager as never, ...(fence ? { worktreeDeletionFence: h.state.fence } : {}) })
  try { return await app.inject({ method: route.method, url: route.url, payload: route.payload }) }
  finally { await app.close() }
}

test("every map mutation enters the worktree-deletion fence before its single native RPC", async () => {
  for (const route of routes) {
    const h = harness()
    const response = await inject(h, route)
    assert.equal(response.statusCode, 200, route.rpc)
    assert.deepEqual(h.state.rpcs, [route.rpc])
    assert.equal(h.state.entries, 1, route.rpc)
  }
})

test("a workspace closed during plugin inventory never reaches the native mutation", async () => {
  for (const route of routes) {
    const h = harness({ inventory: state => { state.workspace = undefined } })
    const response = await inject(h, route)
    assert.notEqual(response.statusCode, 200, route.rpc)
    assert.deepEqual(h.state.rpcs, [], route.rpc)
  }
})

test("a replaced connection or workspace object after preparation fails closed without dispatch", async () => {
  for (const change of [(state: State) => { state.current = false }, (state: State) => { state.workspace = { id: "workspace-1" } }]) {
    for (const route of routes) {
      const h = harness({ inventory: change })
      const response = await inject(h, route)
      assert.notEqual(response.statusCode, 200, route.rpc)
      assert.deepEqual(h.state.rpcs, [], route.rpc)
    }
  }
})

test("an in-progress worktree deletion or a missing fence refuses before dispatch", async () => {
  for (const route of routes) {
    const h = harness()
    let release!: () => void
    const deletion = h.state.fence.run("/owned/repo", ["/owned/repo"], () => new Promise<void>(resolve => { release = resolve }))
    const blocked = await inject(h, route)
    assert.equal(blocked.statusCode, 409, route.rpc)
    release(); await deletion
    const unfenced = await inject(harness(), route, false)
    assert.equal(unfenced.statusCode, 503, route.rpc)
    assert.deepEqual(h.state.rpcs, [])
  }
})

test("deletion admission is held until the dispatched native mutation settles, and never retried", async () => {
  for (const route of routes) {
    let deletionRan = false
    const h = harness({ dispatch: async state => {
      void state.fence.run("/owned/repo", ["/owned/repo"], async () => { deletionRan = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(deletionRan, false, "worktree deletion waits for the admitted mutation")
      throw Object.assign(new Error("lost"), { type: "rpc.internal" })
    } })
    const response = await inject(h, route)
    assert.equal(response.statusCode, 503, route.rpc)
    assert.deepEqual(h.state.rpcs, [route.rpc], "a lost mutation is not replayed")
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(deletionRan, true)
  }
})
