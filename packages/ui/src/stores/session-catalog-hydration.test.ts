import assert from "node:assert/strict"
import { test } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { addInstance, removeInstance } from "./instances"
import { setInstanceMetadata } from "./instance-metadata"
import { fetchSessions, hydrateRestoredSessionChain, removeSessionRuntimeState } from "./session-api"
import { hydrateRestoredWorkspaceState, seedRestoredWorkspaceState } from "./app-session-workspace-hydration"
import { ensureWorktreesLoaded } from "./worktrees"
import { captureSessionCatalog } from "./session-catalog-persistence"
import { activeSessionId, getSessionDraftPrompt, getSessionListIds, getSessionThreads, isSessionExpanded, sessions, setSessions } from "./session-state"
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

test("legacy selected descendants expand loaded ancestors, while explicit collapsed snapshots remain collapsed", async () => {
  for (const explicit of [false, true]) {
    const id = `catalog-legacy-expansion-${explicit}`, f = fixture(id)
    try {
      delete f.saved.sessionCatalog
      if (explicit) f.saved.expandedSessionIds = []
      else delete f.saved.expandedSessionIds
      setSessions(previous => new Map(previous).set(id, new Map([
        ["root", row("root")], ["child", row("child", "root")], ["grandchild", row("grandchild", "child")],
      ])))
      await hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
      assert.equal(activeSessionId().get(id), "grandchild")
      assert.equal(isSessionExpanded(id, "root"), !explicit)
      assert.equal(isSessionExpanded(id, "child"), !explicit)
    } finally { f.cleanup() }
  }
})

test("directory-only cached roots appear whether scope arrives before or after seeding and partial reads", async () => {
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ gitAvailable: false, worktrees: [
    { slug: "root", directory: "/repo", serviceDirectory: "/repo", kind: "root", directoryOnly: true },
  ] })
  try {
    for (const before of [false, true]) for (const parentLoaded of [false, true]) {
      const id = `catalog-directory-root-${before}-${parentLoaded}`, f = fixture(id)
      try {
        const local = { ...row("local", "outside-parent"), location: { directory: "/repo" } }
        const nested = { ...row("nested", "local"), location: { directory: "/repo" } }
        const outside = { ...row("outside-parent"), location: { directory: "/elsewhere" } }
        f.saved.sessionCatalog = captureSessionCatalog([local, nested, ...(parentLoaded ? [outside] : [])])
        if (before) await ensureWorktreesLoaded(id)
        seedRestoredWorkspaceState(id, f.saved)
        if (!before) {
          assert.ok(!getSessionListIds(id).includes("local"), "unknown scope must not invent a native root")
          await fetchSessions(id)
          // Metadata can be revalidated before worktree scope; the candidate
          // must survive both this update and a non-authoritative directory page.
          setSessions(previous => new Map(previous).set(id, new Map(previous.get(id)).set("local", { ...local, instanceId: id })))
          await ensureWorktreesLoaded(id)
        }
        assert.deepEqual(getSessionListIds(id), ["local"])
        const threads = getSessionThreads(id)
        assert.equal(threads.length, 1)
        assert.equal(threads[0].session.id, "local")
        assert.equal(threads[0].children[0].session.id, "nested")
        assert.equal(sessions().get(id)?.get("local")?.parentId, "outside-parent", "keep native ancestry intact")
      } finally { f.cleanup() }
    }
  } finally { serverApi.fetchWorktrees = original }
})

test("directory-only seeding indexes an already loaded row without replacing its newer metadata", async () => {
  const id = "catalog-preexisting-local-root", f = fixture(id), original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ gitAvailable: false, worktrees: [
    { slug: "root", directory: "/repo", kind: "root", directoryOnly: true },
  ] })
  try {
    const local = { ...row("local", "external-parent"), location: { directory: "/repo" } }
    const live = { ...local, title: "Newer live title", instanceId: id }
    f.saved.sessionCatalog = captureSessionCatalog([local])
    setSessions(previous => new Map(previous).set(id, new Map([[local.id, live]])))
    await ensureWorktreesLoaded(id)
    seedRestoredWorkspaceState(id, f.saved)
    assert.deepEqual(getSessionListIds(id), ["local"])
    assert.equal(getSessionThreads(id)[0].session.title, "Newer live title")
    assert.equal(sessions().get(id)?.get("local"), live)
  } finally { serverApi.fetchWorktrees = original; f.cleanup() }
})

test("complete directory-only reconciliation keeps concurrently changed and introduced local roots visible", async () => {
  const id = "catalog-concurrent-local-roots", f = fixture(id), original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ gitAvailable: false, worktrees: [
    { slug: "root", directory: "/repo", kind: "root", directoryOnly: true },
  ] })
  try {
    const local = { ...row("local", "external-parent"), location: { directory: "/repo" } }
    f.saved.sessionCatalog = captureSessionCatalog([local])
    await ensureWorktreesLoaded(id)
    seedRestoredWorkspaceState(id, f.saved)
    setInstanceMetadata(id, { project: { id: "project" } as any })
    const inventory = deferred<any>()
    f.client.session.list = async (input: any) => input.parentID === null ? { data: [], cursor: {} } : inventory.promise
    const refresh = fetchSessions(id)
    await new Promise<void>(resolve => setImmediate(resolve))
    setSessions(previous => new Map(previous).set(id, new Map(previous.get(id))
      .set("local", { ...local, instanceId: id, title: "Concurrent rename" })))
    const added = { ...row("added", "another-external-parent"), location: { directory: "/repo" } }
    seedRestoredWorkspaceState(id, { ...f.saved, sessionCatalog: captureSessionCatalog([added]) })
    inventory.resolve({ data: [], cursor: {} })
    await refresh
    assert.deepEqual(new Set(getSessionListIds(id)), new Set(["local", "added"]))
    assert.deepEqual(new Set(getSessionThreads(id).map(thread => thread.session.id)), new Set(["local", "added"]))
    assert.equal(sessions().get(id)?.get("local")?.title, "Concurrent rename")
  } finally { serverApi.fetchWorktrees = original; f.cleanup() }
})
