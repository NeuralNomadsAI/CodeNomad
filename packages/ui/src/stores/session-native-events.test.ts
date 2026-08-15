import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { clearNativeContentDeltaState } from "./native-session-streaming.ts"
import { handleNativeSessionEvent, handleSessionIdle, handleSessionStatus } from "./session-events.ts"
import { clearInstanceDeletedSessionAuthority, sessions, setSessions } from "./session-state.ts"

const delay = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration))

function session(instanceId: string, id: string): Session {
  return {
    id, instanceId, parentId: null, title: id, agent: "build", model: { providerId: "provider", modelId: "model" },
    status: "idle", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    version: "1", projectID: "project", location: { directory: "/work" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  }
}

describe("native session event reducer", () => {
  it("applies native metadata events and exits compacting on failure", async () => {
    const instanceId = "native-metadata"
    const sessionId = "session"
    const client = { message: { list: async () => ({ data: [] }) } } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    const compacting = { ...session(instanceId, sessionId), status: "compacting" as const }
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, compacting]])))

    try {
      handleNativeSessionEvent(instanceId, {
        id: "rename", created: 2, type: "session.renamed", durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId, title: "Renamed" },
      })
      handleNativeSessionEvent(instanceId, {
        id: "agent", created: 3, type: "session.agent.selected", durable: { aggregateID: sessionId, seq: 2, version: 1 },
        data: { sessionID: sessionId, agent: "plan" },
      })
      handleNativeSessionEvent(instanceId, {
        id: "model", created: 4, type: "session.model.selected", durable: { aggregateID: sessionId, seq: 3, version: 1 },
        data: { sessionID: sessionId, model: { providerID: "next", id: "model-2" } },
      })
      handleNativeSessionEvent(instanceId, {
        id: "failed", created: 5, type: "session.compaction.failed", durable: { aggregateID: sessionId, seq: 4, version: 1 },
        data: { sessionID: sessionId, reason: "manual", error: { name: "UnknownError", data: { message: "failed" } } },
      } as any)
      await delay(10)

      const updated = sessions().get(instanceId)?.get(sessionId)
      assert.equal(updated?.title, "Renamed")
      assert.equal(updated?.agent, "plan")
      assert.deepEqual(updated?.model, { providerId: "next", modelId: "model-2" })
      assert.equal(updated?.status, "idle")
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("coalesces text and tool events, then refreshes authoritatively on idle", async () => {
    const instanceId = "native-events"
    const sessionId = "session"
    let calls = 0
    const client = {
      session: {},
      message: {
        list: async () => {
          calls += 1
          return { data: [{
            id: "assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "provider", id: "model" },
            time: { created: 2, ...(calls > 1 ? { completed: 3 } : {}) },
            content: [
              { type: "text", text: calls > 1 ? "completed text" : "streaming text" },
              {
                id: "tool",
                type: "tool",
                name: "bash",
                time: { created: 2 },
                state: { status: "running", input: { command: "pwd" }, metadata: {} },
              },
            ],
          }] }
        },
      },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    try {
      handleNativeSessionEvent(instanceId, {
        id: "text", created: 1, type: "session.text.delta",
        data: { sessionID: sessionId, assistantMessageID: "assistant", ordinal: 0, delta: "streaming text" },
      })
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "streaming text")
      handleNativeSessionEvent(instanceId, {
        id: "tool", created: 2, type: "session.tool.progress",
        data: { sessionID: sessionId, assistantMessageID: "assistant", id: "tool", metadata: {} },
      })
      await delay(120)

      assert.equal(calls, 1)
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.status, "working")
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "streaming text")
      assert.equal((store.getMessage("assistant")?.parts.tool?.data as any)?.state.status, "running")

      handleSessionIdle(instanceId, { type: "session.idle", data: { sessionID: sessionId } } as any)
      await delay(20)

      assert.equal(calls, 2)
      assert.equal(sessions().get(instanceId)?.get(sessionId)?.status, "idle")
      assert.equal(store.getMessage("assistant")?.status, "complete")
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "completed text")
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("refreshes periodically during a continuous fast native stream", async () => {
    const instanceId = "native-fast-stream"
    const sessionId = "session"
    let calls = 0
    const client = {
      message: { list: async () => { calls += 1; return { data: [] } } },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

    const eventTypes = ["session.text.delta", "session.reasoning.delta", "session.tool.progress"] as const
    let eventIndex = 0
    const stream = setInterval(() => {
      const type = eventTypes[eventIndex % eventTypes.length]
      const id = `event-${eventIndex++}`
      handleNativeSessionEvent(instanceId, {
        id,
        created: eventIndex,
        type,
        data: type === "session.text.delta"
          ? { sessionID: sessionId, assistantMessageID: "assistant", ordinal: 0, delta: "text " }
          : type === "session.reasoning.delta"
            ? { sessionID: sessionId, assistantMessageID: "assistant", ordinal: 1, delta: "reason " }
            : { sessionID: sessionId, assistantMessageID: "assistant", id: "tool", metadata: {} },
      } as any)
    }, 10)

    try {
      await delay(260)
      clearInterval(stream)
      await delay(120)

      assert.ok(calls >= 2, `expected periodic refreshes, received ${calls}`)
      assert.ok(calls <= 5, `expected refreshes to stay bounded, received ${calls}`)
      const streamed = messageStoreBus.getOrCreate(instanceId).getMessage("assistant")
      assert.match((streamed?.parts["assistant-text-0"]?.data as any)?.text ?? "", /text/)
      assert.match((streamed?.parts["assistant-reasoning-1"]?.data as any)?.text ?? "", /reason/)
    } finally {
      clearInterval(stream)
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
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
})
