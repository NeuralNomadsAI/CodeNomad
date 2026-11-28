import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenCode } from "@opencode/client"
import toast from "solid-toast"
import { SESSION_LOCATED_ELSEWHERE_REASON, SESSION_PLACEMENT_HEADER } from "../../../server/src/opencode/session-access-contract"
import { buildInstanceBaseUrl, createInstanceFetch, sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { createFileAttachment } from "../types/attachment"
import { addAttachment, getAttachments } from "./attachments"
import { addInstance, removeInstance } from "./instances"
import { setInstanceMetadata } from "./instance-metadata"
import { fetchSessions, hydrateRestoredSessionChain, refreshSessionRuntimeStatus, removeSessionRuntimeState } from "./session-api"
import { hydrateRestoredWorkspaceState, seedRestoredWorkspaceState } from "./app-session-workspace-hydration"
import { ensureWorktreesLoaded, getWorktreeSlugForParentSession, reloadWorktrees } from "./worktrees"
import { captureSessionCatalog } from "./session-catalog-persistence"
import { activeParentSessionId, activeSessionId, getAuthoritativelyDeletedSessionIdsForInstance, getInstanceSessionIndicatorStatusCached, getSessionDraftPrompt, getSessionListIds, getSessionThreads, isSessionExpanded, setActiveParentSession, setActiveSessionFromList, setSessionDraftPrompt, setSessionPendingPermission, setSessionStatus, sessions, setSessions, withSession } from "./session-state"
import { messageStoreBus } from "./message-v2/bus"
import { confirmSessionPlacement, handleNativeSessionEvent, handleSessionDeleted, isSessionMovePending } from "./session-events"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data"
import { NO_SESSION_DRAFT_SESSION_ID } from "./local-draft-ids"
import { recoveredDraftIds } from "./session-draft-recovery"
import { getMovedAwaySessions, markSessionMovedAway } from "./session-state"
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
    removeInstance(id, { authoritative: false, drafts: "discard" }); sdkManager.destroyClientsForInstance(id)
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

test("the tab indicator follows per-tab snapshots when the list has no worktree scope", () => {
  const id = "catalog-unresolved-scope-indicator", f = fixture(id)
  try {
    setSessions(previous => new Map(previous).set(id, new Map([["root", { ...row("root"), status: "idle" }]])))
    const held = sessions().get(id)
    assert.equal(getInstanceSessionIndicatorStatusCached(id), "idle")
    setSessionStatus(id, "root", "working")
    assert.notEqual(sessions().get(id), held)
    assert.equal(held?.get("root")?.status, "idle")
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

for (const failureFirst of [false, true]) test(`cold restore applies a parent departure despite a failed child read (${failureFirst ? "failure first" : "departure first"})`, async () => {
  const id = `restore-parent-departure-${failureFirst}`, f = fixture(id)
  const parent = deferred<Error>(), child = deferred<Error>()
  const departure = Object.assign(new Error("Session located elsewhere"), {
    _tag: "SessionNotFoundError", reason: SESSION_LOCATED_ELSEWHERE_REASON,
  })
  const unavailable = new Error("Unexpected status 503")
  const reads: string[] = []
  Object.assign(f.saved, { activeSessionId: "child", drafts: { root: "keep draft" } })
  try {
    f.client.session.get = async ({ sessionID }: { sessionID: string }) => {
      reads.push(sessionID)
      throw await (sessionID === "root" ? parent.promise : child.promise)
    }
    const restoring = hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
    const rejected = assert.rejects(restoring, /503/)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(reads.sort(), ["child", "root"])
    if (failureFirst) child.resolve(unavailable)
    else parent.resolve(departure)
    await new Promise<void>(resolve => setImmediate(resolve))
    if (failureFirst) parent.resolve(departure)
    else child.resolve(unavailable)
    await rejected
    assert.notEqual(activeParentSessionId().get(id), "root")
    assert.equal(sessions().get(id)?.has("root"), false)
    assert.equal(sessions().get(id)?.has("child"), true)
    assert.equal(getSessionDraftPrompt(id, "root"), "keep draft")
  } finally {
    parent.resolve(departure)
    child.resolve(unavailable)
    f.cleanup()
  }
})

test("cold restore retries after reconnect supersedes a sibling read error", async () => {
  const id = "restore-stale-sibling-error", f = fixture(id)
  const parent = deferred<void>(), child = deferred<void>()
  const reads = new Map<string, number>()
  Object.assign(f.saved, { activeSessionId: "child", drafts: { child: "keep draft" } })
  f.client.session.get = async ({ sessionID }: { sessionID: string }) => {
    const count = (reads.get(sessionID) ?? 0) + 1
    reads.set(sessionID, count)
    if (count === 1) {
      if (sessionID === "child") {
        await child.promise
        throw new Error("Unexpected status 503")
      }
      await parent.promise
    }
    return { ...row(sessionID), parentID: sessionID === "child" ? "root" : undefined, location: { directory: "/repo" } }
  }
  try {
    const restoring = hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual([...reads.keys()].sort(), ["child", "root"])
    child.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    applyOpenCodeDataEvent(id, "/repo", { id: "connected", type: "server.connected", created: 1, data: {} } as any)
    parent.resolve()
    await restoring
    assert.equal(reads.get("root"), 2)
    assert.equal(reads.get("child"), 2)
    assert.equal(activeSessionId().get(id), "child")
    assert.equal(getSessionDraftPrompt(id, "child"), "keep draft")
  } finally {
    parent.resolve()
    child.resolve()
    destroyOpenCodeData(id)
    f.cleanup()
  }
})

for (const directory of ["/linked-alias", "/repo/linked-alias"]) test(`cold restore keeps a proxy-confirmed alias selected at ${directory}`, async () => {
  const originalFetch = globalThis.fetch
  const originalWorktrees = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({
    isGitRepo: true, worktrees: [
      { slug: "root", directory: "/repo", kind: "root" },
      { slug: "linked", directory: "/repo-linked", kind: "worktree" },
    ],
  })
  const id = "catalog-restored-alias", f = fixture(id)
  const baseUrl = buildInstanceBaseUrl(`/workspaces/${id}/instance`, "http://fixture")
  const native = (id: string, directory: string, parentID?: string) => ({
    ...row(id), parentID, location: { directory }, model: { providerID: "p", id: "m" },
  })
  const alias = native("root", directory)
  let catalogueRoot = alias
  let localChildPresent = false
  try {
    Object.assign(f.saved, { activeSessionId: "root", drafts: { root: "keep draft" }, sessionCatalog: undefined })
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      return Response.json({ data: headers.get(SESSION_PLACEMENT_HEADER) === "1"
        ? { ...alias, listWorktreeSlug: "linked" } : alias })
    }
    f.client.session.get = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) }).session.get
    f.client.session.list = async (input: any) => ({ data: input.project
      ? [catalogueRoot, ...(localChildPresent ? [native("child", "/repo", "root")] : [])]
      : [native("other", "/repo")], cursor: {} })
    setInstanceMetadata(id, { project: { id: "project" } as any })
    await ensureWorktreesLoaded(id)
    await hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
    assert.equal(activeSessionId().get(id), "root")

    await fetchSessions(id, { strictStatus: true })
    assert.equal(activeSessionId().get(id), "root", "a lexical miss cannot undo the owned restore read")
    assert.equal(sessions().get(id)?.get("root")?.location.directory, directory)
    assert.equal(getWorktreeSlugForParentSession(id, "root"), "linked")
    setActiveSessionFromList(id, "other")
    assert.ok(getSessionThreads(id).some(thread => thread.session.id === "root"), "the alias remains listed after switching")
    setActiveSessionFromList(id, "root")

    catalogueRoot = native("root", "/independent-clone")
    localChildPresent = true
    await fetchSessions(id, { strictStatus: true })
    assert.equal(activeSessionId().get(id), undefined, "a different placement cannot inherit the alias confirmation")
    assert.equal(getSessionDraftPrompt(id, "root"), "keep draft")
  } finally { globalThis.fetch = originalFetch; serverApi.fetchWorktrees = originalWorktrees; f.cleanup() }
})

