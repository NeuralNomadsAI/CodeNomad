import assert from "node:assert/strict"
import { it } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { backgroundReads } from "../lib/background-read-queue"
import { addInstance, removeInstance, setActiveInstanceId, updateInstance } from "./instances"
import { setInstanceMetadata } from "./instance-metadata"
import { canRetrySessionPage, fetchSessions, hydrateRestoredSessionChain, loadAllSessions, loadMoreSessions, searchSessions } from "./session-api"
import { activeParentSessionId, activeSessionId, getSessionHasMore, getSessionListError, getSessionListIds, getSessionNextCursor,
  getSessionRoot, getSessionSearchResultIds, getSessionThreads, isSessionSearchComplete, sessions, seedRestoredSessionSelection, setSessions } from "./session-state"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data"
import { seedSessionCatalog } from "./session-catalog-hydration"
import { captureSessionCatalog } from "./session-catalog-persistence"
import { hydrateRestoredWorkspaceState } from "./app-session-workspace-hydration"
import type { Session } from "../types/session"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(done => setImmediate(done))
function row(id: string, directory = "/Work/", parentID?: string) {
  return { id, title: id, parentID, projectID: "same-project", location: { directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } }
}
function cached(id: string, directory = "/Work/", parentId: string | null = null): Session {
  return { ...row(id, directory), instanceId: "saved", parentId, agent: "build", model: { providerId: "p", modelId: "m" },
    status: "idle", runtimeStatusKnown: false, catalogSnapshot: true }
}
function fixture(id: string, serverId = "A") {
  const calls: any[] = []
  let list = async (_input: any): Promise<any> => ({ data: [], cursor: {} })
  const client: any = { session: {
    list: (input: any) => { calls.push(input); return list(input) }, active: async () => ({}),
    get: async () => { throw new Error("Unexpected ancestry lookup") },
  } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, binding: { serverId, directory: "/Work/" }, folder: "/Work/", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setInstanceMetadata(id, { project: { id: "same-project", directory: "/", canonical: "/" } as any })
  return { id, client, calls, list: (read: typeof list) => { list = read }, cleanup() {
    removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id); destroyOpenCodeData(id)
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
  } }
}

it("uses an exact opaque Location, bounded first page, cursor-only demand and next rather than previous", async () => {
  const f = fixture("exact-pages")
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => { throw new Error("Host worktree read forbidden") }
  const status = deferred<any>()
  f.client.session.active = () => status.promise
  f.list(async input => input.cursor ? { data: [row("parent")], cursor: { previous: "not-a-continuation" } }
    : { data: [row("child", "/Work/", "parent")], cursor: { previous: "never", next: "opaque" } })
  try {
    await fetchSessions(f.id, { projectMetadata: new Promise(() => {}) })
    assert.deepEqual(f.calls, [{ directory: "/Work/", limit: 200, order: "desc" }])
    assert.equal(getSessionRoot(f.id, "child")?.id, "child", "a partial child remains visible without fetching parents")
    assert.equal(sessions().get(f.id)?.get("child")?.parentId, "parent")
    assert.equal(getSessionHasMore(f.id), true)
    await loadAllSessions(f.id)
    assert.equal(f.calls.length, 1, "sorting never exhausts the explicit inventory")
    await loadMoreSessions(f.id)
    assert.deepEqual(f.calls.at(-1), { cursor: "opaque" })
    assert.equal(getSessionHasMore(f.id), false)
    assert.equal(getSessionRoot(f.id, "child")?.id, "parent")
    assert.deepEqual(getSessionListIds(f.id), ["parent"])
    assert.equal(getSessionThreads(f.id)[0].children[0].session.id, "child")
  } finally { status.resolve({}); serverApi.fetchWorktrees = original; f.cleanup() }
})

