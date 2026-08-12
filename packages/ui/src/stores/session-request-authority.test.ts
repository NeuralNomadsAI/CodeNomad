import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import { getOpenCodeWorkspaceIdForSession } from "./opencode-workspaces.ts"
import type { Session } from "../types/session.ts"
import { addInstance, clearReloadableInstanceState, instances, isInstanceRuntimeCurrent, removeInstance, setActiveInstanceId, updateInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { clearSessionSearch, fetchSessions, loadMessages, removeSessionRuntimeState, searchSessions } from "./session-api.ts"
import { handleSessionUpdate } from "./session-events.ts"
import {
  clearInstanceDeletedSessionAuthority,
  getSessionDraftPrompt,
  getSessionSearchResultIds,
  invalidateSessionMessageLoad,
  loading,
  messagesLoaded,
  setActiveSession,
  setSessionDraftPrompt,
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
    version: "1", time: { created: 1, updated: 1 },
  }
}

function apiSession(id: string, parentID?: string) {
  return { id, parentID, title: id, version: "1", time: { created: 1, updated: 1 } }
}

function apiMessage(id: string, sessionId: string, text?: string) {
  return {
    info: {
      id, sessionID: sessionId, role: "assistant", agent: "build", providerID: "provider", modelID: "model",
      time: { created: 1 },
    },
    parts: text === undefined ? [] : [{ id: `${id}-part`, type: "text", text }],
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
  const client = { session: {} } as any
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
  it("keeps metadata refreshes in the same runtime but fences client replacement", () => {
    const instanceId = "instance-runtime-token"
    const { cleanup } = setup(instanceId)
    try {
      const captured = instances().get(instanceId)!
      updateInstance(instanceId, { projectName: "refreshed" })
      assert.equal(isInstanceRuntimeCurrent(instanceId, captured), true)
      updateInstance(instanceId, { client: { session: {} } as any })
      assert.equal(isInstanceRuntimeCurrent(instanceId, captured), false)
    } finally {
      cleanup()
    }
  })

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
    ;(client.session as any).messages = () => response.promise
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
    ;(client.session as any).messages = () => response.promise
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const request = loadMessages(instanceId, sessionId)
      invalidateSessionMessageLoad(instanceId, sessionId)
      response.resolve({ data: [apiMessage("evicted-message", sessionId)] })
      await request

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId) ?? false, false)
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
    ;(client.session as any).messages = () => (++calls === 1 ? oldResponse.promise : newResponse.promise)
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

  it("cancels the previous session load when selection moves to another session", async () => {
    const instanceId = "switched-message-load", firstSessionId = "first", secondSessionId = "second"
    const { client, cleanup } = setup(instanceId)
    const firstRequestStarted = deferred<void>()
    let firstSignal: AbortSignal | undefined
    ;(client.session as any).messages = ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) => {
      if (sessionID !== firstSessionId) return Promise.resolve({ data: [apiMessage("second-message", secondSessionId)] })
      firstSignal = options?.signal
      firstRequestStarted.resolve()
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      })
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([
      [firstSessionId, session(instanceId, firstSessionId)],
      [secondSessionId, session(instanceId, secondSessionId)],
    ])))

    try {
      setActiveSession(instanceId, firstSessionId)
      const request = loadMessages(instanceId, firstSessionId)
      await firstRequestStarted.promise
      setActiveSession(instanceId, secondSessionId)
      assert.equal(firstSignal?.aborted, true)
      await loadMessages(instanceId, secondSessionId)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(secondSessionId), ["second-message"])

      await request

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(firstSessionId), [])
      assert.equal(messagesLoaded().get(instanceId)?.has(firstSessionId) ?? false, false)
      assert.equal(loading().loadingMessages.get(instanceId)?.has(firstSessionId) ?? false, false)
    } finally {
      cleanup()
    }
  })

  it("invalidates an in-flight message load during same-runtime rehydration", async () => {
    const instanceId = "same-runtime-rehydration", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    let loadSignal: AbortSignal | undefined
    ;(client.session as any).messages = (_input: unknown, options?: { signal?: AbortSignal }) => {
      loadSignal = options?.signal
      return response.promise
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const request = loadMessages(instanceId, sessionId)
      while (!loadSignal) await new Promise<void>((resolve) => setImmediate(resolve))
      clearReloadableInstanceState(instanceId)
      assert.equal(loadSignal.aborted, true)
      response.resolve({ data: [apiMessage("stale-message", sessionId)] })
      await request

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
    } finally {
      cleanup()
    }
  })

  it("cancels a revision retry while the session is hidden", async () => {
    const instanceId = "hidden-message-retry", sessionId = "session", nextSessionId = "next"
    const { client, cleanup } = setup(instanceId)
    const firstResponse = deferred<any>()
    let calls = 0
    ;(client.session as any).messages = () => {
      calls += 1
      return calls === 1 ? firstResponse.promise : Promise.resolve({ data: [apiMessage("retried-message", sessionId)] })
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([
      [sessionId, session(instanceId, sessionId)],
      [nextSessionId, session(instanceId, nextSessionId)],
    ])))

    try {
      setActiveSession(instanceId, sessionId)
      const request = loadMessages(instanceId, sessionId)
      messageStoreBus.getOrCreate(instanceId).upsertMessage({
        id: "live-message",
        sessionId,
        role: "assistant",
        status: "complete",
        parts: [],
      })
      firstResponse.resolve({ data: [apiMessage("http-message", sessionId)] })
      await new Promise<void>((resolve) => setImmediate(resolve))
      setActiveSession(instanceId, nextSessionId)
      await request

      assert.equal(calls, 1)
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId) ?? false, false)
    } finally {
      cleanup()
    }
  })

  it("cancels child loads owned by the session being left", async () => {
    const instanceId = "switched-child-load", parentSessionId = "parent", childSessionId = "child"
    const { client, cleanup } = setup(instanceId)
    const started = deferred<void>()
    let childSignal: AbortSignal | undefined
    ;(client.session as any).messages = (_parameters: unknown, options?: { signal?: AbortSignal }) => {
      childSignal = options?.signal
      started.resolve()
      return new Promise((_resolve, reject) => options?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      ))
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([
      [parentSessionId, session(instanceId, parentSessionId)],
      [childSessionId, session(instanceId, childSessionId, parentSessionId)],
      ["next", session(instanceId, "next")],
    ])))

    try {
      setActiveSession(instanceId, parentSessionId)
      const request = loadMessages(instanceId, childSessionId)
      await started.promise
      setActiveSession(instanceId, "next")
      assert.equal(childSignal?.aborted, true)
      await request
      assert.equal(loading().loadingMessages.get(instanceId)?.has(childSessionId) ?? false, false)
    } finally {
      cleanup()
    }
  })

  it("cancels a selected child load through its root ownership", async () => {
    const instanceId = "selected-child-load", parentSessionId = "parent", childSessionId = "child"
    const { client, cleanup } = setup(instanceId)
    const started = deferred<void>()
    let childSignal: AbortSignal | undefined
    ;(client.session as any).messages = (_parameters: unknown, options?: { signal?: AbortSignal }) => {
      childSignal = options?.signal
      started.resolve()
      return new Promise((_resolve, reject) => options?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      ))
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([
      [parentSessionId, session(instanceId, parentSessionId)],
      [childSessionId, session(instanceId, childSessionId, parentSessionId)],
      ["next", session(instanceId, "next")],
    ])))

    try {
      setActiveSession(instanceId, childSessionId)
      const request = loadMessages(instanceId, childSessionId)
      await started.promise
      setActiveSession(instanceId, "next")
      assert.equal(childSignal?.aborted, true)
      await request
    } finally {
      cleanup()
    }
  })

  it("cancels child loads when their workspace loses visibility", async () => {
    const instanceId = "hidden-child-load", parentSessionId = "parent", childSessionId = "child"
    const { client, cleanup } = setup(instanceId)
    const started = deferred<void>()
    let childSignal: AbortSignal | undefined
    ;(client.session as any).messages = (_parameters: unknown, options?: { signal?: AbortSignal }) => {
      childSignal = options?.signal
      started.resolve()
      return new Promise((_resolve, reject) => options?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      ))
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([
      [parentSessionId, session(instanceId, parentSessionId)],
      [childSessionId, session(instanceId, childSessionId, parentSessionId)],
    ])))

    try {
      setActiveInstanceId(instanceId)
      setActiveSession(instanceId, parentSessionId)
      const request = loadMessages(instanceId, childSessionId)
      await started.promise
      setActiveInstanceId("another-instance")
      assert.equal(childSignal?.aborted, true)
      await request
    } finally {
      setActiveInstanceId(null)
      cleanup()
    }
  })

  it("rejects message hydration after in-place client replacement", async () => {
    const instanceId = "replaced-message-client", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    ;(client.session as any).messages = () => response.promise
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const request = loadMessages(instanceId, sessionId)
      updateInstance(instanceId, { client: { session: {} } as any })
      response.resolve({ data: [apiMessage("stale-message", sessionId)] })
      await request
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
    } finally {
      cleanup()
    }
  })

  it("rejects session-list deletion after in-place client replacement", async () => {
    const instanceId = "replaced-session-list", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    ;(client.session as any).list = () => response.promise
    ;(client.session as any).status = async () => ({ data: {} })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const request = fetchSessions(instanceId)
      updateInstance(instanceId, { client: { session: {} } as any })
      response.resolve({ data: [] })
      await request
      assert.equal(sessions().get(instanceId)?.has(sessionId), true)
    } finally {
      cleanup()
    }
  })

  it("uses the fetched revert anchor before pruning reconnected history", async () => {
    const instanceId = "authoritative-reconnect-revert", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const staleRevert = { messageID: "stale-anchor" }
    const fetchedRevert = { messageID: "fetched-anchor" }
    ;(client.session as any).list = async () => ({ data: [{ ...apiSession(sessionId), revert: fetchedRevert }] })
    ;(client.session as any).status = async () => ({ data: {} })
    ;(client.session as any).messages = async () => ({ data: [
      apiMessage("before", sessionId, "before"),
      apiMessage("stale-anchor", sessionId, "stale"),
      apiMessage("fetched-anchor", sessionId, "fetched"),
      apiMessage("after", sessionId, "after"),
    ] })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[
      sessionId,
      { ...session(instanceId, sessionId), revert: staleRevert },
    ]])))
    messageStoreBus.getOrCreate(instanceId).setSessionRevert(sessionId, staleRevert)
    for (const id of ["before", "stale-anchor", "fetched-anchor", "after"]) {
      messageStoreBus.getOrCreate(instanceId).upsertMessage({ id, sessionId, role: "assistant", status: "complete", parts: [] })
    }
    messageStoreBus.getOrCreate(instanceId).setSessionRevert(sessionId, staleRevert)

    try {
      await fetchSessions(instanceId)

      assert.deepEqual(sessions().get(instanceId)?.get(sessionId)?.revert, fetchedRevert)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionRevert(sessionId), fetchedRevert)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["before", "stale-anchor"])
    } finally {
      cleanup()
    }
  })

  it("repairs resident history when a session list clears its revert", async () => {
    const instanceId = "session-list-cleared-revert", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const oldRevert = { messageID: "anchor" }
    ;(client.session as any).list = async () => ({ data: [apiSession(sessionId)] })
    ;(client.session as any).status = async () => ({ data: {} })
    ;(client.session as any).messages = async () => ({ data: [
      apiMessage("before", sessionId, "before"),
      apiMessage("anchor", sessionId, "anchor"),
      apiMessage("after", sessionId, "after"),
    ] })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[
      sessionId,
      { ...session(instanceId, sessionId), revert: oldRevert },
    ]])))
    const store = messageStoreBus.getOrCreate(instanceId)
    for (const id of ["before", "anchor", "after"]) {
      store.upsertMessage({ id, sessionId, role: "assistant", status: "complete", parts: [] })
    }
    store.setSessionRevert(sessionId, oldRevert)
    assert.deepEqual(store.getSessionMessageIds(sessionId), ["before"])

    try {
      await fetchSessions(instanceId)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["before", "anchor", "after"])
      assert.equal(store.getSessionRevert(sessionId), null)
    } finally {
      cleanup()
    }
  })

  it("keeps newer SSE revert authority over a deferred session list", async () => {
    const instanceId = "session-list-revert-fence", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    const staleRevert = { messageID: "stale" }
    const currentRevert = { messageID: "current" }
    ;(client.session as any).list = () => response.promise
    ;(client.session as any).status = async () => ({ data: {} })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[
      sessionId,
      { ...session(instanceId, sessionId), revert: staleRevert },
    ]])))

    try {
      const request = fetchSessions(instanceId)
      handleSessionUpdate(instanceId, {
        type: "session.updated",
        properties: { info: { ...apiSession(sessionId), revert: currentRevert } },
      } as any)
      response.resolve({ data: [{ ...apiSession(sessionId), revert: staleRevert }] })
      await request

      assert.equal(sessions().get(instanceId)?.get(sessionId)?.revert?.messageID, currentRevert.messageID)
    } finally {
      cleanup()
    }
  })

  it("applies authoritative status while preserving newer SSE metadata", async () => {
    const instanceId = "session-list-field-authority", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const status = deferred<any>()
    let statusStarted = false
    ;(client.session as any).list = async () => ({ data: [{ ...apiSession(sessionId), title: "Stale title" }] })
    ;(client.session as any).status = () => {
      statusStarted = true
      return status.promise
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[
      sessionId,
      { ...session(instanceId, sessionId), title: "Original title", status: "working" },
    ]])))

    try {
      const request = fetchSessions(instanceId)
      while (!statusStarted) await new Promise<void>((resolve) => setImmediate(resolve))
      handleSessionUpdate(instanceId, {
        type: "session.updated",
        properties: { info: { ...apiSession(sessionId), title: "Current SSE title" } },
      } as any)
      status.resolve({ data: {} })
      await request

      assert.equal(sessions().get(instanceId)?.get(sessionId)?.title, "Current SSE title")
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.status, "idle")
    } finally {
      cleanup()
    }
  })

  it("keeps newer SSE revert authority over a deferred session search", async () => {
    const instanceId = "session-search-revert-fence", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    const staleRevert = { messageID: "stale" }
    const currentRevert = { messageID: "current" }
    ;(client.session as any).list = () => response.promise
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[
      sessionId,
      { ...session(instanceId, sessionId), revert: staleRevert },
    ]])))

    try {
      const request = searchSessions(instanceId, "session")
      handleSessionUpdate(instanceId, {
        type: "session.updated",
        properties: { info: { ...apiSession(sessionId), revert: currentRevert } },
      } as any)
      response.resolve({ data: [{ ...apiSession(sessionId), revert: staleRevert }] })
      await request

      assert.equal(sessions().get(instanceId)?.get(sessionId)?.revert?.messageID, currentRevert.messageID)
    } finally {
      cleanup()
    }
  })

  it("keeps a committed search authoritative over an older reconnect list and history prune", async () => {
    const instanceId = "search-over-reconnect-fence", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const reconnect = deferred<any>()
    const staleRevert = { messageID: "anchor" }
    ;(client.session as any).list = ({ search }: { search?: string }) => search
      ? Promise.resolve({ data: [apiSession(sessionId)] })
      : reconnect.promise
    ;(client.session as any).status = async () => ({ data: {} })
    ;(client.session as any).messages = async () => ({ data: [
      apiMessage("before", sessionId, "before"),
      apiMessage("anchor", sessionId, "anchor"),
      apiMessage("after", sessionId, "after"),
    ] })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const reconnectRequest = fetchSessions(instanceId)
      await searchSessions(instanceId, "session")
      reconnect.resolve({ data: [{ ...apiSession(sessionId), revert: staleRevert }] })
      await reconnectRequest
      await loadMessages(instanceId, sessionId, { force: true })

      assert.equal(sessions().get(instanceId)?.get(sessionId)?.revert, undefined)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["before", "anchor", "after"])
    } finally {
      cleanup()
    }
  })

  it("does not delete a session mutated by a newer search after a complete list starts", async () => {
    const instanceId = "search-over-omitting-list", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const status = deferred<any>()
    let statusStarted = false
    ;(client.session as any).list = ({ search }: { search?: string }) => Promise.resolve({
      data: search ? [{ ...apiSession(sessionId), title: "Current search", metadata: { source: "search" } }] : [],
    })
    ;(client.session as any).status = () => {
      statusStarted = true
      return status.promise
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    setSessionDraftPrompt(instanceId, sessionId, "unsent draft")

    try {
      const reconnect = fetchSessions(instanceId, { authoritativeDeletes: true })
      while (!statusStarted) await new Promise<void>((resolve) => setImmediate(resolve))
      await searchSessions(instanceId, "session")
      status.resolve({ data: {} })
      await reconnect

      assert.equal(sessions().get(instanceId)?.get(sessionId)?.title, "Current search")
      assert.equal(getSessionDraftPrompt(instanceId, sessionId), "unsent draft")
    } finally {
      cleanup()
    }
  })

  it("keeps a newer list commit authoritative over an older search", async () => {
    const instanceId = "list-over-search-fence", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const search = deferred<any>()
    const currentRevert = { messageID: "current-anchor" }
    const staleRevert = { messageID: "stale-anchor" }
    ;(client.session as any).list = ({ search: query }: { search?: string }) => query
      ? search.promise
      : Promise.resolve({ data: [{
          ...apiSession(sessionId),
          title: "Current list",
          metadata: { source: "list" },
          revert: currentRevert,
        }] })
    ;(client.session as any).status = async () => ({ data: {} })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const staleSearch = searchSessions(instanceId, "session")
      await fetchSessions(instanceId)
      search.resolve({ data: [{
        ...apiSession(sessionId),
        title: "Stale search",
        metadata: { source: "search" },
        revert: staleRevert,
      }] })
      await staleSearch

      assert.equal(sessions().get(instanceId)?.get(sessionId)?.title, "Current list")
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.revert?.messageID, currentRevert.messageID)
    } finally {
      cleanup()
    }
  })

  it("returns newer SSE metadata as reconnect authority so reload reapplies its revert", async () => {
    const instanceId = "sse-revert-reconnect-authority", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const status = deferred<any>()
    let statusStarted = false
    ;(client.session as any).list = async () => ({ data: [{
      ...apiSession(sessionId),
      metadata: { source: "stale-list" },
    }] })
    ;(client.session as any).status = () => {
      statusStarted = true
      return status.promise
    }
    ;(client.session as any).messages = async () => ({ data: [
      apiMessage("before", sessionId, "before"),
      apiMessage("anchor", sessionId, "anchor"),
      apiMessage("after", sessionId, "after"),
    ] })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    const store = messageStoreBus.getOrCreate(instanceId)
    for (const id of ["before", "anchor", "after"]) {
      store.upsertMessage({ id, sessionId, role: "assistant", status: "complete", parts: [] })
    }

    try {
      const reconnect = fetchSessions(instanceId)
      while (!statusStarted) await new Promise<void>((resolve) => setImmediate(resolve))
      handleSessionUpdate(instanceId, {
        type: "session.updated",
        properties: { info: { ...apiSession(sessionId), revert: { messageID: "anchor" } } },
      } as any)
      status.resolve({ data: {} })
      const refreshed = await reconnect
      await loadMessages(instanceId, sessionId, { force: true, applySessionRevert: refreshed.has(sessionId) })

      assert.equal(refreshed.has(sessionId), true)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["before"])
    } finally {
      cleanup()
    }
  })

  it("hydrates only missing ancestors without overwriting the owning search result", async () => {
    const instanceId = "search-parent-self-overwrite", sessionId = "child"
    const { client, cleanup } = setup(instanceId)
    const staleRevert = { messageID: "anchor" }
    let calls = 0
    ;(client.session as any).list = () => Promise.resolve({
      data: ++calls === 1
        ? [{ ...apiSession(sessionId, "parent"), title: "current child" }]
        : [
            apiSession("parent"),
            { ...apiSession(sessionId, "parent"), title: "stale child", revert: staleRevert },
            apiSession("unrelated"),
          ],
    })
    ;(client.session as any).messages = async () => ({ data: [
      apiMessage("before", sessionId, "before"),
      apiMessage("anchor", sessionId, "anchor"),
      apiMessage("after", sessionId, "after"),
    ] })

    try {
      await searchSessions(instanceId, "child")
      await loadMessages(instanceId, sessionId, { force: true })

      assert.equal(sessions().get(instanceId)?.get(sessionId)?.title, "current child")
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.revert, undefined)
      assert.equal(sessions().get(instanceId)?.has("unrelated"), false)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["before", "anchor", "after"])
    } finally {
      cleanup()
    }
  })

  it("keeps a newer search revert authoritative over a deferred parent-chain response", async () => {
    const instanceId = "superseded-parent-chain-revert"
    const { client, cleanup } = setup(instanceId)
    const parents = deferred<any>()
    const staleRevert = { messageID: "stale" }
    const currentRevert = { messageID: "current" }
    let calls = 0
    ;(client.session as any).list = () => {
      calls += 1
      if (calls === 1) return Promise.resolve({ data: [apiSession("child", "parent")] })
      if (calls === 2) return parents.promise
      return Promise.resolve({ data: [{ ...apiSession("target"), revert: currentRevert }] })
    }

    try {
      const staleSearch = searchSessions(instanceId, "child")
      while (calls < 2) await new Promise<void>((resolve) => setImmediate(resolve))
      await searchSessions(instanceId, "target")
      assert.equal(sessions().get(instanceId)?.get("target")?.revert?.messageID, currentRevert.messageID)

      parents.resolve({ data: [apiSession("parent"), { ...apiSession("target"), revert: staleRevert }] })
      await staleSearch

      assert.equal(sessions().get(instanceId)?.get("target")?.revert?.messageID, currentRevert.messageID)
    } finally {
      cleanup()
    }
  })

  it("keeps SSE session metadata authoritative over deferred parent hydration", async () => {
    const instanceId = "parent-chain-metadata-fence"
    const { client, cleanup } = setup(instanceId)
    const parents = deferred<any>()
    let calls = 0
    ;(client.session as any).list = () => ++calls === 1
      ? Promise.resolve({ data: [apiSession("child", "parent")] })
      : parents.promise

    try {
      const request = searchSessions(instanceId, "child")
      while (calls < 2) await new Promise<void>((resolve) => setImmediate(resolve))
      handleSessionUpdate(instanceId, {
        type: "session.updated",
        properties: { info: { ...apiSession("parent"), title: "current parent" } },
      } as any)
      parents.resolve({ data: [{ ...apiSession("parent"), title: "stale parent" }] })
      await request

      assert.equal(sessions().get(instanceId)?.get("parent")?.title, "current parent")
      assert.deepEqual(getSessionSearchResultIds(instanceId), ["child"])
    } finally {
      cleanup()
    }
  })

  it("aborts superseded searches and their parent requests", async () => {
    const instanceId = "abort-superseded-search"
    const { client, cleanup } = setup(instanceId)
    let calls = 0
    let searchSignal: AbortSignal | undefined
    let parentSignal: AbortSignal | undefined
    ;(client.session as any).list = (
      { search }: { search?: string },
      options?: { signal?: AbortSignal },
    ) => {
      calls += 1
      if (calls === 1) return Promise.resolve({ data: [apiSession("child", "parent")] })
      if (calls === 2) {
        parentSignal = options?.signal
        return new Promise((_resolve, reject) => options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        ))
      }
      if (search === "stale") {
        searchSignal = options?.signal
        return new Promise((_resolve, reject) => options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        ))
      }
      return Promise.resolve({ data: [apiSession("current")] })
    }

    try {
      const parentSearch = searchSessions(instanceId, "child")
      while (!parentSignal) await new Promise<void>((resolve) => setImmediate(resolve))
      await searchSessions(instanceId, "current")
      await parentSearch
      assert.equal(parentSignal.aborted, true)

      const staleSearch = searchSessions(instanceId, "stale")
      while (!searchSignal) await new Promise<void>((resolve) => setImmediate(resolve))
      clearSessionSearch(instanceId)
      await staleSearch
      assert.equal(searchSignal.aborted, true)
    } finally {
      cleanup()
    }
  })

  it("hydrates a complete deep chain from a capped search page before publishing", async () => {
    const instanceId = "deep-capped-search-chain"
    const { client, cleanup } = setup(instanceId)
    let listCalls = 0
    const getCalls: string[] = []
    ;(client.session as any).list = () => {
      listCalls += 1
      if (listCalls === 1) return Promise.resolve({ data: [apiSession("leaf", "middle")] })
      return Promise.resolve({ data: [
        apiSession("middle", "root"),
        ...Array.from({ length: 199 }, (_, index) => apiSession(`filler-${index}`)),
      ] })
    }
    ;(client.session as any).get = ({ sessionID }: { sessionID: string }) => {
      getCalls.push(sessionID)
      return Promise.resolve({ data: apiSession(sessionID) })
    }

    try {
      await searchSessions(instanceId, "leaf")
      assert.deepEqual(getCalls, ["root"])
      assert.equal(sessions().get(instanceId)?.get("leaf")?.parentId, "middle")
      assert.equal(sessions().get(instanceId)?.get("middle")?.parentId, "root")
      assert.deepEqual(getSessionSearchResultIds(instanceId), ["leaf"])
    } finally {
      cleanup()
    }
  })

  it("does not publish a deep search result whose root chain cannot be resolved", async () => {
    const instanceId = "unresolved-search-chain"
    const { client, cleanup } = setup(instanceId)
    let calls = 0
    ;(client.session as any).list = () => Promise.resolve({ data: ++calls === 1 ? [apiSession("leaf", "missing")] : [] })
    ;(client.session as any).get = async () => { throw new Error("missing parent") }

    try {
      await searchSessions(instanceId, "leaf")
      assert.deepEqual(getSessionSearchResultIds(instanceId), [])
    } finally {
      cleanup()
    }
  })

  it("reloads history pruned by an older revert when search returns newer metadata", async () => {
    const instanceId = "search-revert-history-repair", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    ;(client.session as any).list = async () => ({ data: [apiSession(sessionId)] })
    ;(client.session as any).messages = async () => ({ data: [
      apiMessage("before", sessionId, "before"),
      apiMessage("anchor", sessionId, "anchor"),
      apiMessage("after", sessionId, "after"),
    ] })
    const oldRevert = { messageID: "anchor" }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[
      sessionId,
      { ...session(instanceId, sessionId), revert: oldRevert },
    ]])))
    const store = messageStoreBus.getOrCreate(instanceId)
    for (const id of ["before", "anchor", "after"]) {
      store.upsertMessage({ id, sessionId, role: "assistant", status: "complete", parts: [] })
    }
    store.setSessionRevert(sessionId, oldRevert)
    assert.deepEqual(store.getSessionMessageIds(sessionId), ["before"])

    try {
      await searchSessions(instanceId, "session")
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["before", "anchor", "after"])
      assert.equal(store.getSessionRevert(sessionId), null)
    } finally {
      cleanup()
    }
  })

  it("repairs stale message-store revert during search even when metadata already matches", async () => {
    const instanceId = "search-message-store-revert-repair", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    ;(client.session as any).list = async () => ({ data: [apiSession(sessionId)] })
    ;(client.session as any).messages = async () => ({ data: [
      apiMessage("before", sessionId, "before"),
      apiMessage("anchor", sessionId, "anchor"),
      apiMessage("after", sessionId, "after"),
    ] })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    const store = messageStoreBus.getOrCreate(instanceId)
    for (const id of ["before", "anchor", "after"]) {
      store.upsertMessage({ id, sessionId, role: "assistant", status: "complete", parts: [] })
    }
    store.setSessionRevert(sessionId, { messageID: "anchor" })
    assert.equal(sessions().get(instanceId)?.get(sessionId)?.revert, undefined)
    assert.deepEqual(store.getSessionMessageIds(sessionId), ["before"])

    try {
      await searchSessions(instanceId, "session")
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["before", "anchor", "after"])
      assert.equal(store.getSessionRevert(sessionId), null)
    } finally {
      cleanup()
    }
  })

  it("starts metadata hydration on a replacement runtime instead of reusing the stale promise", async () => {
    const instanceId = "metadata-hydration-runtime", sessionId = "session"
    const { client: oldClient, cleanup } = setup(instanceId)
    const oldGet = deferred<any>()
    let oldCalls = 0
    ;(oldClient.session as any).list = async () => ({ data: [apiSession(sessionId)] })
    ;(oldClient.session as any).status = async () => ({ data: {} })
    ;(oldClient.session as any).get = () => {
      oldCalls += 1
      return oldGet.promise
    }

    try {
      await fetchSessions(instanceId)
      while (oldCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve))

      let newCalls = 0
      const newClient = {
        session: {
          list: async () => ({ data: [apiSession(sessionId)] }),
          status: async () => ({ data: {} }),
          get: async () => {
            newCalls += 1
            return { data: { ...apiSession(sessionId), metadata: { owner: "new-runtime" } } }
          },
        },
      } as any
      ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, newClient)
      updateInstance(instanceId, { client: newClient })

      await fetchSessions(instanceId)
      while (newCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.metadata?.owner, "new-runtime")

      oldGet.resolve({ data: { ...apiSession(sessionId), metadata: { owner: "old-runtime" } } })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.metadata?.owner, "new-runtime")
    } finally {
      cleanup()
    }
  })

  it("hydrates unknown task-child metadata before loading its transcript", async () => {
    const instanceId = "unknown-task-child", childId = "child"
    const { client, cleanup } = setup(instanceId)
    const calls: string[] = []
    ;(client.session as any).get = ({ sessionID }: { sessionID: string }) => {
      calls.push(`get:${sessionID}`)
      return Promise.resolve({ data: apiSession(sessionID, sessionID === childId ? "parent" : undefined) })
    }
    ;(client.session as any).messages = ({ sessionID }: { sessionID: string }) => {
      calls.push(`messages:${sessionID}`)
      return Promise.resolve({ data: [apiMessage("child-message", sessionID)] })
    }

    try {
      await loadMessages(instanceId, childId)
      assert.deepEqual(calls, ["get:child", "get:parent", "messages:child"])
      assert.equal(sessions().get(instanceId)?.get(childId)?.parentId, "parent")
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(childId), ["child-message"])
    } finally {
      cleanup()
    }
  })

  it("keeps SSE metadata received during unknown task-child workspace lookup", async () => {
    const instanceId = "unknown-task-child-workspace-fence", childId = "child"
    const { client, cleanup } = setup(instanceId)
    ;(client.session as any).get = ({ sessionID }: { sessionID: string }) => Promise.resolve({
      data: { ...apiSession(sessionID, sessionID === childId ? "parent" : undefined), title: `stale ${sessionID}` },
    })
    ;(client.session as any).messages = async () => ({ data: [] })

    try {
      const request = loadMessages(instanceId, childId)
      handleSessionUpdate(instanceId, {
        type: "session.updated",
        properties: { info: { ...apiSession(childId, "parent"), title: "current child" } },
      } as any)
      await request

      assert.equal(sessions().get(instanceId)?.get(childId)?.title, "current child")
      assert.equal(sessions().get(instanceId)?.get(childId)?.parentId, "parent")
    } finally {
      cleanup()
    }
  })

  it("does not reuse search authority after an instance reopens", async () => {
    const instanceId = "reopened-session-search"
    const { client, cleanup } = setup(instanceId)
    const oldResponse = deferred<any>()
    const newResponse = deferred<any>()
    let calls = 0
    ;(client.session as any).list = () => (++calls === 1 ? oldResponse.promise : newResponse.promise)

    try {
      const oldRequest = searchSessions(instanceId, "same")
      removeInstance(instanceId, { authoritative: false })
      addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
      const newRequest = searchSessions(instanceId, "same")

      newResponse.resolve({ data: [apiSession("new-session")] })
      await newRequest
      oldResponse.resolve({ data: [apiSession("old-session")] })
      await oldRequest

      assert.deepEqual(getSessionSearchResultIds(instanceId), ["new-session"])
      assert.equal(sessions().get(instanceId)?.has("old-session") ?? false, false)
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
    ;(client.session as any).messages = () => (++calls === 1 ? oldResponse.promise : newResponse.promise)
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

  it("preserves historical assistant error status during hydration", async () => {
    const instanceId = "errored-message-load", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    ;(client.session as any).messages = async () => ({
      data: [{ ...apiMessage("errored-message", sessionId), info: { ...apiMessage("errored-message", sessionId).info, error: { name: "ProviderError" } } }],
    })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      await loadMessages(instanceId, sessionId)
      assert.equal(messageStoreBus.getOrCreate(instanceId).getMessage("errored-message")?.status, "error")
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

  it("loads subagent messages on demand instead of hydrating an entire family", async () => {
    const instanceId = "lazy-subagent-messages", parentId = "parent", childId = "child"
    const { client, cleanup } = setup(instanceId)
    const calls: string[] = []
    ;(client.session as any).messages = async ({ sessionID }: { sessionID: string }) => {
      calls.push(sessionID)
      return { data: [apiMessage(`${sessionID}-message`, sessionID)] }
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([
      [parentId, session(instanceId, parentId)],
      [childId, session(instanceId, childId, parentId)],
    ])))

    try {
      await loadMessages(instanceId, parentId)
      assert.deepEqual(calls, [parentId])
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(childId), [])
    } finally {
      cleanup()
    }
  })

  it("treats sessions omitted from an authoritative status response as idle", async () => {
    const instanceId = "authoritative-idle"
    const { client, cleanup } = setup(instanceId)
    const working = { ...session(instanceId, "working"), status: "working" as const }
    const compacting = { ...session(instanceId, "compacting"), status: "compacting" as const }
    await loadTestWorktree(instanceId)
    setSessions((prev) => new Map(prev).set(instanceId, new Map<string, Session>([
      [working.id, working],
      [compacting.id, compacting],
    ])))
    const statusOptions: unknown[] = []
    let messageOptions: unknown
    ;(client.session as any).list = async () => ({ data: [
      apiSession("working"),
      { ...apiSession("compacting"), directory: "/worktree", workspaceID: "workspace-1" },
    ] })
    ;(client.session as any).status = async (options: unknown) => {
      statusOptions.push(options)
      return { data: {} }
    }
    ;(client.session as any).messages = async (options: unknown) => {
      messageOptions = options
      return { data: [] }
    }
    ;(client.session as any).get = async ({ sessionID }: { sessionID: string }) => ({ data: apiSession(sessionID) })

    try {
      await fetchSessions(instanceId)

      assert.equal(sessions().get(instanceId)?.get("working")?.status, "idle")
      assert.equal(sessions().get(instanceId)?.get("compacting")?.status, "idle")
      assert.deepEqual(
        statusOptions.map((value) => JSON.stringify(value)).sort(),
        [JSON.stringify({ directory: "/work" }), JSON.stringify({ directory: "/work", workspace: "workspace-1" })].sort(),
      )
      await loadMessages(instanceId, "compacting", { force: true })
      assert.deepEqual(messageOptions, { sessionID: "compacting", workspace: "workspace-1" })
      assert.equal(await getOpenCodeWorkspaceIdForSession(instanceId, "compacting"), "workspace-1")
    } finally {
      cleanup()
    }
  })

  it("rejects strict status refresh when a worktree location is unresolved", async () => {
    const instanceId = "unresolved-worktree-status"
    const { client, cleanup } = setup(instanceId)
    const existing = { ...session(instanceId, "worktree-session"), status: "working" as const }
    await loadTestWorktree(instanceId)
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[existing.id, existing]])))
    ;(client.session as any).list = async () => ({ data: [
      { ...apiSession(existing.id), directory: "/worktree" },
    ] })

    try {
      await assert.rejects(() => fetchSessions(instanceId, { strictStatus: true }), /resolve OpenCode workspace/)
      assert.equal(sessions().get(instanceId)?.get(existing.id)?.status, "working")
    } finally {
      cleanup()
    }
  })
})