for (const mode of ["return", "late inventory", "late inventory after reconnect", "late inventory after reconnect with child", "late inventory after reconnect at root", "late inventory after departure", "new departure", "unregistered"] as const) test(`favorite placement reconciles a previous departure (${mode})`, async () => {
  const id = `favorite-return-${mode.replaceAll(" ", "-")}`, f = fixture(id)
  const originalWorktrees = serverApi.fetchWorktrees
  const started = deferred<void>(), read = deferred<any>()
  const alias = { ...row("root"), parentID: undefined, location: { directory: "/repo/linked-alias" },
    listWorktreeSlug: mode === "unregistered" ? undefined : "linked" }
  let hasLinked = !mode.startsWith("late inventory")
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
    { slug: "root", directory: "/repo", kind: "root" },
    ...(hasLinked ? [{ slug: "linked", directory: "/repo-linked", kind: "worktree" } as const] : []),
  ] })
  let reads = 0
  let returnedSession = alias
  f.client.session.get = async () => {
    if (++reads > 1) return returnedSession
    started.resolve()
    return read.promise
  }
  const reconnects = mode.includes("reconnect")
  const child = { ...row("child", "root"), parentID: "root", location: { directory: "/repo" } }
  f.client.session.list = async (input: any) => ({
    data: input.project ? [returnedSession, ...(mode === "late inventory after reconnect with child" ? [child] : [])] : [], cursor: {},
  })
  setInstanceMetadata(id, { project: { id: "project" } as any })
  let restoring: Promise<unknown> | undefined
  try {
    await ensureWorktreesLoaded(id)
    markSessionMovedAway(id, "root", "/other-project")
    setSessionDraftPrompt(id, "root", "keep draft")
    restoring = hydrateRestoredSessionChain(id, ["root"], undefined, undefined, { resolveListPlacement: true })
    await started.promise
    if (mode === "new departure") markSessionMovedAway(id, "root", "/newer-project")
    read.resolve(alias)
    await restoring
    if (!hasLinked) {
      assert.equal(getMovedAwaySessions(id).get("root"), "/other-project")
      assert.equal(getSessionThreads(id).some(thread => thread.session.id === "root"), false)
      if (mode === "late inventory after departure") markSessionMovedAway(id, "root", "/newer-project")
      if (reconnects) {
        applyOpenCodeDataEvent(id, "/repo", { id: "connected", type: "server.connected", created: 1, data: {} } as any)
      }
      if (mode === "late inventory after reconnect at root") {
        returnedSession = { ...alias, location: { directory: "/repo" }, listWorktreeSlug: "root" }
      }
      hasLinked = true
      await reloadWorktrees(id, true)
      if (reconnects) assert.equal(getSessionThreads(id).some(thread => thread.session.id === "root"), false)
    }
    await fetchSessions(id, { strictStatus: true })
    const returned = mode === "return" || mode === "late inventory" || reconnects
    assert.equal(getMovedAwaySessions(id).get("root"), returned ? undefined
      : mode === "new departure" || mode === "late inventory after departure" ? "/newer-project" : "/other-project")
    assert.equal(getSessionThreads(id).some(thread => thread.session.id === "root"), returned)
    assert.equal(getSessionDraftPrompt(id, "root"), "keep draft")
    if (returned) {
      assert.equal(sessions().get(id)?.get("root")?.location.directory, returnedSession.location.directory)
      assert.equal(getWorktreeSlugForParentSession(id, "root"), returnedSession.listWorktreeSlug)
    }
    if (reconnects) assert.equal(reads, 2, "the expired proof needs exactly one fresh read")
  } finally {
    read.resolve(alias)
    await restoring
    serverApi.fetchWorktrees = originalWorktrees
    destroyOpenCodeData(id)
    f.cleanup()
  }
})

