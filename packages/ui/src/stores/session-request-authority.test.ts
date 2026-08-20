import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { fetchSessions, hasMoreMessages, loadMessages, loadMoreMessages, loadMoreSessions, removeSessionRuntimeState, searchSessions } from "./session-api.ts"
import { setInstanceMetadata } from "./instance-metadata.ts"
import {
  clearInstanceDeletedSessionAuthority,
  getSessionSearchResultIds,
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

function session(instanceId: string, id: string): Session {
  return {
    id, instanceId, parentId: null, title: id, agent: "build", model: { providerId: "provider", modelId: "model" },
    status: "idle", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    version: "1", projectID: "project", location: { directory: "/work" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  }
}

function apiSession(id: string, parentID?: string) {
  return {
    id, parentID, title: id, projectID: "project", location: { directory: "/work" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  }
}

function apiMessage(id: string) {
  return {
    id, type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
    time: { created: 1 }, content: [],
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
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
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
    ;(client.session as any).list = () => { calls += 1; return search.promise }
    ;(client.session as any).get = () => parents.promise

    try {
      const request = searchSessions(instanceId, "child")
      search.resolve({ data: [apiSession("child", "parent")] })
      await new Promise<void>((resolve) => setImmediate(resolve))
      removeSessionRuntimeState(instanceId, "child")
      removeSessionRuntimeState(instanceId, "parent")
      parents.resolve(apiSession("parent"))
      await request

      assert.equal(sessions().get(instanceId)?.has("child") ?? false, false)
      assert.equal(sessions().get(instanceId)?.has("parent") ?? false, false)
      assert.deepEqual(getSessionSearchResultIds(instanceId), [])
      assert.equal(calls, 1)
    } finally {
      cleanup()
    }
  })

  it("does not hydrate messages after definitive deletion", async () => {
    const instanceId = "late-message-delete", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    ;(client as any).message = { list: () => response.promise }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      const request = loadMessages(instanceId, sessionId)
      removeSessionRuntimeState(instanceId, sessionId)
      response.resolve({ data: [apiMessage("deleted-message")] })
      await request
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId) ?? false, false)
    } finally {
      cleanup()
    }
  })

  it("keeps a newer message load when an older request finishes last", async () => {
    const instanceId = "newer-message-load", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const oldResponse = deferred<any>()
    const newResponse = deferred<any>()
    let calls = 0
    ;(client as any).message = { list: () => (++calls === 1 ? oldResponse.promise : newResponse.promise) }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      let invalidateOld = () => {}
      const oldRequest = loadMessages(instanceId, sessionId, {
        registerInvalidation: (invalidate) => { invalidateOld = invalidate },
      })
      const newRequest = loadMessages(instanceId, sessionId, { force: true })
      invalidateOld()
      newResponse.resolve({ data: [apiMessage("new-message")] })
      await newRequest
      oldResponse.resolve({ data: [apiMessage("old-message")] })
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

  it("shows the latest message page and preserves it when cursor load-more fails", async () => {
    const instanceId = "partial-message-pages", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    let failSecondPage = false
    let pendingSecondPage: ReturnType<typeof deferred<any>> | undefined
    const requests: any[] = []
    ;(client as any).message = { list: async (input: any) => {
      requests.push(input)
      if (input.cursor && failSecondPage) throw new Error("cursor failed")
      if (input.cursor && pendingSecondPage) return pendingSecondPage.promise
      return input.cursor
        ? { data: [apiMessage("old-2"), apiMessage("old-1")], cursor: {} }
        : { data: [apiMessage("new-2"), apiMessage("new-1")], cursor: { next: "page-2" } }
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      await loadMessages(instanceId, sessionId)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-1", "new-2"])
      assert.deepEqual(requests, [{ sessionID: sessionId, limit: 200, order: "desc" }])
      assert.equal(hasMoreMessages(instanceId, sessionId), true)
      failSecondPage = true
      await assert.rejects(loadMoreMessages(instanceId, sessionId), /cursor failed/)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-1", "new-2"])
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId), true)

      failSecondPage = false
      pendingSecondPage = deferred<any>()
      const firstLoadMore = loadMoreMessages(instanceId, sessionId)
      const concurrentLoadMore = loadMoreMessages(instanceId, sessionId)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(loading().loadingMessages.get(instanceId)?.has(sessionId) ?? false, false)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-1", "new-2"])
      assert.equal(requests.filter((request: any) => request.cursor === "page-2").length, 2)
      pendingSecondPage.resolve({ data: [apiMessage("old-2"), apiMessage("old-1")], cursor: {} })
      await Promise.all([firstLoadMore, concurrentLoadMore])
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["old-1", "old-2", "new-1", "new-2"])
      assert.equal((requests.at(-1) as any)?.cursor, "page-2")
      assert.equal(hasMoreMessages(instanceId, sessionId), false)
    } finally {
      cleanup()
    }
  })

  it("loads paginated project sessions without per-parent requests", async () => {
    const instanceId = "project-descendants"
    const { client, cleanup } = setup(instanceId)
    const requests: any[] = []
    const active: Record<string, unknown> = { later: {} }
    setInstanceMetadata(instanceId, { project: { id: "project", directory: "/work", canonical: "/work" } as any })
    ;(client.session as any).active = async () => active
    ;(client.session as any).list = async (input: any) => {
      requests.push(input)
      if (input.cursor === "page-2") {
        return { data: [apiSession("later"), apiSession("grandchild", "child")], cursor: {} }
      }
      return {
        data: [apiSession("root"), { ...apiSession("child", "root"), subpath: "other-worktree" }],
        cursor: { next: "page-2" },
      }
    }

    try {
      await fetchSessions(instanceId)
      assert.equal(sessions().get(instanceId)?.has("grandchild"), false)
      assert.equal(requests[0].project, "project")
      assert.equal("directory" in requests[0], false)
      assert.equal(requests.every((request) => !("parentID" in request)), true)
      assert.equal(requests.length, 1)

      await loadMoreSessions(instanceId)
      assert.equal(requests.length, 2)
      assert.equal(requests[1].cursor, "page-2")
      assert.equal(sessions().get(instanceId)?.has("grandchild"), true)
      assert.equal(sessions().get(instanceId)?.get("later")?.status, "working")
      assert.equal(sessions().get(instanceId)?.get("later")?.runtimeStatusKnown, true)
    } finally {
      cleanup()
    }
  })
})
