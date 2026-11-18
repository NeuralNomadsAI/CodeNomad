import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenCode } from "@opencode/client"
import { SESSION_LOCATED_ELSEWHERE_REASON } from "../../../server/src/opencode/session-access-contract"
import { buildInstanceBaseUrl, createInstanceFetch, sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { addInstance, removeInstance } from "./instances"
import { setInstanceMetadata } from "./instance-metadata"
import { fetchSessions, hydrateRestoredSessionChain, removeSessionRuntimeState } from "./session-api"
import { hydrateRestoredWorkspaceState, seedRestoredWorkspaceState } from "./app-session-workspace-hydration"
import { ensureWorktreesLoaded } from "./worktrees"
import { captureSessionCatalog } from "./session-catalog-persistence"
import { activeParentSessionId, activeSessionId, getInstanceSessionIndicatorStatusCached, getSessionDraftPrompt, getSessionListIds, getSessionThreads, isSessionExpanded, setActiveParentSession, setActiveSessionFromList, setSessionPendingPermission, setSessionStatus, sessions, setSessions } from "./session-state"
import { messageStoreBus } from "./message-v2/bus"
import { handleNativeSessionEvent } from "./session-events"
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

test("the tab indicator follows publications when the list shares its held map", () => {
  const id = "catalog-unresolved-scope-indicator", f = fixture(id)
  try {
    setSessions(previous => new Map(previous).set(id, new Map([["root", { ...row("root"), status: "idle" }]])))
    const held = sessions().get(id)
    assert.equal(getInstanceSessionIndicatorStatusCached(id), "idle")
    setSessionStatus(id, "root", "working")
    assert.equal(sessions().get(id), held)
    assert.equal(getInstanceSessionIndicatorStatusCached(id), "working")
    setSessionPendingPermission(id, "root", true)
    assert.equal(getInstanceSessionIndicatorStatusCached(id), "permission")
    setSessionPendingPermission(id, "root", false)
    setSessionStatus(id, "root", "idle")
    assert.equal(getInstanceSessionIndicatorStatusCached(id), "idle")
  } finally { f.cleanup() }
})

test("cold catalogue reconciliation clears a departed saved selection and transcript but keeps its draft", async () => {
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  try {
    for (const scenario of ["departed", "local", "new-selection", "moved-back"] as const) {
      const id = `catalog-restored-placement-${scenario}`, f = fixture(id)
      const gate = deferred<any>(), started = deferred<void>()
      const store = messageStoreBus.getOrCreate(id)
      const native = (id: string, directory: string, parentID?: string) => ({
        ...row(id), status: "idle", parentID, location: { directory }, model: { providerID: "p", id: "m" },
      })
      try {
        Object.assign(f.saved, { activeSessionId: "root", drafts: { root: "unsent draft" } })
        seedRestoredWorkspaceState(id, f.saved)
        setInstanceMetadata(id, { project: { id: "project" } as any })
        store.upsertMessage({
          id: "resident", sessionId: "root", role: "user", status: "complete", createdAt: 2,
          parts: [{ id: "text", type: "text", text: "Cached conversation" }],
        })
        f.client.session.list = async (input: any) => {
          if (input.project) { started.resolve(); return gate.promise }
          return { data: [native("other", "/repo")], cursor: {} }
        }
        const refresh = fetchSessions(id, { strictStatus: true })
        await started.promise
        assert.equal(activeSessionId().get(id), "root")
        if (scenario === "new-selection") setActiveParentSession(id, "other")
        if (scenario === "moved-back") handleNativeSessionEvent(id, {
          id: "return", type: "session.moved", created: 10,
          location: { directory: "/independent-clone" },
          data: { sessionID: "root", projectID: "project", location: { directory: "/repo/packages/ui" } },
        } as any)
        gate.resolve({ data: [
          native("root", scenario === "local" ? "/repo/linked" : "/independent-clone"),
          native("child", "/repo", "root"),
          native("grandchild", "/repo", "child"),
        ], cursor: {} })
        await refresh
        const expected = scenario === "departed" ? undefined : scenario === "new-selection" ? "other" : "root"
        assert.equal(activeSessionId().get(id), expected, scenario)
        assert.equal(activeParentSessionId().get(id), expected, scenario)
        if (scenario === "departed" || scenario === "new-selection") assert.deepEqual(store.getSessionMessageIds("root"), [])
        if (scenario === "local" || scenario === "moved-back") {
          assert.deepEqual(store.getSessionMessageIds("root"), ["resident"], scenario)
          assert.ok(getSessionThreads(id).some(thread => thread.session.id === "root"), scenario)
        }
        assert.equal(getSessionDraftPrompt(id, "root"), "unsent draft", scenario)
      } finally { f.cleanup() }
    }
  } finally { serverApi.fetchWorktrees = original }
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

for (const scenario of ["typed restore refusal", "standalone outside inventory", "new local child selection"] as const) {
  test(`restore reconciliation: ${scenario}`, async () => {
    const id = `catalog-departure-${scenario.replaceAll(" ", "-")}`, f = fixture(id)
    const originalWorktrees = serverApi.fetchWorktrees, originalFetch = globalThis.fetch
    const started = deferred<void>(), inventory = deferred<any>()
    serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
    const root = { ...row("root"), location: { directory: "/repo" } }
    const child = { ...row("child", "root"), location: { directory: "/repo" } }
    const native = (session: Session) => ({ ...session, parentID: session.parentId ?? undefined, model: { providerID: "p", id: "m" } })
    const moved = native({ ...root, location: { directory: "/independent-clone" } })
    const store = messageStoreBus.getOrCreate(id)
    try {
      Object.assign(f.saved, {
        activeSessionId: "root", drafts: { root: "keep draft" },
        sessionCatalog: captureSessionCatalog(scenario === "standalone outside inventory" ? [root] : [root, child]),
      })
      seedRestoredWorkspaceState(id, f.saved)
      store.upsertMessage({ id: "resident", sessionId: "root", role: "user", status: "complete", createdAt: 2,
        parts: [{ id: "text", type: "text", text: "Cached conversation" }] })
      setInstanceMetadata(id, { project: { id: "project" } as any })
      f.client.session.list = async (input: any) => {
        if (!input.project) return { data: [], cursor: {} }
        started.resolve()
        return inventory.promise
      }
      if (scenario === "typed restore refusal") {
        const baseUrl = buildInstanceBaseUrl(`/workspaces/${id}/instance`, "http://fixture")
        f.client.session.get = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) }).session.get
        const restore = () => hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
        globalThis.fetch = async () => Response.json({ error: "Refused" }, { status: 403 })
        await assert.rejects(restore(), /403/)
        assert.equal(activeSessionId().get(id), "root")
        globalThis.fetch = async () => Response.json({
          error: "Session does not belong to workspace", reason: SESSION_LOCATED_ELSEWHERE_REASON,
        }, { status: 403 })
        await restore()
        assert.equal(activeSessionId().get(id), undefined, "typed departure reconciles before the catalogue arrives")
      }
      const refresh = fetchSessions(id, { strictStatus: true })
      await started.promise
      if (scenario === "new local child selection") setActiveSessionFromList(id, "child")
      inventory.resolve({ data: scenario === "standalone outside inventory" ? [moved]
        : scenario === "typed restore refusal" ? [native(child)] : [moved, native(child)], cursor: {} })
      await refresh
      assert.equal(getSessionDraftPrompt(id, "root"), "keep draft")
      assert.equal(activeSessionId().get(id), scenario === "new local child selection" ? "child" : undefined)
      assert.equal(activeParentSessionId().get(id), scenario === "new local child selection" ? "child" : undefined)
      assert.equal(sessions().get(id)?.has("root"), false)
      assert.deepEqual(store.getSessionMessageIds("root"), [])
      if (scenario !== "standalone outside inventory") assert.equal(sessions().get(id)?.get("child")?.parentId, "root")
    } finally {
      globalThis.fetch = originalFetch
      serverApi.fetchWorktrees = originalWorktrees
      f.cleanup()
    }
  })
}