for (const mode of ["listed parent", "unrelated", "direct with parent", "direct child first", "direct parent read fails", "direct unrelated"] as const) test(`favorite return to a subfolder follows family scope (${mode})`, async () => {
  const direct = mode.startsWith("direct")
  const hasLocalParent = mode !== "unrelated" && mode !== "direct unrelated"
  const id = `favorite-subfolder-${mode.replaceAll(" ", "-")}`, f = fixture(id)
  const originalWorktrees = serverApi.fetchWorktrees
  const parent = { ...row("root"), location: { directory: "/repo" } }
  const alias = { ...row("child", hasLocalParent ? "root" : null), parentID: hasLocalParent ? "root" : undefined,
    location: { directory: "/repo/linked-alias" }, listWorktreeSlug: "linked" as string | undefined }
  const subfolder = { ...alias, location: { directory: "/feature-junction/pkg" }, listWorktreeSlug: undefined }
  let native = direct ? subfolder : alias, reads = 0, parentReads = 0
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  f.client.session.get = async ({ sessionID }: { sessionID: string }) => {
    if (sessionID === "root") {
      parentReads++
      if (mode === "direct parent read fails") throw new Error("Unexpected status 503")
      return parent
    }
    reads++
    return native
  }
  f.client.session.list = async () => ({ data: [parent, native], cursor: {} })
  setInstanceMetadata(id, { project: { id: "project" } as any })
  try {
    await ensureWorktreesLoaded(id)
    if (mode === "direct with parent" || mode === "direct unrelated") await hydrateRestoredSessionChain(id, ["root"])
    markSessionMovedAway(id, "child", "/other-project")
    setSessionDraftPrompt(id, "child", "keep draft")
    const restore = hydrateRestoredSessionChain(id, ["child"], undefined, undefined, { resolveListPlacement: true })
    if (mode === "direct parent read fails") {
      await assert.rejects(restore, /503/)
      assert.equal(getMovedAwaySessions(id).get("child"), "/other-project")
    } else await restore
    if (direct && mode !== "direct parent read fails") assert.equal(getMovedAwaySessions(id).get("child"), hasLocalParent ? undefined : "/other-project")
    if (!direct) {
      assert.equal(getMovedAwaySessions(id).get("child"), "/other-project")
      native = subfolder
      applyOpenCodeDataEvent(id, "/repo", { id: "connected", type: "server.connected", created: 1, data: {} } as any)
    }
    await fetchSessions(id, { strictStatus: true })
    assert.equal(reads, direct ? 1 : 2)
    if (mode === "direct parent read fails") assert.equal(parentReads, 1, "the catalogue supplies the parent without another point read")
    assert.equal(getMovedAwaySessions(id).get("child"), hasLocalParent ? undefined : "/other-project")
    assert.equal(getSessionThreads(id).some(thread => thread.session.id === "child" || thread.children.some(child => child.session.id === "child")), hasLocalParent)
    assert.equal(getSessionDraftPrompt(id, "child"), "keep draft")
  } finally {
    serverApi.fetchWorktrees = originalWorktrees
    destroyOpenCodeData(id)
    f.cleanup()
  }
})

