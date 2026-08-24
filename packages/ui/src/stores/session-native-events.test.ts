import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { handleNativeSessionEvent, handleSessionStatus } from "./session-events.ts"
import { clearInstanceDeletedSessionAuthority, sessions, setActiveSession, setSessions } from "./session-state.ts"

const delay = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration))

describe("native session event reducer", () => {
  it("keeps compaction deltas in the reducer without projecting each one", () => {
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
        id: "compact", type: "session.compaction.started", created: 1,
        data: { sessionID: sessionId, inputID: "compact", reason: "manual", recent: "" },
      } as any)
      handleInstanceInvalidation(instanceId, {
        id: "delta-1", type: "session.compaction.delta", created: 2,
        data: { sessionID: sessionId, text: "first" },
      } as any)
      handleInstanceInvalidation(instanceId, {
        id: "delta-2", type: "session.compaction.delta", created: 3,
        data: { sessionID: sessionId, text: "second" },
      } as any)

      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal((store.getMessage("compact")?.parts.compact?.data as any)?.text, "")

      handleInstanceInvalidation(instanceId, {
        id: "usage", type: "session.usage.updated", created: 4,
        data: { sessionID: sessionId, cost: 0, tokens: {} },
      } as any)
      assert.equal((store.getMessage("compact")?.parts.compact?.data as any)?.text, "firstsecond")

      handleInstanceInvalidation(instanceId, {
        id: "ended", type: "session.compaction.ended", created: 5,
        data: { sessionID: sessionId, reason: "manual", text: "final", recent: "" },
      } as any)

      assert.equal((store.getMessage("compact")?.parts.compact?.data as any)?.text, "final")
      assert.equal(store.getMessage("compact")?.status, "complete")
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
})
