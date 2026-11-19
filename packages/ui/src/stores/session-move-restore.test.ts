import assert from "node:assert/strict"
import { it } from "node:test"

import { OpenCode } from "@opencode/client"
import { serverApi } from "../lib/api-client.ts"
import { serverEvents } from "../lib/server-events.ts"
import { buildInstanceBaseUrl, createInstanceFetch, sdkManager } from "../lib/sdk-manager.ts"
import { SESSION_LOCATED_ELSEWHERE_REASON, SESSION_PLACEMENT_HEADER } from "../../../server/src/opencode/session-access-contract.ts"
import { addAttachment, deleteSessionAttachments, getAttachments } from "./attachments.ts"
import { fetchSessions } from "./session-api.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { setInstanceMetadata } from "./instance-metadata.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { handleNativeSessionEvent, handleSessionDeleted, isSessionMovePending } from "./session-events.ts"

const getMovedAwaySessionIds = (instanceId: string): Iterable<string> =>
  (sessionState as { getMovedAwaySessionIds?: (id: string) => Iterable<string> }).getMovedAwaySessionIds?.(instanceId) ?? ["<no record getter>"]
import * as sessionState from "./session-state.ts"
import { activeSessionId, getSessionDraftPrompt, getSessionListError, getSessionListIds, getSessionThreads, prependSessionListId, sessions, setActiveSession, setSessionDraftPrompt, setSessions } from "./session-state.ts"
import { ensureWorktreesLoaded, reloadWorktrees, setWorktreeSlugForParentSession } from "./worktrees.ts"

const delay = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration))

async function movedOutsideWorkspace() {
  throw Object.assign(new Error("Session does not belong to workspace"), {
    _tag: "SessionNotFoundError", reason: SESSION_LOCATED_ELSEWHERE_REASON,
  })
}

function setup(id: string, folder: string) {
  const session = {
    id: "restored", instanceId: id, parentId: null, title: "restored", agent: "build",
    model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
    idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    location: { directory: folder }, time: { created: 1, updated: 1 },
  } as Session
  const client = { session: {
    active: async () => ({}),
    list: async () => ({ data: [{ ...session, parentID: undefined }] }),
  } } as any
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder, port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions((previous) => new Map(previous).set(id, new Map([[session.id, session]])))
  prependSessionListId(id, session.id)
  return { session, client, cleanup() {
    messageStoreBus.unregisterInstance(id)
    setSessions((previous) => { const next = new Map(previous); next.delete(id); return next })
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
  } }
}

it("keeps a restored session in each duplicate-folder instance after a same-directory move echo", async () => {
  const first = setup("move-duplicate-first", "C:\\Repo")
  const second = setup("move-duplicate-restored", "C:\\Repo")
  const store = messageStoreBus.getOrCreate(second.session.instanceId)
  store.setMessageWindow("restored", { kind: "history", olderCursor: "older-200", resumeCursor: "page-400", newerCursors: ["page-200"] })
  const window = store.getMessageWindow("restored")
  try {
    handleNativeSessionEvent(second.session.instanceId, {
      id: "same-location", type: "session.moved", created: 1,
      data: { sessionID: "restored", location: { directory: "c:/repo" } },
    } as any)
    assert.ok(sessions().get(second.session.instanceId)?.has("restored"), "The event is not an exclusive transfer to the first matching instance")
    assert.equal(store.getMessageWindow("restored"), window, "Do not clear the historical message window")
    await delay(150)
    assert.ok(sessions().get(second.session.instanceId)?.has("restored"), "Catalog settlement must not remove the restored selection")
    assert.deepEqual(getSessionListIds(second.session.instanceId), ["restored"])
  } finally { first.cleanup(); second.cleanup() }
})

