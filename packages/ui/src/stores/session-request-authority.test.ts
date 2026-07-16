import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { loadMessages, removeSessionRuntimeState, searchSessions } from "./session-api.ts"
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
})