test("complete inventory keeps a saved selection while its placement read is pending", async () => {
  const id = "catalog-pending-alias", f = fixture(id)
  const originalWorktrees = serverApi.fetchWorktrees
  const started = deferred<void>(), read = deferred<any>()
  const alias = { ...row("root"), parentID: undefined, location: { directory: "/linked-alias" }, listWorktreeSlug: "linked" }
  Object.assign(f.saved, { activeSessionId: "root", drafts: { root: "keep draft" }, sessionCatalog: captureSessionCatalog([alias]) })
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
    { slug: "root", directory: "/repo", kind: "root" },
    { slug: "linked", directory: "/repo-linked", kind: "worktree" },
  ] })
  f.client.session.get = async () => { started.resolve(); return read.promise }
  f.client.session.list = async (input: any) => ({ data: input.project ? [alias] : [], cursor: {} })
  setInstanceMetadata(id, { project: { id: "project" } as any })
  let restoration: Promise<unknown> | undefined
  try {
    await ensureWorktreesLoaded(id)
    restoration = hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
    await started.promise
    await fetchSessions(id, { strictStatus: true })
    assert.equal(activeSessionId().get(id), "root", "inventory absence is not a refusal of an in-flight restore")
    read.resolve(alias)
    await restoration
    assert.equal(activeSessionId().get(id), "root")
    assert.equal(getWorktreeSlugForParentSession(id, "root"), "linked")
    assert.equal(getSessionDraftPrompt(id, "root"), "keep draft")
  } finally {
    read.resolve(alias)
    await restoration
    serverApi.fetchWorktrees = originalWorktrees
    f.cleanup()
  }
})

