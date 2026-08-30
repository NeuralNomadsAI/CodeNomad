import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, instances, refreshVolatileInstanceState, removeInstance, updateInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { getCommands } from "./commands.ts"
import { beginMessageHistoryTraversal, fetchAgents, fetchProviders, fetchSessions, hasMoreMessages, hydrateRestoredSessionChain, invalidateMessageHistoryTraversal, isLatestMessageWindow, loadLatestMessageWindow, loadMessages, loadMoreMessages, loadMoreSessions, loadNewerMessageWindow, loadOldestMessageWindow, removeSessionRuntimeState, searchSessions } from "./session-api.ts"
import { getInstanceMetadata, setInstanceMetadata } from "./instance-metadata.ts"
import { loadInstanceMetadata } from "../lib/hooks/use-instance-metadata.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, getOpenCodeMessageRevision } from "./opencode-data.ts"
import {
  clearInstanceDeletedSessionAuthority,
  agents,
  getSessionListError,
  getSessionListIds,
  getSessionMessagesLoadError,
  getSessionSearchResultIds,
  loading,
  messagesLoaded,
  providers,
  prependSessionListId,
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

  it("rejects a zero-revision message response after reconnect advances instance generation", async () => {
    const instanceId = "zero-revision-reconnect", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    ;(client as any).message = { list: () => response.promise }
    ;(client as any).location = { get: async () => ({ directory: "/work" }) }
    ;(client as any).vcs = { get: async () => ({ location: { directory: "/work" }, data: {} }) }
    ;(client as any).project = { list: async () => [] }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      assert.equal(getOpenCodeMessageRevision(instanceId, sessionId), 0)
      const request = loadMessages(instanceId, sessionId)
      applyOpenCodeDataEvent(instanceId, "/work", { id: "connected", type: "server.connected", created: 2, data: {} } as any)
      response.resolve({ data: [apiMessage("stale")], cursor: {} })
      await request

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
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

  it("keeps the session list usable when a background refresh is aborted", async () => {
    const instanceId = "aborted-session-list"
    const { client, cleanup } = setup(instanceId)
    const controller = new AbortController()
    let calls = 0
    ;(client.session as any).list = (_input: unknown, options?: { signal?: AbortSignal }) => {
      calls += 1
      if (calls === 1) return Promise.resolve({ data: [apiSession("root")], cursor: {} })
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("signal is aborted without reason")), { once: true })
      })
    }
    setInstanceMetadata(instanceId, { project: { id: "project", directory: "/work", canonical: "/work" } as any })

    try {
      const request = fetchSessions(instanceId, { reset: true, signal: controller.signal })
      while (calls < 2) await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(getSessionListIds(instanceId), ["root"])
      controller.abort()
      await assert.rejects(request, /signal is aborted without reason/)

      assert.equal(getSessionListError(instanceId), undefined)
      assert.deepEqual(getSessionListIds(instanceId), ["root"])
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
      if (input.cursor && input.order !== undefined) throw new Error("cursor cannot be combined with order")
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
      await new Promise<void>((resolve) => setImmediate(resolve))

      failSecondPage = false
      pendingSecondPage = deferred<any>()
      const firstLoadMore = loadMoreMessages(instanceId, sessionId)
      const concurrentLoadMore = loadMoreMessages(instanceId, sessionId)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(loading().loadingMessages.get(instanceId)?.has(sessionId) ?? false, false)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-1", "new-2"])
      assert.ok(requests.filter((request: any) => request.cursor === "page-2").length >= 1)
      pendingSecondPage.resolve({ data: [apiMessage("old-2"), apiMessage("old-1")], cursor: {} })
      await Promise.all([firstLoadMore, concurrentLoadMore])
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["old-1", "old-2"])
      assert.deepEqual(requests.at(-1), { sessionID: sessionId, limit: 200, cursor: "page-2" })
      assert.equal(hasMoreMessages(instanceId, sessionId), false)
    } finally {
      cleanup()
    }
  })

  it("prunes a partial forced refresh only when its authoritative cursor chain exhausts", async () => {
    const instanceId = "partial-message-refresh", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    let refresh = false
    let failRefresh = false
    const history = Array.from({ length: 400 }, (_, index) => ({
      ...apiMessage(`message-${400 - index}`),
      time: { created: 400 - index, completed: 400 - index },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 1,
    }))
    ;(client as any).message = { list: async (input: any) => !refresh
      ? { data: history, cursor: {} }
      : input.cursor
        ? { data: history.slice(200, 250), cursor: {} }
        : failRefresh
          ? Promise.reject(new Error("replacement refresh failed"))
        : { data: history.slice(0, 200), cursor: { next: "older-page" } } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      await loadMessages(instanceId, sessionId)
      const store = messageStoreBus.getOrCreate(instanceId)
      const oldestInfo = store.getMessageInfo("message-1")
      assert.equal(store.getSessionMessageIds(sessionId).length, 400)
      refresh = true
      await loadMessages(instanceId, sessionId, { force: true })
      assert.deepEqual(store.getSessionMessageIds(sessionId), Array.from({ length: 200 }, (_, index) => `message-${index + 201}`))
      assert.equal(store.getMessageInfo("message-1"), undefined)
      assert.notStrictEqual(store.getMessageInfo("message-201"), oldestInfo)
      assert.equal(store.getSessionUsage(sessionId)?.totalCost, 200)
      assert.equal(hasMoreMessages(instanceId, sessionId), true)

      failRefresh = true
      await assert.rejects(loadMessages(instanceId, sessionId, { force: true }), /replacement refresh failed/)
      failRefresh = false
      await loadMoreMessages(instanceId, sessionId)
      assert.deepEqual(store.getSessionMessageIds(sessionId), Array.from({ length: 50 }, (_, index) => `message-${index + 151}`))
      assert.equal(store.getMessageInfo("message-1"), undefined)
      assert.equal(store.getSessionUsage(sessionId)?.totalCost, 50)
      assert.equal(hasMoreMessages(instanceId, sessionId), false)
    } finally {
      cleanup()
    }
  })

  it("hydrates normally after a non-authoritative remove reuses an instance and session id", async () => {
    const instanceId = "reused-loaded-session", sessionId = "session"
    const old = setup(instanceId)
    ;(old.client as any).message = { list: async () => ({ data: [apiMessage("old-message")], cursor: {} }) }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    await loadMessages(instanceId, sessionId)
    old.cleanup()

    const current = setup(instanceId)
    let calls = 0
    ;(current.client as any).message = { list: async () => {
      calls += 1
      return { data: [apiMessage("new-message")], cursor: {} }
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      assert.equal(calls, 1)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-message"])
    } finally {
      current.cleanup()
    }
  })

  it("keeps a reused instance message-page request registered when the old request settles", async () => {
    const instanceId = "reused-message-page", sessionId = "session"
    const old = setup(instanceId)
    const oldPage = deferred<any>()
    ;(old.client as any).message = { list: (input: any) => input.cursor
      ? oldPage.promise
      : Promise.resolve({ data: [apiMessage("old-new")], cursor: { next: "old-page" } }) }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    await loadMessages(instanceId, sessionId)
    const oldRequest = loadMoreMessages(instanceId, sessionId)
    old.cleanup()

    const current = setup(instanceId)
    const currentPage = deferred<any>()
    let currentPageCalls = 0
    ;(current.client as any).message = { list: (input: any) => {
      if (!input.cursor) return Promise.resolve({ data: [apiMessage("current-new")], cursor: { next: "current-page" } })
      currentPageCalls += 1
      return currentPage.promise
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      await loadMessages(instanceId, sessionId, { force: true })
      const currentRequest = loadMoreMessages(instanceId, sessionId)
      oldPage.resolve({ data: [], cursor: {} })
      await oldRequest
      const concurrentRequest = loadMoreMessages(instanceId, sessionId)
      assert.equal(currentPageCalls, 1)
      currentPage.resolve({ data: [], cursor: {} })
      await Promise.all([currentRequest, concurrentRequest])
    } finally {
      current.cleanup()
    }
  })

  it("replaces older and newer windows without mutating on failure", async () => {
    const instanceId = "replace-windows", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    let failOlder = false
    ;(client as any).message = { list: async (input: any) => {
      if (!input.cursor) return { data: [apiMessage("new-2"), apiMessage("new-1")], cursor: { next: "page-2" } }
      if (failOlder) throw new Error("older failed")
      return { data: [apiMessage("old-2"), apiMessage("old-1")], cursor: {} }
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      failOlder = true
      await assert.rejects(loadMoreMessages(instanceId, sessionId), /older failed/)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-1", "new-2"])
      failOlder = false
      await loadMoreMessages(instanceId, sessionId)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["old-1", "old-2"])
      await loadNewerMessageWindow(instanceId, sessionId)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-1", "new-2"])
      await loadLatestMessageWindow(instanceId, sessionId)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-1", "new-2"])
    } finally {
      cleanup()
    }
  })

  it("retries a latest-window response raced by a native message event", async () => {
    const instanceId = "latest-window-race", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const staleLatest = deferred<any>()
    let calls = 0
    ;(client as any).message = { list: (input: any) => {
      calls += 1
      if (calls === 1) return Promise.resolve({ data: [apiMessage("latest")], cursor: { next: "older" } })
      if (input.cursor === "older") return Promise.resolve({ data: [apiMessage("old")], cursor: {} })
      if (calls === 3) return staleLatest.promise
      return Promise.resolve({ data: [apiMessage("fresh")], cursor: {} })
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      await loadMoreMessages(instanceId, sessionId)
      const request = loadLatestMessageWindow(instanceId, sessionId)
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "live",
        type: "session.step.started",
        created: 2,
        data: {
          sessionID: sessionId,
          assistantMessageID: "fresh",
          agent: "build",
          model: { providerID: "provider", id: "model" },
        },
      } as any)
      staleLatest.resolve({ data: [apiMessage("stale")], cursor: {} })
      await request

      assert.equal(calls, 4)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["fresh"])
    } finally {
      destroyOpenCodeData(instanceId)
      cleanup()
    }
  })

  it("ignores permission and form races but retries a message delta", async () => {
    const instanceId = "latest-window-data-race", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    let calls = 0
    ;(client as any).message = { list: async () => {
      calls += 1
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `permission-${calls}`, type: "permission.asked", created: calls,
        data: { id: `permission-${calls}`, sessionID: sessionId, action: "read", resources: ["*"] },
      } as any)
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `form-${calls}`, type: "form.created", created: calls, location: { directory: "/work" },
        data: { form: { id: `form-${calls}`, sessionID: sessionId, title: "Input", fields: [] } },
      } as any)
      if (calls === 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: "delta", type: "session.text.delta", created: calls,
          data: { sessionID: sessionId, assistantMessageID: "assistant", ordinal: 0, delta: "live" },
        } as any)
      }
      return { data: [apiMessage(`message-${calls}`)], cursor: {} }
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    messageStoreBus.getOrCreate(instanceId).setMessageWindow(sessionId, { kind: "history", resumeCursor: "history", newerCursors: [] })
    try {
      await loadLatestMessageWindow(instanceId, sessionId)

      assert.equal(calls, 2)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["message-2"])
    } finally {
      destroyOpenCodeData(instanceId)
      cleanup()
    }
  })

  it("retries a message page raced by a skill activation", async () => {
    const instanceId = "latest-window-skill-race", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    let calls = 0
    ;(client as any).message = { list: async () => {
      calls += 1
      if (calls === 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: "skill", type: "session.skill.activated", created: 1,
          data: { sessionID: sessionId, id: "skill-message", name: "Skill", text: "Activated" },
        } as any)
      }
      return { data: [apiMessage(`message-${calls}`)], cursor: {} }
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    messageStoreBus.getOrCreate(instanceId).setMessageWindow(sessionId, { kind: "history", resumeCursor: "history", newerCursors: [] })
    try {
      await loadLatestMessageWindow(instanceId, sessionId)

      assert.equal(calls, 2)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["message-2"])
    } finally {
      destroyOpenCodeData(instanceId)
      cleanup()
    }
  })

  it("bounds latest-window retries while native events keep streaming", async () => {
    const instanceId = "latest-window-continuous-race", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    let calls = 0
    ;(client as any).message = { list: async () => {
      calls += 1
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `live-${calls}`,
        type: "session.step.started",
        created: calls,
        data: {
          sessionID: sessionId,
          assistantMessageID: `live-${calls}`,
          agent: "build",
          model: { providerID: "provider", id: "model" },
        },
      } as any)
      return { data: [apiMessage(`stale-${calls}`)], cursor: {} }
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    messageStoreBus.getOrCreate(instanceId).setMessageWindow(sessionId, { kind: "history", resumeCursor: "history", newerCursors: [] })
    try {
      await assert.rejects(loadLatestMessageWindow(instanceId, sessionId))
      assert.equal(calls, 4)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
      assert.equal(isLatestMessageWindow(instanceId, sessionId), false)
      assert.ok(getSessionMessagesLoadError(instanceId, sessionId))
    } finally {
      destroyOpenCodeData(instanceId)
      cleanup()
    }
  })

  it("rejects a history page that loses traversal authority while in flight", async () => {
    const instanceId = "stale-history-traversal", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const oldest = deferred<any>()
    ;(client as any).message = { list: (input: any) => input.order === "asc"
      ? oldest.promise
      : Promise.resolve({ data: [apiMessage("latest")], cursor: { next: "older" } }) }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      const endTraversal = beginMessageHistoryTraversal(instanceId, sessionId)
      const request = loadOldestMessageWindow(instanceId, sessionId)
      endTraversal()
      oldest.resolve({ data: [apiMessage("stale-oldest")], cursor: { next: "newer" } })
      await request

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["latest"])
      assert.equal(isLatestMessageWindow(instanceId, sessionId), true)
    } finally {
      cleanup()
    }
  })

  it("search close invalidates a replacement locator while its oldest page is pending", async () => {
    const instanceId = "closed-replacement-locator", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const oldest = deferred<any>()
    ;(client as any).message = { list: (input: any) => input.order === "asc"
      ? oldest.promise
      : Promise.resolve({ data: [apiMessage("latest")], cursor: { next: "older" } }) }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      const endSearchTraversal = beginMessageHistoryTraversal(instanceId, sessionId)
      beginMessageHistoryTraversal(instanceId, sessionId)
      endSearchTraversal()
      const locator = loadOldestMessageWindow(instanceId, sessionId)

      invalidateMessageHistoryTraversal(instanceId, sessionId)
      oldest.resolve({ data: [apiMessage("stale-locator")], cursor: { next: "newer" } })
      await locator

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["latest"])
      assert.equal(isLatestMessageWindow(instanceId, sessionId), true)
    } finally {
      cleanup()
    }
  })

  it("component disposal invalidates whichever locator owns a pending page", async () => {
    const instanceId = "disposed-current-locator", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const oldest = deferred<any>()
    ;(client as any).message = { list: (input: any) => input.order === "asc"
      ? oldest.promise
      : Promise.resolve({ data: [apiMessage("latest")], cursor: { next: "older" } }) }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      const endOlderOwner = beginMessageHistoryTraversal(instanceId, sessionId)
      beginMessageHistoryTraversal(instanceId, sessionId)
      endOlderOwner()
      const locator = loadOldestMessageWindow(instanceId, sessionId)

      invalidateMessageHistoryTraversal(instanceId, sessionId)
      oldest.resolve({ data: [apiMessage("disposed-stale")], cursor: { next: "newer" } })
      await locator

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["latest"])
      assert.equal(isLatestMessageWindow(instanceId, sessionId), true)
    } finally {
      cleanup()
    }
  })

  it("raw query supersede invalidates a pending locator before debounce", async () => {
    const instanceId = "raw-query-supersede", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const oldest = deferred<any>()
    ;(client as any).message = { list: (input: any) => input.order === "asc"
      ? oldest.promise
      : Promise.resolve({ data: [apiMessage("latest")], cursor: { next: "older" } }) }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      beginMessageHistoryTraversal(instanceId, sessionId)
      const locator = loadOldestMessageWindow(instanceId, sessionId)

      invalidateMessageHistoryTraversal(instanceId, sessionId)
      oldest.resolve({ data: [apiMessage("stale-query")], cursor: { next: "newer" } })
      await locator

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["latest"])
      assert.equal(isLatestMessageWindow(instanceId, sessionId), true)
    } finally {
      cleanup()
    }
  })

  it("accepts a native page started after revert, including later messages", async () => {
    const instanceId = "bounded-revert-authority", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    ;(client as any).message = { list: async () => ({ data: [apiMessage("m300")], cursor: {} }) }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    const step = (id: string, created: number) => {
      applyOpenCodeDataEvent(instanceId, "/work", {
        id, type: "session.step.started", created,
        data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `${id}-end`, type: "session.step.ended", created: created + 1,
        data: { sessionID: sessionId, assistantMessageID: id, finish: "stop" },
      } as any)
    }
    try {
      step("m100", 1)
      step("m200", 3)
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "revert", type: "session.revert.committed", created: 5,
        data: { sessionID: sessionId, to: "m200" },
      } as any)
      step("m300", 6)

      await loadMessages(instanceId, sessionId)

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["m300"])
    } finally {
      destroyOpenCodeData(instanceId)
      cleanup()
    }
  })

  it("rejects stale history pages after cancellation or revert and accepts a later native page", async () => {
    for (const mutation of ["cancel", "revert"] as const) {
      const instanceId = `stale-${mutation}-page`, sessionId = "session"
      const { client, cleanup } = setup(instanceId)
      const stale = deferred<any>()
      let oldestCalls = 0
      ;(client as any).message = { list: (input: any) => {
        if (input.order === "asc") {
          oldestCalls += 1
          return oldestCalls === 1
            ? stale.promise
            : Promise.resolve({ data: [apiMessage(`native-${mutation}`)], cursor: { next: "newer" } })
        }
        return Promise.resolve({ data: [apiMessage("latest")], cursor: { next: "older" } })
      } }
      setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
      try {
        await loadMessages(instanceId, sessionId)
        const request = loadOldestMessageWindow(instanceId, sessionId)
        applyOpenCodeDataEvent(instanceId, "/work", mutation === "cancel"
          ? { id: "mutation", type: "session.inbox.cancelled", created: 2, data: { sessionID: sessionId, inboxID: "latest" } } as any
          : { id: "mutation", type: "session.revert.committed", created: 2, data: { sessionID: sessionId, to: "latest" } } as any)
        stale.resolve({ data: [apiMessage(`stale-${mutation}`)], cursor: { next: "newer" } })
        await request

        assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["latest"])
        await loadOldestMessageWindow(instanceId, sessionId)
        assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [`native-${mutation}`])
      } finally {
        destroyOpenCodeData(instanceId)
        cleanup()
      }
    }
  })

  it("rejects a stale page after more than 200 cancellations without tombstones", async () => {
    const instanceId = "many-cancellation-fence", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const stale = deferred<any>()
    let oldestCalls = 0
    ;(client as any).message = { list: (input: any) => {
      if (input.order !== "asc") return Promise.resolve({ data: [apiMessage("latest")], cursor: { next: "older" } })
      oldestCalls += 1
      return oldestCalls === 1 ? stale.promise : Promise.resolve({ data: [apiMessage("authoritative")], cursor: {} })
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      const request = loadOldestMessageWindow(instanceId, sessionId)
      for (let index = 0; index < 250; index += 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `cancel-${index}`, type: "session.inbox.cancelled", created: index + 2,
          data: { sessionID: sessionId, inboxID: `inbox-${index}` },
        } as any)
      }
      stale.resolve({ data: [apiMessage("stale")], cursor: {} })
      await request
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["latest"])

      await loadOldestMessageWindow(instanceId, sessionId)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["authoritative"])
    } finally {
      destroyOpenCodeData(instanceId)
      cleanup()
    }
  })

  it("fences a newer-page response when revert occurs from an old history window", async () => {
    const instanceId = "old-history-revert-fence", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const staleNewer = deferred<any>()
    let newerCalls = 0
    ;(client as any).message = { list: (input: any) => {
      if (input.order === "asc") return Promise.resolve({ data: [apiMessage("old")], cursor: { next: "newer" } })
      if (input.cursor === "newer") {
        newerCalls += 1
        return newerCalls === 1
          ? staleNewer.promise
          : Promise.resolve({ data: [apiMessage("survivor")], cursor: {} })
      }
      return Promise.resolve({ data: [apiMessage("removed")], cursor: { next: "older" } })
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      await loadOldestMessageWindow(instanceId, sessionId)
      const request = loadNewerMessageWindow(instanceId, sessionId)
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "revert", type: "session.revert.committed", created: 2,
        data: { sessionID: sessionId, to: "removed" },
      } as any)
      staleNewer.resolve({ data: [apiMessage("removed")], cursor: {} })
      await request
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["old"])

      await loadNewerMessageWindow(instanceId, sessionId)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["survivor"])
      assert.equal(isLatestMessageWindow(instanceId, sessionId), true)
    } finally {
      destroyOpenCodeData(instanceId)
      cleanup()
    }
  })

  it("seeks the oldest native page without reversing or mutating on failure", async () => {
    const instanceId = "oldest-window", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const requests: any[] = []
    let failOldest = false
    ;(client as any).message = { list: async (input: any) => {
      requests.push(input)
      if (input.order === "asc") {
        if (failOldest) throw new Error("oldest failed")
        return { data: [apiMessage("first"), apiMessage("second")], cursor: { next: "newer-from-start" } }
      }
      if (input.cursor === "newer-from-start") return { data: [apiMessage("middle-1"), apiMessage("middle-2")], cursor: { next: "newer-middle" } }
      if (input.cursor === "newer-middle") return { data: [apiMessage("recent")], cursor: {} }
      return { data: [apiMessage("new-2"), apiMessage("new-1")], cursor: { next: "page-2" } }
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      failOldest = true
      await assert.rejects(loadOldestMessageWindow(instanceId, sessionId), /oldest failed/)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["new-1", "new-2"])
      failOldest = false
      await loadOldestMessageWindow(instanceId, sessionId)
      assert.deepEqual(requests.at(-1), { sessionID: sessionId, limit: 200, order: "asc" })
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["first", "second"])
      assert.equal(hasMoreMessages(instanceId, sessionId), false)
      await loadNewerMessageWindow(instanceId, sessionId)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["middle-1", "middle-2"])
      await loadNewerMessageWindow(instanceId, sessionId)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["recent"])
      assert.equal(isLatestMessageWindow(instanceId, sessionId), true)
      assert.equal(requests.filter((request) => request.order === "desc").length, 1)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["recent"])
    } finally {
      cleanup()
    }
  })

  it("reaches every newer page after backward cursor memory is capped", async () => {
    const instanceId = "bounded-complete-newer-path", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const latestPage = 40
    ;(client as any).message = { list: async (input: any) => {
      if (!input.cursor) return { data: [apiMessage(`page-${latestPage}`)], cursor: { next: `c${latestPage - 1}` } }
      const page = Number(input.cursor.slice(1))
      return { data: [apiMessage(`page-${page}`)], cursor: page > 0 ? { next: `c${page - 1}` } : {} }
    } }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    try {
      await loadMessages(instanceId, sessionId)
      for (let page = latestPage - 1; page >= 0; page -= 1) await loadMoreMessages(instanceId, sessionId)

      const visited: string[] = []
      while (!isLatestMessageWindow(instanceId, sessionId)) {
        await loadNewerMessageWindow(instanceId, sessionId)
        visited.push(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId)[0]!)
        assert.ok(visited.length <= latestPage)
      }
      assert.deepEqual(visited, Array.from({ length: latestPage }, (_, index) => `page-${index + 1}`))
    } finally {
      cleanup()
    }
  })

  it("loads only the selected session transcript", async () => {
    const instanceId = "selected-transcript", sessionId = "root"
    const { client, cleanup } = setup(instanceId)
    const requests: string[] = []
    ;(client as any).message = { list: async ({ sessionID }: { sessionID: string }) => {
      requests.push(sessionID)
      return { data: [apiMessage(`${sessionID}-message`)], cursor: {} }
    } }
    const child = { ...session(instanceId, "child"), parentId: sessionId }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([
      [sessionId, session(instanceId, sessionId)],
      [child.id, child],
    ])))

    try {
      await loadMessages(instanceId, sessionId)
      assert.deepEqual(requests, [sessionId])
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds("child"), [])
    } finally {
      cleanup()
    }
  })

  it("coalesces concurrent provider catalog loads", async () => {
    const instanceId = "provider-single-flight"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<void>()
    const calls = { provider: 0, model: 0, default: 0 }
    ;(client as any).provider = { list: async () => { calls.provider += 1; await response.promise; return { data: [{ id: "provider", name: "Provider" }] } } }
    ;(client as any).model = {
      list: async () => { calls.model += 1; await response.promise; return { data: [
        { id: "model", providerID: "provider", name: "Model", cost: [{}], limit: {}, variants: [] },
        { id: "retired", providerID: "provider", name: "Retired", status: "deprecated", cost: [{}], limit: {}, variants: [] },
      ] } },
      default: async () => { calls.default += 1; await response.promise; return { data: { id: "model", providerID: "provider", name: "Model", cost: [{}], limit: {}, variants: [] } } },
    }

    try {
      const first = fetchProviders(instanceId)
      const second = fetchProviders(instanceId)
      assert.deepEqual(calls, { provider: 1, model: 1, default: 1 })
      response.resolve()
      assert.deepEqual(await Promise.all([first, second]), [true, true])
      assert.deepEqual(providers().get(instanceId)?.[0]?.models.map((model) => model.id), ["model"])
    } finally {
      cleanup()
    }
  })

  it("runs one trailing provider refresh after an in-flight invalidation", async () => {
    const instanceId = "provider-trailing-refresh"
    const { client, cleanup } = setup(instanceId)
    const gates = [deferred<void>(), deferred<void>()]
    const calls = { provider: 0, model: 0, default: 0 }
    ;(client as any).provider = { list: async () => {
      const index = calls.provider++
      await gates[index].promise
      return { data: [{ id: "provider", name: "Provider" }] }
    } }
    ;(client as any).model = {
      list: async () => {
        const index = calls.model++
        await gates[index].promise
        return { data: [{ id: `model-${index}`, providerID: "provider", name: "Model", cost: [{}], limit: {}, variants: [] }] }
      },
      default: async () => {
        const index = calls.default++
        await gates[index].promise
        return { data: { id: `model-${index}`, providerID: "provider", name: "Model", cost: [{}], limit: {}, variants: [] } }
      },
    }

    try {
      const first = fetchProviders(instanceId)
      const refreshed = fetchProviders(instanceId, { directory: "/work" }, true)
      gates[0].resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(calls, { provider: 2, model: 2, default: 2 })
      gates[1].resolve()
      assert.deepEqual(await Promise.all([first, refreshed]), [true, true])
      assert.equal(providers().get(instanceId)?.[0]?.models[0]?.id, "model-1")
    } finally {
      cleanup()
    }
  })

  it("rejects an old catalog response after an instance id is reused", async () => {
    const instanceId = "provider-reused-instance"
    const old = setup(instanceId)
    const oldGate = deferred<void>()
    let oldCalls = 0
    ;(old.client as any).provider = { list: async () => { oldCalls += 1; await oldGate.promise; return { data: [{ id: "old", name: "Old" }] } } }
    ;(old.client as any).model = {
      list: async () => { await oldGate.promise; return { data: [] } },
      default: async () => { await oldGate.promise; return { data: null } },
    }
    const oldRequest = fetchProviders(instanceId)
    const oldRefresh = fetchProviders(instanceId, { directory: "/work" }, true)
    old.cleanup()

    const current = setup(instanceId)
    const currentGate = deferred<void>()
    ;(current.client as any).provider = { list: async () => { await currentGate.promise; return { data: [{ id: "current", name: "Current" }] } } }
    ;(current.client as any).model = {
      list: async () => { await currentGate.promise; return { data: [] } },
      default: async () => { await currentGate.promise; return { data: null } },
    }

    try {
      const currentRequest = fetchProviders(instanceId)
      oldGate.resolve()
      assert.deepEqual(await Promise.all([oldRequest, oldRefresh]), [false, false])
      assert.equal(oldCalls, 1)
      currentGate.resolve()
      assert.equal(await currentRequest, true)
      assert.equal(providers().get(instanceId)?.[0]?.id, "current")
    } finally {
      current.cleanup()
    }
  })

  it("rejects every old-client response when a live instance replaces its client", async () => {
    const instanceId = "replaced-live-client", sessionId = "session"
    const { client: oldClient, cleanup } = setup(instanceId)
    const sessionResponse = deferred<any>()
    const messageResponse = deferred<any>()
    const agentResponse = deferred<any>()
    const commandResponse = deferred<any>()
    const providerGate = deferred<void>()
    ;(oldClient.session as any).list = () => sessionResponse.promise
    ;(oldClient as any).message = { list: () => messageResponse.promise }
    ;(oldClient as any).agent = {
      list: () => agentResponse.promise,
      get: ({ agentID }: any) => Promise.resolve({ data: { id: agentID, name: agentID, mode: "primary" } }),
    }
    ;(oldClient as any).command = { list: () => commandResponse.promise }
    ;(oldClient as any).provider = { list: async () => { await providerGate.promise; return { data: [{ id: "old-provider", name: "Old" }] } } }
    ;(oldClient as any).model = {
      list: async () => { await providerGate.promise; return { data: [] } },
      default: async () => { await providerGate.promise; return { data: null } },
    }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
    const oldSessionRequest = fetchSessions(instanceId)
    const oldMessageRequest = loadMessages(instanceId, sessionId)
    const oldAgentRequest = fetchAgents(instanceId)
    const oldProviderRequest = fetchProviders(instanceId)
    const oldVolatileRefresh = refreshVolatileInstanceState(instanceId, ["commands"])

    const newClient = {
      session: { active: async () => ({}) },
      command: { list: async () => ({ data: [{ name: "current-command" }] }) },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, newClient)
    updateInstance(instanceId, { client: newClient })
    await refreshVolatileInstanceState(instanceId, ["commands"])
    sessionResponse.resolve({ data: [apiSession("stale-session")], cursor: {} })
    messageResponse.resolve({ data: [apiMessage("stale-message")], cursor: {} })
    agentResponse.resolve({ data: [
      { id: "build", name: "Build", mode: "primary" },
      { id: "plan", name: "Plan", mode: "primary" },
      { id: "old-agent", name: "Old", mode: "primary" },
    ] })
    commandResponse.resolve({ data: [{ name: "stale-command" }] })
    providerGate.resolve()

    try {
      assert.deepEqual(await Promise.all([oldAgentRequest, oldProviderRequest]), [false, false])
      await Promise.all([oldSessionRequest, oldMessageRequest, oldVolatileRefresh])
      assert.equal(sessions().get(instanceId)?.has("stale-session"), false)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
      assert.equal(agents().get(instanceId)?.some(({ id }) => id === "old-agent") ?? false, false)
      assert.equal(providers().get(instanceId)?.some(({ id }) => id === "old-provider") ?? false, false)
      assert.deepEqual(getCommands(instanceId).map(({ name }) => name), ["current-command"])
    } finally {
      cleanup()
    }
  })

  it("invalidates loaded metadata when updateInstance replaces the live client", async () => {
    const instanceId = "metadata-live-client-replacement"
    const { client: oldClient, cleanup } = setup(instanceId)
    const oldGate = deferred<void>()
    const wait = async <T>(value: T) => { await oldGate.promise; return value }
    ;(oldClient as any).project = {
      current: () => wait({ id: "old", directory: "/old", canonical: "/old" }),
      list: () => wait([]),
    }
    ;(oldClient as any).mcp = { list: () => wait({ data: [] }) }
    ;(oldClient as any).plugin = { list: () => wait({ data: [] }) }
    setInstanceMetadata(instanceId, { project: { id: "cached" } as any, mcpStatus: {} as any, plugins: [] })
    const oldRequest = loadInstanceMetadata(instances().get(instanceId)!, { force: true })

    const newClient = {
      session: { active: async () => ({}) },
      project: {
        current: async () => ({ id: "new", directory: "/new", canonical: "/new" }),
        list: async () => [],
      },
      mcp: { list: async () => ({ data: [] }) },
      plugin: { list: async () => ({ data: [] }) },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, newClient)
    updateInstance(instanceId, { client: newClient })

    try {
      await loadInstanceMetadata(instances().get(instanceId)!)
      assert.equal(getInstanceMetadata(instanceId)?.project?.id, "new")
      oldGate.resolve()
      await oldRequest
      assert.equal(getInstanceMetadata(instanceId)?.project?.id, "new")
    } finally {
      oldGate.resolve()
      await oldRequest
      cleanup()
    }
  })

  it("accepts an in-flight catalog when returning to its location", async () => {
    const instanceId = "provider-location-return"
    const { client, cleanup } = setup(instanceId)
    const root = deferred<void>()
    const other = deferred<void>()
    let calls = 0
    const wait = (directory: string) => directory === "/work" ? root.promise : other.promise
    ;(client as any).provider = { list: async ({ location }: any) => { calls += 1; await wait(location.directory); return { data: [{ id: "provider", name: "Provider" }] } } }
    ;(client as any).model = {
      list: async ({ location }: any) => { await wait(location.directory); return { data: [{ id: "model", providerID: "provider", name: "Model", cost: [{}], limit: {}, variants: [] }] } },
      default: async ({ location }: any) => { await wait(location.directory); return { data: { id: "model", providerID: "provider", name: "Model", cost: [{}], limit: {}, variants: [] } } },
    }

    try {
      const firstRoot = fetchProviders(instanceId, { directory: "/work" })
      const otherLocation = fetchProviders(instanceId, { directory: "/other" })
      const returnedRoot = fetchProviders(instanceId, { directory: "/work" })
      assert.equal(calls, 2)
      other.resolve()
      assert.equal(await otherLocation, false)
      root.resolve()
      assert.deepEqual(await Promise.all([firstRoot, returnedRoot]), [true, true])
      assert.equal(providers().get(instanceId)?.[0]?.models[0]?.id, "model")
    } finally {
      cleanup()
    }
  })

  it("loads root, child, and grandchild from a flat project inventory with cursor-only continuations", async () => {
    const instanceId = "project-descendants"
    const { client, cleanup } = setup(instanceId)
    const requests: any[] = []
    const active: Record<string, unknown> = { later: {}, grandchild: {} }
    setInstanceMetadata(instanceId, { project: { id: "project", directory: "/work", canonical: "/work" } as any })
    ;(client.session as any).active = async () => active
    ;(client.session as any).list = async (input: any) => {
      requests.push(input)
      if (input.cursor === "root-page-2") {
        return { data: [apiSession("later")], cursor: {} }
      }
      if (input.cursor === "inventory-page-2") {
        return { data: [apiSession("grandchild", "child")], cursor: {} }
      }
      if (input.parentID === null) return {
        data: [apiSession("root")],
        cursor: { next: "root-page-2" },
      }
      return {
        data: [apiSession("root"), apiSession("child", "root")],
        cursor: { next: "inventory-page-2" },
      }
    }

    try {
      await fetchSessions(instanceId)
      assert.equal(sessions().get(instanceId)?.has("root"), true)
      assert.equal(sessions().get(instanceId)?.has("child"), true)
      assert.equal(sessions().get(instanceId)?.has("grandchild"), true)
      assert.equal(requests[0].project, "project")
      assert.equal("directory" in requests[0], false)
      assert.equal(requests[0].parentID, null)
      assert.equal(requests.some((request) => typeof request.parentID === "string"), false)
      assert.deepEqual(requests[2], { cursor: "inventory-page-2" })

      await loadMoreSessions(instanceId)
      assert.deepEqual(requests[3], { cursor: "root-page-2" })
      assert.equal(requests.filter((request) => request.cursor).every((request) => Object.keys(request).join(",") === "cursor"), true)
      assert.equal(requests.length, 4)
      assert.equal(sessions().get(instanceId)?.get("later")?.status, "working")
      assert.equal(sessions().get(instanceId)?.get("later")?.runtimeStatusKnown, true)
    } finally {
      cleanup()
    }
  })

  it("rejects a repeated incremental session cursor", async () => {
    const instanceId = "repeated-root-cursor"
    const { client, cleanup } = setup(instanceId)
    setInstanceMetadata(instanceId, { project: { id: "project", directory: "/work", canonical: "/work" } as any })
    ;(client.session as any).list = async (input: any) => {
      if (input.cursor === "repeat") return { data: [], cursor: { next: "repeat" } }
      if (input.parentID === null) return { data: [apiSession("root")], cursor: { next: "repeat" } }
      return { data: [apiSession("root")], cursor: {} }
    }

    try {
      await fetchSessions(instanceId)
      await assert.rejects(loadMoreSessions(instanceId), /Repeated session cursor/)
    } finally {
      cleanup()
    }
  })

  it("keeps the global project scoped to the workspace directory", async () => {
    const instanceId = "global-project-directory"
    const { client, cleanup } = setup(instanceId)
    const requests: any[] = []
    setInstanceMetadata(instanceId, { project: { id: "global", directory: "/", canonical: "/" } as any })
    ;(client.session as any).list = async (input: any) => {
      requests.push(input)
      if (input.cursor === "search-next") return { data: [apiSession("search-result")], cursor: {} }
      if (input.cursor) return { data: [], cursor: {} }
      if (input.search) return { data: [], cursor: { next: "search-next" } }
      return { data: [], cursor: { next: input.parentID === null ? "root-next" : "inventory-next" } }
    }

    try {
      await fetchSessions(instanceId)
      await loadMoreSessions(instanceId)
      await searchSessions(instanceId, "needle")

      assert.equal(requests.length, 6)
      assert.deepEqual(requests.at(-1), { cursor: "search-next" })
      assert.equal(requests.filter((request) => !request.cursor).every((request) => request.directory === "/work"), true)
      assert.equal(requests.every((request) => !("project" in request)), true)
      assert.equal(requests.filter((request) => request.cursor)
        .every((request) => Object.keys(request).join(",") === "cursor"), true)
    } finally {
      cleanup()
    }
  })

  it("publishes the root page before the complete project inventory settles", async () => {
    const instanceId = "project-roots-first"
    const { client, cleanup } = setup(instanceId)
    const inventory = deferred<any>()
    const inventoryStarted = deferred<void>()
    setInstanceMetadata(instanceId, { project: { id: "project", directory: "/work", canonical: "/work" } as any })
    ;(client.session as any).list = (input: any) => {
      if (input.parentID === null) return Promise.resolve({ data: [apiSession("new"), apiSession("older")], cursor: {} })
      inventoryStarted.resolve()
      return inventory.promise
    }

    try {
      const request = fetchSessions(instanceId)
      await inventoryStarted.promise
      assert.deepEqual(getSessionListIds(instanceId), ["new", "older"])
      assert.equal(sessions().get(instanceId)?.has("older"), true)
      inventory.resolve({ data: [apiSession("new"), apiSession("older")], cursor: {} })
      await request
    } finally {
      cleanup()
    }
  })

  it("hydrates independent restored session branches in parallel by ancestry level", async () => {
    const instanceId = "parallel-restore"
    const { client, cleanup } = setup(instanceId)
    const children = deferred<void>()
    const started: string[] = []
    ;(client.session as any).get = async ({ sessionID }: { sessionID: string }) => {
      started.push(sessionID)
      if (sessionID !== "parent") await children.promise
      return apiSession(sessionID, sessionID === "parent" ? undefined : "parent")
    }

    try {
      const hydration = hydrateRestoredSessionChain(instanceId, ["first", "second"])
      await Promise.resolve()
      assert.deepEqual(started, ["first", "second"])
      children.resolve()
      await hydration
      assert.deepEqual(started, ["first", "second", "parent"])
    } finally {
      cleanup()
    }
  })

  it("keeps a successful root page when project inventory enrichment fails", async () => {
    const instanceId = "project-inventory-failure"
    const { client, cleanup } = setup(instanceId)
    setInstanceMetadata(instanceId, { project: { id: "project", directory: "/work", canonical: "/work" } as any })
    ;(client.session as any).list = (input: any) => input.parentID === null
      ? Promise.resolve({ data: [apiSession("root")], cursor: {} })
      : Promise.reject(new Error("inventory failed"))

    try {
      await fetchSessions(instanceId)
      assert.deepEqual(getSessionListIds(instanceId), ["root"])
      assert.equal(sessions().get(instanceId)?.has("root"), true)
    } finally {
      cleanup()
    }
  })

  it("rejects an old session continuation after an instance id is reused", async () => {
    const instanceId = "reused-session-page"
    const old = setup(instanceId)
    const oldPage = deferred<any>()
    ;(old.client.session as any).list = (input: any) => input.cursor
      ? oldPage.promise
      : Promise.resolve({ data: [apiSession("old-root")], cursor: { next: "shared-page" } })
    await fetchSessions(instanceId)
    const oldRequest = loadMoreSessions(instanceId)
    old.cleanup()

    const current = setup(instanceId)
    const currentPage = deferred<any>()
    let currentPageCalls = 0
    ;(current.client.session as any).list = (input: any) => {
      if (!input.cursor) return Promise.resolve({ data: [apiSession("current-root")], cursor: { next: "shared-page" } })
      currentPageCalls += 1
      return currentPage.promise
    }

    try {
      await fetchSessions(instanceId)
      const currentRequest = loadMoreSessions(instanceId)
      oldPage.resolve({ data: [apiSession("stale-page")], cursor: {} })
      await oldRequest
      const concurrentRequest = loadMoreSessions(instanceId)
      assert.equal(currentPageCalls, 1)
      assert.equal(sessions().get(instanceId)?.has("stale-page"), false)
      currentPage.resolve({ data: [apiSession("current-page")], cursor: {} })
      await Promise.all([currentRequest, concurrentRequest])
      assert.equal(sessions().get(instanceId)?.has("current-page"), true)
    } finally {
      current.cleanup()
    }
  })

  it("preserves roots added while a complete catalog request is in flight", async () => {
    const instanceId = "session-catalog-concurrent-root"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    ;(client.session as any).list = () => response.promise
    setSessions((previous) => new Map(previous).set(instanceId, new Map([
      ["existing", session(instanceId, "existing")],
      ["missing", session(instanceId, "missing")],
    ])))
    prependSessionListId(instanceId, "missing")
    prependSessionListId(instanceId, "existing")

    try {
      const request = fetchSessions(instanceId)
      setSessions((previous) => {
        const next = new Map(previous)
        const current = new Map(next.get(instanceId))
        current.set("late", session(instanceId, "late"))
        next.set(instanceId, current)
        return next
      })
      prependSessionListId(instanceId, "late")
      response.resolve({ data: [apiSession("existing")], cursor: {} })
      await request
      assert.deepEqual(getSessionListIds(instanceId), ["late", "existing"])
      assert.equal(sessions().get(instanceId)?.has("late"), true)
      assert.equal(sessions().get(instanceId)?.has("missing"), false)
    } finally {
      cleanup()
    }
  })

  it("prunes missing roots without deleting restored child chains", async () => {
    const instanceId = "root-pruning"
    const { client, cleanup } = setup(instanceId)
    setInstanceMetadata(instanceId, { project: { id: "project", directory: "/work", canonical: "/work" } as any })
    ;(client.session as any).list = async () => ({ data: [apiSession("root")], cursor: {} })
    const child = { ...session(instanceId, "child"), parentId: "root" }
    const grandchild = { ...session(instanceId, "grandchild"), parentId: "child" }
    const missingChild = { ...session(instanceId, "missing-child"), parentId: "missing-root" }
    const missingGrandchild = { ...session(instanceId, "missing-grandchild"), parentId: "missing-child" }
    const orphan = { ...session(instanceId, "orphan"), parentId: "disconnected" }
    const orphanGrandchild = { ...session(instanceId, "orphan-grandchild"), parentId: "orphan" }
    setSessions((previous) => new Map(previous).set(instanceId, new Map([
      ["root", session(instanceId, "root")],
      ["missing-root", session(instanceId, "missing-root")],
      ["child", child],
      ["grandchild", grandchild],
      ["missing-child", missingChild],
      ["missing-grandchild", missingGrandchild],
      ["orphan", orphan],
      ["orphan-grandchild", orphanGrandchild],
    ])))

    try {
      await fetchSessions(instanceId)
      assert.equal(sessions().get(instanceId)?.has("missing-root"), false)
      assert.equal(sessions().get(instanceId)?.has("missing-child"), false)
      assert.equal(sessions().get(instanceId)?.has("missing-grandchild"), false)
      assert.equal(sessions().get(instanceId)?.has("orphan"), false)
      assert.equal(sessions().get(instanceId)?.has("orphan-grandchild"), false)
      assert.equal(sessions().get(instanceId)?.has("child"), true)
      assert.equal(sessions().get(instanceId)?.has("grandchild"), true)
    } finally {
      cleanup()
    }
  })
})
