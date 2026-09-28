import assert from "node:assert/strict"
import { it } from "node:test"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { sdkManager } from "../lib/sdk-manager"
import { removeInstance, waitForInstanceInitialSessionHydration } from "./instances"
import { getSessionListIds, sessions } from "./session-state"
import { refreshSessionCatalog } from "./session-api"

it("publishes root sessions before project metadata and checkout discovery, then reconciles verified families", async () => {
  const id = "startup-slow-checkouts"
  let release!: (value: any) => void
  const checkouts = new Promise<any>(resolve => { release = resolve })
  let releaseProject!: (value: any) => void
  const project = new Promise<any>(resolve => { releaseProject = resolve })
  let supplemental = 0
  let catalogReads = 0
  const root = { id: "root", title: "root", projectID: "project", location: { directory: "/repo" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } }
  const linked = { ...root, id: "linked", location: { directory: "/linked" } }
  const foreign = { ...root, id: "foreign", location: { directory: "/clone" } }
  const client: any = {
    location: { get: () => project },
    session: { active: async () => ({}), list: async (input: any) => ({ data: input.project ? [root, linked, foreign] : [root], cursor: {} }) },
    project: { list: async () => { supplemental++; return [] } },
    mcp: { list: async () => ({ location: { directory: "/repo" }, data: [] }) },
    plugin: { list: async () => ({ data: [] }) },
    agent: { list: async () => ({ data: [] }) },
    provider: { list: async () => { catalogReads++; return { data: [] } } },
    model: { list: async () => ({ data: [] }), default: async () => ({ data: null }) },
    command: { list: async () => ({ data: [] }) },
  }
  const oldCreate = sdkManager.createClient
  const oldWorktrees = serverApi.fetchWorktrees
  sdkManager.createClient = () => client
  serverApi.fetchWorktrees = () => checkouts
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  try {
    ;(serverEvents as any).dispatch({ type: "workspace.started", workspace: {
      id, path: "/repo", status: "ready", proxyPath: `/workspaces/${id}/instance`,
    } })
    const catalog = refreshSessionCatalog(id)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(getSessionListIds(id), ["root"])
    assert.equal(supplemental, 0)
    assert.equal(catalogReads, 1)
    assert.equal(sessions().get(id)?.has("linked"), false)
    releaseProject({ directory: "/repo", project: { id: "project" } })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(getSessionListIds(id), ["root"])
    assert.equal(sessions().get(id)?.has("linked"), false)
    release({ isGitRepo: true, worktrees: [
      { slug: "root", directory: "/repo", kind: "root" },
      { slug: "linked", directory: "/linked", kind: "worktree" },
    ] })
    await waitForInstanceInitialSessionHydration(id)
    await catalog
    assert.deepEqual(getSessionListIds(id), ["root", "linked"])
    assert.equal(sessions().get(id)?.has("foreign"), false)
    assert.equal(supplemental, 1)
    assert.equal(catalogReads, 1)
  } finally {
    releaseProject({ directory: "/repo", project: { id: "project" } })
    release({ isGitRepo: false, worktrees: [] })
    sdkManager.createClient = oldCreate
    serverApi.fetchWorktrees = oldWorktrees
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
  }
})