for (const mode of ["departure", "newer proof", "settled move"] as const) test(`reconciles restore refusal after a catalogue merge (${mode})`, async (t) => {
  const id = `catalog-refusal-after-merge-${mode.replaceAll(" ", "-")}`, f = fixture(id)
  const originalWorktrees = serverApi.fetchWorktrees
  const started = deferred<void>(), read = deferred<any>()
  const alias = { ...row("root"), location: { directory: "/linked-alias" } }
  const foreign = { ...alias, location: { directory: "/independent-clone" } }
  const child = { ...row("child", "root"), parentID: "root", location: { directory: "/repo" } }
  const refusal = Object.assign(new Error("Session located elsewhere"), {
    _tag: "SessionNotFoundError", reason: SESSION_LOCATED_ELSEWHERE_REASON,
  })
  Object.assign(f.saved, { activeSessionId: "root", drafts: { root: "keep draft" }, sessionCatalog: captureSessionCatalog([alias]) })
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  f.client.session.get = async () => { started.resolve(); return read.promise }
  f.client.session.list = async (input: any) => ({ data: input.project ? [foreign, child] : [], cursor: {} })
  setInstanceMetadata(id, { project: { id: "project" } as any })
  let restoration: Promise<unknown> | undefined
  try {
    await ensureWorktreesLoaded(id)
    restoration = hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
    await started.promise
    await fetchSessions(id, { strictStatus: true })
    assert.equal(sessions().get(id)?.get("root")?.location.directory, foreign.location.directory)
    assert.equal(activeSessionId().get(id), "root", "inventory defers to the pending placement read")
    if (mode === "newer proof") {
      withSession(id, "root", session => { session.location = { directory: "/repo" } })
      confirmSessionPlacement(id, "root", sessions().get(id)!.get("root")!)
    }
    if (mode === "settled move") {
      t.mock.timers.enable({ apis: ["setTimeout"] })
      f.client.session.list = async (input: any) => ({ data: input.project ? [child] : [], cursor: {} })
      handleNativeSessionEvent(id, { id: "move-back", type: "session.moved", created: 2,
        data: { sessionID: "root", location: { directory: "/repo" } } } as any)
      t.mock.timers.tick(100)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(isSessionMovePending(id, "root"), false)
    }
    read.resolve(Promise.reject(refusal))
    await restoration
    assert.equal(activeSessionId().get(id), mode === "departure" ? undefined : "root")
    assert.equal(sessions().get(id)?.has("root"), mode !== "departure")
    assert.equal(sessions().get(id)?.has("child"), true)
    assert.equal(getSessionDraftPrompt(id, "root"), "keep draft")
  } finally {
    read.resolve(alias)
    await restoration
    serverApi.fetchWorktrees = originalWorktrees
    f.cleanup()
  }
})

