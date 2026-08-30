import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { handleNativeSessionEvent, handleSessionStatus } from "./session-events.ts"
import { clearInstanceDeletedSessionAuthority, messagesLoaded, sessions, setActiveSession, setMessagesLoaded, setSessions } from "./session-state.ts"

const delay = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration))

describe("native session event reducer", () => {
  it("applies the complete moved location before reconciliation", () => {
    const instanceId = "native-session-moved"
    const sessionId = "session"
    const client = { session: { list: async () => ({ data: [], cursor: {} }), active: async () => ({}) } } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/worktree", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, {
      id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
      idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      projectID: "old-project", subpath: "old", location: { directory: "/old" }, time: { created: 1, updated: 1 },
    } as any]])))

    try {
      handleNativeSessionEvent(instanceId, {
        id: "moved", created: 2, type: "session.moved",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: {
          sessionID: sessionId,
          projectID: "new-project",
          subpath: "apps/web",
          location: { directory: "/worktree", workspaceID: "workspace-2" },
        },
      })

      const moved = sessions().get(instanceId)?.get(sessionId)
      assert.deepEqual(moved?.location, { directory: "/worktree", workspaceID: "workspace-2" })
      assert.equal(moved?.projectID, "new-project")
      assert.equal(moved?.subpath, "apps/web")
    } finally {
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("does not infer a cross-instance owner from a shared directory", async () => {
    const sourceId = "native-session-source"
    const duplicateId = "native-session-duplicate"
    const sessionId = "session"
    const client = { session: { list: async () => ({ data: [], cursor: {} }), active: async () => ({}) } } as any
    for (const instanceId of [sourceId, duplicateId]) {
      ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
      addInstance({ id: instanceId, folder: "/shared", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    }
    setSessions((previous) => new Map(previous).set(sourceId, new Map([[sessionId, {
      id: sessionId, instanceId: sourceId, parentId: null, title: sessionId, agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
      idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      projectID: "project", location: { directory: "/old" }, time: { created: 1, updated: 1 },
    } as any]])))

    try {
      handleNativeSessionEvent(sourceId, {
        id: "moved", created: 2, type: "session.moved",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId, projectID: "project", location: { directory: "/shared", workspaceID: "unknown" } },
      })
      assert.equal(Boolean(sessions().get(duplicateId)?.has(sessionId)), false)
      await delay(20)
      assert.equal(Boolean(sessions().get(duplicateId)?.has(sessionId)), false)
    } finally {
      setSessions((previous) => {
        const next = new Map(previous)
        next.delete(sourceId)
        next.delete(duplicateId)
        return next
      })
      for (const instanceId of [sourceId, duplicateId]) {
        removeInstance(instanceId, { authoritative: false })
        sdkManager.destroyClientsForInstance(instanceId)
      }
    }
  })

  it("projects text immediately, coalesces compaction deltas, and keeps terminal state authoritative", async () => {
    const instanceId = "native-compaction-delta"
    const sessionId = "session"
    const client = { session: { active: async () => ({}) } } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, {
      id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
      idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      projectID: "project", location: { directory: "/work" }, time: { created: 1, updated: 1 },
    } as any]])))
    setActiveSession(instanceId, sessionId)

    try {
      handleInstanceInvalidation(instanceId, {
        id: "assistant", type: "session.step.started", created: 1,
        data: { sessionID: sessionId, assistantMessageID: "assistant", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      handleInstanceInvalidation(instanceId, {
        id: "text", type: "session.text.started", created: 2,
        data: { sessionID: sessionId, assistantMessageID: "assistant" },
      } as any)
      handleInstanceInvalidation(instanceId, {
        id: "compact", type: "session.compaction.started", created: 3,
        data: { sessionID: sessionId, inputID: "compact", reason: "manual", recent: "" },
      } as any)
      handleInstanceInvalidation(instanceId, {
        id: "text-delta-1", type: "session.text.delta", created: 4,
        data: { sessionID: sessionId, assistantMessageID: "assistant", ordinal: 0, delta: "hello" },
      } as any)
      handleInstanceInvalidation(instanceId, {
        id: "text-delta-2", type: "session.text.delta", created: 5,
        data: { sessionID: sessionId, assistantMessageID: "assistant", ordinal: 0, delta: " world" },
      } as any)
      handleInstanceInvalidation(instanceId, {
        id: "delta-1", type: "session.compaction.delta", created: 6,
        data: { sessionID: sessionId, text: "first" },
      } as any)
      handleInstanceInvalidation(instanceId, {
        id: "delta-2", type: "session.compaction.delta", created: 7,
        data: { sessionID: sessionId, text: "second" },
      } as any)

      const store = messageStoreBus.getOrCreate(instanceId)
      const assistantText = () => store.getMessage("assistant")?.partIds
        .map((partId) => store.getMessage("assistant")?.parts[partId].data)
        .find((part) => part?.type === "text")?.text
      assert.equal(assistantText(), "hello world")
      assert.equal((store.getMessage("compact")?.parts.compact?.data as any)?.text, "")

      await delay(300)
      assert.equal((store.getMessage("compact")?.parts.compact?.data as any)?.text, "firstsecond")

      handleInstanceInvalidation(instanceId, {
        id: "delta-3", type: "session.compaction.delta", created: 8,
        data: { sessionID: sessionId, text: "stale" },
      } as any)
      assert.equal((store.getMessage("compact")?.parts.compact?.data as any)?.text, "firstsecond")
      handleInstanceInvalidation(instanceId, {
        id: "ended", type: "session.compaction.ended", created: 9,
        data: { sessionID: sessionId, reason: "manual", text: "final", recent: "" },
      } as any)

      assert.equal((store.getMessage("compact")?.parts.compact?.data as any)?.text, "final")
      assert.equal(store.getMessage("compact")?.status, "complete")
      await delay(300)
      assert.equal((store.getMessage("compact")?.parts.compact?.data as any)?.text, "final")
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("keeps the newest status while an unknown session is hydrating", async () => {
    const instanceId = "native-status-race"
    const sessionId = "unknown"
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const client = {
      session: {
        get: async () => {
          await gate
          return {
            id: sessionId, title: sessionId, parentID: null, version: "1", projectID: "project",
            location: { directory: "/work" }, time: { created: 1, updated: 1 },
          }
        },
      },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })

    try {
      handleNativeSessionEvent(instanceId, {
        id: "started", created: 1, type: "session.execution.started",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId }, location: { directory: "/work" },
      })
      handleSessionStatus(instanceId, {
        type: "session.status", data: { sessionID: sessionId, status: { type: "idle" } },
      } as any)
      release()
      await delay(20)

      assert.equal(sessions().get(instanceId)?.get(sessionId)?.status, "idle")
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.runtimeStatusKnown, true)
    } finally {
      setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("invalidates a loaded inactive transcript after a native message event", () => {
    const instanceId = "inactive-transcript"
    const sessionId = "inactive"
    const client = { session: { active: async () => ({}) } } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, {
      id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
      idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      projectID: "project", location: { directory: "/work" }, time: { created: 1, updated: 1 },
    } as any]])))
    setActiveSession(instanceId, "other")
    setMessagesLoaded((previous) => new Map(previous).set(instanceId, new Set([sessionId])))

    try {
      handleInstanceInvalidation(instanceId, {
        id: "step", type: "session.step.started", created: 2,
        data: { sessionID: sessionId, assistantMessageID: "assistant", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      assert.equal(Boolean(messagesLoaded().get(instanceId)?.has(sessionId)), false)
    } finally {
      setMessagesLoaded((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("hydrates the persisted assistant error after an interruption", async () => {
    const instanceId = "native-interruption-message"
    const sessionId = "session"
    const client = {
      message: {
        list: async () => ({
          data: [{
            id: "assistant-aborted", type: "assistant", agent: "build",
            model: { providerID: "provider", id: "model" }, content: [],
            error: { type: "aborted", message: "Step interrupted" }, time: { created: 2, completed: 3 },
          }],
          cursor: {},
        }),
      },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, {
      id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "working", retry: null,
      idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      projectID: "project", location: { directory: "/work" }, time: { created: 1, updated: 1 },
    } as any]])))

    try {
      handleNativeSessionEvent(instanceId, {
        id: "interrupted", created: 3, type: "session.execution.interrupted",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId, reason: "user" }, location: { directory: "/work" },
      })
      await delay(20)

      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal(store.getMessage("assistant-aborted")?.parts["assistant-aborted-error"]?.data.type, "text")
      assert.equal(store.getMessageInfo("assistant-aborted")?.error?.name, "MessageAbortedError")
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.generationRecovery, "interrupted")
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("keeps active work when a terminal event is stale or the session remains active", async () => {
    const instanceId = "native-terminal-reconciliation"
    const sessionId = "session"
    let resolveActive!: (value: Record<string, unknown>) => void
    const client = {
      session: {
        active: () => new Promise<Record<string, unknown>>((resolve) => { resolveActive = resolve }),
      },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, {
      id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "working", retry: null,
      idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      projectID: "project", location: { directory: "/work" }, time: { created: 1, updated: 1 },
    } as any]])))

    try {
      handleNativeSessionEvent(instanceId, {
        id: "succeeded", created: 2, type: "session.execution.succeeded",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId }, location: { directory: "/work" },
      })
      handleNativeSessionEvent(instanceId, {
        id: "restarted", created: 3, type: "session.execution.started",
        durable: { aggregateID: sessionId, seq: 2, version: 1 },
        data: { sessionID: sessionId }, location: { directory: "/work" },
      })
      resolveActive({})
      await delay(10)
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.status, "working")

      client.session.active = async () => ({ [sessionId]: {} })
      handleNativeSessionEvent(instanceId, {
        id: "interrupted", created: 4, type: "session.execution.interrupted",
        durable: { aggregateID: sessionId, seq: 3, version: 1 },
        data: { sessionID: sessionId, reason: "user" }, location: { directory: "/work" },
      })
      await delay(10)
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.status, "working")
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.generationRecovery, null)
    } finally {
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })
})
