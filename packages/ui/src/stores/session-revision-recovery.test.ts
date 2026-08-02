import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { enqueueDelta, requestDeltaRecovery } from "./delta-buffer.ts"
import { addInstance, removeInstance, updateInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { loadMessages } from "./session-api.ts"
import { handleMessageUpdate, handleSessionDeleted, handleSessionIdle } from "./session-events.ts"
import { clearInstanceDeletedSessionAuthority, messagesLoaded, sessions, setActiveSession, setMessagesLoaded, setSessions } from "./session-state.ts"

function session(instanceId: string, id: string, status: Session["status"] = "idle"): Session {
  return {
    id, instanceId, parentId: null, title: id, agent: "build",
    model: { providerId: "provider", modelId: "model" }, status, retry: null,
    idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    version: "1", time: { created: 1, updated: 1 },
  }
}

function apiMessage(id: string, sessionId: string, modelId = "model", text?: string) {
  return {
    info: {
      id, sessionID: sessionId, role: "assistant", agent: "build",
      providerID: "provider", modelID: modelId, time: { created: 1, completed: 2 },
    },
    parts: text === undefined ? [] : [{ id: `${id}-part`, type: "text", text }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_500
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for revision recovery")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function setup(instanceId: string, sessionId: string, status: Session["status"] = "idle") {
  const client = { session: {} } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 1, proxyPath: "", status: "ready", client })
  setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId, status)]])))
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