test("catalog eviction preserves the session draft until native deletion", async () => {
  const id = "catalog-scope-draft", f = fixture(id), sessionID = "moving"
  const composer = NO_SESSION_DRAFT_SESSION_ID
  const originalWorktrees = serverApi.fetchWorktrees, originalToast = toast.custom
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  toast.custom = () => "recovered"
  let inScope = true
  const reads: string[] = []
  const nativeRow = { ...row(sessionID), location: { directory: "/repo" }, model: { providerID: "p", id: "m" } }
  f.client.session.list = async () => ({ data: inScope ? [nativeRow] : [], cursor: {} })
  f.client.session.get = async ({ sessionID }: { sessionID: string }) => {
    reads.push(sessionID)
    if (!inScope) throw Object.assign(new Error("Session does not belong to workspace"), { status: 403 })
    return nativeRow
  }
  const refresh = () => fetchSessions(id, { strictStatus: true })
  const writeDraft = (key: string, text: string, bytes: number[]) => {
    setSessionDraftPrompt(id, key, text)
    addAttachment(id, key, createFileAttachment(`${key}.bin`, `${key}.bin`, "application/octet-stream", new Uint8Array(bytes)))
  }
  const checkDraft = (key: string, text: string, bytes: number[]) => {
    assert.equal(getSessionDraftPrompt(id, key), text)
    assert.deepEqual(getAttachments(id, key).map(({ source }) =>
      source.type === "file" && Array.from(source.data ?? [])), [bytes])
  }
  try {
    setInstanceMetadata(id, { project: { id: "project" } as any })
    await refresh()
    assert.deepEqual(getSessionListIds(id), [sessionID])
    writeDraft(sessionID, "session draft", [65, 0, 253])
    writeDraft(composer, "independent draft", [66])

    inScope = false
    await refresh()
    assert.deepEqual(getSessionListIds(id), [])
    assert.equal(sessions().get(id)?.has(sessionID) ?? false, false)
    assert.deepEqual(reads, [], "inventory eviction must not probe missing rows")
    assert.deepEqual(recoveredDraftIds(id), [], "scope eviction must not transfer a draft")
    checkDraft(sessionID, "session draft", [65, 0, 253])
    checkDraft(composer, "independent draft", [66])
    const proofs = await hydrateRestoredSessionChain(id, [sessionID], undefined, undefined, { verifyDrafts: true, reconcileDeparture: true })
    assert.deepEqual(reads, [sessionID])
    assert.equal(proofs.size, 0, "a native ownership refusal is not an absence proof")
    assert.equal(getAuthoritativelyDeletedSessionIdsForInstance(id).has(sessionID), false)

    inScope = true
    await refresh()
    assert.deepEqual(getSessionListIds(id), [sessionID])
    checkDraft(sessionID, "session draft", [65, 0, 253])
    checkDraft(composer, "independent draft", [66])
    assert.deepEqual(recoveredDraftIds(id), [])

    handleSessionDeleted(id, { type: "session.deleted", data: { sessionID } })
    assert.deepEqual(getSessionListIds(id), [])
    assert.equal(getAuthoritativelyDeletedSessionIdsForInstance(id).has(sessionID), true)
    assert.equal(getSessionDraftPrompt(id, sessionID), "")
    assert.deepEqual(getAttachments(id, sessionID), [])
    const recovered = recoveredDraftIds(id)
    assert.equal(recovered.length, 1)
    checkDraft(recovered[0], "session draft", [65, 0, 253])
    checkDraft(composer, "independent draft", [66])
    assert.deepEqual(reads, [sessionID], "return and native deletion need no additional point reads")
  } finally {
    toast.custom = originalToast
    serverApi.fetchWorktrees = originalWorktrees
    f.cleanup()
  }
})