test("cold restore reconciles a departed parent after the local child read without overriding user selection", async () => {
  const originalFetch = globalThis.fetch
  const originalWorktrees = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({
    isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }],
  })
  try {
    for (const userSelects of [false, true]) {
      const id = `catalog-cold-local-child-${userSelects}`, f = fixture(id)
      const releasedParent = deferred<void>(), childRead = deferred<Response>()
      const baseUrl = buildInstanceBaseUrl(`/workspaces/${id}/instance`, "http://fixture")
      const local = (id: string, parentID?: string) => ({
        ...row(id), status: "idle", parentID, location: { directory: "/linked-worktree" }, model: { providerID: "p", id: "m" },
      })
      try {
        Object.assign(f.saved, { activeSessionId: "child", drafts: {}, sessionCatalog: undefined })
        await ensureWorktreesLoaded(id)
        globalThis.fetch = async (input) => {
          const path = new URL(String(input)).pathname
          if (path.endsWith("/child")) return childRead.promise
          assert.ok(path.endsWith("/root"), path)
          releasedParent.resolve()
          return Response.json({ error: "Session does not belong to workspace", reason: SESSION_LOCATED_ELSEWHERE_REASON }, { status: 403 })
        }
        f.client.session.get = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) }).session.get
        const restoring = hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
        await releasedParent.promise
        await new Promise<void>(resolve => setImmediate(resolve))
        if (userSelects) setActiveParentSession(id, "other")
        childRead.resolve(Response.json({ data: local("child", "root") }))
        await restoring
        const selected = userSelects ? "other" : "child"
        assert.equal(activeSessionId().get(id), selected)
        assert.equal(activeParentSessionId().get(id), selected)
        assert.equal(sessions().get(id)?.get("child")?.parentId, "root")
      } finally { childRead.resolve(Response.json({ data: local("child", "root") })); f.cleanup() }
    }
  } finally { globalThis.fetch = originalFetch; serverApi.fetchWorktrees = originalWorktrees }
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
