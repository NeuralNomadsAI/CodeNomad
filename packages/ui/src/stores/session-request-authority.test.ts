import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance, updateInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { fetchSessions, loadMessages, removeSessionRuntimeState, searchSessions } from "./session-api.ts"
import {
  clearInstanceDeletedSessionAuthority,
  getSessionSearchResultIds,
  invalidateSessionMessageLoad,
  loading,
  messagesLoaded,
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

  it("aborts obsolete message requests and ignores clients that do not honor abort", async () => {
    const instanceId = "aborted-message-load", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    let signal: AbortSignal | undefined
    ;(client as any).message = { list: (_input: unknown, options: { signal?: AbortSignal }) => {
      signal = options.signal
      return response.promise
    } }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const request = loadMessages(instanceId, sessionId)
      invalidateSessionMessageLoad(instanceId, sessionId)
      assert.equal(signal?.aborted, true)
      response.resolve({ data: [apiMessage("late-message", sessionId)] })
      await request
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
    } finally {
      cleanup()
    }
  })

  it("does not eagerly load descendants with a root transcript", async () => {
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

  it("purges every session-state bucket when an instance is removed", async () => {
    const instanceId = "instance-state-purge", sessionId = "session"
    const { cleanup } = setup(instanceId)
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    messagesLoaded().set(instanceId, new Set([sessionId]))

    try {
      removeInstance(instanceId, { authoritative: false })
      assert.equal(sessions().has(instanceId), false)
      assert.equal(messagesLoaded().has(instanceId), false)
      assert.equal(loading().loadingMessages.has(instanceId), false)
    } finally {
      cleanup()
    }
  })

  it("reloads complete native history after an evicted session is selected again", async () => {
    const instanceId = "evicted-message-reload", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    let calls = 0
    ;(client as any).message = { list: async () => ({ data: [
      apiMessage(`message-${++calls}-a`, sessionId),
      apiMessage(`message-${calls}-b`, sessionId),
    ] }) }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      await loadMessages(instanceId, sessionId)
      const store = messageStoreBus.getOrCreate(instanceId)
      store.restoreScrollSnapshot(sessionId, "message-stream", { scrollTop: 240, atBottom: false, updatedAt: 1 })
      store.clearSession(sessionId, { preserveScroll: true })

      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId) ?? false, false)
      assert.deepEqual(store.getScrollSnapshot(sessionId, "message-stream"), { scrollTop: 240, atBottom: false, updatedAt: 1 })

      await loadMessages(instanceId, sessionId)
      assert.equal(calls, 2)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["message-2-a", "message-2-b"])
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

  it("does not accept a late response from a replaced client", async () => {
    const instanceId = "replaced-message-client", sessionId = "session"
    const { client: oldClient, cleanup } = setup(instanceId)
    const oldResponse = deferred<any>()
    ;(oldClient as any).message = { list: () => oldResponse.promise }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const oldRequest = loadMessages(instanceId, sessionId)
      const newClient = { session: { active: async () => ({}) }, message: { list: async () => ({ data: [] }) } } as any
      updateInstance(instanceId, { client: newClient })
      oldResponse.resolve({ data: [apiMessage("old-client-message", sessionId)] })
      await oldRequest
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
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
      assert.deepEqual(messageOptions, { sessionID: "compacting" })
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