it("preserves partial/error snapshots and evicts absent rows only on a qualified terminal page, with concurrent fences", async () => {
  const f = fixture("exact-reconcile")
  seedSessionCatalog(f.id, captureSessionCatalog([cached("missing"), cached("changed"), cached("root"), cached("missing-child", "/Work/", "root")]))
  let fail = false
  f.list(async input => {
    if (input.cursor && fail) throw new Error("page offline")
    return input.cursor ? { data: [], cursor: { previous: "previous-only" } }
      : { data: [row("root")], cursor: { next: "tail" } }
  })
  try {
    await fetchSessions(f.id)
    assert.equal(sessions().get(f.id)?.has("missing-child"), true)
    fail = true
    await assert.rejects(loadMoreSessions(f.id), /page offline/)
    assert.equal(canRetrySessionPage(f.id), true)
    assert.equal(getSessionNextCursor(f.id), "tail")
    assert.equal(sessions().get(f.id)?.has("missing"), true)
    assert.match(getSessionListError(f.id)!, /page offline/)
    setSessions(previous => new Map(previous).set(f.id, new Map(previous.get(f.id)).set("changed", { ...cached("changed"), title: "Concurrent" })))
    fail = false
    await Promise.all([loadMoreSessions(f.id), loadMoreSessions(f.id)])
    assert.equal(sessions().get(f.id)?.has("missing"), false)
    assert.equal(sessions().get(f.id)?.has("missing-child"), false)
    assert.equal(sessions().get(f.id)?.get("changed")?.title, "Concurrent")
    assert.equal(getSessionHasMore(f.id), false)
    assert.equal(getSessionListError(f.id), undefined)
    assert.equal(canRetrySessionPage(f.id), false)
    f.list(async () => ({ data: [], cursor: {} }))
    await fetchSessions(f.id)
    assert.equal(sessions().get(f.id)?.size, 0, "a qualified empty initial inventory is authoritative")
  } finally { f.cleanup() }
})

it("rejects root, sibling, parent, worktree, case and separator aliases without host normalization or snapshot eviction", async () => {
  const f = fixture("exact-foreign")
  seedSessionCatalog(f.id, captureSessionCatalog([cached("saved"), cached("foreign-cached", "/work/")]))
  try {
    assert.equal(sessions().get(f.id)?.has("foreign-cached"), false)
    for (const directory of ["/", "/Work", "/work/", "/Work/sibling", "/Work/.worktrees/task", "\\Work\\"]) {
      f.list(async () => ({ data: [row("foreign", directory)], cursor: {} }))
      await assert.rejects(fetchSessions(f.id))
      assert.equal(sessions().get(f.id)?.has("foreign"), false)
      assert.equal(sessions().get(f.id)?.has("saved"), true)
    }
  } finally { f.cleanup() }
})

for (const retire of ["close", "rotation", "rebind", "generation"] as const) {
  it(`fences late inventory, continuation and lookup on ${retire}`, async () => {
    const f = fixture(`exact-stale-${retire}`)
    const stalePage = deferred<any>(), staleLookup = deferred<any>()
    f.list(async input => input.cursor ? stalePage.promise : { data: [row("root")], cursor: { next: "same-cursor" } })
    f.client.session.get = () => staleLookup.promise
    try {
      await fetchSessions(f.id)
      const more = loadMoreSessions(f.id), lookup = hydrateRestoredSessionChain(f.id, ["late-lookup"])
      await tick()
      if (retire === "close") removeInstance(f.id, { authoritative: false })
      if (retire === "rotation") updateInstance(f.id, { capabilities: { generation: 2 } as any })
      if (retire === "rebind") updateInstance(f.id, { binding: { serverId: "B", directory: "/Work/" } })
      if (retire === "generation") destroyOpenCodeData(f.id)
      stalePage.resolve({ data: [row("late-page")], cursor: {} })
      staleLookup.resolve(row("late-lookup"))
      await Promise.all([more, lookup])
      assert.equal(sessions().get(f.id)?.has("late-page") ?? false, false)
      assert.equal(sessions().get(f.id)?.has("late-lookup") ?? false, false)
      const before = f.calls.length
      if (retire === "close") await assert.rejects(loadMoreSessions(f.id), /Instance not ready/)
      else await assert.rejects(loadMoreSessions(f.id))
      assert.equal(f.calls.length, before, "a cursor from a retired scope cannot be dispatched")
      assert.equal(canRetrySessionPage(f.id), false)
    } finally { stalePage.resolve({ data: [], cursor: {} }); staleLookup.resolve(row("late-lookup")); f.cleanup() }
  })
}