it("does not move a session family when worktree option hydration reselects the current directory", async () => {
  const fixture = setup("worktree-selection-noop", "C:\\Repo\\")
  const original = serverApi.fetchWorktrees
  const moves: string[] = []
  let destination = fixture.session.location.directory
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
    { slug: "root", directory: "c:/repo" },
    { slug: "feature", directory: "c:/repo/.worktrees/feature" },
  ] }) as any
  const moveOptions = {
    moveFamily: async (_instanceId: string, rootSessionId: string, slug: string) => {
      moves.push(`${rootSessionId}:${slug}`)
      destination = slug === "root" ? "c:/repo" : "c:/repo/.worktrees/feature"
    },
    refreshSessions: async () => {
      setSessions((previous) => {
        const next = new Map(previous)
        const current = new Map(next.get(fixture.session.instanceId))
        current.set(fixture.session.id, { ...current.get(fixture.session.id)!, location: { directory: destination } })
        next.set(fixture.session.instanceId, current)
        return next
      })
    },
  }
  try {
    await ensureWorktreesLoaded(fixture.session.instanceId)
    await setWorktreeSlugForParentSession(fixture.session.instanceId, "restored", "root", moveOptions)
    assert.deepEqual(moves, [], "Controlled option initialization is not a move request")
    await setWorktreeSlugForParentSession(fixture.session.instanceId, "restored", "feature", moveOptions)
    assert.deepEqual(moves, ["restored:feature"], "A real directory change still moves the session family")
    await setWorktreeSlugForParentSession(fixture.session.instanceId, "restored", "feature", moveOptions)
    assert.equal(moves.length, 1)
  } finally { serverApi.fetchWorktrees = original; fixture.cleanup() }
})

it("keeps an in-project move in the source instance when another tab opens that worktree directly", async () => {
  const worktree = setup("move-worktree-first", "/repo/.worktrees/feature")
  const root = setup("move-project-restored", "/repo")
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
    { slug: "root", directory: "/repo" },
    { slug: "feature", directory: "/repo/.worktrees/feature" },
  ] }) as any
  root.client.session.list = async () => ({ data: [{ ...root.session, location: { directory: "/repo/.worktrees/feature" } }] })
  try {
    await ensureWorktreesLoaded(root.session.instanceId)
    handleNativeSessionEvent(root.session.instanceId, {
      id: "worktree-location", type: "session.moved", created: 1,
      data: { sessionID: "restored", location: { directory: "/repo/.worktrees/feature" } },
    } as any)
    assert.equal(sessions().get(root.session.instanceId)?.get("restored")?.location.directory, "/repo/.worktrees/feature")
    await delay(150)
    assert.deepEqual(getSessionListIds(root.session.instanceId), ["restored"])
  } finally { serverApi.fetchWorktrees = original; worktree.cleanup(); root.cleanup() }
})

it("still removes the old instance projection when the session really leaves its location scope", async () => {
  const target = setup("move-real-target", "/other")
  const source = setup("move-real-source", "/repo")
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  setInstanceMetadata(source.session.instanceId, { project: { id: "source-project", canonical: "/repo" } as any })
  source.client.session.list = async () => ({ data: [] })
  source.client.session.get = movedOutsideWorkspace
  try {
    handleNativeSessionEvent(source.session.instanceId, {
      id: "different-location", type: "session.moved", created: 1,
      data: { sessionID: "restored", location: { directory: "/other" } },
    } as any)
    await delay(150)
    assert.equal(sessions().get(source.session.instanceId)?.has("restored") ?? false, false)
    assert.equal(sessions().get(target.session.instanceId)?.get("restored")?.location.directory, "/other")
    assert.deepEqual(getSessionListIds(source.session.instanceId), [])
    assert.deepEqual(getSessionListIds(target.session.instanceId), ["restored"])
  } finally { serverApi.fetchWorktrees = original; source.cleanup(); target.cleanup() }
})