describe("revision conflict recovery", () => {
  it("bounds sustained full-history conflicts with backoff", async () => {
    const instanceId = "bounded-revision-recovery", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    let calls = 0
    ;(client.session as any).messages = async () => {
      calls += 1
      messageStoreBus.getOrCreate(instanceId).upsertMessage({
        id: `conflict-${calls}`, sessionId, role: "assistant", status: "streaming",
        createdAt: calls, updatedAt: calls,
      })
      return { data: [apiMessage("authoritative", sessionId, "stale-model")] }
    }

    try {
      setActiveSession(instanceId, sessionId)
      await loadMessages(instanceId, sessionId)
      await waitFor(() => calls === 4)
      await new Promise((resolve) => setTimeout(resolve, 350))
      assert.equal(calls, 4, "one initial load plus three bounded recovery attempts")
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.model.modelId, "model")
    } finally {
      cleanup()
    }
  })

  it("defers recovery while streaming and resumes from the idle event", async () => {
    const instanceId = "streaming-revision-recovery", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId, "working")
    let calls = 0
    ;(client.session as any).messages = async () => {
      calls += 1
      return { data: [apiMessage("authoritative", sessionId)] }
    }

    try {
      requestDeltaRecovery({ instanceId, sessionId, messageId: "message", partId: "part", field: "text" })
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(calls, 0)
      handleSessionIdle(instanceId, { type: "session.idle", properties: { sessionID: sessionId } } as any)
      await waitFor(() => calls === 2)
    } finally {
      cleanup()
    }
  })

  it("invalidates hidden recovery so reactivation reloads", async () => {
    const instanceId = "hidden-revision-recovery", sessionId = "session", nextSessionId = "next"
    const { client, cleanup } = setup(instanceId, sessionId)
    setSessions((prev) => {
      const next = new Map(prev)
      next.get(instanceId)?.set(nextSessionId, session(instanceId, nextSessionId))
      return next
    })
    let calls = 0
    let signal: AbortSignal | undefined
    ;(client.session as any).messages = (_input: unknown, options?: { signal?: AbortSignal }) => {
      calls += 1
      if (calls > 1) return Promise.resolve({ data: [apiMessage("reloaded", sessionId, "model", "complete")] })
      signal = options?.signal
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }))
    }

    try {
      setActiveSession(instanceId, sessionId)
      setMessagesLoaded((prev) => new Map(prev).set(instanceId, new Set([sessionId])))
      requestDeltaRecovery({ instanceId, sessionId, messageId: "message", partId: "part", field: "text" })
      await waitFor(() => calls === 1 && Boolean(signal))
      handleSessionIdle(instanceId, { type: "session.idle", properties: { sessionID: sessionId } } as any)
      requestDeltaRecovery({ instanceId, sessionId, messageId: "new-delta", partId: "part", field: "text" })
      setActiveSession(instanceId, nextSessionId)
      await waitFor(() => signal?.aborted === true)
      await new Promise((resolve) => setTimeout(resolve, 350))
      assert.equal(calls, 1)
      assert.equal(messagesLoaded().get(instanceId)?.has(sessionId), false)

      setActiveSession(instanceId, sessionId)
      await loadMessages(instanceId, sessionId)
      assert.equal(calls, 2)
    } finally {
      cleanup()
    }
  })

  it("clears a deferred working recovery when the session is deleted", async () => {
    const instanceId = "deleted-deferred-recovery", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId, "working")
    let calls = 0
    ;(client.session as any).messages = async () => {
      calls += 1
      return { data: [apiMessage("authoritative", sessionId)] }
    }

    try {
      setActiveSession(instanceId, sessionId)
      requestDeltaRecovery({ instanceId, sessionId, messageId: "old", partId: "part", field: "text" })
      handleSessionDeleted(instanceId, { type: "session.deleted", properties: { info: { id: sessionId } } } as any)
      setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))
      requestDeltaRecovery({ instanceId, sessionId, messageId: "new", partId: "part", field: "text" })
      await waitFor(() => calls === 1)
    } finally {
      cleanup()
    }
  })

  it("replaces a sleeping recovery when the runtime changes", async () => {
    const instanceId = "replacement-runtime-recovery", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    let oldCalls = 0
    let replacementCalls = 0
    ;(client.session as any).messages = async () => { oldCalls += 1; return { data: [] } }
    const replacementClient = {
      session: { messages: async () => { replacementCalls += 1; return { data: [] } }, status: async () => ({ data: {} }) },
    } as any

    try {
      requestDeltaRecovery({ instanceId, sessionId, messageId: "message", partId: "part", field: "text" })
      updateInstance(instanceId, { client: replacementClient })
      ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, replacementClient)
      requestDeltaRecovery({ instanceId, sessionId, messageId: "replacement-message", partId: "part", field: "text" })
      await waitFor(() => replacementCalls === 1)
      assert.equal(oldCalls, 0)
    } finally {
      cleanup()
    }
  })

  it("does not carry an idle fallback into a replacement runtime", async () => {
    const instanceId = "idle-fallback-runtime-fence", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    const started = deferred<void>()
    const release = deferred<void>()
    let replacementCalls = 0
    ;(client.session as any).messages = async () => {
      started.resolve()
      await release.promise
      return { data: [apiMessage("old-runtime", sessionId)] }
    }
    const replacementClient = {
      session: { messages: async () => { replacementCalls += 1; return { data: [] } }, status: async () => ({ data: {} }) },
    } as any

    try {
      requestDeltaRecovery({ instanceId, sessionId, messageId: "message", partId: "part", field: "text" })
      await started.promise
      handleSessionIdle(instanceId, { type: "session.idle", properties: { sessionID: sessionId } } as any)
      requestDeltaRecovery({ instanceId, sessionId, messageId: "new-delta", partId: "part", field: "text" })
      updateInstance(instanceId, { client: replacementClient })
      ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, replacementClient)
      release.resolve()
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(replacementCalls, 0)
    } finally {
      cleanup()
    }
  })

  it("aborts a message load at its requested timeout", async () => {
    const instanceId = "revision-recovery-timeout", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    let signal: AbortSignal | undefined
    ;(client.session as any).messages = (_input: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }))
    }

    try {
      await assert.rejects(loadMessages(instanceId, sessionId, { force: true, timeoutMs: 10 }), /timed out/)
      assert.equal(signal?.aborted, true)
    } finally {
      cleanup()
    }
  })

  it("falls through to idle reconciliation after recovery attempts are exhausted", async () => {
    const instanceId = "exhausted-idle-recovery", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    const thirdAttempt = deferred<void>()
    let calls = 0
    ;(client.session as any).messages = async () => {
      calls += 1
      if (calls <= 3) {
        messageStoreBus.getOrCreate(instanceId).upsertMessage({
          id: `conflict-${calls}`, sessionId, role: "assistant", status: "streaming",
          createdAt: calls, updatedAt: calls,
        })
      }
      if (calls === 3) {
        setSessions((prev) => {
          const next = new Map(prev)
          const current = next.get(instanceId)?.get(sessionId)
          if (current) next.get(instanceId)?.set(sessionId, { ...current, status: "working" })
          return next
        })
        await thirdAttempt.promise
      }
      return { data: [apiMessage("authoritative", sessionId)] }
    }

    try {
      requestDeltaRecovery({ instanceId, sessionId, messageId: "message", partId: "part", field: "text" })
      await waitFor(() => calls === 3)
      const store = messageStoreBus.getOrCreate(instanceId)
      for (let attempt = 1; attempt <= 3; attempt += 1) store.removeMessage(`conflict-${attempt}`)
      assert.equal(store.hasSessionActiveWork(sessionId), false)
      handleSessionIdle(instanceId, { type: "session.idle", properties: { sessionID: sessionId } } as any)
      thirdAttempt.resolve()
      await waitFor(() => calls === 4)
    } finally {
      cleanup()
    }
  })

  it("runs one post-recovery reconciliation when idle arrives during a successful recovery", async () => {
    const instanceId = "idle-during-recovery", sessionId = "session", messageId = "message"
    const { client, cleanup } = setup(instanceId, sessionId)
    const first = deferred<void>()
    let calls = 0
    ;(client.session as any).messages = async () => {
      calls += 1
      if (calls === 1) {
        await first.promise
        return { data: [apiMessage(messageId, sessionId, "model", "pre-idle")] }
      }
      return { data: [apiMessage(messageId, sessionId, "model", "post-idle")] }
    }
    messageStoreBus.getOrCreate(instanceId).upsertMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      status: "streaming",
      parts: [{ id: `${messageId}-part`, type: "text", text: "old" }] as any,
    })

    try {
      setActiveSession(instanceId, sessionId)
      requestDeltaRecovery({ instanceId, sessionId, messageId: "missing", partId: "part", field: "text" })
      await waitFor(() => calls === 1)
      handleSessionIdle(instanceId, { type: "session.idle", properties: { sessionID: sessionId } } as any)
      first.resolve()
      await waitFor(() => calls === 2)
      await new Promise((resolve) => setTimeout(resolve, 200))

      const part = messageStoreBus.getOrCreate(instanceId).getMessage(messageId)?.parts[`${messageId}-part`]?.data as any
      assert.equal(part?.text, "post-idle")
      assert.equal(calls, 2)
    } finally {
      cleanup()
    }
  })

  it("waits for buffered deltas before accepting a history snapshot", async () => {
    const instanceId = "buffered-delta-recovery", sessionId = "session", messageId = "message"
    const { client, cleanup } = setup(instanceId, sessionId)
    const first = deferred<any>()
    let calls = 0
    ;(client.session as any).messages = async () => {
      calls += 1
      if (calls === 1) return first.promise
      return { data: [apiMessage(messageId, sessionId, "model", "base tail")] }
    }
    messageStoreBus.getOrCreate(instanceId).upsertMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      status: "streaming",
      parts: [{ id: `${messageId}-part`, type: "text", text: "base" }] as any,
    })

    try {
      const load = loadMessages(instanceId, sessionId)
      await waitFor(() => calls === 1)
      enqueueDelta(instanceId, messageId, `${messageId}-part`, "text", " tail", sessionId)
      first.resolve({ data: [apiMessage(messageId, sessionId, "model", "base")] })
      await load
      await waitFor(() => calls === 2)
      const part = messageStoreBus.getOrCreate(instanceId).getMessage(messageId)?.parts[`${messageId}-part`]?.data as any
      assert.equal(part?.text, "base tail")
    } finally {
      cleanup()
    }
  })

  it("accepts a newer history snapshot that supersedes a buffered append", async () => {
    const instanceId = "buffered-delta-newer-snapshot", sessionId = "session", messageId = "message"
    const { client, cleanup } = setup(instanceId, sessionId)
    const first = deferred<any>()
    let calls = 0
    ;(client.session as any).messages = async () => {
      calls += 1
      if (calls === 1) return first.promise
      return { data: [apiMessage(messageId, sessionId, "model", "base tail plus")] }
    }
    const store = messageStoreBus.getOrCreate(instanceId)
    store.upsertMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      status: "streaming",
      parts: [{ id: `${messageId}-part`, type: "text", text: "base" }] as any,
    })

    try {
      const load = loadMessages(instanceId, sessionId)
      await waitFor(() => calls === 1)
      enqueueDelta(instanceId, messageId, `${messageId}-part`, "text", " tail", sessionId)
      first.resolve({ data: [apiMessage(messageId, sessionId, "model", "base")] })
      await load
      await waitFor(() => calls === 2)
      await new Promise((resolve) => setTimeout(resolve, 200))

      const part = store.getMessage(messageId)?.parts[`${messageId}-part`]?.data as any
      assert.equal(part?.text, "base tail plus")
      assert.equal(calls, 2)
    } finally {
      cleanup()
    }
  })

  it("accepts an authoritative part replacement after fencing a buffered append", async () => {
    const instanceId = "buffered-delta-part-replacement", sessionId = "session", messageId = "message"
    const { client, cleanup } = setup(instanceId, sessionId)
    const first = deferred<any>()
    let calls = 0
    ;(client.session as any).messages = async () => {
      calls += 1
      if (calls === 1) return first.promise
      return { data: [apiMessage(messageId, sessionId, "model", "replacement")] }
    }
    const store = messageStoreBus.getOrCreate(instanceId)
    store.upsertMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      status: "streaming",
      parts: [{ id: `${messageId}-part`, type: "text", text: "base" }] as any,
    })

    try {
      const load = loadMessages(instanceId, sessionId)
      await waitFor(() => calls === 1)
      enqueueDelta(instanceId, messageId, `${messageId}-part`, "text", " tail", sessionId)
      first.resolve({ data: [apiMessage(messageId, sessionId, "model", "base")] })
      await load
      handleMessageUpdate(instanceId, {
        type: "message.part.updated",
        properties: {
          part: { id: `${messageId}-part`, sessionID: sessionId, messageID: messageId, type: "text", text: "replacement" },
        },
      } as any)
      await waitFor(() => calls === 2)
      await new Promise((resolve) => setTimeout(resolve, 200))

      const part = store.getMessage(messageId)?.parts[`${messageId}-part`]?.data as any
      assert.equal(part?.text, "replacement")
      assert.equal(calls, 2)
    } finally {
      cleanup()
    }
  })

  it("preserves a resident message and buffered delta across omitted recovery snapshots", async () => {
    const instanceId = "buffered-delta-empty-recovery", sessionId = "session", messageId = "message"
    const { client, cleanup } = setup(instanceId, sessionId)
    const first = deferred<any>()
    let calls = 0
    ;(client.session as any).messages = async () => {
      calls += 1
      if (calls === 1) return first.promise
      if (calls === 2) return { data: [apiMessage(messageId, sessionId, "model", "base")] }
      return { data: [] }
    }
    const store = messageStoreBus.getOrCreate(instanceId)
    store.upsertMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      status: "streaming",
      parts: [{ id: `${messageId}-part`, type: "text", text: "base" }] as any,
    })

    try {
      const load = loadMessages(instanceId, sessionId)
      await waitFor(() => calls === 1)
      enqueueDelta(instanceId, messageId, `${messageId}-part`, "text", " tail", sessionId)
      first.resolve({ data: [] })
      await load
      assert.deepEqual(store.getSessionMessageIds(sessionId), [messageId])
      await waitFor(() => calls === 4)
      const part = store.getMessage(messageId)?.parts[`${messageId}-part`]?.data as any
      assert.equal(part?.text, "base tail")
      assert.deepEqual(store.getSessionMessageIds(sessionId), [messageId])
    } finally {
      cleanup()
    }
  })
})
