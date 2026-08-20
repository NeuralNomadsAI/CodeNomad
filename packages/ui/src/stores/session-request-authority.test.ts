import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { fetchProviders, fetchSessions, hasMoreMessages, loadMessages, loadMoreMessages, loadMoreSessions, removeSessionRuntimeState, searchSessions } from "./session-api.ts"
import { setInstanceMetadata } from "./instance-metadata.ts"
import {
  clearInstanceDeletedSessionAuthority,
  getSessionSearchResultIds,
  getThreadTotals,
  loading,
  messagesLoaded,
  providers,
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
      list: async () => { calls.model += 1; await response.promise; return { data: [{ id: "model", providerID: "provider", name: "Model", cost: [{}], limit: {}, variants: [] }] } },
      default: async () => { calls.default += 1; await response.promise; return { data: { id: "model", providerID: "provider", name: "Model", cost: [{}], limit: {}, variants: [] } } },
    }

    try {
      const first = fetchProviders(instanceId)
      const second = fetchProviders(instanceId)
      assert.deepEqual(calls, { provider: 1, model: 1, default: 1 })
      response.resolve()
      assert.deepEqual(await Promise.all([first, second]), [true, true])
      assert.equal(providers().get(instanceId)?.[0]?.models[0]?.id, "model")
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
        data: [apiSession("root"), {
          ...apiSession("child", "root"),
          cost: 0.2,
          tokens: { input: 300, output: 100, reasoning: 50, cache: { read: 0, write: 0 } },
          subpath: "other-worktree",
        }],
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
      assert.deepEqual(getThreadTotals(instanceId, "root"), {
        cost: 0.2, inputTokens: 300, outputTokens: 100, reasoningTokens: 50,
      })

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