it("removes a single moved session from its old instance while its children stay there", async () => {
  const source = setup("move-single-source", "/repo")
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  setInstanceMetadata(source.session.instanceId, { project: { id: "source-project", canonical: "/repo" } as any })
  const child = { ...source.session, id: "left-child", parentId: "restored", title: "left-child" }
  setSessions((previous) => new Map(previous).set(source.session.instanceId,
    new Map([...previous.get(source.session.instanceId)!, [child.id, child]])))
  setActiveSession(source.session.instanceId, "restored")
  const reads: string[] = []
  source.client.session.list = async (input: any) => ({ data: input.parentID === null ? [] : [{ ...child, parentID: "restored" }] })
  // The workspace proxy refuses a session that now lives elsewhere, through the real adapter.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ error: "Session does not belong to workspace", reason: SESSION_LOCATED_ELSEWHERE_REASON }, { status: 403 })
  const baseUrl = buildInstanceBaseUrl("/workspaces/move-single-source/instance", "http://fixture")
  const proxy = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
  source.client.session.get = (input: any, options: any) => { reads.push(input.sessionID); return proxy.session.get(input, options) }
  try {
    await ensureWorktreesLoaded(source.session.instanceId)
    handleNativeSessionEvent(source.session.instanceId, {
      id: "single-move", type: "session.moved", created: 1, location: { directory: "/repo" },
      data: { sessionID: "restored", location: { directory: "/elsewhere" } },
    } as any)
    await delay(150)
    assert.equal(sessions().get(source.session.instanceId)?.has("restored") ?? false, false)
    assert.equal(activeSessionId().get(source.session.instanceId), undefined)
    assert.deepEqual(getSessionListIds(source.session.instanceId), [])
    assert.equal(getSessionListError(source.session.instanceId), undefined)
    assert.deepEqual(reads, ["restored", "restored"], "the move probe and the child’s parent read both see the departure")

    // Moving back makes it a session of this workspace again.
    const returned = { ...source.session, parentID: undefined }
    source.client.session.list = async (input: any) => ({ data: input.parentID === null ? [returned] : [returned, { ...child, parentID: "restored" }] })
    handleNativeSessionEvent(source.session.instanceId, {
      id: "single-move-back", type: "session.moved", created: 2, location: { directory: "/elsewhere" },
      data: { sessionID: "restored", location: { directory: "/repo" } },
    } as any)
    await delay(150)
    assert.deepEqual(getSessionListIds(source.session.instanceId), ["restored"])
    assert.equal(sessions().get(source.session.instanceId)?.get("left-child")?.parentId, "restored")
  } finally { globalThis.fetch = originalFetch; serverApi.fetchWorktrees = original; source.cleanup() }
})

const listedIds = (instanceId: string) => {
  const ids: string[] = []
  const walk = (threads: ReturnType<typeof getSessionThreads>) => { for (const thread of threads) { ids.push(thread.session.id); walk(thread.children) } }
  walk(getSessionThreads(instanceId))
  return ids.sort()
}

it("never lists a session located outside the tab, even when its project inventory and local children bring it back", async () => {
  const source = setup("move-clone-inventory", "/repo")
  const id = source.session.instanceId
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
    { slug: "root", directory: "/repo", kind: "root" }, { slug: "feature", directory: "/repo-feature", kind: "worktree" },
  ] }) as any
  // An independent clone shares the native project ID.
  setInstanceMetadata(id, { project: { id: "shared-project", canonical: "/repo" } as any })
  const row = (sessionId: string, directory: string, parentID?: string) => ({ ...source.session, id: sessionId, title: sessionId,
    parentId: parentID ?? null, parentID, projectID: "shared-project", location: { directory } })
  const child = row("left-child", "/repo", "restored")
  const worktreeParent = row("worktree-parent", "/repo-feature"), worktreeChild = row("worktree-child", "/repo", "worktree-parent")
  setSessions((previous) => new Map(previous).set(id, new Map([...previous.get(id)!, [child.id, child as any]])))
  setActiveSession(id, "restored")
  let parentLocation = "/repo"
  source.client.session.list = async (input: any) => {
    const native = [row("restored", parentLocation), child, worktreeParent, worktreeChild]
    return { data: input.project ? native : native.filter(session => session.location.directory === input.directory && !session.parentID) }
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ error: "Session does not belong to workspace", reason: SESSION_LOCATED_ELSEWHERE_REASON }, { status: 403 })
  const baseUrl = buildInstanceBaseUrl(`/workspaces/${id}/instance`, "http://fixture")
  const proxy = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
  source.client.session.get = (input: any, options: any) => proxy.session.get(input, options)
  try {
    await ensureWorktreesLoaded(id)
    parentLocation = "/independent-clone"
    handleNativeSessionEvent(id, moved("to-clone", "restored", "/independent-clone"))
    await delay(250)
    assert.deepEqual(listedIds(id), ["worktree-child", "worktree-parent"], "a parent in a registered worktree stays listed")
    await fetchSessions(id, { reset: true })
    assert.deepEqual(listedIds(id), ["worktree-child", "worktree-parent"])
    const search = sessionState.beginSessionSearch(id, "restored")
    sessionState.setSessionSearchResults(id, "restored", ["restored"], search)
    assert.deepEqual(sessionState.getSessionSearchSessions(id), [], "search cannot surface a moved-away row either")
    assert.equal(getSessionListError(id), undefined)
    // A cold catalogue sees the same shared-project inventory without the event.
    sessionState.clearInstanceMovedAwaySessions(id)
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
    await fetchSessions(id, { reset: true })
    assert.deepEqual(listedIds(id), ["worktree-child", "worktree-parent"])
    assert.equal(getSessionListError(id), undefined)
  } finally { globalThis.fetch = originalFetch; serverApi.fetchWorktrees = original; source.cleanup() }
})