it("keeps homonymous IDs/cursors independent across local, A and B, coalescing passive reads into one trailing refresh", async () => {
  const targets = [fixture("inventory-local", "local-shared"), fixture("inventory-A", "A"), fixture("inventory-B", "B")]
  try {
    for (const [index, f] of targets.entries()) {
      // Local metadata without project enrichment keeps this test about target isolation.
      if (index === 0) setInstanceMetadata(f.id, undefined)
      f.list(async input => ({ data: [{ ...row(input.cursor ? "same-tail" : "same-root"), title: f.id }], cursor: input.cursor ? {} : { next: "same-cursor" } }))
    }
    await Promise.all(targets.map(f => fetchSessions(f.id)))
    await Promise.all(targets.map(f => loadMoreSessions(f.id)))
    for (const f of targets) assert.equal(sessions().get(f.id)?.get("same-tail")?.title, f.id)
    const f = targets[1], gate = deferred<any>()
    f.list(async () => gate.promise)
    const before = f.calls.length
    const reads = [fetchSessions(f.id), fetchSessions(f.id), fetchSessions(f.id), fetchSessions(f.id)]
    await tick()
    assert.equal(f.calls.length, before + 1)
    gate.resolve({ data: [row("fresh")], cursor: {} })
    await Promise.all(reads)
    assert.equal(f.calls.length, before + 2)
  } finally { targets.forEach(f => f.cleanup()) }
})

it("bounds exact native search to one page and never uses worktrees, parent hydration or full inventory as a fallback", async () => {
  const f = fixture("exact-search")
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => { throw new Error("Host worktree read forbidden") }
  f.list(async () => ({ data: [], cursor: { next: "more-matches", previous: "ignore" } }))
  try {
    await searchSessions(f.id, "needle")
    assert.deepEqual(f.calls, [{ search: "needle", directory: "/Work/", order: "desc", limit: 200 }])
    assert.deepEqual(getSessionSearchResultIds(f.id), [])
    assert.equal(isSessionSearchComplete(f.id), false)
  } finally { serverApi.fetchWorktrees = original; f.cleanup() }
})

it("retains snapshots through empty partial pages and rejects repeated cursors without declaring exhaustion", async () => {
  const f = fixture("exact-empty-partial")
  seedSessionCatalog(f.id, captureSessionCatalog([cached("saved")]))
  f.list(async () => ({ data: [], cursor: { next: "repeat", previous: "irrelevant" } }))
  try {
    await fetchSessions(f.id)
    assert.equal(sessions().get(f.id)?.has("saved"), true)
    await assert.rejects(loadMoreSessions(f.id), /Repeated session cursor/)
    assert.equal(getSessionNextCursor(f.id), "repeat")
    assert.equal(getSessionHasMore(f.id), true)
    assert.equal(sessions().get(f.id)?.has("saved"), true)
  } finally { f.cleanup() }
})

it("preserves a surviving selected child when exact reconciliation removes its former parent", async () => {
  const f = fixture("exact-selected-child")
  seedSessionCatalog(f.id, captureSessionCatalog([cached("parent"), cached("child", "/Work/", "parent")]))
  seedRestoredSessionSelection(f.id, "parent", "child")
  f.list(async () => ({ data: [row("child", "/Work/", "parent")], cursor: {} }))
  try {
    await fetchSessions(f.id)
    assert.equal(sessions().get(f.id)?.has("parent"), false)
    assert.equal(activeSessionId().get(f.id), "child")
    assert.equal(activeParentSessionId().get(f.id), "child")
    assert.equal(sessions().get(f.id)?.get("child")?.parentId, "parent")
  } finally { f.cleanup() }
})

it("replaces a generation-stale startup read after equivalent descriptor bindings are recreated", async () => {
  const f = fixture("exact-descriptor-startup"), first = deferred<any>()
  f.list(async () => f.calls.length === 1 ? first.promise : { data: [row("fresh")], cursor: {} })
  const request = fetchSessions(f.id)
  try {
    await tick()
    updateInstance(f.id, { binding: { serverId: "A", directory: "/Work/" } })
    applyOpenCodeDataEvent(f.id, "/Work/", { id: "connected", type: "server.connected", created: 1, data: {} } as any)
    first.resolve({ data: [row("obsolete")], cursor: {} })
    await request
    assert.equal(f.calls.length, 2)
    assert.equal(sessions().get(f.id)?.has("obsolete"), false)
    assert.deepEqual(getSessionListIds(f.id), ["fresh"])
  } finally { first.resolve({ data: [], cursor: {} }); await request; f.cleanup() }
})

