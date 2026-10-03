import assert from "node:assert/strict"
import { test } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { addInstance, removeInstance } from "./instances"
import { setInstanceMetadata } from "./instance-metadata"
import { fetchSessions, hydrateRestoredSessionChain, removeSessionRuntimeState } from "./session-api"
import { seedRestoredWorkspaceState } from "./app-session-workspace-hydration"
import { captureSessionCatalog } from "./session-catalog-persistence"
import { activeSessionId, getSessionDraftPrompt, getSessionListIds, isSessionExpanded, sessions, setSessions } from "./session-state"
import type { RestorableWorkspaceTabState } from "./client-state-codec"
import type { Session } from "../types/session"

function row(id: string, parentId: string | null = null): Session {
  return { id, title: id, parentId, projectID: "project", location: { directory: "/repo/linked" },
    time: { created: 1, updated: 1 }, agent: "build", model: { providerId: "p", modelId: "m" },
    instanceId: "old-runtime", status: "working", runtimeStatusKnown: true, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(id: string) {
  const root = row("root"), child = row("child", "root"), grandchild = row("grandchild", "child")
  const saved: RestorableWorkspaceTabState = { kind: "workspace", folder: "/repo", activeParentSessionId: "root", activeSessionId: "grandchild",
    drafts: { grandchild: "saved draft" }, attachments: {}, scrollSnapshots: {}, unseenIdleSince: { child: 100 }, generationRecovery: { root: "working" },
    expandedSessionIds: ["root", "child"], sessionCatalog: captureSessionCatalog([root, child, grandchild]) }
  const client: any = { session: { active: async () => ({}), list: async () => ({ data: [], cursor: {} }) } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  return { saved, client, cleanup() {
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
    removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id)
  } }
}

test("restores hierarchy, selection and draft before any native read and revalidates selected metadata", async () => {
  const id = "catalog-immediate", f = fixture(id), read = deferred<any>()
  let reads = 0
  f.client.session.get = async () => { reads++; return read.promise }
  try {
    seedRestoredWorkspaceState(id, f.saved)
    assert.equal(reads, 0)
    assert.deepEqual(getSessionListIds(id), ["root"])
    assert.equal(sessions().get(id)?.size, 3)
    assert.equal(sessions().get(id)?.get("grandchild")?.instanceId, id)
    assert.equal(sessions().get(id)?.get("grandchild")?.runtimeStatusKnown, false)
    assert.equal(sessions().get(id)?.get("root")?.generationRecovery, "pending")
    assert.equal(sessions().get(id)?.get("child")?.idleSince, 100)
    assert.equal(isSessionExpanded(id, "child"), true)
    assert.equal(activeSessionId().get(id), "grandchild")
    assert.equal(getSessionDraftPrompt(id, "grandchild"), "saved draft")
    const request = hydrateRestoredSessionChain(id, ["grandchild"])
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(reads, 1)
    // Move the selected row to a root in the fresh response to stop ancestry reads.
    read.resolve({ ...row("grandchild"), parentID: undefined, model: { providerID: "p", id: "m" }, title: "Native title" })
    await request
    assert.equal(sessions().get(id)?.get("grandchild")?.title, "Native title")
    assert.equal(sessions().get(id)?.get("grandchild")?.catalogSnapshot, undefined)
    removeSessionRuntimeState(id, "child")
    seedRestoredWorkspaceState(id, f.saved)
    assert.equal(sessions().get(id)?.has("child"), false, "repeated hydration must not resurrect deleted rows")
  } finally { f.cleanup() }
})

test("partial, unavailable and failed inventories preserve saved families; complete inventory evicts absent cached children", async () => {
  const id = "catalog-reconciliation", f = fixture(id)
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
    { slug: "root", directory: "/repo", kind: "root" }, { slug: "linked", directory: "/repo/linked", kind: "worktree" },
  ] })
  try {
    seedRestoredWorkspaceState(id, f.saved)
    await fetchSessions(id)
    assert.equal(sessions().get(id)?.size, 3, "a complete directory page is not a complete workspace inventory")
    assert.deepEqual(getSessionListIds(id), ["root"])
    setInstanceMetadata(id, { project: { id: "project" } as any })
    f.client.session.list = async (input: any) => {
      if (input.project) throw new Error("Inventory unavailable")
      return { data: [], cursor: {} }
    }
    await fetchSessions(id)
    assert.equal(sessions().get(id)?.size, 3)
    assert.equal(activeSessionId().get(id), "grandchild")
    const gate = deferred<any>()
    f.client.session.list = async (input: any) => input.project ? gate.promise : { data: [], cursor: {} }
    const refresh = fetchSessions(id)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(sessions().get(id)?.size, 3)
    gate.resolve({ data: [{ ...row("root"), parentID: undefined, model: { providerID: "p", id: "m" } }], cursor: {} })
    await refresh
    assert.deepEqual([...sessions().get(id)!.keys()], ["root"])
    seedRestoredWorkspaceState(id, f.saved)
    assert.deepEqual([...sessions().get(id)!.keys()], ["root"], "final-inventory evictions survive repeated hydration")
  } finally { serverApi.fetchWorktrees = original; f.cleanup() }
})

test("a concurrent rename survives selected-row revalidation and a concurrent root survives complete reconciliation", async () => {
  const id = "catalog-concurrent", f = fixture(id), read = deferred<any>()
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  f.client.session.get = async () => read.promise
  try {
    seedRestoredWorkspaceState(id, f.saved)
    const hydration = hydrateRestoredSessionChain(id, ["root"])
    await new Promise<void>(resolve => setImmediate(resolve))
    setSessions(previous => new Map(previous).set(id, new Map(previous.get(id)).set("root", { ...previous.get(id)!.get("root")!, title: "Newer title" })))
    read.resolve({ ...row("root"), title: "Old title", model: { providerID: "p", id: "m" } })
    await hydration
    assert.equal(sessions().get(id)?.get("root")?.title, "Newer title")
    setInstanceMetadata(id, { project: { id: "project" } as any })
    const inventory = deferred<any>()
    f.client.session.list = async (input: any) => input.project ? inventory.promise : { data: [], cursor: {} }
    const refresh = fetchSessions(id)
    await new Promise<void>(resolve => setImmediate(resolve))
    setSessions(previous => new Map(previous).set(id, new Map(previous.get(id)).set("root", { ...previous.get(id)!.get("root")!, title: "Newest title" })))
    inventory.resolve({ data: [], cursor: {} })
    await refresh
    assert.equal(sessions().get(id)?.get("root")?.title, "Newest title")
    assert.ok(getSessionListIds(id).includes("root"))
  } finally { serverApi.fetchWorktrees = original; f.cleanup() }
})