it("keeps a child moved into an owned project subfolder listed, also after a reload, with its activity", async () => {
  const source = setup("move-owned-subfolder", "/repo")
  const id = source.session.instanceId
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  setInstanceMetadata(id, { project: { id: "subfolder-project", canonical: "/repo" } as any })
  const row = (sessionId: string, directory: string, parentID?: string) => ({ ...source.session, id: sessionId, title: sessionId,
    parentId: parentID ?? null, parentID, location: { directory } })
  let childDirectory = "/repo"
  source.client.session.list = async (input: any) => {
    const native = [row("restored", "/repo"), row("sub-child", childDirectory, "restored"), row("other", "/repo")]
    return { data: input.project ? native : native.filter(session => session.location.directory === input.directory && !session.parentID) }
  }
  try {
    await ensureWorktreesLoaded(id)
    await fetchSessions(id, { reset: true })
    // The child's own agent moves it while it is shown.
    setActiveSession(id, "sub-child")
    childDirectory = "/repo/packages/ui"
    handleNativeSessionEvent(id, moved("into-package", "sub-child", childDirectory))
    await delay(200)
    assert.equal(activeSessionId().get(id), "sub-child", "a move within the workspace keeps the selection")
    setActiveSession(id, "other")
    assert.deepEqual(listedIds(id), ["other", "restored", "sub-child"])
    sessionState.setSessionStatus(id, "sub-child", "working")
    assert.equal(sessionState.getInstanceSessionIndicatorStatusCached(id), "working")
    // A reloaded tab loads it from the project inventory.
    setSessions((previous) => { const next = new Map(previous); next.delete(id); return next })
    await fetchSessions(id, { reset: true })
    assert.deepEqual(listedIds(id), ["other", "restored", "sub-child"])
  } finally { serverApi.fetchWorktrees = original; source.cleanup() }
})