for (const mode of ["standalone", "local descendant", "absent parent", "deleted"] as const) {
  test(`revalidates a confirmed alias after first connection (${mode})`, async () => {
    const id = `catalog-alias-reconnect-${mode.replaceAll(" ", "-")}`, f = fixture(id)
    const originalFetch = globalThis.fetch, originalWorktrees = serverApi.fetchWorktrees
    const native = (id: string, directory: string, parentID?: string) => ({
      ...row(id), parentID, location: { directory }, model: { providerID: "p", id: "m" },
    })
    let alias = native("root", "/linked-alias")
    let deleted = false
    const moved = { ...native("root", "/second-linked-alias"), projectID: "moved-project", subpath: "pkg" }
    const baseUrl = buildInstanceBaseUrl(`/workspaces/${id}/instance`, "http://fixture")
    const replies = {
      owned: () => Response.json({ data: alias }),
      forbidden: () => Response.json({ error: "Forbidden" }, { status: 403 }),
      missing: () => Response.json({ _tag: "SessionNotFoundError", sessionID: "root", message: "Session not found" }, { status: 404 }),
      departed: () => Response.json({ reason: SESSION_LOCATED_ELSEWHERE_REASON }, { status: 403 }),
    }
    let reply: () => Response | Promise<Response> = replies.owned, reads = 0
    const probeStarted = deferred<void>(), delayed = deferred<Response>()
    const placementProbeStarted = deferred<void>(), delayedPlacement = deferred<Response>()
    const agentDirectories: string[] = []
    try {
      serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
      globalThis.fetch = async input => {
        assert.ok(new URL(String(input)).pathname.endsWith("/api/session/root"))
        reads++
        return reply()
      }
      f.client.session.get = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) }).session.get
      f.client.agent = { list: async ({ location }: any) => { agentDirectories.push(location.directory); return [] } }
      f.client.session.list = async (input: any) => ({ data: input.project
        ? [...(mode === "absent parent" || deleted ? [] : [alias]),
          ...(mode === "local descendant" || mode === "absent parent" ? [native("child", "/repo", "root")] : [])]
        : [native("other", "/repo")], cursor: {} })
      Object.assign(f.saved, { activeSessionId: "root", drafts: { root: "keep draft" }, sessionCatalog: undefined })
      setInstanceMetadata(id, { project: { id: "project" } as any })
      await ensureWorktreesLoaded(id)
      await hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
      await fetchSessions(id, { strictStatus: true })
      assert.equal(activeSessionId().get(id), "root")
      assert.equal(reads, 1, "a current proof and normal rows need no probe")

      applyOpenCodeDataEvent(id, "/repo", { id: "connected", type: "server.connected", created: 1, data: {} } as any)
      reply = replies.forbidden
      await fetchSessions(id, { strictStatus: true })
      assert.equal(activeSessionId().get(id), "root", "expiry and generic 403 are not a departure")
      assert.equal(reads, 2)

      reply = () => Response.json({ data: moved })
      await fetchSessions(id, { strictStatus: true })
      assert.equal(activeSessionId().get(id), "root")
      assert.equal(reads, 3)
      const placed = sessions().get(id)?.get("root")
      assert.deepEqual([placed?.location.directory, placed?.projectID, placed?.subpath],
        [moved.location.directory, moved.projectID, moved.subpath])
      assert.ok(agentDirectories.includes(moved.location.directory), "composer catalogue reads the confirmed placement")
      alias = moved
      await fetchSessions(id, { strictStatus: true })
      assert.equal(reads, 3, "successful revalidation renews the proof")

      destroyOpenCodeData(id)
      reply = () => { probeStarted.resolve(); return delayed.promise }
      const older = fetchSessions(id, { strictStatus: true })
      const superseded = assert.rejects(older, /superseded/)
      await probeStarted.promise
      reply = replies.forbidden
      await fetchSessions(id, { strictStatus: true })
      delayed.resolve(replies.departed())
      await superseded
      assert.equal(activeSessionId().get(id), "root", "a superseded refusal cannot evict")
      assert.equal(reads, 5)

      reply = () => { placementProbeStarted.resolve(); return delayedPlacement.promise }
      const pending = fetchSessions(id, { strictStatus: true })
      await placementProbeStarted.promise
      const newer = { directory: "/repo/newer" }
      withSession(id, "root", session => { session.location = newer })
      delayedPlacement.resolve(Response.json({ data: { ...moved, location: { directory: "/stale-alias" } } }))
      await pending
      assert.equal(sessions().get(id)?.get("root")?.location, newer, "a probe cannot overwrite a newer placement")
      assert.equal(activeSessionId().get(id), "root")
      withSession(id, "root", session => { session.location = moved.location })

      deleted = mode === "deleted"
      reply = deleted ? replies.missing : replies.departed
      await fetchSessions(id, { strictStatus: true })
      assert.equal(reads, 7)
      assert.equal(activeSessionId().get(id), undefined, "typed absence removes the projection")
      assert.equal(sessions().get(id)?.has("root") ?? false, false)
      if (mode === "local descendant" || mode === "absent parent") assert.equal(sessions().get(id)?.has("child"), true)
      assert.equal(getSessionDraftPrompt(id, "root"), "keep draft")
    } finally {
      delayed.resolve(replies.forbidden())
      delayedPlacement.resolve(replies.forbidden())
      destroyOpenCodeData(id)
      globalThis.fetch = originalFetch
      serverApi.fetchWorktrees = originalWorktrees
      f.cleanup()
    }
  })
}

