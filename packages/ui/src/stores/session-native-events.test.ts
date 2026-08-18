import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { handleNativeSessionEvent, handleSessionStatus } from "./session-events.ts"
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
