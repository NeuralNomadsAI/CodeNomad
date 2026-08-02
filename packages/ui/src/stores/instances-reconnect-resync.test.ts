import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import {
  addInstance,
  addPermissionToQueue,
  addQuestionToQueue,
  getPermissionQueue,
  getQuestionQueue,
  hasAnsweredQuestion,
  markQuestionAnswered,
  removeInstance,
  updateInstance,
} from "./instances.ts"
import {
  handlePermissionReplied,
  handlePermissionUpdated,
  handleQuestionAnswered,
  handleQuestionAsked,
} from "./session-events.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { getSessionDraftPrompt, sessions, setActiveSession, setMessagesLoaded, setSessionDraftPrompt, setSessions } from "./session-state.ts"
import { reloadOpenCodeWorkspaces } from "./opencode-workspaces.ts"
import { fetchSessions } from "./session-api.ts"
import { setVisibleSessionMemory } from "./session-memory.ts"
import { reloadWorktrees } from "./worktrees.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reconnect resync")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

type PendingResponse = Promise<any> | (() => Promise<any>)
type PendingMessages = (input: any, options?: { signal?: AbortSignal }) => Promise<any>

function resolvePending(pending: PendingResponse | undefined, fallback: any): Promise<any> {
  if (typeof pending === "function") return pending()
  return pending ?? Promise.resolve(fallback)
}

function setup(instanceId: string, pending: {
  sessions?: PendingResponse
  permissions?: PendingResponse
    questions?: PendingResponse
    legacyPermissions?: PendingResponse
    legacyQuestions?: PendingResponse
    messages?: PendingMessages
} = {}) {
  let sessionLists = 0
  let permissionLists = 0
  let questionLists = 0
  let legacyPermissionLists = 0
  let legacyQuestionLists = 0
  let messageLists = 0
  const messageSessionIds: string[] = []
  const permissionLocations: any[] = []
  const questionLocations: any[] = []
  const client = {
    session: {
      list: () => { sessionLists += 1; return resolvePending(pending.sessions, { data: [] }) },
      status: async () => ({ data: {} }),
      messages: async (input: any, options?: { signal?: AbortSignal }) => {
        messageLists += 1
        messageSessionIds.push(input.sessionID)
        return pending.messages?.(input, options) ?? { data: [] }
      },
    },
    permission: { list: () => { legacyPermissionLists += 1; return resolvePending(pending.legacyPermissions, { data: [] }) } },
    question: { list: () => { legacyQuestionLists += 1; return resolvePending(pending.legacyQuestions, { data: [] }) } },
    v2: {
      permission: { request: { list: (input: any) => { permissionLists += 1; permissionLocations.push(input?.location); return resolvePending(pending.permissions, { data: { data: [] } }) } } },
      question: { request: { list: (input: any) => { questionLists += 1; questionLocations.push(input?.location); return resolvePending(pending.questions, { data: { data: [] } }) } } },
    },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 1, proxyPath: "", status: "ready", client })
  return {
    client,
    sessionLists: () => sessionLists,
    permissionLists: () => permissionLists,
    questionLists: () => questionLists,
    legacyPermissionLists: () => legacyPermissionLists,
    legacyQuestionLists: () => legacyQuestionLists,
    messageLists: () => messageLists,
    messageSessionIds,
    permissionLocations,
    questionLocations,
    cleanup() {
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    },
  }
}