test("cold restore retains owned child evidence only for the same placement after a runtime refresh", async () => {
  const originalFetch = globalThis.fetch
  const originalWorktrees = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({
    isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }],
  })
  try {
    for (const changed of [null, "directory", "workspaceID", "projectID", "subpath"] as const) {
      const id = `catalog-cold-placement-${changed ?? "same"}`, f = fixture(id)
      const parentStarted = deferred<void>(), parentRead = deferred<Response>()
      const baseUrl = buildInstanceBaseUrl(`/workspaces/${id}/instance`, "http://fixture")
      const departure = () => Response.json({ reason: SESSION_LOCATED_ELSEWHERE_REASON }, { status: 403 })
      let child = {
        ...row("child"), parentID: "root", subpath: "pkg",
        location: { directory: "/linked-worktree/pkg", workspaceID: "workspace" },
        model: { providerID: "p", id: "m" },
      }
      try {
        Object.assign(f.saved, { activeSessionId: "child", drafts: {}, sessionCatalog: undefined })
        await ensureWorktreesLoaded(id)
        globalThis.fetch = async (input) => {
          const path = new URL(String(input)).pathname
          if (path.endsWith("/child")) return Response.json({ data: child })
          assert.ok(path.endsWith("/root"), path)
          parentStarted.resolve()
          return parentRead.promise
        }
        f.client.session.get = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) }).session.get
        const restoring = hydrateRestoredWorkspaceState(id, f.saved, new AbortController().signal, () => true)
        await parentStarted.promise
        await new Promise<void>(resolve => setImmediate(resolve))
        const owned = sessions().get(id)!.get("child")!
        assert.ok(owned, "the child read publishes before the parent's refusal")
        setSessionStatus(id, "child", "working")
        if (changed === "directory" || changed === "workspaceID") {
          child = { ...child, location: { ...child.location, [changed]: "/another-checkout" } }
        } else if (changed) child = { ...child, [changed]: "other" }
        await refreshSessionRuntimeStatus(id)
        const refreshed = sessions().get(id)!.get("child")!
        assert.notEqual(refreshed.location, owned.location, "the runtime read replaced the location object")
        parentRead.resolve(departure())
        await restoring
        const selected = changed ? undefined : "child"
        assert.equal(activeSessionId().get(id), selected, changed ?? "equal placement")
        assert.equal(activeParentSessionId().get(id), selected, changed ?? "equal placement")
      } finally { parentRead.resolve(departure()); f.cleanup() }
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

test("favorite hydration indexes an off-page directory-only display root without querying its external parent", async () => {
  const id = "catalog-directory-favorite", f = fixture(id), original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ gitAvailable: false, worktrees: [
    { slug: "root", directory: "/repo", kind: "root", directoryOnly: true },
  ] })
  try {
    await ensureWorktreesLoaded(id)
    const gets: string[] = []
    f.client.session.get = async ({ sessionID }: { sessionID: string }) => {
      gets.push(sessionID)
      assert.equal(sessionID, "local")
      return { id: "local", parentID: "foreign", projectID: "project", location: { directory: "/repo" },
        title: "favorite child", time: { created: 1, updated: 1 } }
    }
    assert.deepEqual(getSessionListIds(id), [])
    await hydrateRestoredSessionChain(id, ["local"])
    assert.deepEqual(gets, ["local"])
    assert.deepEqual(getSessionListIds(id), ["local"])
    assert.equal(getSessionThreads(id)[0].session.parentId, "foreign")
    assert.equal(sessions().get(id)?.has("foreign"), false)
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
