import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import {
  createSession,
  deleteSession,
  fetchAgents,
  fetchProviders,
  fetchSessions,
  forkSession,
  loadMessages,
  removeSessionRuntimeState,
  searchSessions,
} from "./session-api.ts"
import {
  agents,
  clearInstanceDeletedSessionAuthority,
  getSessionMessagesLoadError,
  getSessionSearchResultIds,
  loading,
  messagesLoaded,
  providers,
  sessions,
  setSessions,
} from "./session-state.ts"
import { reloadWorktrees } from "./worktrees.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function session(instanceId: string, id: string, parentId: string | null = null): Session {
  return {
    id, instanceId, parentId, title: id, agent: "build", model: { providerId: "provider", modelId: "model" },
    status: "idle", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    version: "1", projectID: "project", location: { directory: "/work" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  }
}

function apiSession(id: string, parentID?: string) {
  return { id, parentID, title: id, projectID: "project", location: { directory: "/work" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } }
}

function apiMessage(id: string, _sessionId: string) {
  return {
    id, type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
    time: { created: 1 }, content: [],
  }
}

async function loadTestWorktree(instanceId: string): Promise<void> {
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({
    worktrees: [{ slug: "branch", directory: "/worktree" }],
    isGitRepo: true,
  } as any)
  try {
    await reloadWorktrees(instanceId)
  } finally {
    serverApi.fetchWorktrees = original
  }
}

function setup(instanceId: string) {
  const client = { session: { active: async () => ({}) } } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  return {
    client,
    cleanup() {
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    },
  }
}