describe("reconnect interruption resync", () => {
  it("does not commit a session refresh after its status request is aborted", async () => {
    const instanceId = "reconnect-aborted-status", sessionId = "session"
    const status = deferred<any>()
    const harness = setup(instanceId)
    let statusParameters: unknown
    let statusSignal: AbortSignal | undefined
    harness.client.session.status = (parameters: unknown, options?: { signal?: AbortSignal }) => {
      statusParameters = parameters
      statusSignal = options?.signal
      return status.promise
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, {
      id: sessionId,
      instanceId,
      parentId: null,
      title: "Resident",
      status: "idle",
      model: { providerId: "", modelId: "" },
    } as any]])))
    setSessionDraftPrompt(instanceId, sessionId, "unsent draft")
    const controller = new AbortController()

    try {
      const refresh = fetchSessions(instanceId, { authoritativeDeletes: true, signal: controller.signal })
      await waitFor(() => statusSignal !== undefined)
      assert.equal(statusParameters, undefined)
      assert.equal(statusSignal, controller.signal)
      controller.abort(new Error("refresh timed out"))
      status.resolve({ data: {} })
      await refresh

      assert.equal(sessions().get(instanceId)?.has(sessionId), true)
      assert.equal(getSessionDraftPrompt(instanceId, sessionId), "unsent draft")
    } finally {
      harness.cleanup()
    }
  })

  it("does not commit a session list that settles after abort", async () => {
    const instanceId = "reconnect-aborted-list", sessionId = "session"
    const list = deferred<any>()
    const harness = setup(instanceId)
    let listSignal: AbortSignal | undefined
    harness.client.session.list = (_parameters: unknown, options?: { signal?: AbortSignal }) => {
      listSignal = options?.signal
      return list.promise
    }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, {
      id: sessionId,
      instanceId,
      parentId: null,
      title: "Resident",
      status: "idle",
      model: { providerId: "", modelId: "" },
    } as any]])))
    setSessionDraftPrompt(instanceId, sessionId, "unsent draft")
    const controller = new AbortController()

    try {
      const refresh = fetchSessions(instanceId, { authoritativeDeletes: true, signal: controller.signal })
      await waitFor(() => listSignal !== undefined)
      controller.abort(new Error("refresh timed out"))
      list.resolve({ data: [] })
      await refresh

      assert.equal(sessions().get(instanceId)?.has(sessionId), true)
      assert.equal(getSessionDraftPrompt(instanceId, sessionId), "unsent draft")
    } finally {
      harness.cleanup()
    }
  })

  it("keeps resident state when a reconnect session refresh is empty", async () => {
    const instanceId = "reconnect-merge-only", sessionId = "session"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [
        { slug: "root", directory: "/work", kind: "root" },
        { slug: "feature", directory: "/feature", kind: "worktree" },
      ],
    })
    const harness = setup(instanceId)
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, {
      id: sessionId,
      instanceId,
      parentId: null,
      title: "Resident",
      status: "idle",
      model: { providerId: "", modelId: "" },
    } as any]])))
    setSessionDraftPrompt(instanceId, sessionId, "unsent draft")
    messageStoreBus.getOrCreate(instanceId).upsertMessage({
      id: "message",
      sessionId,
      role: "assistant",
      status: "complete",
      parts: [{ id: "part", type: "text", text: "resident" }] as any,
    })

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.sessionLists() === 1)
      await new Promise((resolve) => setTimeout(resolve, 20))

      assert.equal(sessions().get(instanceId)?.has(sessionId), true)
      assert.equal(getSessionDraftPrompt(instanceId, sessionId), "unsent draft")
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["message"])
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      harness.cleanup()
    }
  })

  it("deletes missing sessions only after complete root topology and project scope", async () => {
    const instanceId = "reconnect-authoritative-sessions", sessionId = "deleted"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [{ slug: "root", directory: "/work", kind: "root" }],
    })
    const harness = setup(instanceId)
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, {
      id: sessionId,
      instanceId,
      parentId: null,
      title: "Deleted",
      status: "idle",
      model: { providerId: "", modelId: "" },
    } as any]])))
    setSessionDraftPrompt(instanceId, sessionId, "discard with deletion")

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.sessionLists() === 1)
      await waitFor(() => !sessions().get(instanceId)?.has(sessionId))
      assert.equal(getSessionDraftPrompt(instanceId, sessionId), "")
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      harness.cleanup()
    }
  })

  it("reloads selected and visible sessions whose previous message loads were empty", async () => {
    const instanceId = "reconnect-selected-empty", sessionId = "selected-empty", visibleSessionId = "visible-empty"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [{ slug: "root", directory: "/work", kind: "root" }],
    })
    const harness = setup(instanceId, {
      sessions: Promise.resolve({ data: [
        { id: sessionId, title: "Selected", directory: "/work", time: { created: 1 } },
        { id: visibleSessionId, title: "Visible", directory: "/work", time: { created: 1 } },
      ] }),
    })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([sessionId, visibleSessionId].map((id) => [id, {
      id,
      instanceId,
      parentId: null,
      title: id,
      status: "idle",
      model: { providerId: "", modelId: "" },
    } as any]))))
    setActiveSession(instanceId, sessionId)
    setVisibleSessionMemory(instanceId, visibleSessionId, true)
    setMessagesLoaded((prev) => new Map(prev).set(instanceId, new Set([sessionId, visibleSessionId])))

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.messageLists() === 2)
      assert.deepEqual(new Set(harness.messageSessionIds), new Set([sessionId, visibleSessionId]))
    } finally {
      setVisibleSessionMemory(instanceId, visibleSessionId, false)
      serverApi.fetchWorktrees = originalFetchWorktrees
      harness.cleanup()
    }
  })

  it("aborts a stalled reconnect message reload", async () => {
    const instanceId = "reconnect-message-timeout", sessionId = "selected"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [{ slug: "root", directory: "/work", kind: "root" }],
    })
    let messageSignal: AbortSignal | undefined
    const harness = setup(instanceId, {
      sessions: Promise.resolve({ data: [{ id: sessionId, title: "Selected", directory: "/work", time: { created: 1 } }] }),
      messages: (_input, options) => {
        messageSignal = options?.signal
        return new Promise((_resolve, reject) => {
          messageSignal?.addEventListener("abort", () => reject(messageSignal?.reason), { once: true })
        })
      },
    })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, {
      id: sessionId,
      instanceId,
      parentId: null,
      title: sessionId,
      status: "idle",
      model: { providerId: "", modelId: "" },
    } as any]])))
    setActiveSession(instanceId, sessionId)

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => Boolean(messageSignal))
      await Promise.race([
        new Promise<void>((resolve) => messageSignal?.addEventListener("abort", () => resolve(), { once: true })),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("reconnect message reload did not abort")), 6_000)),
      ])
      assert.equal(messageSignal?.aborted, true)
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      harness.cleanup()
    }
  })

  it("continues interruption resync when the session refresh fails", async () => {
    const instanceId = "reconnect-session-list-failure"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    const harness = setup(instanceId, {
      sessions: Promise.reject(new Error("session list unavailable")),
      permissions: Promise.resolve({ data: { data: [permission] } }),
    })

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => getPermissionQueue(instanceId).length === 1)
      assert.equal(getPermissionQueue(instanceId)[0]?.id, permission.id)
    } finally {
      harness.cleanup()
    }
  })

  it("reconciles missed permissions and questions through their authoritative lists", async () => {
    const instanceId = "reconnect-interruptions"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    const question = { id: "question", sessionID: "session", questions: [] } as any
    const harness = setup(instanceId, {
      permissions: Promise.resolve({ data: { data: [permission] } }),
      questions: Promise.resolve({ data: { data: [question] } }),
    })

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => getPermissionQueue(instanceId).length === 1 && getQuestionQueue(instanceId).length === 1)
      assert.equal(getPermissionQueue(instanceId)[0]?.id, permission.id)
      assert.equal(getQuestionQueue(instanceId)[0]?.id, question.id)
    } finally {
      harness.cleanup()
    }
  })

  it("rejects stale list results after newer accepted replies", async () => {
    const instanceId = "reconnect-interruption-fences"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    const question = { id: "question", sessionID: "session", questions: [] } as any
    const permissions = deferred<any>()
    const questions = deferred<any>()
    const harness = setup(instanceId, { permissions: permissions.promise, questions: questions.promise })

    try {
      addPermissionToQueue(instanceId, permission, "v2")
      addQuestionToQueue(instanceId, question, "v2")
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.permissionLists() === 1 && harness.questionLists() === 1)

      handlePermissionReplied(instanceId, { type: "permission.replied", properties: { requestID: permission.id } } as any)
      handleQuestionAnswered(instanceId, { type: "question.replied", properties: { requestID: question.id } } as any)
      permissions.resolve({ data: { data: [permission] } })
      questions.resolve({ data: { data: [question] } })
      await new Promise((resolve) => setTimeout(resolve, 20))

      assert.deepEqual(getPermissionQueue(instanceId), [])
      assert.deepEqual(getQuestionQueue(instanceId), [])
    } finally {
      harness.cleanup()
    }
  })

  it("does not delete asked events that arrive while reconnect lists are in flight", async () => {
    const instanceId = "reconnect-newer-asked-events"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    const question = { id: "question", sessionID: "session", questions: [] } as any
    const permissions = deferred<any>()
    const questions = deferred<any>()
    const harness = setup(instanceId, { permissions: permissions.promise, questions: questions.promise })

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.permissionLists() === 1 && harness.questionLists() === 1)
      handlePermissionUpdated(instanceId, { type: "permission.v2.asked", properties: permission } as any)
      handleQuestionAsked(instanceId, { type: "question.v2.asked", properties: question } as any)
      permissions.resolve({ data: { data: [] } })
      questions.resolve({ data: { data: [] } })
      await new Promise((resolve) => setTimeout(resolve, 20))

      assert.equal(getPermissionQueue(instanceId)[0]?.id, permission.id)
      assert.equal(getQuestionQueue(instanceId)[0]?.id, question.id)
    } finally {
      harness.cleanup()
    }
  })

  it("keeps local queues and accepts V2 additions when legacy snapshots fail", async () => {
    const instanceId = "reconnect-incomplete-legacy"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    const question = { id: "question", sessionID: "session", questions: [] } as any
    const v2Permission = { id: "v2-permission", sessionID: "session", permission: "write", patterns: [] } as any
    const v2Question = { id: "v2-question", sessionID: "session", questions: [] } as any
    const harness = setup(instanceId, {
      legacyPermissions: () => Promise.reject(new Error("permission list unavailable")),
      legacyQuestions: () => Promise.reject(new Error("question list unavailable")),
      permissions: Promise.resolve({ data: { data: [v2Permission] } }),
      questions: Promise.resolve({ data: { data: [v2Question] } }),
    })

    try {
      addPermissionToQueue(instanceId, permission, "legacy")
      addQuestionToQueue(instanceId, question, "legacy")
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.legacyPermissionLists() === 3 && harness.legacyQuestionLists() === 3)

      assert.deepEqual(getPermissionQueue(instanceId).map((entry) => entry.id), [permission.id, v2Permission.id])
      assert.deepEqual(getQuestionQueue(instanceId).map((entry) => entry.id), [question.id, v2Question.id])
      assert.equal(harness.permissionLists(), 3)
      assert.equal(harness.questionLists(), 3)
    } finally {
      harness.cleanup()
    }
  })

  it("retries a transient V2 snapshot and restores the missed request", async () => {
    const instanceId = "reconnect-v2-retry"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    let attempts = 0
    const harness = setup(instanceId, {
      permissions: () => {
        attempts += 1
        if (attempts === 1) return Promise.reject(new Error("temporary V2 failure"))
        return Promise.resolve({ data: { data: [permission] } })
      },
    })

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => getPermissionQueue(instanceId).length === 1)
      assert.equal(harness.permissionLists(), 2)
    } finally {
      harness.cleanup()
    }
  })

  it("ignores permission and question snapshots that settle after their retry timeout", async () => {
    const instanceId = "reconnect-late-timeout"
    const permission = { id: "stale-permission", sessionID: "session", permission: "read", patterns: [] } as any
    const question = { id: "stale-question", sessionID: "session", questions: [] } as any
    const firstPermissions = deferred<any>()
    const firstQuestions = deferred<any>()
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [{ slug: "root", directory: "/work", kind: "root" }],
    })
    const harness = setup(instanceId)
    let permissionCalls = 0
    let questionCalls = 0
    let firstPermissionParameters: unknown
    let firstQuestionParameters: unknown
    let firstPermissionSignal: AbortSignal | undefined
    let firstQuestionSignal: AbortSignal | undefined
    harness.client.permission.list = (parameters: unknown, options?: { signal?: AbortSignal }) => {
      permissionCalls += 1
      if (permissionCalls === 1) {
        firstPermissionParameters = parameters
        firstPermissionSignal = options?.signal
      }
      return permissionCalls === 1 ? firstPermissions.promise : Promise.resolve({ data: [] })
    }
    harness.client.question.list = (parameters: unknown, options?: { signal?: AbortSignal }) => {
      questionCalls += 1
      if (questionCalls === 1) {
        firstQuestionParameters = parameters
        firstQuestionSignal = options?.signal
      }
      return questionCalls === 1 ? firstQuestions.promise : Promise.resolve({ data: [] })
    }

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => permissionCalls === 2 && questionCalls === 2, 7_000)
      assert.equal(firstPermissionParameters, undefined)
      assert.equal(firstQuestionParameters, undefined)
      assert.equal(firstPermissionSignal?.aborted, true)
      assert.equal(firstQuestionSignal?.aborted, true)
      firstPermissions.resolve({ data: [permission] })
      firstQuestions.resolve({ data: [question] })
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.deepEqual(getPermissionQueue(instanceId), [])
      assert.deepEqual(getQuestionQueue(instanceId), [])
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      harness.cleanup()
    }
  })

  it("keeps local queues when V2 snapshots exhaust their retries", async () => {
    const instanceId = "reconnect-incomplete-v2"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    const question = { id: "question", sessionID: "session", questions: [] } as any
    const legacyPermission = { id: "legacy-permission", sessionID: "session", permission: "write", patterns: [] } as any
    const legacyQuestion = { id: "legacy-question", sessionID: "session", questions: [] } as any
    const harness = setup(instanceId, {
      legacyPermissions: Promise.resolve({ data: [legacyPermission] }),
      legacyQuestions: Promise.resolve({ data: [legacyQuestion] }),
      permissions: () => Promise.reject(new Error("permission V2 unavailable")),
      questions: () => Promise.reject(new Error("question V2 unavailable")),
    })

    try {
      addPermissionToQueue(instanceId, permission, "v2")
      addQuestionToQueue(instanceId, question, "v2")
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.permissionLists() === 3 && harness.questionLists() === 3)

      assert.deepEqual(getPermissionQueue(instanceId).map((entry) => entry.id), [permission.id, legacyPermission.id])
      assert.deepEqual(getQuestionQueue(instanceId).map((entry) => entry.id), [question.id, legacyQuestion.id])
    } finally {
      harness.cleanup()
    }
  })

  it("retains reply tombstones through an empty reconnect snapshot", async () => {
    const instanceId = "reconnect-delayed-stale-events"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    const question = { id: "question", sessionID: "session", questions: [] } as any
    const harness = setup(instanceId)

    try {
      addPermissionToQueue(instanceId, permission, "v2")
      addQuestionToQueue(instanceId, question, "v2")
      handlePermissionReplied(instanceId, { type: "permission.replied", properties: { requestID: permission.id } } as any)
      handleQuestionAnswered(instanceId, { type: "question.replied", properties: { requestID: question.id } } as any)
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.permissionLists() === 1 && harness.questionLists() === 1)
      await new Promise((resolve) => setTimeout(resolve, 20))

      handlePermissionUpdated(instanceId, { type: "permission.v2.asked", properties: permission } as any)
      handleQuestionAsked(instanceId, { type: "question.v2.asked", properties: question } as any)
      assert.deepEqual(getPermissionQueue(instanceId), [])
      assert.deepEqual(getQuestionQueue(instanceId), [])
    } finally {
      harness.cleanup()
    }
  })

  it("tombstones authoritative absence before delayed ask events", async () => {
    const instanceId = "reconnect-authoritative-absence"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    const question = { id: "question", sessionID: "session", questions: [] } as any
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [{ slug: "root", directory: "/work", kind: "root" }],
    })
    const harness = setup(instanceId)

    try {
      addPermissionToQueue(instanceId, permission, "v2")
      addQuestionToQueue(instanceId, question, "v2")
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.permissionLists() === 1 && harness.questionLists() === 1)
      await waitFor(() => getPermissionQueue(instanceId).length === 0 && getQuestionQueue(instanceId).length === 0)

      handlePermissionUpdated(instanceId, { type: "permission.v2.asked", properties: permission } as any)
      handleQuestionAsked(instanceId, { type: "question.v2.asked", properties: question } as any)
      assert.deepEqual(getPermissionQueue(instanceId), [])
      assert.deepEqual(getQuestionQueue(instanceId), [])
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      harness.cleanup()
    }
  })

  it("refreshes worktree topology before reconnect interruption lists", async () => {
    const instanceId = "reconnect-worktree-refresh"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    let worktreeLists = 0
    serverApi.fetchWorktrees = async () => {
      worktreeLists += 1
      return { isGitRepo: true, worktrees: [{ slug: "root", directory: "/work", kind: "root" }] }
    }
    const harness = setup(instanceId)

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => worktreeLists === 1 && harness.permissionLists() === 1)
      assert.equal(worktreeLists, 1)
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      harness.cleanup()
    }
  })

  it("keeps interruption queues when reconnect worktree freshness fails", async () => {
    const instanceId = "reconnect-stale-worktrees"
    const permission = { id: "permission", sessionID: "session", permission: "read", patterns: [] } as any
    const question = { id: "question", sessionID: "session", questions: [] } as any
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [{ slug: "root", directory: "/work", kind: "root" }],
    })
    const harness = setup(instanceId)

    try {
      assert.equal(await reloadWorktrees(instanceId), true)
      addPermissionToQueue(instanceId, permission, "v2")
      addQuestionToQueue(instanceId, question, "v2")
      serverApi.fetchWorktrees = async () => { throw new Error("worktree list unavailable") }

      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.permissionLists() === 1 && harness.questionLists() === 1)
      assert.deepEqual(getPermissionQueue(instanceId).map(({ id }) => id), [permission.id])
      assert.deepEqual(getQuestionQueue(instanceId).map(({ id }) => id), [question.id])
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      harness.cleanup()
    }
  })

  it("force-refreshes OpenCode workspace ids before reconnect lists", async () => {
    const instanceId = "reconnect-workspace-id-refresh"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    let workspaceId = "workspace-old"
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [
        { slug: "root", directory: "/work", kind: "root" },
        { slug: "feature", directory: "/feature", kind: "worktree" },
      ],
    })
    const harness = setup(instanceId)
    harness.client.experimental = {
      workspace: {
        syncList: async () => ({ data: [] }),
        list: async () => ({ data: [{ id: workspaceId, directory: "/feature" }] }),
      },
    }

    try {
      await reloadWorktrees(instanceId)
      await reloadOpenCodeWorkspaces(instanceId)
      workspaceId = "workspace-new"

      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.permissionLocations.some((location) => location?.workspace === workspaceId))
      assert.equal(harness.permissionLocations.some((location) => location?.workspace === "workspace-old"), false)
      assert.equal(harness.questionLocations.some((location) => location?.workspace === workspaceId), true)
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      harness.cleanup()
    }
  })

  it("bounds answered-question tombstones while retaining ordinary delayed-event fences", () => {
    const instanceId = "bounded-question-tombstones"
    try {
      markQuestionAnswered(instanceId, "recent", 1_000)
      assert.equal(hasAnsweredQuestion(instanceId, "recent", 2_000), true)
      assert.equal(hasAnsweredQuestion(instanceId, "recent", Number.MAX_SAFE_INTEGER), false)

      for (let index = 0; index <= 4_096; index += 1) {
        markQuestionAnswered(instanceId, `question-${index}`, 10_000 + index)
      }
      assert.equal(hasAnsweredQuestion(instanceId, "question-0", 20_000), false)
      assert.equal(hasAnsweredQuestion(instanceId, "question-4096", 20_000), true)
    } finally {
      removeInstance(instanceId, { authoritative: false })
    }
  })

  it("does not carry a reconnect pass into a replacement runtime", async () => {
    const instanceId = "reconnect-runtime-fence"
    const sessions = deferred<any>()
    const harness = setup(instanceId, { sessions: sessions.promise })

    try {
      sseManager.onConnectionRestored?.(instanceId)
      await waitFor(() => harness.sessionLists() === 1)
      updateInstance(instanceId, { client: { session: {} } as any })
      sessions.resolve({ data: [] })
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(harness.permissionLists(), 0)
      assert.equal(harness.questionLists(), 0)
    } finally {
      harness.cleanup()
    }
  })
})
