import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import { getOpenCodeWorkspaceIdForSession } from "./opencode-workspaces.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
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
import { setAuthoritativeSessionLocation } from "./session-location-authority.ts"

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

  it("does not let a search response restore a pre-move session location", async () => {
    const instanceId = "late-search-location", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const response = deferred<any>()
    ;(client.session as any).list = () => response.promise
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[
      sessionId,
      { ...session(instanceId, sessionId), directory: "/repo", workspaceId: undefined },
    ]])))

    try {
      const request = searchSessions(instanceId, "session")
      setAuthoritativeSessionLocation(instanceId, sessionId, {
        directory: "/repo-feature",
        workspaceId: "workspace-feature",
      })
      setSessions((prev) => {
        const next = new Map(prev)
        const instanceSessions = new Map(next.get(instanceId))
        instanceSessions.set(sessionId, {
          ...instanceSessions.get(sessionId)!,
          directory: "/repo-feature",
          workspaceId: "workspace-feature",
        })
        next.set(instanceId, instanceSessions)
        return next
      })
      response.resolve({ data: [{ ...apiSession(sessionId), directory: "/repo" }] })
      await request

      assert.equal(sessions().get(instanceId)?.get(sessionId)?.directory, "/repo-feature")
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.workspaceId, "workspace-feature")
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
