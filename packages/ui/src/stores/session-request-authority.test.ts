import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { createSession, fetchAgents, fetchProviders, fetchSessions, loadMessages, refreshSessionCatalog, removeSessionRuntimeState, searchSessions } from "./session-api.ts"
import { getCommands } from "./commands.ts"
import {
  clearInstanceDeletedSessionAuthority,
  getSessionSearchResultIds,
  getSessionListIds,
  invalidateSessionMessageLoad,
  loading,
  messagesLoaded,
  agents,
  providers,
  sessions,
  setAgents,
  setProviders,
  setActiveSession,
  setSessionPage,
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
      setAgents((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
      setProviders((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
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

  it("lists each logical root and worktree once and reconciles a complete union", async () => {
    const instanceId = "multi-directory-session-list"
    const { client, cleanup } = setup(instanceId)
    await loadTestWorktree(instanceId)
    const root = session(instanceId, "root")
    const worktree = { ...session(instanceId, "worktree"), location: { directory: "/worktree" } }
    const worktreePageTwo = { ...session(instanceId, "worktree-2"), location: { directory: "/worktree" } }
    const deleted = session(instanceId, "deleted")
    setSessions((prev) => new Map(prev).set(instanceId, new Map([
      [root.id, root],
      [worktree.id, worktree],
      [deleted.id, deleted],
    ])))
    const listOptions: any[] = []
    ;(client.session as any).list = async (options: any) => {
      listOptions.push(options)
      if (options.directory !== "/worktree") return { data: [apiSession(root.id)], cursor: {} }
      return options.cursor
        ? { data: [{ ...apiSession(worktreePageTwo.id), location: { directory: "/worktree" } }], cursor: {} }
        : { data: [{ ...apiSession(worktree.id), location: { directory: "/worktree" } }], cursor: { next: "worktree-2" } }
    }
    ;(client.session as any).active = async () => ({})

    try {
      await fetchSessions(instanceId)

      assert.deepEqual(listOptions, [
        { directory: "/work", limit: 10000 },
        { directory: "/worktree", limit: 10000 },
        { directory: "/worktree", cursor: "worktree-2", limit: 10000 },
      ])
      assert.deepEqual(Array.from(sessions().get(instanceId)?.keys() ?? []), [root.id, worktree.id, worktreePageTwo.id])
    } finally {
      cleanup()
    }
  })

  it("keeps missing local sessions when any directory cursor walk is partial", async () => {
    const instanceId = "partial-multi-directory-session-list"
    const { client, cleanup } = setup(instanceId)
    await loadTestWorktree(instanceId)
    const existing = session(instanceId, "existing")
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[existing.id, existing]])))
    setSessionPage(instanceId, [existing.id], false, true)
    ;(client.session as any).list = async (options: any) => {
      if (options.directory === "/work") return { data: [apiSession("root")], cursor: {} }
      if (!options.cursor) return { data: [apiSession("worktree")], cursor: { next: "page-2" } }
      throw new Error("cursor failed")
    }
    ;(client.session as any).active = async () => ({})

    try {
      await fetchSessions(instanceId)
      assert.deepEqual(Array.from(sessions().get(instanceId)?.keys() ?? []), [existing.id, "root", "worktree"])
      assert.deepEqual(getSessionListIds(instanceId), [existing.id])
    } finally {
      cleanup()
    }
  })

  it("loads every ascending message page and hydrates once in page order", async () => {
    const instanceId = "multi-page-messages", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    const options: any[] = []
    ;(client as any).message = { list: async (input: any) => {
      options.push(input)
      return input.cursor
        ? { data: [apiMessage("message-2", sessionId)], cursor: {} }
        : { data: [apiMessage("message-1", sessionId)], cursor: { next: "page-2" } }
    } }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      await loadMessages(instanceId, sessionId)
      assert.deepEqual(options, [
        { sessionID: sessionId, limit: 200, order: "asc" },
        { sessionID: sessionId, limit: 200, cursor: "page-2" },
      ])
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["message-1", "message-2"])
    } finally {
      cleanup()
    }
  })

  it("does not replace messages when a later page fails", async () => {
    const instanceId = "partial-message-pages", sessionId = "session"
    const { client, cleanup } = setup(instanceId)
    let failSecondPage = false
    ;(client as any).message = { list: async (input: any) => {
      if (input.cursor && failSecondPage) throw new Error("cursor failed")
      return input.cursor
        ? { data: [apiMessage("old-2", sessionId)], cursor: {} }
        : { data: [apiMessage("old-1", sessionId)], cursor: { next: "page-2" } }
    } }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      await loadMessages(instanceId, sessionId)
      failSecondPage = true
      await assert.rejects(loadMessages(instanceId, sessionId, { force: true }), /cursor failed/)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["old-1", "old-2"])
    } finally {
      cleanup()
    }
  })

  it("keeps session agent ids independent from catalog labels and defaults new sessions", async () => {
    const instanceId = "cold-agent-list"
    const { client, cleanup } = setup(instanceId)
    const created: any[] = []
    const persisted = { ...session(instanceId, "persisted"), agent: "Build" }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[persisted.id, persisted]])))
    ;(client as any).agent = {
      list: async () => ({ data: [] }),
      get: async ({ agentID }: any) => ({ data: {
        id: agentID,
        name: agentID === "build" ? "Build" : "Plan",
        description: "",
        mode: "primary",
        hidden: false,
      } }),
    }
    ;(client as any).model = { default: async () => ({ data: {
      id: "model", providerID: "opencode",
    } }) }
    ;(client.session as any).create = async (input: any) => {
      created.push(input)
      return apiSession("created")
    }

    try {
      await fetchAgents(instanceId)
      assert.deepEqual(agents().get(instanceId)?.map(({ id, name }) => ({ id, name })), [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ])
      assert.equal(sessions().get(instanceId)?.get("persisted")?.agent, "Build")
      setSessions((prev) => new Map(prev).set(instanceId, new Map()))
      await createSession(instanceId)
      assert.equal(created[0].agent, "build")
      assert.deepEqual(created[0].model, { providerID: "opencode", id: "model" })
      assert.equal(sessions().get(instanceId)?.get("created")?.agent, "build")
    } finally {
      cleanup()
    }
  })

  it("builds a deterministic provider catalog from cold-start model results", async () => {
    const instanceId = "cold-provider-list"
    const { client, cleanup } = setup(instanceId)
    const model = {
      id: "model", modelID: "model", providerID: "opencode", name: "Model",
      variants: [], cost: [{ input: 0, output: 0 }], limit: { context: 100, output: 10 },
    }
    ;(client as any).provider = { list: async () => ({ data: [] }) }
    ;(client as any).model = {
      list: async () => ({ data: [model] }),
      default: async () => ({ data: model }),
    }

    try {
      await fetchProviders(instanceId)
      assert.deepEqual(providers().get(instanceId)?.map((provider) => ({
        id: provider.id,
        name: provider.name,
        defaultModelId: provider.defaultModelId,
        models: provider.models.map((item) => item.id),
      })), [{ id: "opencode", name: "opencode", defaultModelId: "model", models: ["model"] }])
    } finally {
      cleanup()
    }
  })

  it("refreshes agents, providers, models, and commands for the active session location", async () => {
    const instanceId = "active-catalog-location"
    const { client, cleanup } = setup(instanceId)
    const locations: Array<[string, unknown]> = []
    const record = (kind: string, input: any) => locations.push([kind, input?.location])
    ;(client as any).agent = {
      list: async (input: any) => {
        record("agent", input)
        return { data: ["build", "plan"].map((id) => ({ id, name: id, description: "", mode: "primary" })) }
      },
    }
    ;(client as any).provider = { list: async (input: any) => { record("provider", input); return { data: [] } } }
    ;(client as any).model = {
      list: async (input: any) => { record("model", input); return { data: [] } },
      default: async (input: any) => { record("default", input); return { data: null } },
    }
    ;(client as any).command = { list: async (input: any) => { record("command", input); return { data: [] } } }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([
      ["root", session(instanceId, "root")],
      ["worktree", { ...session(instanceId, "worktree"), location: { directory: "/worktree", workspaceID: "workspace-1" } }],
    ])))

    try {
      setActiveSession(instanceId, "root")
      await refreshSessionCatalog(instanceId)
      setActiveSession(instanceId, "worktree")
      await refreshSessionCatalog(instanceId)

      assert.deepEqual(locations, [
        ["agent", { directory: "/work" }], ["provider", { directory: "/work" }], ["model", { directory: "/work" }], ["default", { directory: "/work" }], ["command", { directory: "/work" }],
        ["agent", { directory: "/worktree", workspace: "workspace-1" }], ["provider", { directory: "/worktree", workspace: "workspace-1" }], ["model", { directory: "/worktree", workspace: "workspace-1" }], ["default", { directory: "/worktree", workspace: "workspace-1" }], ["command", { directory: "/worktree", workspace: "workspace-1" }],
      ])
      assert.deepEqual(getCommands(instanceId), [])
    } finally {
      cleanup()
    }
  })

  it("retries a catalog location after a transient request failure", async () => {
    const instanceId = "catalog-refresh-retry"
    const { client, cleanup } = setup(instanceId)
    let agentCalls = 0
    let providerCalls = 0
    let commandCalls = 0
    ;(client as any).agent = {
      list: async () => {
        agentCalls++
        return { data: ["build", "plan"].map((id) => ({ id, name: id, description: "", mode: "primary" })) }
      },
    }
    ;(client as any).provider = { list: async () => { providerCalls++; return { data: [] } } }
    ;(client as any).model = {
      list: async () => ({ data: [] }),
      default: async () => ({ data: null }),
    }
    ;(client as any).command = { list: async () => {
      commandCalls++
      if (commandCalls === 1) throw new Error("temporary")
      return { data: [] }
    } }

    try {
      await refreshSessionCatalog(instanceId)
      await refreshSessionCatalog(instanceId)
      await refreshSessionCatalog(instanceId)

      assert.deepEqual({ agentCalls, providerCalls, commandCalls }, { agentCalls: 2, providerCalls: 2, commandCalls: 2 })
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
