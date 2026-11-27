import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { createClientSession } from "../types/session.ts"
import { handleNativeSessionEvent, handleSessionUpdate } from "./session-events.ts"
import { refreshSessionRuntimeStatus } from "./session-api.ts"
import { clearInstanceDeletedSessionAuthority, messagesLoaded, sessions, setActiveSession, setMessagesLoaded, setSessions } from "./session-state.ts"
import { emptyLatestWindow } from "./message-v2/message-window.ts"
import { seedSessionMessagesV2 } from "./message-v2/bridge.ts"
import { normalizeSessionMessage } from "./message-v2/normalizers.ts"

const delay = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration))

describe("native session event reducer", () => {
  it("projects rename titles and reads only missing metadata, retaining the latest title in flight", async () => {
    const instanceId = "native-session-rename"
    let reads = 0
    let reply!: (info: any) => void
    const client = { session: { get: () => {
      reads++
      return new Promise(resolve => { reply = resolve })
    } } } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    sseManager.seedStatus(instanceId, "connected")
    const rename = (sessionID: string, title: string) => {
      const event = { id: title, type: "session.renamed", created: 2, location: { directory: "/work" },
        data: { sessionID, title } } as const
      handleInstanceInvalidation(instanceId, event as any)
      handleNativeSessionEvent(instanceId, event as any)
    }
    try {
      const info = { id: "known", location: { directory: "/work" }, projectID: "project", title: "Old",
        time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
      setSessions(previous => new Map(previous).set(instanceId, new Map([["known", { ...info, parentId: null, instanceId, status: "idle" } as any]])))
      rename("known", "New")
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(reads, 0)
      assert.equal(sessions().get(instanceId)?.get("known")?.title, "New")
      const archive = (sessionID: string, type: "session.archived" | "session.unarchived", created: number) =>
        handleNativeSessionEvent(instanceId, { id: type, type, created, data: { sessionID } } as any)
      rename("cold", "First")
      rename("cold", "Second")
      archive("cold", "session.archived", 3)
      assert.equal(reads, 1)
      reply({ ...info, id: "cold", parentID: "known" })
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(sessions().get(instanceId)?.get("cold")?.title, "Second")
      assert.equal(sessions().get(instanceId)?.get("cold")?.time.archived, 3)
      rename("cold", "Third")
      assert.equal(reads, 1)
      assert.equal(sessions().get(instanceId)?.get("cold")?.title, "Third")

      rename("listed", "Rename before list")
      const listRow = { ...info, id: "listed", parentId: "known", instanceId, status: "idle" } as any
      setSessions(previous => new Map(previous).set(instanceId, new Map(previous.get(instanceId)).set(listRow.id, listRow)))
      archive("listed", "session.archived", 3)
      archive("listed", "session.unarchived", 4)
      reply({ ...info, id: "listed", parentID: "known", time: { ...info.time, archived: 1 } })
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(reads, 2)
      assert.equal(sessions().get(instanceId)?.get("listed")?.title, "Rename before list")
      assert.equal(sessions().get(instanceId)?.get("listed")?.time.archived, undefined)

      rename("newer", "Superseded rename")
      archive("newer", "session.archived", 3)
      reply({ ...info, id: "newer", title: "Newer snapshot", time: { ...info.time, updated: 5 } })
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(sessions().get(instanceId)?.get("newer")?.title, "Newer snapshot")
      assert.equal(sessions().get(instanceId)?.get("newer")?.time.archived, undefined)

      rename("newer-list", "Superseded rename")
      const newerRow = { ...listRow, id: "newer-list", title: "Newer list", time: { ...info.time, updated: 5 } }
      setSessions(previous => new Map(previous).set(instanceId, new Map(previous.get(instanceId)).set(newerRow.id, newerRow)))
      rename("newer-list", "Late event")
      archive("newer-list", "session.archived", 3)
      reply({ ...info, id: "newer-list", parentID: "known" })
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(sessions().get(instanceId)?.get("newer-list")?.title, "Newer list")
      assert.equal(sessions().get(instanceId)?.get("newer-list")?.time.archived, undefined)
    } finally {
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("preserves durable session metadata and recognizes the streamed step boundary", () => {
    const instanceId = "native-session-metadata"
    const sessionId = "session"
    const client = { session: { active: async () => ({}) } } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    try {
      handleSessionUpdate(instanceId, {
        id: "created", type: "session.created", created: 1,
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        location: { directory: "/work" },
        data: { sessionID: sessionId, title: "Session", version: "1", metadata: { client: "codenomad", restore: { window: "primary" } } },
      } as any)
      assert.deepEqual(sessions().get(instanceId)?.get(sessionId)?.metadata, { client: "codenomad", restore: { window: "primary" } })
      handleNativeSessionEvent(instanceId, {
        id: "streamed", type: "session.step.streamed", created: 2,
        durable: { aggregateID: sessionId, seq: 2, version: 1 },
        location: { directory: "/work" }, data: { sessionID: sessionId, assistantMessageID: "assistant" },
      } as any)
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.status, "working")
    } finally {
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  for (const retry of [false, true]) it(`drops ${retry ? "backoff after a new attempt" : "compaction after settlement"} from a shared cold read`, async () => {
    const instanceId = `shared-status-read-${retry}`
    const sessionId = "cold"
    let reads = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const info = {
      id: sessionId, title: "old", projectID: "project", version: "1",
      location: { directory: "/work" }, time: { created: 1, updated: 1 },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const client = { session: { active: async () => ({}), get: async () => { reads++; await gate; return info } } } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    let seq = 0
    const emit = (type: string, extra = {}) => handleNativeSessionEvent(instanceId, {
      id: `event-${++seq}`, type, created: seq + 1, location: info.location,
      durable: { aggregateID: sessionId, seq, version: 1 }, data: { sessionID: sessionId, ...extra },
    } as any)
    const row = () => sessions().get(instanceId)?.get(sessionId)
    try {
      emit("session.renamed", { title: "Renamed" })
      if (retry) emit("session.retry.scheduled", { assistantMessageID: "msg_retry", attempt: 1, at: Date.now() + 5_000,
        error: { name: "UnknownError", message: "Provider backoff" } })
      else emit("session.compaction.started")
      assert.equal(reads, 1)
      setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, createClientSession(info as any, instanceId)]])))
      await emit(retry ? "session.execution.started" : "session.execution.succeeded")
      const expectedStatus = retry ? "working" : "idle"
      assert.equal(row()?.status, expectedStatus)
      assert.equal(row()?.retry, null)
      release()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(row()?.title, "Renamed")
      assert.equal(row()?.status, expectedStatus)
      assert.equal(row()?.retry, null)
    } finally {
      release()
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

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
        data: { sessionID: sessionId, inputID: "compact", reason: "manual" },
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
        data: { sessionID: sessionId, reason: "manual", text: "final" },
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
        active: async () => ({}),
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
      handleNativeSessionEvent(instanceId, {
        id: "succeeded", created: 2, type: "session.execution.succeeded",
        durable: { aggregateID: sessionId, seq: 2, version: 1 },
        data: { sessionID: sessionId }, location: { directory: "/work" },
      })
      // Settlement is confirmed while the session's metadata is still hydrating.
      await delay(10)
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

  it("reloads a watched transcript when a pending prompt settles without any SSE events", async () => {
    const instanceId = "native-pending-settlement-reload"
    const sessionId = "session"
    const prompt = { id: "user-1", type: "user", text: "first prompt", time: { created: 1, completed: 1 } }
    const reply = {
      id: "assistant-1", type: "assistant", agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: 2, completed: 3 },
      content: [{ type: "text", text: "reply without events" }],
    }
    let messageReads = 0
    const client = {
      session: {
        active: async () => ({}),
        get: async () => ({
          id: sessionId, title: sessionId, projectID: "project", location: { directory: "/work" },
          time: { created: 1, updated: 3, idle: 3 }, outcome: "succeeded",
        }),
      },
      message: {
        list: async () => {
          messageReads += 1
          return { data: [reply, prompt], cursor: {} }
        },
      },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    const store = messageStoreBus.getOrCreate(instanceId)
    const normalized = normalizeSessionMessage(sessionId, prompt as any)
    seedSessionMessagesV2(instanceId, { id: sessionId }, [normalized.message], new Map([[normalized.info.id, normalized.info]]))
    store.setMessageWindow(sessionId, emptyLatestWindow())
    setMessagesLoaded((previous) => new Map(previous).set(instanceId, new Set([sessionId])))
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, {
      id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
      idleSince: 1, generationRecovery: "pending", generationAdmissionEpoch: 1,
      generationAdmissionIdleBoundary: 1, runtimeStatusKnown: true,
      projectID: "project", location: { directory: "/work" }, time: { created: 1, updated: 1, idle: 1 },
    } as any]])))
    setActiveSession(instanceId, sessionId)

    try {
      await refreshSessionRuntimeStatus(instanceId)
      for (let attempt = 0; attempt < 20 && !store.getSessionMessageIds(sessionId).includes("assistant-1"); attempt += 1) {
        await delay(5)
      }
      assert.equal(messageReads, 1)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["user-1", "assistant-1"])
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.generationRecovery, null)
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("reloads a watched transcript when execution succeeds while only the user prompt is visible", async () => {
    const instanceId = "native-succeeded-missing-reply"
    const sessionId = "session"
    const prompt = { id: "user-1", type: "user", text: "first prompt", time: { created: 1, completed: 1 } }
    const reply = {
      id: "assistant-1", type: "assistant", agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: 2, completed: 3 },
      content: [{ type: "text", text: "reloaded reply" }],
    }
    let messageReads = 0
    const client = {
      session: { active: async () => ({}) },
      message: {
        list: async () => {
          messageReads += 1
          return { data: [reply, prompt], cursor: {} }
        },
      },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    const store = messageStoreBus.getOrCreate(instanceId)
    const normalized = normalizeSessionMessage(sessionId, prompt as any)
    seedSessionMessagesV2(instanceId, { id: sessionId }, [normalized.message], new Map([[normalized.info.id, normalized.info]]))
    store.setMessageWindow(sessionId, emptyLatestWindow())
    setMessagesLoaded((previous) => new Map(previous).set(instanceId, new Set([sessionId])))
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, {
      id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "working", retry: null,
      idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      projectID: "project", location: { directory: "/work" }, time: { created: 1, updated: 1 },
    } as any]])))
    setActiveSession(instanceId, sessionId)

    try {
      handleNativeSessionEvent(instanceId, {
        id: "succeeded", created: 3, type: "session.execution.succeeded",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId }, location: { directory: "/work" },
      })
      for (let attempt = 0; attempt < 20 && !store.getSessionMessageIds(sessionId).includes("assistant-1"); attempt += 1) {
        await delay(5)
      }
      assert.equal(messageReads, 1)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["user-1", "assistant-1"])
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })
})