it("renders no row through an ancestor located elsewhere, like a child whose parent is missing", async () => {
  const source = setup("excluded-middle", "/repo")
  const id = source.session.instanceId
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  setInstanceMetadata(id, { project: { id: "middle-project", canonical: "/repo" } as any })
  const row = (sessionId: string, directory: string, parentID?: string) => ({ ...source.session, id: sessionId, title: sessionId,
    parentId: parentID ?? null, parentID, location: { directory } })
  let middleDirectory = "/repo"
  source.client.session.get = movedOutsideWorkspace
  source.client.session.list = async (input: any) => {
    const native = [row("restored", "/repo"), row("middle", middleDirectory, "restored"), row("grandchild", "/repo", "middle"),
      row("local-child", "/repo", "restored")]
    return { data: input.project ? native : native.filter(session => session.location.directory === input.directory && !session.parentID) }
  }
  try {
    await ensureWorktreesLoaded(id)
    await fetchSessions(id, { reset: true })
    assert.deepEqual(listedIds(id), ["grandchild", "local-child", "middle", "restored"])
    middleDirectory = "/elsewhere"
    handleNativeSessionEvent(id, moved("middle-away", "middle", middleDirectory))
    await delay(250)
    // The refresh brings the middle back as a family member; it stays located elsewhere.
    assert.equal(sessions().get(id)?.has("middle"), true)
    assert.deepEqual(listedIds(id), ["local-child", "restored"])
    sessionState.setSessionStatus(id, "grandchild", "working")
    assert.equal(sessionState.getInstanceSessionIndicatorStatusCached(id), "idle", "an unlisted grandchild's work does not light the tab")
  } finally { serverApi.fetchWorktrees = original; source.cleanup() }
})

it("releases a moved-away record on deletion, on a refresh that lists the session and with its instance", async () => {
  for (const release of ["deletion", "refresh", "instance"] as const) {
    const source = setup(`move-record-${release}`, "/repo")
    const id = source.session.instanceId
    const original = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
    source.client.session.list = async () => ({ data: [] })
    source.client.session.get = movedOutsideWorkspace
    try {
      await ensureWorktreesLoaded(id)
      handleNativeSessionEvent(id, moved("away", "restored", "/foreign"))
      await delay(200)
      assert.deepEqual([...getMovedAwaySessionIds(id)], ["restored"], release)
      if (release === "deletion") handleSessionDeleted(id, { type: "session.deleted", data: { sessionID: "restored" } } as any)
      else if (release === "refresh") {
        source.client.session.list = async () => ({ data: [{ ...source.session, parentID: undefined }] })
        await fetchSessions(id, { reset: true })
      } else removeInstance(id, { authoritative: false })
      assert.deepEqual([...getMovedAwaySessionIds(id)], [], release)
    } finally { serverApi.fetchWorktrees = original; source.cleanup() }
  }
})

const moved = (id: string, sessionID: string, directory: string, created = 1) => ({
  id, type: "session.moved", created, data: { sessionID, location: { directory } },
}) as any
// Outside the opened folder: only its registration makes it owned.
const newWorktree = { slug: "new", directory: "/repo-worktrees/new", kind: "worktree" } as const

it("lists a standalone incoming move at a registered checkout alias, not a nested repository", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const destination = setup("move-incoming-alias", "/repo")
  const id = destination.session.instanceId
  const originalWorktrees = serverApi.fetchWorktrees, originalFetch = globalThis.fetch
  const localRoot = { slug: "root", directory: "/repo", kind: "root" } as const
  const row = (sessionID: string, directory: string) => ({
    ...destination.session, id: sessionID, parentID: undefined, location: { directory }, projectID: "project",
  })
  const incoming = row("incoming", "/checkout-alias"), nested = row("nested", "/nested-alias")
  let listed = incoming
  let departed = false
  try {
    serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [localRoot, newWorktree] })
    setInstanceMetadata(id, { project: { id: "project", canonical: "/repo" } as any })
    const baseUrl = buildInstanceBaseUrl(`/workspaces/${id}/instance`, "http://fixture")
    destination.client.session.get = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) }).session.get
    destination.client.session.list = async (input: any) => ({
      data: input.project ? [...(departed ? [] : [listed]), nested] : [row("restored", "/repo")],
      cursor: {},
    })
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname
      if (path.endsWith("/nested")) {
        return Response.json({ data: nested })
      }
      assert.ok(path.endsWith("/incoming"), path)
      return departed ? Response.json({ reason: SESSION_LOCATED_ELSEWHERE_REASON }, { status: 403 })
        : Response.json({ data: { ...incoming, listWorktreeSlug: newWorktree.slug } })
    }
    await ensureWorktreesLoaded(id)
    setActiveSession(id, "restored")
    handleNativeSessionEvent(id, moved("arrive", "incoming", incoming.location.directory))
    handleNativeSessionEvent(id, moved("nested-arrive", "nested", nested.location.directory))
    t.mock.timers.tick(100)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(listedIds(id), ["incoming", "restored"])
    assert.equal(sessions().get(id)?.get("incoming")?.location.directory, "/checkout-alias")
    assert.equal(sessions().get(id)?.has("nested"), false, "proxy eligibility alone does not admit a nested repository")
    assert.equal(activeSessionId().get(id), "restored")

    listed = { ...incoming, title: "Refreshed alias title" }
    await fetchSessions(id, { strictStatus: true })
    assert.deepEqual(listedIds(id), ["incoming", "restored"])
    assert.equal(sessions().get(id)?.get("incoming")?.title, listed.title)
    setSessionDraftPrompt(id, "incoming", "keep draft")
    departed = true
    handleNativeSessionEvent(id, moved("leave", "incoming", "/another-project", 2))
    t.mock.timers.tick(100)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(listedIds(id), ["restored"])
    assert.equal(sessions().get(id)?.has("incoming"), false)
    assert.equal(getSessionDraftPrompt(id, "incoming"), "keep draft")
  } finally {
    globalThis.fetch = originalFetch
    serverApi.fetchWorktrees = originalWorktrees
    destination.cleanup()
  }
})

