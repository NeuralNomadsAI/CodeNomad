import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { handleNativeSessionEvent, handleSessionIdle } from "./session-events.ts"
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
      handleNativeSessionEvent(instanceId, { type: "session.text.delta", data: { sessionID: sessionId } })
      handleNativeSessionEvent(instanceId, { type: "session.tool.progress", data: { sessionID: sessionId } })
      await delay(120)

      const store = messageStoreBus.getOrCreate(instanceId)
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
})