for (const retire of ["close", "rotation", "directory"] as const) {
  it(`never publishes or reconciles a late first page after ${retire}`, async () => {
    const f = fixture(`exact-first-${retire}`), first = deferred<any>()
    seedSessionCatalog(f.id, captureSessionCatalog([cached("saved")]))
    f.list(async () => first.promise)
    const request = fetchSessions(f.id)
    await tick()
    try {
      if (retire === "close") removeInstance(f.id, { authoritative: false })
      if (retire === "rotation") updateInstance(f.id, { capabilities: { generation: 2 } as any })
      if (retire === "directory") updateInstance(f.id, { binding: { serverId: "A", directory: "/Other/" } })
      first.resolve({ data: [row("late-first")], cursor: {} })
      await request
      assert.equal(sessions().get(f.id)?.has("late-first") ?? false, false)
      if (retire !== "close") assert.equal(sessions().get(f.id)?.has("saved"), true)
    } finally { first.resolve({ data: [], cursor: {} }); await request; f.cleanup() }
  })
}

it("limits historical reads from local, A and B to two shared slots without hidden follow-up scans", async () => {
  const targets = [fixture("pages-budget-local", "local-shared"), fixture("pages-budget-A"), fixture("pages-budget-B", "B")]
  const hold = deferred<void>()
  let active = 0, maximum = 0, started = 0
  try {
    setActiveInstanceId(null)
    for (const f of targets) {
      if (f.id.endsWith("local")) setInstanceMetadata(f.id, undefined)
      f.list(async input => {
        if (!input.cursor) return { data: [row("root")], cursor: { next: "same" } }
        started++; maximum = Math.max(maximum, ++active)
        try { await hold.promise; return { data: [row("tail")], cursor: {} } }
        finally { active-- }
      })
    }
    await Promise.all(targets.map(f => fetchSessions(f.id)))
    const pages = targets.map(f => loadMoreSessions(f.id))
    await tick()
    assert.equal(started, 2)
    hold.resolve()
    await Promise.all(pages)
    assert.equal(maximum, 2)
    assert.equal(started, 3)
    await tick()
    assert.ok(targets.every(f => f.calls.length === 2))
  } finally { hold.resolve(); targets.forEach(f => f.cleanup()) }
})

it("hydrates only bounded same-Location ancestors and restores a truncated native chain without rewriting its parent", async () => {
  const f = fixture("exact-ancestry")
  const lookups: string[] = []
  f.client.session.get = async ({ sessionID }: any) => {
    lookups.push(sessionID)
    return sessionID === "child" ? row("child", "/Work/", "outside") : row("outside", "/Work")
  }
  try {
    await hydrateRestoredWorkspaceState(f.id, { kind: "workspace", folder: "/Work/", serverId: "A", activeSessionId: "child",
      drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} }, new AbortController().signal, () => true)
    assert.deepEqual(lookups, ["child", "outside"])
    assert.equal(sessions().get(f.id)?.has("outside"), false)
    assert.equal(sessions().get(f.id)?.get("child")?.parentId, "outside")
    assert.equal(activeSessionId().get(f.id), "child")
    assert.equal(getSessionRoot(f.id, "child")?.id, "child")
    lookups.length = 0
    f.client.session.get = async ({ sessionID }: any) => { lookups.push(sessionID); return row(sessionID, "/Work/", `chain-${lookups.length}`) }
    await assert.rejects(hydrateRestoredSessionChain(f.id, ["chain-0"]))
    assert.equal(lookups.length, 200)
  } finally { f.cleanup() }
})

it("shares the two secondary slots across targets and promotes only the selected first page", async () => {
  const targets = [fixture("budget-A"), fixture("budget-B", "B"), fixture("budget-C", "C")]
  const hold = deferred<void>()
  const controller = new AbortController()
  let reads: Promise<void>[] = []
  try {
    const occupied = [backgroundReads.run(controller.signal, () => hold.promise), backgroundReads.run(controller.signal, () => hold.promise)]
    reads = targets.map(f => fetchSessions(f.id))
    await tick()
    assert.ok(targets.every(f => f.calls.length === 0))
    setActiveInstanceId(targets[0].id)
    await tick()
    assert.equal(targets[0].calls.length, 1)
    assert.equal(targets[1].calls.length, 0)
    hold.resolve()
    await Promise.all([...occupied, ...reads])
    assert.ok(targets.every(f => f.calls.length === 1))
  } finally { hold.resolve(); await Promise.allSettled(reads); targets.forEach(f => f.cleanup()) }
})