it("uses the workspace proxy to keep a session moved to an owned worktree alias", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const source = setup("move-owned-alias", "/repo")
  const id = source.session.instanceId
  const originalWorktrees = serverApi.fetchWorktrees
  const originalFetch = globalThis.fetch
  const alias = "/worktree-alias", canonical = newWorktree.directory
  const root = { slug: "root", directory: "/repo", kind: "root" } as const
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [root, newWorktree] })
  const row = { ...source.session, parentID: undefined, location: { directory: alias } }
  const child = { ...source.session, id: "local-child", parentID: "restored", location: { directory: canonical } }
  setInstanceMetadata(id, { project: { id: "project", canonical: "/repo" } as any })
  source.client.session.list = async (input: any) => ({ data: input.project ? [row, child] : [] })
  const baseUrl = buildInstanceBaseUrl(`/workspaces/${id}/instance`, "http://fixture")
  const proxy = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
  let reads = 0
  let proxyReady = false
  source.client.session.get = (...args: Parameters<typeof proxy.session.get>) => {
    if (new Headers(args[1]?.headers).get(SESSION_PLACEMENT_HEADER) === "1") reads++
    return proxy.session.get(...args)
  }
  globalThis.fetch = async () => proxyReady ? Response.json({ data: row }) : Response.json({ error: "Forbidden" }, { status: 403 })
  try {
    await ensureWorktreesLoaded(id)
    setActiveSession(id, "restored")
    setSessionDraftPrompt(id, "restored", "keep draft")
    handleNativeSessionEvent(id, moved("into-alias", "restored", alias))
    t.mock.timers.tick(100)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(activeSessionId().get(id), "restored", "a generic 403 does not confirm departure")
    assert.ok(isSessionMovePending(id, "restored"))
    assert.deepEqual([...getMovedAwaySessionIds(id)], [])
    proxyReady = true
    await reloadWorktrees(id, true)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(activeSessionId().get(id), "restored")
    assert.equal(sessions().get(id)?.get("restored")?.location.directory, alias)
    assert.equal(reads, 2, "only the workspace-scoped read confirms the alias")
    // Exercise both a catalogue with local descendants and a standalone alias
    // excluded from the lexical project inventory.
    await fetchSessions(id, { strictStatus: true })
    source.client.session.list = async (input: any) => ({ data: input.project ? [row] : [] })
    await fetchSessions(id, { strictStatus: true })
    assert.equal(activeSessionId().get(id), "restored")
    assert.deepEqual(listedIds(id), ["restored"])
    assert.deepEqual([...getMovedAwaySessionIds(id)], [])
    assert.equal(getSessionDraftPrompt(id, "restored"), "keep draft")
  } finally {
    globalThis.fetch = originalFetch
    serverApi.fetchWorktrees = originalWorktrees
    source.cleanup()
  }
})