describe("session request authority", () => {
  it("does not restore deleted search results or their parent chain", async () => {
    const instanceId = "late-search-delete"
    const { client, cleanup } = setup(instanceId)
    const search = deferred<any>()
    const parents = deferred<any>()
    let calls = 0
    ;(client.session as any).list = () => (++calls === 1 ? search.promise : parents.promise)

    try {
      const request = searchSessions(instanceId, "child")
      search.resolve({ data: [apiSession("child", "parent")] })
      await new Promise<void>((resolve) => setImmediate(resolve))
      removeSessionRuntimeState(instanceId, "child")
      removeSessionRuntimeState(instanceId, "parent")
      parents.resolve({ data: [apiSession("parent")] })
      await request

      assert.equal(sessions().get(instanceId)?.has("child") ?? false, false)
      assert.equal(sessions().get(instanceId)?.has("parent") ?? false, false)
      assert.deepEqual(getSessionSearchResultIds(instanceId), [])
    } finally {
      cleanup()
    }
  })

  it("does not hydrate messages after definitive deletion", async () => {
    const instanceId = "late-message-delete", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    ;(client as any).message = { list: () => response.promise }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const request = loadMessages(instanceId, sessionId)
      removeSessionRuntimeState(instanceId, sessionId)
      response.resolve({ data: [apiMessage("deleted-message", sessionId)] })
      await request

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId) ?? false, false)
    } finally {
      cleanup()
    }
  })

  it("does not hydrate messages after cache eviction", async () => {
    const instanceId = "late-message-eviction", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    ;(client as any).message = { list: () => response.promise }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const request = loadMessages(instanceId, sessionId)
      messageStoreBus.getOrCreate(instanceId).clearSession(sessionId)
      response.resolve({ data: [apiMessage("evicted-message", sessionId)] })
      await request

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId) ?? false, false)
    } finally {
      cleanup()
    }
  })

  it("loads every message page before hydrating the transcript", async () => {
    const instanceId = "paginated-message-load", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const finalPage = deferred<any>()
    const inputs: any[] = []
    ;(client as any).message = { list: async (input: any) => {
      inputs.push(input)
      if (!input.cursor) return { data: [apiMessage("first", sessionId)], cursor: { next: "page-2" } }
      return finalPage.promise
    } }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    const store = messageStoreBus.getOrCreate(instanceId)
    store.upsertMessage({ id: "evicted", sessionId, role: "assistant", status: "complete", createdAt: 1, updatedAt: 1 })
    messagesLoaded().set(instanceId, new Set([sessionId]))
    store.clearSession(sessionId)

    try {
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId) ?? false, false)
      const request = loadMessages(instanceId, sessionId)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(store.getSessionMessageIds(sessionId), [])
      finalPage.resolve({ data: [apiMessage("second", sessionId)], cursor: {} })
      await request

      assert.deepEqual(inputs, [
        { sessionID: sessionId, limit: 200, order: "asc" },
        { sessionID: sessionId, limit: 200, cursor: "page-2" },
      ])
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["first", "second"])
    } finally {
      cleanup()
    }
  })

  it("rejects a repeated cursor without hydrating a partial transcript", async () => {
    const instanceId = "repeated-message-cursor", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    ;(client as any).message = { list: async () => ({
      data: [apiMessage("partial", sessionId)],
      cursor: { next: "repeat" },
    }) }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      await assert.rejects(loadMessages(instanceId, sessionId), /Repeated message cursor/)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId) ?? false, false)
    } finally {
      cleanup()
    }
  })

  it("bounds retries while message revisions keep changing", async () => {
    const instanceId = "bounded-message-retry", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    let calls = 0
    ;(client as any).message = { list: async (input: any) => {
      calls += 1
      if (!input.cursor) return { data: [apiMessage(`first-${calls}`, sessionId)], cursor: { next: `page-${calls}` } }
      messageStoreBus.getOrCreate(instanceId).upsertMessage({
        id: `stream-${calls}`, sessionId, role: "assistant", status: "streaming", createdAt: calls, updatedAt: calls,
      })
      return { data: [apiMessage(`last-${calls}`, sessionId)], cursor: {} }
    } }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      await loadMessages(instanceId, sessionId, { force: true })
      assert.equal(calls, 4)
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId) ?? false, false)
      assert.ok(getSessionMessagesLoadError(instanceId, sessionId), "exhausted conflicts must remain explicit")
    } finally {
      cleanup()
    }
  })

  it("rejects late create and fork responses after an instance reopens", async () => {
    const instanceId = "late-session-mutations"
    const { client, cleanup } = setup(instanceId)
    const created = deferred<any>()
    const forked = deferred<any>()
    ;(client.session as any).create = () => created.promise
    ;(client.session as any).fork = () => forked.promise
    const reopenedClient = { session: { active: async () => ({}) } } as any

    try {
      const createRequest = createSession(instanceId)
      await new Promise<void>((resolve) => setImmediate(resolve))
      removeInstance(instanceId, { authoritative: false })
      addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client: reopenedClient })
      created.resolve(apiSession("late-created"))
      await assert.rejects(createRequest, /Instance no longer ready/)
      assert.equal(sessions().get(instanceId)?.has("late-created") ?? false, false)

      removeInstance(instanceId, { authoritative: false })
      addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
      const forkRequest = forkSession(instanceId, "source")
      removeInstance(instanceId, { authoritative: false })
      addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client: reopenedClient })
      forked.resolve(apiSession("late-fork"))
      await assert.rejects(forkRequest, /Instance no longer ready/)
      assert.equal(sessions().get(instanceId)?.has("late-fork") ?? false, false)
    } finally {
      cleanup()
    }
  })

  it("ignores late delete, agent, and provider responses after an instance reopens", async () => {
    const instanceId = "late-instance-operations", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const removed = deferred<any>()
    const agentList = deferred<any>()
    const providerList = deferred<any>()
    ;(client.session as any).remove = () => removed.promise
    ;(client as any).agent = { list: () => agentList.promise }
    ;(client as any).provider = { list: () => providerList.promise }
    ;(client as any).model = { list: async () => ({ data: [] }) }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const deleteRequest = deleteSession(instanceId, sessionId)
      const agentsRequest = fetchAgents(instanceId)
      const providersRequest = fetchProviders(instanceId)
      removeInstance(instanceId, { authoritative: false })
      const reopenedClient = { session: { active: async () => ({}) } } as any
      addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client: reopenedClient })
      setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

      removed.resolve({ data: true })
      agentList.resolve({ data: [{ name: "late-agent", mode: "primary" }] })
      providerList.resolve({ data: [{ id: "late-provider", name: "Late" }] })
      await Promise.all([deleteRequest, agentsRequest, providersRequest])

      assert.equal(sessions().get(instanceId)?.has(sessionId), true)
      assert.equal(agents().has(instanceId), false)
      assert.equal(providers().has(instanceId), false)
    } finally {
      cleanup()
    }
  })

  it("does not eagerly load descendant transcripts", async () => {
    const instanceId = "root-only-load", rootId = "root", childId = "child"
    const { client, cleanup } = setup(instanceId)
    const calls: string[] = []
    ;(client as any).message = { list: async ({ sessionID }: { sessionID: string }) => {
      calls.push(sessionID)
      return { data: [] }
    } }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([
      [rootId, session(instanceId, rootId)],
      [childId, session(instanceId, childId, rootId)],
    ])))

    try {
      await loadMessages(instanceId, rootId)
      assert.deepEqual(calls, [rootId])
    } finally {
      cleanup()
    }
  })

  it("purges session state and rejects late loads when an instance closes", async () => {
    const instanceId = "instance-state-purge", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    let signal: AbortSignal | undefined
    ;(client as any).message = { list: (_input: unknown, options: { signal?: AbortSignal }) => {
      signal = options.signal
      return response.promise
    } }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    messagesLoaded().set(instanceId, new Set([sessionId]))

    try {
      const request = loadMessages(instanceId, sessionId, { force: true })
      removeInstance(instanceId, { authoritative: false })
      assert.equal(signal?.aborted, true)
      response.resolve({ data: [apiMessage("late", sessionId)] })
      await request

      assert.equal(sessions().has(instanceId), false)
      assert.equal(messagesLoaded().has(instanceId), false)
      assert.equal(loading().loadingMessages.has(instanceId), false)
      assert.equal(messageStoreBus.getInstance(instanceId), undefined)
    } finally {
      cleanup()
    }
  })

  it("does not reuse message load authority after an instance reopens", async () => {
    const instanceId = "reopened-message-load", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const oldResponse = deferred<any>()
    const newResponse = deferred<any>()
    let calls = 0
    ;(client as any).message = { list: () => (++calls === 1 ? oldResponse.promise : newResponse.promise) }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const oldRequest = loadMessages(instanceId, sessionId)
      removeInstance(instanceId, { authoritative: false })
      addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
      setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
      const newRequest = loadMessages(instanceId, sessionId, { force: true })

      oldResponse.resolve({ data: [apiMessage("old-message", sessionId)] })
      await oldRequest
      newResponse.resolve({ data: [apiMessage("new-message", sessionId)] })
      await newRequest

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-message"])
    } finally {
      cleanup()
    }
  })

  it("keeps a newer load authoritative when an older request finishes last", async () => {
    const instanceId = "newer-message-load", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const oldResponse = deferred<any>()
    const newResponse = deferred<any>()
    let calls = 0
    ;(client as any).message = { list: () => (++calls === 1 ? oldResponse.promise : newResponse.promise) }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      let invalidateOld = () => {}
      const oldRequest = loadMessages(instanceId, sessionId, {
        registerInvalidation: (invalidate) => { invalidateOld = invalidate },
      })
      const newRequest = loadMessages(instanceId, sessionId, { force: true })
      invalidateOld()
      newResponse.resolve({ data: [apiMessage("new-message", sessionId)] })
      await newRequest
      oldResponse.resolve({ data: [apiMessage("old-message", sessionId)] })
      await oldRequest

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-message"])
      assert.equal(loading().loadingMessages.get(instanceId)?.has(sessionId) ?? false, false)
    } finally {
      cleanup()
    }
  })

  it("does not let an older timeout invalidate a newer session-list request", async () => {
    const instanceId = "newer-session-list"
    const { client, cleanup } = setup(instanceId)
    const oldResponse = deferred<any>()
    const newResponse = deferred<any>()
    let calls = 0
    ;(client.session as any).list = () => (++calls === 1 ? oldResponse.promise : newResponse.promise)
    ;(client.session as any).status = async () => ({ data: {} })
    ;(client.session as any).get = async ({ sessionID }: { sessionID: string }) => ({ data: apiSession(sessionID) })

    try {
      let invalidateOld = () => {}
      const oldRequest = fetchSessions(instanceId, {
        registerInvalidation: (invalidate) => { invalidateOld = invalidate },
      })
      const newRequest = fetchSessions(instanceId)
      invalidateOld()
      newResponse.resolve({ data: [apiSession("new-session")] })
      await newRequest
      oldResponse.resolve({ data: [apiSession("old-session")] })
      await oldRequest

      assert.equal(sessions().get(instanceId)?.has("new-session"), true)
      assert.equal(sessions().get(instanceId)?.has("old-session"), false)
    } finally {
      cleanup()
    }
  })

  it("reconciles stale runtime status from native active sessions", async () => {
    const instanceId = "authoritative-idle"
    const { client, cleanup } = setup(instanceId)
    const working = { ...session(instanceId, "working"), status: "working" as const }
    const compacting = { ...session(instanceId, "compacting"), status: "compacting" as const }
    const staleWorking = { ...session(instanceId, "stale-working"), status: "working" as const }
    await loadTestWorktree(instanceId)
    setSessions((prev) => new Map(prev).set(instanceId, new Map<string, Session>([
      [working.id, working],
      [compacting.id, compacting],
      [staleWorking.id, staleWorking],
    ])))
    const statusOptions: unknown[] = []
    let messageOptions: unknown
    ;(client.session as any).list = async () => ({ data: [
      apiSession("working"),
      { ...apiSession("compacting"), directory: "/worktree", workspaceID: "workspace-1" },
      apiSession("stale-working"),
    ] })
    ;(client.session as any).active = async () => ({ working: { type: "running" } })
    ;(client.session as any).status = async (options: unknown) => {
      statusOptions.push(options)
      return { data: {} }
    }
    ;(client as any).message = { list: async (options: unknown) => {
      messageOptions = options
      return { data: [] }
    } }
    ;(client.session as any).get = async ({ sessionID }: { sessionID: string }) => ({ data: apiSession(sessionID) })

    try {
      await fetchSessions(instanceId)

      assert.equal(sessions().get(instanceId)?.get("working")?.status, "working")
      assert.equal(sessions().get(instanceId)?.get("compacting")?.status, "idle")
      assert.equal(sessions().get(instanceId)?.get("stale-working")?.status, "idle")
      assert.equal(sessions().get(instanceId)?.get("compacting")?.runtimeStatusKnown, true)
      assert.deepEqual(statusOptions, [])
      await loadMessages(instanceId, "compacting", { force: true })
      assert.deepEqual(messageOptions, { sessionID: "compacting", limit: 200, order: "asc" })
    } finally {
      cleanup()
    }
  })

  it("refreshes sessions when active status is unavailable", async () => {
    const instanceId = "active-status-unavailable"
    const { client, cleanup } = setup(instanceId)
    const existing = { ...session(instanceId, "existing"), status: "working" as const }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[existing.id, existing]])))
    ;(client.session as any).list = async () => ({ data: [apiSession(existing.id), apiSession("new")] })
    ;(client.session as any).active = async () => { throw new Error("forbidden") }

    try {
      await fetchSessions(instanceId)
      assert.equal(sessions().get(instanceId)?.get(existing.id)?.status, "working")
      assert.equal(sessions().get(instanceId)?.get(existing.id)?.runtimeStatusKnown, true)
      assert.equal(sessions().get(instanceId)?.get("new")?.status, "idle")
      assert.equal(sessions().get(instanceId)?.get("new")?.runtimeStatusKnown, false)
    } finally {
      cleanup()
    }
  })

  it("accepts native absolute session locations without workspace probing", async () => {
    const instanceId = "unresolved-worktree-status"
    const { client, cleanup } = setup(instanceId)
    const existing = { ...session(instanceId, "worktree-session"), status: "working" as const }
    await loadTestWorktree(instanceId)
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[existing.id, existing]])))
    ;(client.session as any).list = async () => ({ data: [
      { ...apiSession(existing.id), location: { directory: "/worktree" } },
    ] })
    ;(client.session as any).active = async () => ({ [existing.id]: { type: "running" } })

    try {
      await fetchSessions(instanceId, { strictStatus: true })
      assert.equal(sessions().get(instanceId)?.get(existing.id)?.status, "working")
      assert.equal(sessions().get(instanceId)?.get(existing.id)?.location.directory, "/worktree")
    } finally {
      cleanup()
    }
  })
})
