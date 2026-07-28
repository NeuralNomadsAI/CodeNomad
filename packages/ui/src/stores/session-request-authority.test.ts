import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, instances, isInstanceRuntimeCurrent, removeInstance, updateInstance } from "./instances.ts"
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

function apiMessage(id: string, sessionId: string) {
  return {
    info: {
      id, sessionID: sessionId, role: "assistant", agent: "build", providerID: "provider", modelID: "model",
      time: { created: 1 },
    },
    parts: [],
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
      const oldRequest = loadMessages(instanceId, sessionId)
      const newRequest = loadMessages(instanceId, sessionId, { force: true })
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
})