for (const registered of [true, false]) {
  it(`keeps placement unresolved until the worktree inventory recovers (${registered ? "local" : "departed"})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const source = setup(`move-retry-${registered}`, "/repo")
    const id = source.session.instanceId
    const original = serverApi.fetchWorktrees
    let recovered = false
    serverApi.fetchWorktrees = async (_id: string, fresh = false) => {
      if (fresh && !recovered) throw new Error("Worktree inventory unavailable")
      return { isGitRepo: true, worktrees: [
        { slug: "root", directory: "/repo", kind: "root" }, ...(recovered && registered ? [newWorktree] : []),
      ] } as any
    }
    const row = { ...source.session, parentID: undefined, location: { directory: newWorktree.directory } }
    const child = { ...source.session, id: "child", parentID: "restored", location: { directory: "/repo" } }
    // The local case is standalone: the old inventory can't include the moved
    // row through a child, so it retains the original checkout until recovery.
    source.client.session.list = async (input: any) => ({ data: input.project ? registered ? [row] : [row, child] : [] })
    source.client.session.get = async () => {
      if (!recovered) throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (!registered) return movedOutsideWorkspace()
      return row
    }
    const agentDirectories: string[] = []
    source.client.agent = { list: async ({ location }: any) => { agentDirectories.push(location.directory); return [] } }
    setInstanceMetadata(id, { project: { id: "project" } as any })
    try {
      await ensureWorktreesLoaded(id)
      setActiveSession(id, "restored")
      setSessionDraftPrompt(id, "restored", "keep draft")
      handleNativeSessionEvent(id, moved("into-new", "restored", newWorktree.directory))
      t.mock.timers.tick(100)
      await new Promise<void>(resolve => setImmediate(resolve))
      await fetchSessions(id, { strictStatus: true })
      assert.equal(activeSessionId().get(id), "restored", "stale inventory cannot evict an unresolved move")
      assert.deepEqual([...getMovedAwaySessionIds(id)], [])

      recovered = true
      await reloadWorktrees(id, true)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(activeSessionId().get(id), registered ? "restored" : undefined)
      assert.deepEqual([...getMovedAwaySessionIds(id)], registered ? [] : ["restored"])
      assert.equal(getSessionDraftPrompt(id, "restored"), "keep draft")
      if (registered) {
        assert.equal(sessions().get(id)?.get("restored")?.location.directory, newWorktree.directory)
        assert.ok(agentDirectories.includes(newWorktree.directory), "the composer loads agents at the confirmed checkout")
      }
    } finally { serverApi.fetchWorktrees = original; source.cleanup() }
  })
}

it("decides a move away only from a fresh worktree inventory", async () => {
  const source = setup("move-fresh-inventory", "/repo")
  const original = serverApi.fetchWorktrees
  const reads: boolean[] = []
  // The display snapshot predates the worktree the session just moved into.
  serverApi.fetchWorktrees = async (_id: string, fresh = false) => {
    reads.push(fresh)
    return { isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }, ...(fresh ? [newWorktree] : [])] } as any
  }
  setActiveSession(source.session.instanceId, "restored")
  source.client.session.list = async () => ({ data: [{ ...source.session, parentID: undefined, location: { directory: newWorktree.directory } }] })
  try {
    await ensureWorktreesLoaded(source.session.instanceId)
    handleNativeSessionEvent(source.session.instanceId, moved("into-new", "restored", newWorktree.directory))
    await delay(200)
    assert.ok(reads.includes(true), "the move decision reads a fresh inventory")
    assert.ok(sessions().get(source.session.instanceId)?.has("restored"))
    assert.equal(activeSessionId().get(source.session.instanceId), "restored")
    assert.deepEqual(getSessionListIds(source.session.instanceId), ["restored"])
  } finally { serverApi.fetchWorktrees = original; source.cleanup() }
})

it("lists a moved-away session again after a later inventory change or session refresh shows it belongs", async () => {
  for (const recovery of ["inventory", "refresh"] as const) {
    const source = setup(`move-recover-${recovery}`, "/repo")
    const original = serverApi.fetchWorktrees
    let registered = false
    serverApi.fetchWorktrees = async () => ({ isGitRepo: true,
      worktrees: [{ slug: "root", directory: "/repo", kind: "root" }, ...(registered ? [newWorktree] : [])] }) as any
    const listed = { ...source.session, parentID: undefined, location: { directory: newWorktree.directory } }
    source.client.session.list = async () => ({ data: registered ? [listed] : [] })
    try {
      await ensureWorktreesLoaded(source.session.instanceId)
      // The proxy confirms the destination is elsewhere until registration.
      source.client.session.get = movedOutsideWorkspace
      handleNativeSessionEvent(source.session.instanceId, moved("into-unregistered", "restored", newWorktree.directory))
      await delay(200)
      assert.equal(sessions().get(source.session.instanceId)?.has("restored") ?? false, false)
      registered = true
      if (recovery === "inventory") (serverEvents as any).dispatch({ type: "workspace.worktreesChanged", workspaceId: source.session.instanceId })
      else await fetchSessions(source.session.instanceId, { reset: true })
      await delay(100)
      assert.deepEqual(getSessionListIds(source.session.instanceId), ["restored"], recovery)
    } finally { serverApi.fetchWorktrees = original; source.cleanup() }
  }
})

it("keeps the unsent draft and attachments of a moved-away session for its return", async () => {
  const source = setup("move-keeps-draft", "/repo")
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
  const id = source.session.instanceId
  const attachment = { id: "attachment", type: "text", display: "notes", url: "data:text/plain,notes", filename: "notes.txt", mediaType: "text/plain" } as any
  try {
    await ensureWorktreesLoaded(id)
    setSessionDraftPrompt(id, "restored", "unsent reply")
    addAttachment(id, "restored", attachment)
    const list = source.client.session.list
    source.client.session.list = async () => ({ data: [] })
    source.client.session.get = movedOutsideWorkspace
    handleNativeSessionEvent(id, moved("away", "restored", "/elsewhere"))
    await delay(200)
    assert.equal(sessions().get(id)?.has("restored") ?? false, false)
    assert.equal(getSessionDraftPrompt(id, "restored"), "unsent reply")
    assert.deepEqual(getAttachments(id, "restored").map(value => value.id), ["attachment"])
    source.client.session.list = list
    handleNativeSessionEvent(id, moved("back", "restored", "/repo", 2))
    await delay(200)
    assert.deepEqual(getSessionListIds(id), ["restored"])
    assert.equal(getSessionDraftPrompt(id, "restored"), "unsent reply")
    assert.deepEqual(getAttachments(id, "restored").map(value => value.id), ["attachment"])
  } finally { deleteSessionAttachments(id, "restored"); serverApi.fetchWorktrees = original; source.cleanup() }
})

it("applies only the latest move's placement when an earlier decision is still reading the inventory", async () => {
  const source = setup("move-fenced", "/repo")
  const original = serverApi.fetchWorktrees
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let blocking = false
  serverApi.fetchWorktrees = async (_id: string, fresh = false) => {
    if (fresh && blocking) await blocked
    return { isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] } as any
  }
  const id = source.session.instanceId
  setActiveSession(id, "restored")
  try {
    await ensureWorktreesLoaded(id)
    blocking = true
    handleNativeSessionEvent(id, moved("out", "restored", "/elsewhere"))
    await delay(150)
    // Back home while the move-out decision still waits for its inventory.
    handleNativeSessionEvent(id, moved("back", "restored", "/repo", 2))
    await delay(50)
    release()
    await delay(250)
    assert.ok(sessions().get(id)?.has("restored"))
    assert.equal(activeSessionId().get(id), "restored", "a superseded move never removes the selection")
    assert.deepEqual(getSessionListIds(id), ["restored"])
  } finally { release(); serverApi.fetchWorktrees = original; source.cleanup() }
})
