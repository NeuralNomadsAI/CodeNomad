import assert from "node:assert/strict"
import { it } from "node:test"
import toast from "solid-toast"
import { serverApi } from "../lib/api-client"
import { getToastHistory } from "../lib/notifications"
import { serverEvents } from "../lib/server-events"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import { addInstance, incompletePendingRecovery, invalidatePendingRequestSync, removeInstance, syncPendingRequests, waitForInstanceInitialHydration, waitForInstanceInitialSessionHydration } from "./instances"
import { getSessionListIds, sessions } from "./session-state"
import { refreshSessionCatalog } from "./session-api"
import { reloadWorktrees } from "./worktrees"

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

it("warns when initial hydration fails before pending recovery can start", async () => {
  const id = "startup-pending-unavailable"
  const oldCreate = sdkManager.createClient, oldWorktrees = serverApi.fetchWorktrees
  const oldToast = toast.custom
  toast.custom = () => "fixture-toast"
  const client: any = { session: { list: async () => ({ data: [], cursor: {} }) }, location: { get: async () => ({ directory: "/repo" }) } }
  sdkManager.createClient = () => client
  serverApi.fetchWorktrees = async () => { throw new Error("Worktree metadata unavailable") }
  const warnings = () => getToastHistory().filter((item) => item.message.includes("Question and permission recovery is incomplete")).length
  const before = warnings()
  try {
    ;(serverEvents as any).dispatch({ type: "workspace.started", workspace: {
      id, path: "/repo", status: "ready", proxyPath: `/workspaces/${id}/instance`,
    } })
    await assert.rejects(waitForInstanceInitialHydration(id))
    assert.equal(warnings(), before + 1)
  } finally {
    sdkManager.createClient = oldCreate
    serverApi.fetchWorktrees = oldWorktrees
    toast.custom = oldToast
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
  }
})

for (const scenario of ["success", "reuse", "invalidation", "unrelated compaction"] as const) it(`startup metadata failure after ${scenario} only warns when still unrecovered`, async () => {
  const oldCreate = sdkManager.createClient, oldWorktrees = serverApi.fetchWorktrees, oldPending = serverApi.getPendingRequests
  const oldToast = toast.custom
  toast.custom = () => "fixture-toast"
  const warnings = () => getToastHistory().filter((item) => item.message.includes("Question and permission recovery is incomplete")).length
  serverApi.getPendingRequests = async (_id, directories) => ({ supported: true, directories: directories.map((directory) => ({
    directory, status: "ok" as const, locations: [{ location: { directory }, permissions: [], forms: [] }],
  })) })
  const id = `stale-startup-${scenario}`, otherId = `compaction-${id}`
  let failWorktrees!: (error: Error) => void
  const worktrees = new Promise<any>((_resolve, reject) => { failWorktrees = reject })
  const client: any = { session: { list: async () => ({ data: [], cursor: {} }) }, location: { get: async () => ({ directory: "/repo" }) } }
  sdkManager.createClient = () => client
  let reads = 0
  serverApi.fetchWorktrees = () => { reads++; return worktrees }
  // Startup joins an existing forced read, whose failure is not swallowed like an initial inventory miss.
  const preload = reloadWorktrees(id)
  void preload.catch(() => {})
  try {
    for (let attempt = 0; attempt < 100 && !reads; attempt++) await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(reads, 1)
    const before = warnings()
    ;(serverEvents as any).dispatch({ type: "workspace.started", workspace: {
      id, path: "/repo", status: "ready", proxyPath: `/workspaces/${id}/instance`,
    } })
    const failed = assert.rejects(waitForInstanceInitialHydration(id), /Old checkout read failed/, scenario)
    await new Promise<void>(resolve => setImmediate(resolve))
    if (scenario === "reuse") {
      removeInstance(id, { authoritative: false })
      addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client: { ...client } })
    } else if (scenario === "invalidation") invalidatePendingRequestSync(id)
    else if (scenario === "unrelated compaction") {
      addInstance({ id: otherId, folder: "/other", port: 0, pid: 0, proxyPath: "", status: "ready", client })
      sseManager["handleEvent"](otherId, { id: "start", created: 1, type: "session.compaction.started",
        location: { directory: "/other" }, data: { sessionID: "unrelated", reason: "auto" },
      } as any)
    }
    if (scenario === "success" || scenario === "reuse") await syncPendingRequests(id)
    failWorktrees(new Error("Old checkout read failed"))
    await assert.rejects(preload)
    await failed
    await new Promise<void>(resolve => setImmediate(resolve))
    const unrecovered = scenario === "invalidation" || scenario === "unrelated compaction"
    assert.equal(incompletePendingRecovery().has(id), unrecovered)
    assert.equal(warnings(), before + Number(unrecovered))
  } finally {
    failWorktrees(new Error("Fixture disposed"))
    removeInstance(otherId, { authoritative: false })
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
    sdkManager.createClient = oldCreate
    serverApi.fetchWorktrees = oldWorktrees
    serverApi.getPendingRequests = oldPending
    toast.custom = oldToast
  }
})
